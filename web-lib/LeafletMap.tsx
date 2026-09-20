/**
 * LeafletMap.tsx — mapa de SOLO LECTURA de un proyecto (web). Sin dibujo ni edición.
 *
 * Capas, con el mismo criterio que el mapa nativo: polígono dorado (borde #FFD700, relleno
 * 30 %), vértices numerados en azul claro, celdas analizadas como círculos dorados con su
 * rank, y muestras de campo. Base satelital: Esri World Imagery (ver baseLayer.ts).
 * El CSS de Leaflet se sirve desde /vendor/leaflet.css (ver +html.tsx).
 *
 * Todo texto de popups se arma con textContent (nada de innerHTML): los datos vienen de la
 * base y no deben poder inyectar HTML.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import type { WebSample } from '../app/core/webData';
import type { KnownOccurrence } from '../app/core/mrdsService';
import { addBaseLayer } from './baseLayer';

export type MapHandle = { flyTo: (lat: number, lng: number, zoom?: number) => void };

type Props = {
  vertices: { latitude: number; longitude: number }[];
  points: any[];
  samples: WebSample[];
  /** Yacimientos conocidos (USGS MRDS), marcadores azules como en la app nativa. */
  occurrences?: KnownOccurrence[];
};

const GOLD = '#FFD700';
const MAX_NUMBERED = 60; // sobre esto, el resto de celdas se dibuja como puntos ligeros (canvas)

const isNum = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);

function popupEl(lines: string[]): HTMLElement {
  const el = document.createElement('div');
  lines.filter(Boolean).forEach((t, i) => {
    const row = document.createElement(i === 0 ? 'strong' : 'div');
    row.textContent = t;
    el.appendChild(row);
  });
  return el;
}

function numberedIcon(rawLabel: string, bg: string, size: number, fontSize: number, color = '#000'): L.DivIcon {
  // El label puede venir de datos (rank): solo alfanumérico, nunca HTML.
  const label = String(rawLabel).replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:1.5px solid #000;` +
      `color:${color};font:700 ${fontSize}px/${size - 3}px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.6)">${label}</div>`,
  });
}

const LeafletMap = forwardRef<MapHandle, Props>(function LeafletMap({ vertices, points, samples, occurrences }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng, zoom = 16) => { mapRef.current?.flyTo([lat, lng], zoom, { duration: 0.6 }); },
  }), []);

  // Mapa: se crea una sola vez.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    // Atribución ARRIBA a la derecha: el panel de resultados tapa el borde inferior del mapa y Esri exige que se vea.
    const map = L.map(elRef.current, { preferCanvas: true, zoomControl: true, worldCopyJump: true, attributionControl: false }).setView([23.5, -103], 5);
    L.control.attribution({ position: 'topright' }).addTo(map);
    addBaseLayer(map); // Esri World Imagery
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // El contenedor cambia de tamaño (rotación, panel del chat, barra de Safari): recalcular.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  // Nuevo proyecto → vuelve a encuadrar (declarado ANTES del dibujo: debe correr primero).
  useEffect(() => { fittedRef.current = false; }, [vertices]);

  // Capas de datos: se redibujan cuando cambia el proyecto.
  useEffect(() => {
    const map = mapRef.current, group = layerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const bounds: L.LatLngExpression[] = [];

    const verts = vertices.filter((v) => isNum(v?.latitude) && isNum(v?.longitude));
    if (verts.length >= 3) {
      const ll = verts.map((v) => [v.latitude, v.longitude] as [number, number]);
      L.polygon(ll, { color: GOLD, weight: 3, fillColor: GOLD, fillOpacity: 0.3 }).addTo(group);
      ll.forEach((p) => bounds.push(p));
    }
    verts.forEach((v, i) => {
      L.marker([v.latitude, v.longitude], { icon: numberedIcon(String(i + 1), '#87CEFA', 22, 11), interactive: false }).addTo(group);
    });

    const pts = points.filter((p) => isNum(p?.lat) && isNum(p?.lng));
    pts.forEach((p, i) => {
      const rank = p.rank ?? i + 1;
      const score = Math.round(p.score ?? p.base_score ?? 0);
      const popup = popupEl([
        `Punto #${rank}`,
        `Score ${score}${p.consensus ? ` · ${String(p.consensus)}` : ''}`,
        p.near_lineament ? 'Sobre un posible lineamiento' : '',
        `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
      ]);
      if (i < MAX_NUMBERED) {
        L.marker([p.lat, p.lng], { icon: numberedIcon(String(rank), GOLD, 24, 12), zIndexOffset: 1000 - i }).bindPopup(popup).addTo(group);
      } else {
        L.circleMarker([p.lat, p.lng], { radius: 4, color: '#000', weight: 1, fillColor: GOLD, fillOpacity: 0.9 }).bindPopup(popup).addTo(group);
      }
      bounds.push([p.lat, p.lng]);
    });

    samples.filter((s) => isNum(s.lat) && isNum(s.lng)).forEach((s) => {
      L.marker([s.lat, s.lng], { icon: numberedIcon('M', '#4FC3F7', 22, 11), zIndexOffset: 2000 })
        .bindPopup(popupEl([`Muestra ${s.muestra_codigo || ''}`.trim(), s.mineral_detectado, s.descripcion_texto]))
        .addTo(group);
      bounds.push([s.lat, s.lng]);
    });

    // MRDS: dibujado al final y SIN sumar al encuadre (no deben alejar el zoom del polígono).
    (occurrences ?? []).filter((o) => isNum(o.lat) && isNum(o.lng)).forEach((o) => {
      L.circleMarker([o.lat, o.lng], { radius: 7, color: '#0A0A0A', weight: 1.5, fillColor: '#4FC3F7', fillOpacity: 1 })
        .bindPopup(popupEl([o.name || 'Yacimiento', [o.commodity, o.status].filter(Boolean).join(' · ') || 'USGS MRDS'])).addTo(group);
    });

    if (bounds.length > 0 && !fittedRef.current) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 17 });
      fittedRef.current = true;
    }
  }, [vertices, points, samples, occurrences]);

  return <div ref={elRef} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: '#111' }} />;
});

export default LeafletMap;
