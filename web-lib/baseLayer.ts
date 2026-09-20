/**
 * baseLayer.ts — capa base SATELITAL de los mapas de la PWA (dibujo y detalle): Esri World Imagery.
 * Un solo punto de cambio si algún día se migra a otro proveedor (ver docs/BACKLOG.md).
 *
 * Por qué Esri y no "la misma que la app nativa": la nativa usa el mapa satelital/híbrido DE LA PLATAFORMA
 * (react-native-maps sin `provider`: Apple Maps en iPhone). Apple/Google no ofrecen esos tiles por URL para
 * Leaflet; Esri World Imagery es la alternativa satelital sin clave. Es "parecida", no idéntica.
 *
 * TÉRMINOS (Esri Master License Agreement, según la ficha del servicio):
 *  - La ATRIBUCIÓN es obligatoria y debe estar visible en el mapa (abajo).
 *  - No es para exportar/descargar teselas para uso sin conexión: el service worker NO las cachea
 *    (solo cachea archivos de este mismo origen) y no hay pre-descarga.
 *  - El servicio gratuito (URL sin clave) es el "legacy": Esri advierte que puede desactivarse sin aviso.
 *
 * ZOOM: en zonas rurales (verificado en Sinaloa y Baja California Sur) hay imagen real hasta z18; desde z19
 * Esri devuelve siempre un mosaico gris "Map data not yet available". Con maxNativeZoom=18 Leaflet amplía la
 * imagen z18 en los zooms 19–20 en vez de mostrar ese aviso.
 */
import L from 'leaflet';

// OJO: el orden de Esri es {z}/{y}/{x} (fila antes que columna), no {z}/{x}/{y}.
export const ESRI_IMAGERY_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export const ESRI_ATTRIBUTION =
  'Powered by <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> · ' +
  'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';

export function addBaseLayer(map: L.Map): L.TileLayer {
  return L.tileLayer(ESRI_IMAGERY_URL, {
    maxNativeZoom: 18,
    maxZoom: 20,
    attribution: ESRI_ATTRIBUTION,
  }).addTo(map);
}
