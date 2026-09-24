'use strict';
/**
 * server-ai — Proxy de IA autenticado para ProspectorAI (servicio independiente).
 *
 * NO tiene nada de GEE/AgroCrop. Solo:
 *   GET  /health          → status
 *   POST /api/ai/chat     → valida token Supabase → rate limit → Anthropic
 *   POST /api/ai/villegas → chat del Ing. Villegas para la PWA: el cliente manda SOLO
 *                           mensajes; el system prompt se arma aquí (ver villegas.js)
 *
 * Variables de entorno (se configuran en Railway, nunca en el cliente):
 *   ANTHROPIC_API_KEY          — clave del servidor (NUEVA, no la vieja expuesta)
 *   SUPABASE_URL               — https://kjprkyuaghzwjatcjnyx.supabase.co
 *   SUPABASE_ANON_KEY          — anon (pública), para validar el token de usuario
 *   SUPABASE_SERVICE_ROLE_KEY  — secreta, para leer profile + rate limit RPC
 *   AI_DAILY_LIMIT             — opcional, default 50 consultas/día (admins exentos)
 *   AI_DAILY_TOKENS            — opcional, default 1.000.000 tokens/día por usuario
 *   ALLOWED_ORIGINS            — opcional, CSV de orígenes CORS (default: *)
 *   PORT                       — lo inyecta Railway
 */
const express = require('express');
const cors    = require('cors');
const { validateBody, buildAnthropicPayload, estimateTokens } = require('./villegas');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const SUPABASE_URL              = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY || '';
const AI_DAILY_LIMIT            = parseInt(process.env.AI_DAILY_LIMIT || '50', 10);
// Presupuesto diario de TOKENS por usuario (entrada estimada + max_tokens de salida).
// El límite por peticiones no acota el gasto: 50 peticiones pueden ser 50k tokens o
// 10M. El default (1M) está calibrado para NO estorbar el uso normal —50 turnos de
// chat a ~20k tokens dan justo 1M— y sí frenar el abuso: con `express.json` aceptando
// hasta 25 MB, una sola petición inflada valdría millones de tokens y aquí se corta
// antes de llegar a Anthropic. Súbelo por env si un usuario legítimo topa.
const AI_DAILY_TOKENS           = parseInt(process.env.AI_DAILY_TOKENS || '1000000', 10);

// ── Modelos permitidos ───────────────────────────────────────────────────────
// El endpoint reenviaba `model` tal cual venía del cliente. Cualquier usuario
// registrado podía pedir el modelo más caro del catálogo con max_tokens al tope,
// contra la clave del dueño, y solo gastaba UNA de sus 50 consultas diarias.
// Whitelist + tope de salida por modelo. Si añades un modelo a la app, va aquí.
const ALLOWED_MODELS = {
  'claude-sonnet-4-6':            { maxOutput: 8192 },
  'claude-haiku-4-5-20251001':    { maxOutput: 4096 },
};
const DEFAULT_MAX_TOKENS = 1500;

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : '*';

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'OPTIONS'] }));
// Las consultas de IA pueden traer imágenes en base64 (foto de roca / chat) → límite alto.
const jsonBig = express.json({ limit: '25mb' });
// /api/ai/villegas (PWA) solo recibe texto: lleva su propio parser con tope de 256 KB.
// Sin este desvío el parser global de 25 MB correría primero y anularía ese tope.
app.use((req, res, next) => (req.path === '/api/ai/villegas' ? next() : jsonBig(req, res, next)));

// ── Helpers Supabase ─────────────────────────────────────────────────────────
// Cabeceras con la llave de servicio. Llave legacy (JWT, empieza por eyJ): apikey + Bearer, como
// siempre. Llave nueva (sb_secret_…, no es JWT): SOLO apikey; como Bearer la rechaza el gateway.
// Con el helper el mismo código sirve antes y después de migrar la llave.
function serviceHeaders(extra = {}) {
  const h = { apikey: SUPABASE_SERVICE_ROLE_KEY, ...extra };
  if (SUPABASE_SERVICE_ROLE_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  return h;
}

async function supabaseUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

async function supabaseProfile(uid) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role,active,deleted`, {
    headers: serviceHeaders(),
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : null;
}

// ── Límite de respaldo EN MEMORIA (fail-closed) ──────────────────────────────
// El contador de verdad vive en Supabase. Si esa llamada falla, antes se devolvía
// `true` ("déjalo pasar"): un rate limit que se abre solo cuando falla no es un
// rate limit — basta con tumbar el RPC para tener IA ilimitada contra la clave del
// dueño. Ahora, si el contador remoto no responde, se cae a este contador local:
// más estricto (LOCAL_FALLBACK_RATIO del límite normal), por proceso y por día.
//
// Es en memoria a propósito: se pierde al reiniciar el contenedor, pero el contador
// remoto es quien manda en cuanto vuelve. Su trabajo es aguantar el hueco, no
// sustituirlo.
const LOCAL_FALLBACK_RATIO = 0.4;
const localUsage = new Map(); // uid → { day: 'YYYY-MM-DD', requests, tokens }

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function localUsageFor(uid) {
  const day = utcDay();
  const cur = localUsage.get(uid);
  if (!cur || cur.day !== day) {
    // Poda perezosa: al cambiar el día se tira todo lo del día anterior.
    if (localUsage.size > 5000) localUsage.clear();
    const fresh = { day, requests: 0, tokens: 0 };
    localUsage.set(uid, fresh);
    return fresh;
  }
  return cur;
}

/**
 * ¿Puede este usuario hacer una consulta más de `estTokens` tokens?
 * Devuelve { ok, reason }. NUNCA devuelve ok:true por defecto ante un fallo.
 */
async function checkAiUsage(uid, maxRequests, maxTokens, estTokens) {
  // El presupuesto de tokens se lleva SIEMPRE en local, incluso con el RPC sano: el
  // contador remoto cuenta peticiones, y una petición puede valer 500 tokens o
  // 200.000. Sin esto, el "límite diario" no acotaba el gasto real.
  const local = localUsageFor(uid);
  if (local.tokens + estTokens > maxTokens) {
    const pretty = maxTokens >= 1_000_000
      ? `${(maxTokens / 1_000_000).toFixed(maxTokens % 1_000_000 ? 1 : 0)} M`
      : `${Math.round(maxTokens / 1000)} mil`;
    return { ok: false, reason: `Alcanzaste el límite diario de IA (${pretty} tokens/día). Vuelve mañana.` };
  }

  let remoteOk = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_increment_ai_usage`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_user: uid, p_max: maxRequests }),
    });
    if (r.ok) remoteOk = await r.json(); // boolean
  } catch { /* remoteOk se queda en null → respaldo local */ }

  if (remoteOk === false) {
    return { ok: false, reason: `Alcanzaste el límite diario de IA (${maxRequests} consultas/día). Vuelve mañana.` };
  }

  if (remoteOk === null) {
    // Fail-closed: el contador remoto no contestó → manda el respaldo local, que es
    // más apretado. Se registra para que el fallo no pase inadvertido.
    const localMax = Math.max(1, Math.floor(maxRequests * LOCAL_FALLBACK_RATIO));
    console.warn(`[rate-limit] contador remoto caído; usando respaldo local (${local.requests}/${localMax}) uid=${uid}`);
    if (local.requests >= localMax) {
      return { ok: false, reason: 'El servicio de IA está degradado y se aplicó un límite reducido. Intenta más tarde.' };
    }
  }

  local.requests += 1;
  local.tokens   += estTokens;
  return { ok: true };
}

// ── Rutas ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'prospectorai-ai-proxy',
    configured: !!(ANTHROPIC_API_KEY && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Servidor IA no configurado (faltan variables de entorno).' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Falta el token de sesión.' });

    const user = await supabaseUser(token);
    if (!user || !user.id) return res.status(403).json({ error: 'Sesión inválida. Inicia sesión de nuevo.' });

    const profile = await supabaseProfile(user.id);
    if (profile && (profile.deleted === true || profile.active === false)) {
      return res.status(403).json({ error: 'Cuenta suspendida.' });
    }
    const isAdmin = !!profile && profile.role === 'admin';

    const { model, max_tokens, system, messages } = req.body || {};
    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Payload inválido: se requieren model y messages.' });
    }

    // ── Validación del payload (antes se reenviaba tal cual) ──────────────────
    const modelCfg = ALLOWED_MODELS[model];
    if (!modelCfg) {
      return res.status(400).json({ error: `Modelo no permitido: ${String(model).slice(0, 60)}` });
    }
    const requested = Number.isFinite(max_tokens) ? Math.floor(max_tokens) : DEFAULT_MAX_TOKENS;
    if (requested < 1) {
      return res.status(400).json({ error: 'max_tokens inválido.' });
    }
    // Se recorta en vez de rechazar: un cliente viejo que pida de más sigue
    // funcionando, solo que acotado.
    const safeMaxTokens = Math.min(requested, modelCfg.maxOutput);

    // Coste estimado de la llamada = entrada + techo de salida. La estimación de
    // entrada es aproximada (~4 caracteres por token) y a propósito conservadora:
    // el objetivo es acotar el gasto, no facturar al milímetro.
    const payloadChars = JSON.stringify({ system: system ?? '', messages }).length;
    const estTokens    = Math.ceil(payloadChars / 4) + safeMaxTokens;

    if (!isAdmin) {
      const usage = await checkAiUsage(user.id, AI_DAILY_LIMIT, AI_DAILY_TOKENS, estTokens);
      if (!usage.ok) {
        return res.status(429).json({ error: usage.reason });
      }
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: safeMaxTokens, system, messages }),
    });
    const body = await anthropicRes.text();
    res.status(anthropicRes.status).type('application/json').send(body);
  } catch (err) {
    console.error('[/api/ai/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Chat del Ing. Villegas para la PWA ───────────────────────────────────────
// El bundle web NUNCA lleva el system prompt: el cliente manda solo mensajes (y
// opcionalmente un bloque de datos `context`); aquí se valida, se arma el prompt,
// se aplica el mismo rate limit/presupuesto de tokens que /api/ai/chat y se llama a
// Anthropic. Respuesta: { reply, usage, truncated }. Errores: { error } (mismo formato que /chat).
app.post('/api/ai/villegas', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Servidor IA no configurado (faltan variables de entorno).' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Falta el token de sesión.' });

    const user = await supabaseUser(token);
    if (!user || !user.id) return res.status(403).json({ error: 'Sesión inválida. Inicia sesión de nuevo.' });

    const profile = await supabaseProfile(user.id);
    if (profile && (profile.deleted === true || profile.active === false)) {
      return res.status(403).json({ error: 'Cuenta suspendida.' });
    }
    const isAdmin = !!profile && profile.role === 'admin';

    // Se valida DESPUÉS de autenticar: un anónimo no puede ni sondear el formato.
    const parsed = validateBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const payload = buildAnthropicPayload(parsed.value);

    if (!isAdmin) {
      const usage = await checkAiUsage(user.id, AI_DAILY_LIMIT, AI_DAILY_TOKENS, estimateTokens(payload));
      if (!usage.ok) return res.status(429).json({ error: usage.reason });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(80_000),
    });
    const raw = await anthropicRes.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* cuerpo no JSON */ }

    if (!anthropicRes.ok || !data) {
      // Detalle solo en logs del servidor; al cliente, un mensaje genérico.
      console.error(`[/api/ai/villegas] Anthropic ${anthropicRes.status}: ${raw.slice(0, 300)}`);
      const status = anthropicRes.status === 429 ? 429 : anthropicRes.status === 529 ? 503 : 502;
      return res.status(status).json({ error: 'El Ing. Villegas no pudo responder ahora. Intenta de nuevo en un momento.' });
    }

    const reply = (Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!reply) return res.status(502).json({ error: 'El Ing. Villegas devolvió una respuesta vacía. Intenta de nuevo.' });

    const u = data.usage || {};
    const usageOut = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    };
    // Telemetría mínima (sin contenido de mensajes): tokens reales por llamada.
    console.log(`[villegas] mode=${parsed.value.mode} uid=${user.id} in=${usageOut.input_tokens} out=${usageOut.output_tokens} cache_w=${usageOut.cache_creation_input_tokens} cache_r=${usageOut.cache_read_input_tokens}`);
    // truncated: la salida topó max_tokens (la respuesta termina a media frase); el cliente lo avisa.
    res.json({ reply, usage: usageOut, truncated: data.stop_reason === 'max_tokens' });
  } catch (err) {
    console.error('[/api/ai/villegas]', err.message);
    res.status(500).json({ error: 'Error interno del servidor de IA.' });
  }
});

// JSON mal formado / cuerpo demasiado grande en /villegas → 400/413 en JSON (no HTML de Express).
app.use('/api/ai/villegas', (err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'La petición es demasiado grande.' });
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'JSON mal formado.' });
  console.error('[/api/ai/villegas] middleware:', err && err.message);
  res.status(500).json({ error: 'Error interno del servidor de IA.' });
});

// ── Redirecciones de invitación (los links exp:// no son clicables en WhatsApp) ──
// Actualiza estas constantes cuando cambien el canal o haya un APK nuevo.
const IOS_EXP_URL = 'exp://u.expo.dev/d95e10b8-82f0-44d8-935a-7059989e4e54?channel-name=preview';
const APK_URL     = 'https://github.com/gcobras75-stack/ProspectorAI/releases/download/apk-preview-20260708/ProspectorAI-preview-v1.apk';

app.get('/ios', (_req, res) => res.redirect(302, IOS_EXP_URL));
app.get('/apk', (_req, res) => res.redirect(302, APK_URL));

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ProspectorAI</title>
<style>
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#000;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  .card{width:100%;max-width:420px;text-align:center}
  h1{color:#FFD700;font-size:30px;font-weight:900;margin:0 0 6px}
  p{color:#999;margin:0 0 28px;font-size:15px}
  a.btn{display:block;text-decoration:none;font-weight:800;font-size:16px;border-radius:12px;padding:16px;margin:12px 0}
  .ios{background:#FFD700;color:#000}
  .apk{background:#0d0d0d;color:#FFD700;border:1px solid #FFD700}
  small{color:#666;display:block;margin-top:18px;line-height:1.5}
</style></head><body>
  <div class="card">
    <h1>⛏️ ProspectorAI</h1>
    <p>Elige tu dispositivo para instalar</p>
    <a class="btn ios" href="/ios">📱 iPhone (Expo Go)</a>
    <a class="btn apk" href="/apk">🤖 Android (APK)</a>
    <small>En iPhone necesitas la app <b>Expo Go</b> instalada.<br>En Android, permite "orígenes desconocidos" al instalar el APK.</small>
  </div>
</body></html>`);
});

app.use((_req, res) => res.status(404).json({ error: 'Endpoint no encontrado.' }));

app.listen(PORT, () => {
  console.log(`[server-ai] Proxy de IA ProspectorAI escuchando en el puerto ${PORT}`);
});
