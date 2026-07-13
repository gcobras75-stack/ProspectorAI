/**
 * externalNav.ts — "Cómo llegar": abre la navegación en una app de mapas externa.
 *
 * COMPLEMENTARIO al GPS interno de ProspectorAI, no lo sustituye:
 *   · mapas externos  → para llegar EN VEHÍCULO hasta la zona (hay carretera),
 *   · GPS interno     → para el último tramo a pie, donde ya no hay camino.
 *
 * Detección: Linking.canOpenURL solo es fiable si el esquema está declarado en el
 * manifiesto nativo (LSApplicationQueriesSchemes en iOS, <queries> en Android 11+).
 * Como esa declaración es config NATIVA y no viaja en un OTA, la detección puede
 * devolver "no instalada" aunque la app sí lo esté. Por eso:
 *   1) si la detección encuentra apps, se ofrecen esas;
 *   2) si no encuentra ninguna, se ofrecen todas igualmente y se confía en el
 *      fallback: si abrir la app falla, se cae al navegador.
 * Así el usuario nunca se queda sin forma de llegar al punto.
 */
import { Alert, Linking, Platform } from 'react-native';

interface NavApp {
  id: string;
  label: string;
  scheme: string;
  /** Deep link con destino y modo "cómo llegar" (conducción). */
  url: (lat: number, lng: number) => string;
  iosOnly?: boolean;
}

const NAV_APPS: NavApp[] = [
  {
    id: 'google',
    label: 'Google Maps',
    scheme: 'comgooglemaps://',
    url: (lat, lng) => `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`,
  },
  {
    id: 'waze',
    label: 'Waze',
    scheme: 'waze://',
    url: (lat, lng) => `waze://?ll=${lat},${lng}&navigate=yes`,
  },
  {
    id: 'apple',
    label: 'Apple Maps',
    scheme: 'maps://',
    url: (lat, lng) => `maps://?daddr=${lat},${lng}&dirflg=d`,
    iosOnly: true,
  },
];

/** Fallback universal: Google Maps en el navegador. No requiere ninguna app. */
const webUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

/** Abre `url`; si la app no responde, cae al navegador. Nunca lanza. */
async function openOrFallback(url: string, lat: number, lng: number): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch (_) {
    try {
      await Linking.openURL(webUrl(lat, lng));
    } catch (_e) {
      Alert.alert('Cómo llegar', 'No se pudo abrir ninguna aplicación de mapas.');
    }
  }
}

/**
 * Ofrece las apps de navegación disponibles hacia (lat, lng) y abre la elegida.
 * `label` solo se usa para el título del diálogo.
 */
export async function openExternalNavigation(
  lat: number,
  lng: number,
  label?: string
): Promise<void> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    Alert.alert('Cómo llegar', 'Este punto no tiene coordenadas válidas.');
    return;
  }

  const candidates = NAV_APPS.filter(a => !a.iosOnly || Platform.OS === 'ios');

  const detected: NavApp[] = [];
  for (const app of candidates) {
    try {
      if (await Linking.canOpenURL(app.scheme)) detected.push(app);
    } catch (_) { /* la detección no es fiable sin config nativa; se ignora */ }
  }

  // Si la detección no encontró nada, no asumimos que no hay apps: ofrecemos todas
  // y dejamos que el fallback resuelva si alguna no está instalada.
  const options = detected.length > 0 ? detected : candidates;

  Alert.alert(
    'Cómo llegar',
    label
      ? `Navegar hasta ${label}\n${lat.toFixed(5)}, ${lng.toFixed(5)}`
      : `Navegar hasta ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    [
      ...options.map(app => ({
        text: app.label,
        onPress: () => { void openOrFallback(app.url(lat, lng), lat, lng); },
      })),
      {
        text: 'Abrir en el navegador',
        onPress: () => { void openOrFallback(webUrl(lat, lng), lat, lng); },
      },
      { text: 'Cancelar', style: 'cancel' as const },
    ],
    { cancelable: true }
  );
}
