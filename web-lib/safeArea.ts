/**
 * safeArea.ts — márgenes de seguridad de iOS (barra de estado / Dynamic Island / indicador de inicio).
 *
 * El HTML declara `viewport-fit=cover` (scripts/export-web.js), así que Safari dibuja la página DEBAJO de la
 * barra de estado y del indicador de inicio: sin estos márgenes, lo que quede pegado arriba o abajo se tapa.
 * `env()` vale 0 fuera de iOS/notch, y en modo instalado con barra de estado opaca, así que nunca estorba.
 *
 * Arriba lo resuelve UNA vez el layout raíz (app-web/_layout.tsx) para todas las pantallas. Abajo, la barra de
 * pestañas ya suma el inset por sí sola; las pantallas SIN pestañas (detalle, Nuevo análisis) usan bottomPad().
 */
export const SAFE_TOP = 'env(safe-area-inset-top, 0px)';
export const SAFE_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

/** paddingBottom que suma el inset inferior a un relleno base (react-native-web acepta el string CSS). */
export const bottomPad = (px: number): any => `calc(${px}px + ${SAFE_BOTTOM})`;
