'use strict';
/**
 * villegas.js — lógica pura del endpoint POST /api/ai/villegas (chat del Ing. Villegas
 * para la PWA de consulta). Sin red ni Express: valida el body y arma el payload de
 * Anthropic, para poder probarlo aislado. index.js pone la auth, el rate limit y el fetch.
 *
 * DIFERENCIA CLAVE con /api/ai/chat: aquí el cliente NO manda `system`, `model` ni
 * `max_tokens`. El servidor arma el prompt (villegas-prompts.js), fija el modelo y
 * acota la salida. El cliente solo aporta mensajes de texto y, opcionalmente, un
 * bloque de DATOS del proyecto (`context`).
 *
 * Body permitido (cualquier otra clave → 400):
 *   mode      'chat' (default) | 'punto'  (interpretación de UN punto: INTERPRETACION_SYSTEM)
 *   messages  [{ role: 'user'|'assistant', content: string }]
 *   context   string opcional (solo modo chat): datos del análisis. El servidor lo antepone
 *             como primer turno de usuario junto con las instrucciones de respuesta.
 */
const { GEOLOGO_SYSTEM, INTERPRETACION_SYSTEM } = require('./villegas-prompts');

// Mismo modelo que el chat nativo (MODEL_SMART).
const MODEL = 'claude-sonnet-4-6';

const MODES = {
  chat:  { maxTokens: 1500 },
  punto: { maxTokens: 3000 },
};

const LIMITS = {
  maxMessages:      40,      // por petición; el modelo ve solo los últimos HISTORY_KEPT
  historyKept:      20,      // igual que askClaudeGeologoExperto (slice(-20))
  maxMessageChars:  8000,
  maxTotalChars:    60000,
  maxContextChars:  16000,
};

const ALLOWED_KEYS = new Set(['mode', 'messages', 'context']);

// Instrucciones de respuesta del primer turno (en la app nativa viajan dentro del
// mensaje de contexto; aquí se agregan en el servidor para que no estén en el bundle).
const CONTEXT_TAIL = `

Responde con:
1. Resumen interpretativo: que ves?, que patron de alteracion muestra?
2. Significado geologico: que sistema mineral es compatible?
3. Plan de campo: donde caminar primero y que buscar?`;

// Canal web: el prompt base habla de "Botón Trazar", "Analizar", cámara, etc. Desde la
// PWA nada de eso existe. Va en un SEGUNDO bloque de system, después del bloque cacheado,
// así el prefijo cacheado sigue idéntico al de la app nativa.
const WEB_CHANNEL_NOTE = `CANAL ACTUAL: el usuario te consulta desde la versión WEB de solo consulta de ProspectorAI (PWA). Ahí puede ver sus proyectos, resultados y mapa, pero NO puede trazar polígonos, correr análisis nuevos, tomar fotos ni registrar muestras: eso solo se hace en la app nativa (iPhone/Android). Cuando tu respuesta sugiera una de esas acciones, dile que se hace en la app nativa. Solo cuentas con los datos que se te entregan en la conversación; no inventes nada más.`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Valida el body. Devuelve { ok: true, value } o { ok: false, error }.
 * `value` = { mode, context, messages } ya normalizado (mensajes recortados a los últimos
 * historyKept y, sin contexto, empezando por un turno de usuario).
 */
function validateBody(body) {
  if (!isPlainObject(body)) return { ok: false, error: 'Payload inválido: se esperaba un objeto JSON.' };

  for (const k of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(k)) {
      return { ok: false, error: `Campo no permitido: "${String(k).slice(0, 30)}". Solo se aceptan mode, messages y context.` };
    }
  }

  const mode = body.mode === undefined ? 'chat' : body.mode;
  if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    return { ok: false, error: 'mode inválido (usa "chat" o "punto").' };
  }

  const rawMessages = body.messages === undefined ? [] : body.messages;
  if (!Array.isArray(rawMessages)) return { ok: false, error: 'messages debe ser un arreglo.' };
  if (rawMessages.length > LIMITS.maxMessages) {
    return { ok: false, error: `Demasiados mensajes (máximo ${LIMITS.maxMessages}).` };
  }

  let total = 0;
  const messages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (!isPlainObject(m)) return { ok: false, error: `Mensaje ${i + 1} mal formado.` };
    for (const k of Object.keys(m)) {
      if (k !== 'role' && k !== 'content') return { ok: false, error: `Mensaje ${i + 1}: campo no permitido "${String(k).slice(0, 30)}".` };
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      return { ok: false, error: `Mensaje ${i + 1}: role debe ser "user" o "assistant".` };
    }
    if (typeof m.content !== 'string') {
      return { ok: false, error: `Mensaje ${i + 1}: content debe ser texto.` };
    }
    const content = m.content.trim();
    if (!content) return { ok: false, error: `Mensaje ${i + 1}: content vacío.` };
    if (content.length > LIMITS.maxMessageChars) {
      return { ok: false, error: `Mensaje ${i + 1} demasiado largo (máximo ${LIMITS.maxMessageChars} caracteres).` };
    }
    total += content.length;
    messages.push({ role: m.role, content });
  }
  if (total > LIMITS.maxTotalChars) {
    return { ok: false, error: `La conversación es demasiado larga (máximo ${LIMITS.maxTotalChars} caracteres).` };
  }

  let context = null;
  if (body.context !== undefined) {
    if (mode !== 'chat') return { ok: false, error: 'context solo se admite en mode "chat".' };
    if (typeof body.context !== 'string' || !body.context.trim()) {
      return { ok: false, error: 'context debe ser texto no vacío.' };
    }
    context = body.context.trim();
    if (context.length > LIMITS.maxContextChars) {
      return { ok: false, error: `context demasiado largo (máximo ${LIMITS.maxContextChars} caracteres).` };
    }
  }

  if (mode === 'punto') {
    if (messages.length !== 1 || messages[0].role !== 'user') {
      return { ok: false, error: 'mode "punto" requiere exactamente un mensaje de usuario con los datos del punto.' };
    }
    if (messages[0].content.length > LIMITS.maxContextChars) {
      return { ok: false, error: `Datos del punto demasiado largos (máximo ${LIMITS.maxContextChars} caracteres).` };
    }
    return { ok: true, value: { mode, context: null, messages } };
  }

  // mode chat
  if (messages.length === 0 && !context) {
    return { ok: false, error: 'Falta la conversación: manda al menos un mensaje o un context.' };
  }
  if (messages.length > 0 && messages[messages.length - 1].role !== 'user') {
    return { ok: false, error: 'El último mensaje debe ser del usuario.' };
  }

  let kept = messages.slice(-LIMITS.historyKept);
  // Sin contexto, la API exige empezar por un turno de usuario.
  if (!context) {
    while (kept.length > 0 && kept[0].role !== 'user') kept = kept.slice(1);
    if (kept.length === 0) return { ok: false, error: 'La conversación debe incluir un mensaje del usuario.' };
  }
  return { ok: true, value: { mode, context, messages: kept } };
}

/** Payload para /v1/messages. El system se arma AQUÍ; nunca viene del cliente. */
function buildAnthropicPayload({ mode, context, messages }) {
  const { maxTokens } = MODES[mode];

  if (mode === 'punto') {
    // Sin cache_control a propósito (mismo criterio que la app nativa: ~1.200 tokens,
    // por debajo del mínimo cacheable de Sonnet 4.6).
    return { model: MODEL, max_tokens: maxTokens, system: INTERPRETACION_SYSTEM, messages };
  }

  const system = [
    { type: 'text', text: GEOLOGO_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: WEB_CHANNEL_NOTE },
  ];
  const finalMessages = context
    ? [{ role: 'user', content: context + CONTEXT_TAIL }, ...messages]
    : messages;
  return { model: MODEL, max_tokens: maxTokens, system, messages: finalMessages };
}

/** Estimación conservadora (~4 caracteres/token) + techo de salida, como /api/ai/chat. */
function estimateTokens(payload) {
  const chars = JSON.stringify({ system: payload.system, messages: payload.messages }).length;
  return Math.ceil(chars / 4) + payload.max_tokens;
}

module.exports = { validateBody, buildAnthropicPayload, estimateTokens, LIMITS, MODEL };
