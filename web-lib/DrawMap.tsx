/**
 * DrawMap.tsx — mapa Leaflet para dibujar y editar UN polígono o rectángulo de análisis.
 *
 * Usa Leaflet-Geoman (dibujo/edición táctil). Solo se permite una zona a la vez: al crear
 * otra se reemplaza la anterior. Cada cambio se reporta como [{latitude, longitude}], el
 * mismo formato que usa la app nativa y espera el servidor GEE (SatelliteEngine lo convierte
 * a GeoJSON [lng, lat]).
 *
 * Geoman espera `window.L` (el UMD de Leaflet no lo define bajo un bundler): se asigna antes
 * de cargarlo.
 *
 * Barra de herramientas: el estilo vive en /vendor/pwa-map.css (fondo oscuro, acentos amarillos,
 * botones grandes para el dedo). Aquí solo se le agrega la ETIQUETA DE TEXTO a cada botón y se
 * tiñe el ícono (Geoman los trae como imagen gris; se convierten en máscara para pintarlos).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import type {} from '@geoman-io/leaflet-geoman-free';
import type { Coordinate } from './geo';
import { addBaseLayer } from './baseLayer';

if (typeof window !== 'undefined') {
  (window as any).L = L;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@geoman-io/leaflet-geoman-free');
}

export type DrawHandle = {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  /** Pide la ubicación del usuario, la marca en el mapa y centra ahí. Reporta el resultado por onLocate. */
  locate: () => void;
  clear: () => void;
};

/** Resultado del botón 📍 (para que la pantalla lo muestre; antes fallaba en silencio). */
export type LocateStatus =
  | { state: 'searching' }
  | { state: 'found'; accuracy: number }
  | { state: 'error'; message: string };

type Props = {
  /** Color del contorno/relleno según el semáforo de hectáreas. */
  areaColor: string;
  /** Zona actual (null si no hay o se borró). */
  onChange: (coords: Coordinate[] | null) => void;
  /** Forma que se está trazando ('Polygon', 'Rectangle'…) o null al terminar/cancelar. */
  onDrawing?: (shape: string | null) => void;
  onLocate?: (status: LocateStatus) => void;
};

const GOLD = '#FFD700';
const NATIVE_BLUE = '#007AFF'; // color de "tu posición" en la app nativa (index.tsx: punto azul con borde blanco)

// Etiqueta visible de cada herramienta de Geoman, por la clase de su ícono.
const TOOL_LABELS: Record<string, string> = {
  'leaflet-pm-icon-rectangle': 'Rectángulo',
  'leaflet-pm-icon-polygon': 'Polígono',
  'leaflet-pm-icon-edit': 'Editar',
  'leaflet-pm-icon-drag': 'Mover',
  'leaflet-pm-icon-delete': 'Borrar',
};

/** Le pone texto visible a cada botón de la barra y tiñe su ícono. Idempotente. */
function decorateToolbar(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.leaflet-pm-toolbar .control-icon').forEach((icon) => {
    const cls = Object.keys(TOOL_LABELS).find((c) => icon.classList.contains(c));
    const btn = icon.closest<HTMLElement>('.leaflet-buttons-control-button');
    if (!cls || !btn || btn.dataset.pmLabeled) return;
    btn.dataset.pmLabeled = '1';
    // El ícono original es una imagen gris: se usa como MÁSCARA para poder pintarlo (amarillo / negro si está activo).
    const bg = getComputedStyle(icon).backgroundImage;
    if (bg && bg !== 'none') {
      icon.style.setProperty('-webkit-mask-image', bg);
      icon.style.setProperty('mask-image', bg);
      icon.style.backgroundImage = 'none';
    }
    icon.classList.add('pm-tinted');
    const label = document.createElement('span');
    label.className = 'pm-tool-label';
    label.textContent = TOOL_LABELS[cls];
    btn.appendChild(label);
    btn.setAttribute('aria-label', TOOL_LABELS[cls]);
    btn.setAttribute('title', TOOL_LABELS[cls]);
  });
}

/** Marca el PRIMER vértice del trazo en curso (el que hay que tocar para cerrar). El cursor de Geoman también es un
 *  `.marker-icon`, por eso se excluye. Idempotente. */
function markFirstVertex(root: HTMLElement) {
  if (root.querySelector('.pm-first-vertex')) return;
  root.querySelector<HTMLElement>('.marker-icon:not(.cursor-marker):not(.marker-icon-middle)')?.classList.add('pm-first-vertex');
}

const dotIcon = (heading: number | null) => {
  // Mismo diseño que "tu posición" en la app nativa: punto azul 16 px, borde blanco 2 px, sombra;
  // con flecha de rumbo (azul translúcida) solo si el dispositivo informa hacia dónde se mueve.
  const arrow = heading != null && Number.isFinite(heading)
    ? `<div style="position:absolute;left:-12px;top:-12px;width:40px;height:40px;transform:rotate(${heading}deg);pointer-events:none">` +
      `<div style="width:0;height:0;margin:0 auto;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid rgba(0,122,255,0.8)"></div></div>`
    : '';
  return L.divIcon({
    className: 'pm-user-dot',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    html: `<div style="position:relative;width:16px;height:16px">${arrow}` +
      `<div style="position:absolute;inset:0;border-radius:50%;background:${NATIVE_BLUE};border:2px solid #FFF;box-shadow:0 0 3px rgba(0,0,0,0.5);box-sizing:border-box"></div></div>`,
  });
};

const GEO_ERRORS: Record<number, string> = {
  1: 'No se pudo obtener tu ubicación — revisa los permisos de Safari/Chrome para este sitio (iPhone: Ajustes › Privacidad y seguridad › Localización › Safari).',
  2: 'No se pudo obtener tu ubicación — el dispositivo no encontró señal. Activa la ubicación y prueba a cielo abierto.',
  3: 'Tu ubicación tardó demasiado en llegar. Sal a cielo abierto e intenta de nuevo.',
};

const DrawMap = forwardRef<DrawHandle, Props>(function DrawMap({ areaColor, onChange, onDrawing, onLocate }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.Polygon | null>(null);
  const userRef = useRef<L.LayerGroup | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDrawingRef = useRef(onDrawing);
  onDrawingRef.current = onDrawing;
  const onLocateRef = useRef(onLocate);
  onLocateRef.current = onLocate;
  const colorRef = useRef(areaColor);
  colorRef.current = areaColor;
  const drawingShapeRef = useRef<string | null>(null);

  const emit = () => {
    const layer = layerRef.current;
    if (!layer) { onChangeRef.current(null); return; }
    const ring = (layer.getLatLngs() as L.LatLng[][])[0] || [];
    onChangeRef.current(ring.map((p) => ({ latitude: p.lat, longitude: p.lng })));
  };

  const locate = () => {
    const map = mapRef.current;
    const report = (s: LocateStatus) => onLocateRef.current?.(s);
    if (!map) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      report({ state: 'error', message: 'Este navegador no permite obtener la ubicación.' });
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      report({ state: 'error', message: 'La ubicación solo funciona en una conexión segura (https).' });
      return;
    }
    report({ state: 'searching' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy, heading } = pos.coords;
        const ll = L.latLng(latitude, longitude);
        const group = userRef.current;
        if (group) {
          group.clearLayers();
          // Círculo de precisión (tenue) + punto de "tu posición". Ninguno es interactivo: no estorban al dibujar.
          if (Number.isFinite(accuracy) && accuracy > 0) {
            L.circle(ll, { radius: accuracy, color: NATIVE_BLUE, weight: 1, opacity: 0.5, fillColor: NATIVE_BLUE, fillOpacity: 0.1, interactive: false, pane: 'userPane' }).addTo(group);
          }
          L.marker(ll, { icon: dotIcon(heading), interactive: false, keyboard: false, pane: 'userPane' }).addTo(group);
        }
        map.flyTo(ll, Math.max(map.getZoom(), 16), { duration: 0.6 });
        report({ state: 'found', accuracy: Math.round(accuracy || 0) });
      },
      (err) => {
        report({ state: 'error', message: GEO_ERRORS[err.code] || 'No se pudo obtener tu ubicación. Intenta de nuevo.' });
      },
      // Alta precisión (GPS, no solo Wi-Fi/antenas) y un margen razonable: en campo el GPS tarda en fijar.
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 },
    );
  };

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, zoom = 16) => { mapRef.current?.flyTo([lat, lng], zoom, { duration: 0.6 }); },
    locate,
    clear: () => {
      if (layerRef.current && mapRef.current) mapRef.current.removeLayer(layerRef.current);
      layerRef.current = null;
      emit();
    },
  }), []);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    // Zoom arriba a la derecha: la izquierda queda libre para la barra de herramientas grande.
    const map = L.map(elRef.current, { zoomControl: false, worldCopyJump: true }).setView([23.5, -103], 5);
    L.control.zoom({ position: 'topright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
    addBaseLayer(map); // Esri World Imagery + su atribución obligatoria (visible abajo a la derecha)
    mapRef.current = map;

    // Capa propia (por encima del polígono y sin capturar toques) para "tu posición".
    const userPane = map.createPane('userPane');
    userPane.style.zIndex = '650';
    userPane.style.pointerEvents = 'none';
    userRef.current = L.layerGroup().addTo(map);

    const style = () => ({ color: colorRef.current, fillColor: colorRef.current, fillOpacity: 0.3, weight: 3 });

    map.pm.setLang('es');
    map.pm.addControls({
      position: 'topleft',
      drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false, drawText: false,
      drawPolygon: true, drawRectangle: true,
      editMode: true, dragMode: true, removalMode: true,
      cutPolygon: false, rotateMode: false,
    });
    map.pm.setGlobalOptions({
      allowSelfIntersection: false,
      snappable: false,
      pathOptions: style(),
      templineStyle: { color: GOLD },
      hintlineStyle: { color: GOLD, dashArray: [5, 5] },
    });

    // Botones con texto. Si Geoman vuelve a pintar la barra, se re-decora (idempotente).
    const root = map.getContainer();
    decorateToolbar(root);
    const mo = new MutationObserver(() => {
      decorateToolbar(root);
      if (drawingShapeRef.current === 'Polygon') markFirstVertex(root); // aparece al colocar el primer punto
    });
    mo.observe(root, { childList: true, subtree: true });

    // Aviso "toca el primer punto…": lo muestra la pantalla mientras hay un trazo en curso.
    // El primer vértice pulsa (ver pwa-map.css) para que se vea a cuál tocar para cerrar la figura.
    map.on('pm:drawstart', (e: any) => {
      drawingShapeRef.current = e.shape || null;
      onDrawingRef.current?.(e.shape || null);
    });
    map.on('pm:drawend', () => {
      drawingShapeRef.current = null;
      onDrawingRef.current?.(null);
    });

    map.on('pm:create', (e: any) => {
      // Una sola zona: la nueva reemplaza a la anterior.
      if (layerRef.current && layerRef.current !== e.layer) map.removeLayer(layerRef.current);
      const layer = e.layer as L.Polygon;
      layerRef.current = layer;
      layer.setStyle(style());
      // 'pm:markerdrag' = área en vivo mientras se arrastra un vértice; el resto cubre soltar,
      // agregar/quitar vértices, mover la zona entera y salir del modo edición.
      for (const ev of ['pm:markerdrag', 'pm:markerdragend', 'pm:edit', 'pm:update', 'pm:dragend', 'pm:vertexadded', 'pm:vertexremoved', 'pm:disable']) layer.on(ev, emit);
      drawingShapeRef.current = null;
      onDrawingRef.current?.(null);
      emit();
    });
    map.on('pm:remove', (e: any) => {
      if (e.layer === layerRef.current) { layerRef.current = null; emit(); }
    });

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);
    return () => { mo.disconnect(); ro.disconnect(); map.remove(); mapRef.current = null; layerRef.current = null; userRef.current = null; };
  }, []);

  // El semáforo de hectáreas recolorea la zona ya dibujada.
  useEffect(() => {
    layerRef.current?.setStyle({ color: areaColor, fillColor: areaColor });
    mapRef.current?.pm.setGlobalOptions({ pathOptions: { color: areaColor, fillColor: areaColor, fillOpacity: 0.3, weight: 3 } });
  }, [areaColor]);

  return <div ref={elRef} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: '#111' }} />;
});

export default DrawMap;
