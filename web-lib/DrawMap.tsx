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
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import type {} from '@geoman-io/leaflet-geoman-free';
import type { Coordinate } from './geo';

if (typeof window !== 'undefined') {
  (window as any).L = L;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@geoman-io/leaflet-geoman-free');
}

export type DrawHandle = {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  locate: () => void;
  clear: () => void;
};

type Props = {
  /** Color del contorno/relleno según el semáforo de hectáreas. */
  areaColor: string;
  /** Zona actual (null si no hay o se borró). */
  onChange: (coords: Coordinate[] | null) => void;
};

const GOLD = '#FFD700';

const DrawMap = forwardRef<DrawHandle, Props>(function DrawMap({ areaColor, onChange }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.Polygon | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const colorRef = useRef(areaColor);
  colorRef.current = areaColor;

  const emit = () => {
    const layer = layerRef.current;
    if (!layer) { onChangeRef.current(null); return; }
    const ring = (layer.getLatLngs() as L.LatLng[][])[0] || [];
    onChangeRef.current(ring.map((p) => ({ latitude: p.lat, longitude: p.lng })));
  };

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, zoom = 16) => { mapRef.current?.flyTo([lat, lng], zoom, { duration: 0.6 }); },
    locate: () => { mapRef.current?.locate({ setView: true, maxZoom: 16 }); },
    clear: () => {
      if (layerRef.current && mapRef.current) mapRef.current.removeLayer(layerRef.current);
      layerRef.current = null;
      emit();
    },
  }), []);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, worldCopyJump: true }).setView([23.5, -103], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    mapRef.current = map;

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

    map.on('pm:create', (e: any) => {
      // Una sola zona: la nueva reemplaza a la anterior.
      if (layerRef.current && layerRef.current !== e.layer) map.removeLayer(layerRef.current);
      const layer = e.layer as L.Polygon;
      layerRef.current = layer;
      layer.setStyle(style());
      // 'pm:markerdrag' = área en vivo mientras se arrastra un vértice; el resto cubre soltar,
      // agregar/quitar vértices, mover la zona entera y salir del modo edición.
      for (const ev of ['pm:markerdrag', 'pm:markerdragend', 'pm:edit', 'pm:update', 'pm:dragend', 'pm:vertexadded', 'pm:vertexremoved', 'pm:disable']) layer.on(ev, emit);
      emit();
    });
    map.on('pm:remove', (e: any) => {
      if (e.layer === layerRef.current) { layerRef.current = null; emit(); }
    });

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  // El semáforo de hectáreas recolorea la zona ya dibujada.
  useEffect(() => {
    layerRef.current?.setStyle({ color: areaColor, fillColor: areaColor });
    mapRef.current?.pm.setGlobalOptions({ pathOptions: { color: areaColor, fillColor: areaColor, fillOpacity: 0.3, weight: 3 } });
  }, [areaColor]);

  return <div ref={elRef} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: '#111' }} />;
});

export default DrawMap;
