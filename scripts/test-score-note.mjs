// Guardia: todo archivo que muestra un score/porcentaje debe llevar la frase fija (SCORE_NOTE)
// y ninguno debe elegir el número a mano. Correr: node --test scripts/test-score-note.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SITES = [
  'app/components/SelectedPointModal.tsx', 'app/components/TapPanel.tsx', 'app/components/ResultsPanel.tsx',
  'app/components/ScoreCard.tsx', 'app/components/SampleDetailModal.tsx', 'app/(tabs)/proyectos.tsx',
  'app/(tabs)/index.tsx', 'web-lib/LeafletMap.tsx', 'app/core/ReportGenerator.ts', 'app/core/excelExport.ts',
];
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('la frase fija tiene el texto acordado', () => {
  const src = read('app/core/scoreNote.ts');
  assert.match(src, /Señal de evidencia satelital · no es probabilidad de hallazgo\. Compárala solo con otros puntos de tu misma zona\./);
});
for (const f of SITES) {
  test(`${f} muestra SCORE_NOTE`, () => {
    const src = read(f);
    assert.match(src, /import \{ SCORE_NOTE \} from/);
    assert.ok((src.match(/SCORE_NOTE/g) || []).length >= 2, 'importada y usada');
  });
}
test('nadie elige el número a mano (score || base_score)', () => {
  for (const f of SITES) {
    assert.doesNotMatch(read(f), /\.score\s*(\|\||\?\?)\s*\w+\.base_score|\.base_score\s*(\|\||\?\?)\s*\w+\.score/, f);
  }
});
