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
