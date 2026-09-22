/**
 * confirmAction.ts — el ÚNICO diálogo de confirmación de acciones destructivas de la PWA.
 *
 * Repaso de consistencia (2026-09-21): las 5 pantallas habían ido inventando su propio `window.confirm`
 * suelto, cada una con su redacción. Esta función es la única forma correcta de confirmar algo en la PWA:
 * siempre "¿Pregunta corta? Consecuencia en una frase.", siempre tuteo, nunca un texto genérico como
 * "¿Estás seguro?" que no dice qué se pierde.
 *
 * `question` es la pregunta ("¿Cerrar tu sesión?"); `consequence` dice QUÉ se pierde en una frase corta
 * ("Se borrará el chat guardado en este navegador."). Las dos son obligatorias: una confirmación sin decir
 * la consecuencia no sirve para nada.
 */
export function confirmAction(question: string, consequence: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true; // sin diálogo posible: no bloquea
  return window.confirm(`${question} ${consequence}`);
}
