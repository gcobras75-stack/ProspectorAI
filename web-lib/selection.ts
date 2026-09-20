/**
 * selection.ts — proyecto elegido en la PWA, compartido entre las pestañas.
 * Vive en memoria (fuente de verdad) y se respalda en localStorage por conveniencia
 * (recordar la elección al reabrir). Todo acceso a storage va en try/catch.
 */
const KEY = 'pwa.selectedProjectId';
let current: string | null = null;

export function getSelectedProjectId(): string | null {
  if (current) return current;
  try { current = window.localStorage.getItem(KEY); } catch { /* storage bloqueado */ }
  return current;
}

export function setSelectedProjectId(id: string | null): void {
  current = id;
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch { /* storage bloqueado */ }
}

// ── Interpretación de un punto pendiente (ResultsPanel → pestaña Geólogo) ────────────────
// Solo en memoria y de un solo uso: el detalle del proyecto la deja aquí, cambia de pestaña y
// el chat la toma al enfocarse. Contiene los datos reales del punto (no es un prompt).
let pendingInterpretation: string | null = null;

export function setPendingInterpretation(ctx: string | null): void { pendingInterpretation = ctx; }

export function takePendingInterpretation(): string | null {
  const c = pendingInterpretation;
  pendingInterpretation = null;
  return c;
}
