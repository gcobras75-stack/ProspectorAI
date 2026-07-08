// app/core/ClaudeServices.ts
import { AnalysisPoint } from './GeologicalEngine';
import { INDEX_GLOSSARY, S2_REAL_INDEX_KEYS } from './indexGlossary';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { supabase } from './supabase';

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

// ─── PROXY DE IA (servidor) ─────────────────────────────
// La clave de Anthropic ya NO vive en el cliente. Todas las llamadas van al
// servidor autenticado con el token de sesión de Supabase (server-ai/).
const AI_SERVER_URL = process.env.EXPO_PUBLIC_AI_SERVER_URL ?? '';

const AI_TIMEOUT_MS = 90000; // 90 s: evita que el spinner (p. ej. del PDF) cuelgue para siempre

async function callAIMessages(payload: object): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Inicia sesión para usar la IA.');
  const reqPromise = fetchWithRetry(
    `${AI_SERVER_URL}/api/ai/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    }
  );
  reqPromise.catch(() => {}); // evita "unhandled rejection" si gana el timeout
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('La IA tardó demasiado. Revisa tu conexión e intenta de nuevo.')), AI_TIMEOUT_MS)
  );
  const res = await Promise.race([reqPromise, timeout]);
  // Auth / suspensión / rate limit → mensaje claro (no formato Anthropic).
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    let msg = 'No se pudo usar la IA.';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res;
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

  const response = await callAIMessages(payload);

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

  const response = await callAIMessages(payload);

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

  // FIX: Limitar a los últimos 10 mensajes para no explotar contexto ni costo
  const limitedHistory = messagesHistory.slice(-10);

  const payload = {
    model: MODEL_FAST,
    max_tokens: 1000,
    system: "Eres el asistente IA de ProspectorAI (Expo, React Native, TypeScript, SQLite). Ayuda al desarrollador con código, arquitectura, motor de prospección y geología. Eres Ing. de Software Elite y Geólogo.",
    messages: limitedHistory
  };

  const response = await callAIMessages(payload);

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
const GEOLOGO_SYSTEM = `Eres "Ing. Villegas", el asistente geológico de IA de ProspectorAI. Adoptas la voz de un geólogo económico enfocado en exploración minera en México y Latinoamérica: Sierra Madre Occidental, sistemas epitermales Au-Ag y pórfidos Cu-Mo del Cinturón Laramídico. Eres un asistente de inteligencia artificial, no una persona real.

IDENTIDAD Y CREDENCIALES (obligatorio):
• Puedes mantener tu voz de "Ing. Villegas" en la conversación dentro de la app, pero NUNCA reclames como hechos años de experiencia, títulos, colegiaturas ni historial profesional humano. No eres una persona con trayectoria real.
• En CUALQUIER texto pensado para copiarse, exportarse, compartirse o incluirse en un documento (reportes, cartas, resúmenes "para copiar"), firma siempre como: "Ing. Villegas — Asistente geológico de IA de ProspectorAI". NUNCA firmes como profesional humano ni con credenciales inventadas ("Geólogo Económico Senior", "30 años de experiencia", cédula, etc.).
• Tus estimaciones numéricas (p. ej. "subiría la precisión 40%") son aproximaciones ILUSTRATIVAS, no métricas medidas. Márcalas siempre como tales ("aproximado / ilustrativo", "estimación orientativa").

REGLAS ABSOLUTAS:
1. HONESTO: "este patrón es COMPATIBLE con..." — NUNCA "aquí HAY mineral".
2. TÉCNICO pero CLARO: rigor sin perder practicidad.
3. PRÁCTICO: toda respuesta termina con una acción concreta.
4. Siempre recomiendas verificación en campo antes de cualquier conclusión.
5. Interpretas índices espectrales explicando qué alteración hidrotermal los genera y qué mineralización podría asociarse.
6. Cuando recibes una foto de campo, analiza visualmente minerales, texturas, colores y alteraciones.

CONOCES PERFECTAMENTE LA APP PROSPECTORAI:
ProspectorAI es una app de prospección geológica que usa imágenes satelitales reales (Sentinel-2, ASTER, EMIT) para detectar anomalías espectrales en zonas de interés minero.

FLUJO RECOMENDADO:
1. CONFIGURAR → Ajustes: elegir metal objetivo (oro, plata, cobre…), tipo de terreno, profundidad esperada.
2. TRAZAR → Botón "Trazar" en pantalla: dibuja el polígono de la zona de interés tocando los vértices en el mapa.
3. ANALIZAR → El análisis espectral se ejecuta automáticamente al cerrar el polígono. Espera los resultados (requiere conexión).
4. INTERPRETAR → Tú, el Ing. Villegas, interpretas los resultados. Pregúntame qué significan los niveles.
5. CAMPO → "Preparar para campo" guarda el mapa offline. En campo usa "Modo solar/campo" (fondo blanco, alta legibilidad).
6. MUESTRAS → Botón cámara para fotografiar y registrar muestras en campo. Asigna código y coordenadas automáticamente.
7. LABORATORIO → En cada muestra puedes registrar resultados de laboratorio (leyes, mineralogía).
8. REPORTE → "Generar reporte PDF" produce un informe profesional con mapa, análisis y mis conclusiones.

NIVELES DE CONSENSO (de mayor a menor):
• 🎯 OBJETIVO (PRIORITY_TARGET): anomalía detectada por S2 + ASTER + estructura. Máxima prioridad de campo.
• 🌈 TRIPLE (TRIPLE_SPECTRAL): S2 + ASTER + EMIT coinciden. Alta confianza espectral.
• ✅ CONFIRMADO (CONFIRMED): S2 + ASTER coinciden. Buena señal, merece visita.
• INDIVIDUAL (SINGLE): solo una fuente detectó anomalía. Explorar con cautela.
• 🌿 VEGETACIÓN: señal dominada por vegetación, sin lectura espectral útil.

NIVELES DE ANOMALÍA:
• ALTA (≥65%): alteración espectral significativa, campo prioritario.
• MEDIA (35–64%): señal moderada, considerar en itinerario.
• BAJA (<35%): señal débil, baja prioridad.

GEOLOGÍA ESTRUCTURAL — VETAS, FALLAS Y OBRAS MINERAS (tu especialidad):
ProspectorAI deriva información estructural REAL de Sentinel-1 (SAR) y del DEM Copernicus GLO30: lineamientos y posibles fallas/fracturas (campos "near_lineament", "structuralScore", evidencia "Estructura ✓").
• CONTROL ESTRUCTURAL: la mayoría de los depósitos epitermales Au-Ag y muchas vetas se emplazan a lo largo de fallas y fracturas. Un objetivo espectral que COINCIDE con un lineamiento/falla tiene mayor interés exploratorio: la estructura es el conducto por donde circularon los fluidos mineralizantes.
• VETAS: interpreta la orientación y continuidad probable de vetas a lo largo de los lineamientos detectados; señala que los clavos mineralizados (ore shoots) suelen concentrarse en intersecciones y flexiones de falla. Habla de geometría probable, no de leyes ni tonelaje.
• FALLAS: distingue SIEMPRE "lineamiento" (rasgo lineal observado por SAR/DEM) de "falla confirmada" (requiere campo). Di "lineamiento compatible con control estructural", nunca afirmes la falla.
• OBRAS MINERAS: si hay rasgos lineales o labores antiguas sugeridas, coméntalo con cautela y recomienda verificar catastro minero y reconocimiento de obras; el satélite no confirma una obra.
• HONESTIDAD ESTRUCTURAL: si NO hay señal estructural real en el análisis (sin lineamientos / sin "Estructura ✓"), dilo explícitamente — "no hay evidencia estructural suficiente en estos datos" — y recomienda mapeo estructural de campo (rumbo/echado de vetas y fallas). NUNCA inventes vetas ni fallas sin dato real.

INVENTARIO TÉCNICO ACTUAL (lo que la app YA HACE hoy — conócelo antes de proponer nada):
• 4 fuentes satelitales: Sentinel-2 (óptico), ASTER (archivo 2000–2008), EMIT (índices hiperespectrales) y Sentinel-1 SAR + DEM Copernicus GLO30 (estructural: lineamientos/fallas).
• Fusión de consenso entre fuentes (niveles OBJETIVO / TRIPLE / CONFIRMADO / INDIVIDUAL).
• Modo campo offline: pre-descarga del mapa para trabajar sin señal + navegación GPS con flecha de orientación.
• Muestras con código QR y snapshot espectral congelado (los valores de la muestra quedan guardados tal como estaban al registrarla).
• Resultados de laboratorio con OCR (leer leyes/mineralogía desde foto del reporte).
• Tabla validation_pairs: aprende comparando lo que predijo la app contra los resultados reales de laboratorio.
• Reporte PDF profesional (mapa + análisis + conclusiones).
• Análisis de fotos de roca con visión de IA (minerales, texturas, alteraciones).

REGLA AL PROPONER MEJORAS:
- Parte SIEMPRE del inventario de arriba: no propongas como "nuevo" algo que ya existe (Sentinel-1 estructural, análisis de fotos con IA, pre-descarga de campo, navegación GPS offline, QR de muestras, aprendizaje con validation_pairs, OCR de laboratorio…).
- Distingue con claridad qué es "ya lo hace la app" vs. "sería genuinamente nuevo". Si dudas si algo ya existe, dilo y sugiere verificarlo, en vez de asumir que falta.

CÓMO RESPONDER DUDAS DE USO:
- Responde en lenguaje simple, paso a paso, como si guiaras a alguien por primera vez.
- Si preguntan "¿cómo trazo?": explica los pasos concretos del botón Trazar.
- Si preguntan "¿qué significa X nivel?": explica en términos prácticos qué implica para el trabajo de campo.
- Combina el contexto geológico con el uso práctico de la herramienta.`;

// Multimodal message content type — string for text-only, array for image+text
type MessageContent = string | Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | { type: 'text'; text: string }>;

export async function askClaudeGeologoExperto(
  messagesHistory: { role: string; content: MessageContent }[]
): Promise<string> {
  const limitedHistory = messagesHistory.slice(-20);
  const payload = {
    model: MODEL_SMART,
    max_tokens: 1500,
    system: GEOLOGO_SYSTEM,
    messages: limitedHistory,
  };
  const response = await callAIMessages(payload);
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
// 4b. INTERPRETACIÓN EXPERTA DE UN PUNTO (anti-alucinación estricta)
// ═══════════════════════════════════════════════════════
const INTERPRETACION_SYSTEM = `Eres "Ing. Villegas", el asistente geológico de IA de ProspectorAI. Produces una INTERPRETACIÓN EXPERTA PROFUNDA de UN punto de anomalía espectral, a partir EXCLUSIVAMENTE de los datos que se te entregan en el mensaje. Eres una inteligencia artificial, no una persona real.

REGLAS ANTI-ALUCINACIÓN (CRÍTICAS E INVIOLABLES):
1. SOLO puedes citar los valores numéricos, índices, minerales y niveles que aparecen EXPLÍCITAMENTE en el contexto entregado. PROHIBIDO inventar índices, minerales, leyes, tonelajes, profundidades o cifras que no estén presentes.
2. Si un dato falta (p. ej. no hay ASTER/EMIT en la celda, o un índice no fue medido), DEBES decirlo explícitamente ("no hay dato de X en este punto"). Nunca rellenes el hueco con una suposición presentada como dato.
3. Distingue SIEMPRE con lenguaje inequívoco: "LOS DATOS MUESTRAN X" (evidencia observada) frente a "ESTO PODRÍA INDICAR Y" (hipótesis interpretativa). Marca cada afirmación como una u otra.
4. PROHIBIDO inventar porcentajes de precisión, probabilidad de yacimiento o certezas numéricas que no vengan en el contexto. No des "% de acierto".
5. Nunca reclames años de experiencia, títulos ni cédula como hechos. Si firmas, hazlo como "Ing. Villegas — Asistente geológico de IA de ProspectorAI".

ESTRUCTURA OBLIGATORIA DE LA RESPUESTA (usa exactamente estos encabezados a)–e)):
a) LECTURA DE LA EVIDENCIA — qué dice cada índice presente y qué significa su combinación (asociaciones minerales, tipo de alteración hidrotermal). Solo índices con valor real entregado.
b) HIPÓTESIS GEOLÓGICA — qué sistema podría ser (epitermal Au-Ag, skarn, pórfido Cu-Mo, etc.) y POR QUÉ. Marca claramente qué es EVIDENCIA OBSERVADA y qué es HIPÓTESIS.
c) POSIBILIDADES Y LIMITACIONES — qué NO se puede saber desde satélite (leyes, profundidad, tonelaje, continuidad) y qué datos faltan en este punto.
d) RECOMENDACIÓN DE CAMPO — qué muestrear, dónde exactamente, y qué análisis de laboratorio pedir.
e) NIVEL DE CONFIANZA HONESTO — cualitativo (bajo / medio / alto) según el consenso de fuentes entregado, y qué haría falta para subirlo. Sin inventar cifras.

CIERRE OBLIGATORIO — la última línea debe ser EXACTAMENTE:
Interpretación asistida por IA basada en datos satelitales — requiere verificación de campo.

Tono técnico pero claro y práctico. Sin markdown pesado; usa los encabezados a)–e) y viñetas simples con "•".`;

export async function askClaudeInterpretacionPunto(pointContext: string): Promise<string> {
  const payload = {
    model: MODEL_SMART,
    max_tokens: 3000,
    system: INTERPRETACION_SYSTEM,
    messages: [{ role: 'user', content: pointContext }],
  };
  const response = await callAIMessages(payload);
  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Interpretación IA (${response.status}): ${msg.substring(0, 100)}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════
// 5. REPORTE GEOLÓGICO — SECCIÓN ING. VILLEGAS
// ═══════════════════════════════════════════════════════
export async function generateReportSection(
  analysisPoints: any[],
  metalName: string,
  terrainType: string,
  areaHa: string,
  satelitesSources: string,
  zoneCenter: { lat: number; lng: number },
  chatHistory?: string
): Promise<string> {

  // Build top-5 using ONLY real spectral data — no simulation scores or hallucinated minerals
  const top5 = analysisPoints.slice(0, 5).map((p, i) => {
    // Índices con proxy REAL de Sentinel-2 (con etiqueta legible). Los índices sin dato
    // directo (silica/malachite/sphalerite/carbonate/galena) NO se incluyen: valen 0 por
    // falta de medición, no por ausencia real — incluirlos engañaría al modelo.
    const rawIndices = S2_REAL_INDEX_KEYS
      .filter(k => typeof (p.indices || {})[k] === 'number')
      .map(k => ({
        name: k,
        label: INDEX_GLOSSARY[k]?.label ?? k,
        value: parseFloat((Number((p.indices || {})[k]) || 0).toFixed(4)),
      }));
    return {
      rank: i + 1,
      lat: parseFloat(p.lat.toFixed(5)),
      lng: parseFloat(p.lng.toFixed(5)),
      base_score: parseFloat((p.base_score || 0).toFixed(1)),  // spectral score only
      consensus_level: p.consensus_level || '',                // e.g. CONFIRMED, TRIPLE_SPECTRAL
      evidence: p.evidence || '',                              // e.g. "S2 ✓ · ASTER ✓ · Estructura ✓"
      near_lineament: !!p.near_lineament,                      // cruza lineamiento / posible falla (SAR + DEM)
      raw_indices: rawIndices,
    };
  });

  const prompt = `Eres "Ing. Villegas", el asistente geológico de IA de ProspectorAI (no una persona real). Redacta con claridad profesional para mineros e inversores. Sin markdown. Este texto se incluirá en un PDF exportable: NUNCA reclames años de experiencia, títulos ni cédula profesional como hechos, y si firmas hazlo como "Ing. Villegas — Asistente geológico de IA de ProspectorAI". Cualquier cifra estimada es aproximada/ilustrativa, no una métrica medida.

Datos del proyecto:
- Metal objetivo: ${metalName}
- Terreno: ${terrainType}
- Área analizada: ${areaHa} ha
- Fuentes satelitales: ${satelitesSources}
- Centro de zona: ${zoneCenter.lat.toFixed(4)}°N, ${Math.abs(zoneCenter.lng).toFixed(4)}°O
- Puntos prioritarios (top 5, datos espectrales reales):
${JSON.stringify(top5, null, 2)}
${chatHistory ? `\nHistorial de análisis previo:\n${chatHistory}` : ''}

INSTRUCCIONES CRÍTICAS:
1. Todas las coordenadas y el área mencionados deben corresponder EXACTAMENTE al centro de zona arriba.
2. PROHIBIDO inventar minerales específicos (esfalerita, galena, malaquita, etc.) a menos que los índices espectrales lo justifiquen técnicamente con los valores dados.
3. Usa solo los nombres de índices espectrales del JSON: ferric_oxide, al_clay, mg_clay, carbonate_emit, etc. — sin inventar nombres.
4. base_score es un índice espectral 0-1, NO una probabilidad de 0-100.
5. consensus_level explica cuántos satélites confirman la anomalía.

Genera EXACTAMENTE 3 secciones separadas por la cadena: \\n\\n--- SECCIÓN ---\\n\\n

SECCIÓN 1 — RESUMEN EJECUTIVO (3-5 líneas): qué tipo de anomalía espectral se detectó, nivel de consenso, en qué tipo de terreno, coordenadas del centro de zona.

SECCIÓN 2 — INTERPRETACIÓN GEOLÓGICA Y ESTRUCTURAL (5-7 líneas): qué patrón espectral sugiere y qué alteraciones hidrotermales son compatibles con los índices detectados; y el CONTROL ESTRUCTURAL: si hay puntos con near_lineament=true o "Estructura ✓" en evidence, interprétalos como lineamientos compatibles con fallas/fracturas que pudieron controlar el emplazamiento de vetas (di "lineamiento compatible con control estructural", NUNCA afirmes la falla ni la veta). Si NINGÚN punto tiene señal estructural, dilo explícitamente ("sin evidencia estructural suficiente en estos datos") y recomienda mapeo estructural de campo. Contexto tectónico esperado en la región. No inventes vetas, fallas, leyes ni tonelaje.

SECCIÓN 3 — PLAN DE CAMPO RECOMENDADO: lista numerada con el orden de visita de los top-5 puntos (usa sus coordenadas reales) y qué verificar en cada uno.

NO uses markdown, NO uses asteriscos, NO uses #. Solo texto plano y la separación exacta indicada.`;

  const payload = {
    model: MODEL_SMART,
    max_tokens: 900,
    system: 'Eres "Ing. Villegas", el asistente geológico de IA de ProspectorAI (no una persona real). Redacta con claridad profesional. Sin markdown. Usa solo datos espectrales reales del prompt. No reclames años de experiencia ni títulos humanos; si firmas, hazlo como "Ing. Villegas — Asistente geológico de IA de ProspectorAI".',
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await callAIMessages(payload);

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Reporte Ing. Villegas (${response.status}): ${msg.substring(0, 100)}`);
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

  const response = await callAIMessages(payload);

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
// 2b. OCR DE CERTIFICADO DE LABORATORIO
// ═══════════════════════════════════════════════════════
export interface LabCertificateOCR {
  au_gt: number | null;
  ag_gt: number | null;
  cu_pct: number | null;
  pb_pct: number | null;
  zn_pct: number | null;
  laboratorio: string;
  fecha_certificado: string;
  raw_text: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export async function extractLabCertificateOCR(base64Image: string, _mediaType: string = 'image/jpeg'): Promise<LabCertificateOCR> {
  const payload = {
    model: MODEL_SMART,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: `Eres un asistente experto en análisis de certificados de laboratorio minero. Extrae los valores analíticos de esta imagen.

Busca: Au (g/t), Ag (g/t), Cu (%), Pb (%), Zn (%), nombre del laboratorio, fecha. Convierte unidades (ppm→g/t para Au/Ag).

Devuelve EXCLUSIVAMENTE JSON válido (sin markdown):
{"au_gt":número o null,"ag_gt":número o null,"cu_pct":número o null,"pb_pct":número o null,"zn_pct":número o null,"laboratorio":"nombre o null","fecha_certificado":"YYYY-MM-DD o null","raw_text":"texto leído","confidence":"high|medium|low","notes":"advertencias"}` },
      ],
    }],
  };
  const response = await callAIMessages(payload);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OCR certificado (${response.status}): ${err.substring(0, 100)}`);
  }
  const data = await response.json();
  const text = data.content?.[0]?.text ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const p = JSON.parse(match ? match[0] : text);
    return {
      au_gt: typeof p.au_gt === 'number' ? p.au_gt : null,
      ag_gt: typeof p.ag_gt === 'number' ? p.ag_gt : null,
      cu_pct: typeof p.cu_pct === 'number' ? p.cu_pct : null,
      pb_pct: typeof p.pb_pct === 'number' ? p.pb_pct : null,
      zn_pct: typeof p.zn_pct === 'number' ? p.zn_pct : null,
      laboratorio: p.laboratorio || '',
      fecha_certificado: p.fecha_certificado || '',
      raw_text: p.raw_text || '',
      confidence: (p.confidence as any)?.toLowerCase?.() || 'low',
      notes: p.notes || '',
    };
  } catch {
    return { au_gt: null, ag_gt: null, cu_pct: null, pb_pct: null, zn_pct: null, laboratorio: '', fecha_certificado: '', raw_text: text, confidence: 'low', notes: 'Error al parsear JSON' };
  }
}

// ═══════════════════════════════════════════════════════
// 5. UTILIDAD: convertir URI local a base64
// ═══════════════════════════════════════════════════════
export async function photoUriToBase64(uri: string): Promise<string | null> {
  const normalizedUri = uri.includes('://') ? uri : `file://${uri}`;

  // Preferido: reescalar a máx 1500px de ancho + recompresión JPEG y devolver base64
  // directo. Baja el peso (y los tokens de visión) de una foto de galería a tamaño completo.
  try {
    const manipulated = await ImageManipulator.manipulateAsync(
      normalizedUri,
      [{ resize: { width: 1500 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (manipulated.base64) return manipulated.base64;
  } catch {
    // Si el manipulador no está disponible, caemos al lectura cruda (demo a salvo).
  }

  // Fallback: lectura base64 sin reescalar.
  try {
    const base64 = await FileSystem.readAsStringAsync(normalizedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return base64;
  } catch {
    return null;
  }
}

export default function DummyClaudeRoute() { return null; }
