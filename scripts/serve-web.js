// Servidor local de dist-web/ que aplica los MISMOS rewrites y cabeceras de dist-web/vercel.json (CSP incluida), para probar la PWA
// como la verá Vercel. Uso: node scripts/serve-web.js [puerto=8099] [carpeta=dist-web]
// Variable CSP_OVERRIDE (opcional): sustituye el valor de Content-Security-Policy (para controles negativos de las pruebas).
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 8099);
const root = path.resolve(process.argv[3] || 'dist-web');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

// Solo los patrones que usa vercel.json: "/(.*)", rutas exactas y "/prefijo/(.*)".
const toRe = (src) => new RegExp('^' + src.split('(.*)').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const headerRules = (cfg.headers || []).map((h) => ({ re: toRe(h.source), headers: h.headers }));
const rewrite = (cfg.rewrites || [])[0] && { re: new RegExp('^' + cfg.rewrites[0].source + '$'), to: cfg.rewrites[0].destination };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const h = {};
  for (const r of headerRules) if (r.re.test(p)) for (const { key, value } of r.headers) h[key] = key === 'Content-Security-Policy' && process.env.CSP_OVERRIDE ? process.env.CSP_OVERRIDE : value;
  let file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (rewrite && rewrite.re.test(p)) file = path.join(root, rewrite.to); else { res.writeHead(404, h); return res.end('404'); }
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': h['Content-Type'] || MIME[ext] || 'application/octet-stream', ...h });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`dist-web en http://localhost:${port} (cabeceras de vercel.json)`));
