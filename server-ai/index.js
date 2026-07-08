'use strict';
/**
 * server-ai — Proxy de IA autenticado para ProspectorAI (servicio independiente).
 *
 * NO tiene nada de GEE/AgroCrop. Solo:
 *   GET  /health          → status
 *   POST /api/ai/chat     → valida token Supabase → rate limit → Anthropic
 *
 * Variables de entorno (se configuran en Railway, nunca en el cliente):
 *   ANTHROPIC_API_KEY          — clave del servidor (NUEVA, no la vieja expuesta)
 *   SUPABASE_URL               — https://kjprkyuaghzwjatcjnyx.supabase.co
 *   SUPABASE_ANON_KEY          — anon (pública), para validar el token de usuario
 *   SUPABASE_SERVICE_ROLE_KEY  — secreta, para leer profile + rate limit RPC
 *   AI_DAILY_LIMIT             — opcional, default 50 (admins nunca se bloquean)
 *   ALLOWED_ORIGINS            — opcional, CSV de orígenes CORS (default: *)
 *   PORT                       — lo inyecta Railway
 */
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const SUPABASE_URL              = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY || '';
const AI_DAILY_LIMIT            = parseInt(process.env.AI_DAILY_LIMIT || '50', 10);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : '*';

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'OPTIONS'] }));
// Las consultas de IA pueden traer imágenes en base64 (foto de roca / chat) → límite alto.
app.use(express.json({ limit: '25mb' }));

// ── Helpers Supabase ─────────────────────────────────────────────────────────
async function supabaseUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

async function supabaseProfile(uid) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role,active,deleted`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function checkAiUsage(uid, max) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_increment_ai_usage`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user: uid, p_max: max }),
    });
    if (!r.ok) return true; // si el rate limit falla, no bloquees la IA
    return await r.json();   // boolean
  } catch { return true; }
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

    if (!isAdmin) {
      const allowed = await checkAiUsage(user.id, AI_DAILY_LIMIT);
      if (allowed === false) {
        return res.status(429).json({ error: `Alcanzaste el límite diario de IA (${AI_DAILY_LIMIT} consultas/día). Vuelve mañana.` });
      }
    }

    const { model, max_tokens, system, messages } = req.body || {};
    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Payload inválido: se requieren model y messages.' });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });
    const body = await anthropicRes.text();
    res.status(anthropicRes.status).type('application/json').send(body);
  } catch (err) {
    console.error('[/api/ai/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Endpoint no encontrado.' }));

app.listen(PORT, () => {
  console.log(`[server-ai] Proxy de IA ProspectorAI escuchando en el puerto ${PORT}`);
});
