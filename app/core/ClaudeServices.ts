// app/core/ClaudeServices.ts
import { AnalysisPoint } from './GeologicalEngine';
import * as FileSystem from 'expo-file-system/legacy';

// ─── MODELOS ───────────────────────────────────────────
const MODEL_FAST   = 'claude-haiku-4-5-20251001';   // Cámara y chat
const MODEL_SMART  = 'claude-sonnet-4-6';            // Análisis espectral

// ─── RETRY CON BACKOFF EXPONENCIAL ─────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return response;
    } catch (e: any) {
      lastError = e;
      const waitMs = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

// ─── HEADERS COMUNES ───────────────────────────────────
function getHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

// ─── VALIDAR API KEY ────────────────────────────────────
function getApiKey(): string {
  const key = process.env.EXPO_PUBLIC_CLAUDE_API_KEY?.trim();
  if (!key) throw new Error('Configura EXPO_PUBLIC_CLAUDE_API_KEY en tu .env');
  return key;
}

// ═══════════════════════════════════════════════════════
// 1. ANÁLISIS DE IMAGEN DE ROCA
// ═══════════════════════════════════════════════════════
export interface ClaudeAnalysis {
  mineral_detectado: string;
  probabilidad: number;
  indicadores: string[];
  alteracion: string;
  fluorescencia_uv: string;
  recomendacion: string;
  analisis_detallado: string;
}

export async function analyzeRockImageWithClaude(
  base64Image: string,
  captureType: string
): Promise<ClaudeAnalysis> {
  const API_KEY = getApiKey();

  let promptContext = "Muestra de campo estándar capturada con cámara normal de smartphone.";
  if (captureType === 'microscopio') {
    promptContext = "Imagen macro capturada con microscopio de alta magnificación. Busca cristales micrométricos, texturas finas y estructuras internas críticas.";
  } else if (captureType.startsWith('uv_')) {
    promptContext = `Imagen bajo iluminación UV tipo ${captureType}. Analiza patrones de fluorescencia espectral (Tungsteno, Fluorita, Scheelita, Calcita, Uranio secundario).`;
  }

  const payload = {
    model: MODEL_FAST,
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: base64Image }
        },
        {
          type: "text",
          text: `Actúa como el mejor geólogo del mundo experto en alteraciones y metalogenia. Analiza visualmente esta muestra. ${promptContext}

Identifica el metal o mineral evaluando texturas, alteraciones y colores. Sé definitivo y preciso.

Devuelve EXCLUSIVAMENTE JSON válido (sin markdown):
{
  "mineral_detectado": "Ej. Cuarzo aurífero con arsenopirita",
  "probabilidad": 85,
  "indicadores": ["textura en peineta", "fuerte lixiviación"],
  "alteracion": "Ej. Argílica avanzada",
  "fluorescencia_uv": "N/A o describe color y mineral bajo UV",
  "analisis_detallado": "Explicación técnica de las paragénesis observadas.",
  "recomendacion": "Acción directa de campo. Ej: 🔴 Muestreo sistemático de canal."
}`
        }
      ]
    }]
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Anthropic (${response.status}): ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '';
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (parseErr) {
      throw new Error('Error al parsear JSON de la IA. Respuesta: ' + content.substring(0, 120));
    }
  }

  throw new Error('La IA no devolvió un JSON válido. Respuesta recibida: ' + (content.substring(0, 120) || '(vacía)'));
}

// ═══════════════════════════════════════════════════════
// 2. ANÁLISIS ESPECTRAL POR LOTE (usa Sonnet - más inteligente)
// ═══════════════════════════════════════════════════════
export interface IndiceAnalizado {
  nombre: string;
  valor: number;
  nivel: 'ALTO' | 'MEDIO' | 'BAJO';
  interpretacion: string;
}

export interface SpectralAnalysisResult {
  id: string;
  score: number;
  indices_analizados: IndiceAnalizado[];
  analisis_integral: string;
  geologia_interpretada: string;
  recomendacion: string;
}

export async function analyzeSpectralCandidatesBatch(
  candidates: AnalysisPoint[],
  mineral: string,
  terrain: string,
  rockType: string
): Promise<SpectralAnalysisResult[]> {
  const API_KEY = getApiKey();

  const candidatesData = candidates.map(c => ({
    id: c.id, rank: c.rank, base_score: c.base_score, indices: c.indices
  }));

  const prompt = `Eres un Geólogo Principal experto en exploración de recursos minerales.
Analiza índices espectrales de ${candidates.length} puntos candidatos.
Mineral objetivo: ${mineral.toUpperCase()}
Contexto: Terreno "${terrain}", roca dominante "${rockType}".

Interpreta los valores como anomalías espectrales reales de satélites hiperespectrales.
Genera análisis PROFESIONAL y ESPECÍFICO basado en los valores numéricos.

Datos:
${JSON.stringify(candidatesData, null, 2)}

Devuelve EXCLUSIVAMENTE un arreglo JSON válido (sin markdown):
[
  {
    "id": "MISMO_ID_DEL_CANDIDATO",
    "score": 98,
    "indices_analizados": [
      {
        "nombre": "Gossan",
        "valor": 0.87,
        "nivel": "ALTO",
        "interpretacion": "Oxidación intensa, sombrero de hierro sobre veta"
      }
    ],
    "analisis_integral": "Explicación técnica con datos numéricos del porqué indica el mineral.",
    "geologia_interpretada": "Modelo geológico proyectado (ej. Zona epitermal con vetas de cuarzo).",
    "recomendacion": "ACCIÓN ESPECÍFICA. Ej: 🔴 MUESTREO URGENTE - Tomar muestra en afloramiento."
  }
]`;

  const payload = {
    model: MODEL_SMART,   // Sonnet para análisis complejo
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) throw new Error('Fallo al conectar con Claude Sonnet.');

  const data = await response.json();
  const content = data.content?.[0]?.text || '';
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return [];
}

// ═══════════════════════════════════════════════════════
// 3. CHAT GEÓLOGO (historial limitado a últimos 10)
// ═══════════════════════════════════════════════════════
export async function askClaudeGeologist(
  messagesHistory: { role: string; content: string }[]
): Promise<string> {
  const API_KEY = getApiKey();

  // FIX: Limitar a los últimos 10 mensajes para no explotar contexto ni costo
  const limitedHistory = messagesHistory.slice(-10);

  const payload = {
    model: MODEL_FAST,
    max_tokens: 1000,
    system: "Eres el asistente IA de ProspectorAI (Expo, React Native, TypeScript, SQLite). Ayuda al desarrollador con código, arquitectura, motor de prospección y geología. Eres Ing. de Software Elite y Geólogo.",
    messages: limitedHistory
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Anthropic: ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════
// 4. CHAT GEÓLOGO EXPERTO (sistema epitermal Au-Ag México)
// ═══════════════════════════════════════════════════════
const GEOLOGO_SYSTEM = `Eres el Dr. Marco Ruiz, geólogo económico senior con 30 años de experiencia en exploración minera en México y Latinoamérica.
Especialista en: Sierra Madre Occidental, sistemas epitermales de baja sulfuración Au-Ag, pórfidos Cu-Mo del Cinturón Laramídico.
Usas ProspectorAI con datos reales de Sentinel-2 y ASTER para interpretar anomalías espectrales.

REGLAS ABSOLUTAS:
1. HONESTO: Siempre "este patrón es COMPATIBLE con..." — NUNCA "aquí HAY mineral".
2. TÉCNICO pero CLARO: sin jerga innecesaria, rigor sin perder practicidad.
3. PRÁCTICO: toda respuesta termina con una acción de campo concreta.
4. Siempre recomiendas verificación en campo antes de cualquier conclusión.
5. Cuando interpretas índices espectrales: explica qué alteración hidrotermal los genera y qué mineralización podría asociarse.
6. Cuando recibes una foto de campo, analiza visualmente los minerales, texturas, colores y alteraciones visibles.`;

// Multimodal message content type — string for text-only, array for image+text
type MessageContent = string | Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | { type: 'text'; text: string }>;

export async function askClaudeGeologoExperto(
  messagesHistory: { role: string; content: MessageContent }[]
): Promise<string> {
  const API_KEY = getApiKey();
  const limitedHistory = messagesHistory.slice(-20);
  const payload = {
    model: MODEL_SMART,
    max_tokens: 1500,
    system: GEOLOGO_SYSTEM,
    messages: limitedHistory,
  };
  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );
  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Geólogo IA (${response.status}): ${msg.substring(0, 100)}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════
// 5. REPORTE GEOLÓGICO — SECCIÓN DR. RUIZ
// ═══════════════════════════════════════════════════════
export async function generateReportSection(
  analysisPoints: any[],
  metalName: string,
  terrainType: string,
  areaHa: string,
  satelitesSources: string,
  chatHistory?: string
): Promise<string> {
  const API_KEY = getApiKey();

  const top5 = analysisPoints.slice(0, 5).map((p, i) => ({
    rank: i + 1,
    lat: p.lat,
    lng: p.lng,
    score: p.score || p.base_score || 0,
    analisis: p.analisis_integral || p.geologia_interpretada || '',
    indices: p.indices_analizados || p.indices || [],
  }));

  const prompt = `Eres Dr. Marco Ruiz, geólogo explorador. Redacta con claridad profesional para mineros e inversores. Sé concreto. Sin markdown.

Datos del proyecto:
- Metal objetivo: ${metalName}
- Terreno: ${terrainType}
- Área analizada: ${areaHa} ha
- Fuentes satelitales: ${satelitesSources}
- Puntos prioritarios (top 5):
${JSON.stringify(top5, null, 2)}
${chatHistory ? `\nHistorial de análisis previo:\n${chatHistory}` : ''}

Genera EXACTAMENTE 3 secciones separadas por la cadena: \\n\\n--- SECCIÓN ---\\n\\n

SECCIÓN 1 — RESUMEN EJECUTIVO (3-5 líneas): qué se encontró, nivel de anomalía, qué metal y en qué tipo de terreno.

SECCIÓN 2 — INTERPRETACIÓN GEOLÓGICA (4-6 líneas): qué patrón espectral y estructural sugiere, minerales guía, contexto tectónico esperado.

SECCIÓN 3 — PLAN DE CAMPO RECOMENDADO: lista numerada con el orden de visita de los top-5 puntos y qué muestrear en cada uno.

NO uses markdown, NO uses asteriscos, NO uses encabezados con #. Solo texto plano y la separación exacta indicada.`;

  const payload = {
    model: MODEL_SMART,
    max_tokens: 800,
    system: 'Eres Dr. Marco Ruiz, geólogo explorador. Redacta con claridad profesional para mineros e inversores. Sé concreto. Sin markdown.',
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Reporte Dr. Ruiz (${response.status}): ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════
// 6. RESEÑA DE FOTO DE MUESTRA DE CAMPO
// ═══════════════════════════════════════════════════════
export async function generateSampleResena(
  fotoBase64: string,
  analisisTexto: string,
  anomalyLevel: string,
  coordText: string
): Promise<string> {
  const API_KEY = getApiKey();

  const payload = {
    model: MODEL_FAST,
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: fotoBase64 },
        },
        {
          type: 'text',
          text: `Describe en 2-3 líneas qué se observa en esta roca/muestra de campo y su relación con la anomalía satelital ${anomalyLevel} detectada en las coordenadas ${coordText}. Análisis previo: ${analisisTexto}. Responde en español, sin markdown.`,
        },
      ],
    }],
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Reseña muestra (${response.status}): ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════
// 5. UTILIDAD: convertir URI local a base64
// ═══════════════════════════════════════════════════════
export async function photoUriToBase64(uri: string): Promise<string | null> {
  try {
    const normalizedUri = uri.startsWith('file://') ? uri : `file://${uri}`;
    const base64 = await FileSystem.readAsStringAsync(normalizedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return base64;
  } catch {
    return null;
  }
}

export default function DummyClaudeRoute() { return null; }
