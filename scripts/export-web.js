/**
 * export-web.js — build de la PWA:  node scripts/export-web.js
 *
 * 1) `expo export -p web` con PROSPECTOR_WEB=1 (raíz del router = app-web/, ver app.config.js
 *    y metro.config.js) hacia dist-web/.
 * 2) Parchea dist-web/index.html: con `output: single` Expo usa una plantilla fija e ignora
 *    +html.tsx, así que aquí se inyectan manifest, iconos de iOS, viewport-fit=cover,
 *    colores de barra y el CSS de Leaflet. Falla si una sustitución no encuentra su ancla
 *    (para enterarse si Expo cambia la plantilla).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = 'dist-web';

const r = spawnSync('npx', ['expo', 'export', '-p', 'web', '--output-dir', out, '--clear'], {
  cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, PROSPECTOR_WEB: '1' },
});
if (r.status !== 0) process.exit(r.status || 1);

const file = path.join(root, out, 'index.html');
let html = fs.readFileSync(file, 'utf8');

function replaceOnce(from, to, what) {
  if (!html.includes(from)) throw new Error(`export-web: no se encontró ${what} en index.html (¿cambió la plantilla de Expo?)`);
  html = html.replace(from, to);
}

replaceOnce('<html lang="en">', '<html lang="es">', '<html lang>');
replaceOnce(
  '<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, shrink-to-fit=no" />',
  'meta viewport',
);
replaceOnce('<title>ProspectorAI</title>', '<title>ProspectorAI</title>\n    <meta name="description" content="Dibuja zonas, corre análisis satelitales, consulta tus proyectos y chatea con el Ing. Villegas." />', '<title>');
replaceOnce(
  '</head>',
  [
    '<link rel="manifest" href="/manifest.json" />',
    '<meta name="theme-color" content="#000000" />',
    '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="Prospector" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
    '<link rel="stylesheet" href="/vendor/leaflet.css" />',
    '<link rel="stylesheet" href="/vendor/leaflet-geoman.css" />',
    '<link rel="stylesheet" href="/vendor/pwa-map.css" />',
    '<style>html,body{background:#000;overscroll-behavior:none}</style>',
    '</head>',
  ].join('\n  '),
  '</head>',
);

fs.writeFileSync(file, html);
console.log('export-web: index.html parcheado (manifest, iOS, leaflet.css).');
