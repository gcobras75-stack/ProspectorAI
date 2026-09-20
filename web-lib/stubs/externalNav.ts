/**
 * Stub web de app/core/externalNav.ts (ver metro.config.js). La versión nativa detecta apps
 * de mapas instaladas y pregunta con Alert.alert (no-op en react-native-web). En web se abre
 * el enlace universal de Google Maps: en iOS/Android abre la app de mapas si está instalada.
 */
export async function openExternalNavigation(lat: number, lng: number, _label?: string): Promise<void> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank', 'noopener,noreferrer');
}
