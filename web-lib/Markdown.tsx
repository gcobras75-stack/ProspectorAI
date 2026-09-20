/**
 * Markdown.tsx — render de markdown para las respuestas del Ing. Villegas (solo web).
 *
 * react-markdown + remark-gfm (tablas, tachado). SEGURO por diseño: no se habilita HTML
 * crudo (sin rehype-raw), así que un texto del modelo no puede inyectar etiquetas; los
 * enlaces pasan por el filtro de URL por defecto y abren en pestaña nueva con noopener.
 * Los estilos son inline para el tema oscuro de la app.
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const GOLD = '#FFD700';
const TEXT = '#EEEEEE';
const DIM = '#9A9A9A';
const LINE = '#2E2E2E';
// Misma pila que react-native-web para el resto de la app (los <div> crudos no la heredan).
const FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const h = (size: number, mt: number): React.CSSProperties => ({
  color: GOLD, fontSize: size, fontWeight: 800, margin: `${mt}px 0 8px`, lineHeight: 1.3,
});

const components: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ node, ...p }) => <h1 style={h(19, 6)} {...p} />,
  h2: ({ node, ...p }) => <h2 style={h(17, 16)} {...p} />,
  h3: ({ node, ...p }) => <h3 style={h(15.5, 14)} {...p} />,
  h4: ({ node, ...p }) => <h4 style={h(15, 12)} {...p} />,
  p: ({ node, ...p }) => <p style={{ margin: '0 0 10px', lineHeight: 1.55 }} {...p} />,
  strong: ({ node, ...p }) => <strong style={{ color: '#FFFFFF', fontWeight: 700 }} {...p} />,
  em: ({ node, ...p }) => <em style={{ color: '#DDD' }} {...p} />,
  ul: ({ node, ...p }) => <ul style={{ margin: '0 0 10px', paddingLeft: 22 }} {...p} />,
  ol: ({ node, ...p }) => <ol style={{ margin: '0 0 10px', paddingLeft: 24 }} {...p} />,
  li: ({ node, ...p }) => <li style={{ margin: '3px 0', lineHeight: 1.5 }} {...p} />,
  hr: () => <hr style={{ border: 0, borderTop: `1px solid ${LINE}`, margin: '14px 0' }} />,
  blockquote: ({ node, ...p }) => (
    <blockquote style={{ margin: '0 0 10px', padding: '4px 12px', borderLeft: `3px solid ${GOLD}`, background: '#1A1A14', color: '#DDD' }} {...p} />
  ),
  a: ({ node, ...p }) => <a style={{ color: '#7CC4FF' }} target="_blank" rel="noopener noreferrer" {...p} />,
  code: ({ node, ...p }) => (
    <code style={{ background: '#222', color: '#FFD98A', padding: '1px 5px', borderRadius: 4, fontSize: '0.9em' }} {...p} />
  ),
  pre: ({ node, ...p }) => (
    <pre style={{ background: '#111', border: `1px solid ${LINE}`, borderRadius: 8, padding: 10, overflowX: 'auto', margin: '0 0 10px' }} {...p} />
  ),
  // Las tablas anchas hacen scroll horizontal dentro de la burbuja (no rompen el layout en móvil).
  table: ({ node, ...p }) => (
    <div style={{ overflowX: 'auto', margin: '0 0 12px', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13.5, minWidth: '100%' }} {...p} />
    </div>
  ),
  th: ({ node, ...p }) => (
    <th style={{ textAlign: 'left', color: GOLD, border: `1px solid ${LINE}`, padding: '6px 9px', background: '#1B1B1B', whiteSpace: 'nowrap', minWidth: 96 }} {...p} />
  ),
  td: ({ node, ...p }) => <td style={{ border: `1px solid ${LINE}`, padding: '6px 9px', verticalAlign: 'top', color: TEXT, minWidth: 96 }} {...p} />,
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div style={{ color: TEXT, fontSize: 15, fontFamily: FONT, wordBreak: 'break-word', userSelect: 'text' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export { DIM as MARKDOWN_DIM };
