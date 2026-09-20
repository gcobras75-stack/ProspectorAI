/**
 * geeAuth.ts — identidad por usuario ante el servidor GEE (prospector-gee-server).
 *
 * Las rutas de minería del servidor (/api/mining, /api/structural, /api/emit, /api/zone) pueden exigir
 * el JWT de la sesión de Supabase (`Authorization: Bearer <access_token>`), que el servidor verifica
 * localmente. Sin secretos en el cliente: es el token de sesión del propio usuario.
 *
 * Con el servidor en modo `off`/`warn` (hoy) la cabecera se ignora, así que mandarla es inocuo.
 * Si NO hay sesión, o falla la lectura, no se manda nada y la petición sale exactamente como antes.
 * La usan SatelliteEngine y ReportGenerator (nativa y PWA comparten este archivo).
 */
import { supabase } from './supabase';

// getSession() puede tener que refrescar el token (red). Un análisis no debe colgarse por eso.
const SESSION_TIMEOUT_MS = 4000;

export async function geeAuthHeaders(): Promise<Record<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await Promise.race([
      supabase.auth.getSession().then((r) => r.data.session),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SESSION_TIMEOUT_MS); }),
    ]);
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}
