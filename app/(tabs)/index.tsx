import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { StyleSheet, View, Text, ActivityIndicator, Platform, TouchableOpacity, Alert, Pressable, ScrollView, Dimensions, TextInput, Modal } from 'react-native';
import MapView, { Marker, Polygon, Region, MapPressEvent, PanDragEvent, UrlTile } from 'react-native-maps';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as ImagePicker from 'expo-image-picker';
import NetInfo from '@react-native-community/netinfo';
import { analyzeZoneLocal, computeAllMetalScores, enrichPointsWithDeepData, MetalScore } from '../core/GeologicalEngine';
import { Colors, Typography, Spacing, Radii, Touch } from '../core/theme';
import { fetchMiningSpectralGrid, fetchMiningAsterGrid, fetchAsterCoverage, fetchStructuralGrid, fetchEmitGrid, fetchThermalGrid, computeAdaptiveCellSize, type MiningSpectralResult, type AsterSpectralResult, type StructuralResult, type EmitSpectralResult, type ThermalResult } from '../core/SatelliteEngine';
import { getAreaLevel, AREA_LEVEL_COLOR, areaBlockMessage, AREA_WARN_MESSAGE } from '../core/areaLimits';
import { fuseAnalysisPoints, computeZoneProspectivity, type ZoneProspectivity } from '../core/ConsensusFusion';
import FieldModeButton, { FieldModeButtonHandle } from '../components/FieldModeButton';
import HistoryModal from '../components/HistoryModal';
import ConfigModal from '../components/ConfigModal';
import MoreSheet from '../components/MoreSheet';
import { TAP_METAL_META } from '../core/spectralHelpers';
import { materialIcon, materialLabel, normalizeMaterialId, isThermalMaterial } from '../core/materialsCatalog';
import { newAnalisisId, setCurrentAnalisis, logAnalisisZona } from '../core/costTelemetry';
import TapPanel from '../components/TapPanel';
import SelectedPointModal from '../components/SelectedPointModal';
import WaypointModal from '../components/WaypointModal';
import ResultsPanel from '../components/ResultsPanel';
import { initDB, getMuestras, saveMuestra, clearMuestras, savePoligonoCache, getPendingPolygons, saveProjectState, loadProjectState, listProjects, createProject, renameProject, updateMuestraCodigo } from '../core/Database';
import { scheduleFlush } from '../core/SyncEngine';
import { proposeRockType, centroidOf, rockSourceLabel, type RockProposal, type RockSource } from '../core/lithologyService';
import SampleDetailModal from '../components/SampleDetailModal';
import SampleLabelModal from '../components/SampleLabelModal';
import { analyzeRockImageWithClaude, ClaudeAnalysis, analyzeSpectralCandidatesBatch, askClaudeGeologist } from '../core/ClaudeServices';
import { useBadge } from '../core/BadgeContext';
import { generateAndShareReport } from '../core/ReportGenerator';
import { parseCoordinate } from '../core/coordParse';
import { fetchKnownOccurrences, KnownOccurrencesResult } from '../core/mrdsService';

type Coordinate = { latitude: number; longitude: number };
type DrawingType = 'none' | 'polygon' | 'rectangle';

// ── UTM helpers ────────────────────────────────────────────────────────────────

function latLngToUTMComponents(lat: number, lng: number): { zona: string; easting: number; northing: number } {
  // WGS84 to UTM — Transverse Mercator
  const a = 6378137.0, f = 1 / 298.257223563;
  const b = a * (1 - f);
  const e2 = 1 - (b * b) / (a * a);
  const e = Math.sqrt(e2);
  const n0 = lat < 0 ? 10000000 : 0;
  const zoneNum = Math.floor((lng + 180) / 6) + 1;
  const lng0 = (zoneNum - 1) * 6 - 180 + 3;
  const latR = lat * Math.PI / 180;
  const lngR = lng * Math.PI / 180;
  const lng0R = lng0 * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = (e2 / (1 - e2)) * Math.cos(latR) ** 2;
  const A2 = Math.cos(latR) * (lngR - lng0R);
  const e1sq = e2;
  const M = a * ((1 - e1sq/4 - 3*e1sq**2/64 - 5*e1sq**3/256) * latR
    - (3*e1sq/8 + 3*e1sq**2/32 + 45*e1sq**3/1024) * Math.sin(2*latR)
    + (15*e1sq**2/256 + 45*e1sq**3/1024) * Math.sin(4*latR)
    - (35*e1sq**3/3072) * Math.sin(6*latR));
  const k0 = 0.9996;
  const easting = k0 * N * (A2 + (1 - T + C) * A2**3/6 + (5 - 18*T + T**2 + 72*C) * A2**5/120) + 500000;
  const northing = n0 + k0 * (M + N * Math.tan(latR) * (A2**2/2 + (5 - T + 9*C + 4*C**2) * A2**4/24 + (61 - 58*T + T**2) * A2**6/720));
  const latBands = 'CDEFGHJKLMNPQRSTUVWXX';
  const bandIndex = Math.min(Math.max(Math.floor((lat + 80) / 8), 0), 20);
  const zona = `${zoneNum}${latBands[bandIndex]}`;
  return { zona, easting: Math.round(easting), northing: Math.round(northing) };
}

function generateMuestraCodigo(
  projectName: string,
  analysisPoints: any[],
  sampleLat: number,
  sampleLng: number,
  existingSamplesCount: number
): { codigo: string; rank: number } {
  // Short project tag: first 8 alphanumeric chars, uppercase
  const tag = projectName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 8) || 'PROJ';
  // Find nearest analysis point
  let nearestRank = 0;
  if (analysisPoints.length > 0) {
    let minDist = Infinity;
    for (const p of analysisPoints) {
      const d = Math.sqrt((p.lat - sampleLat) ** 2 + (p.lng - sampleLng) ** 2);
      if (d < minDist) { minDist = d; nearestRank = p.rank ?? 0; }
    }
  }
  const pLabel = nearestRank > 0 ? String(nearestRank).padStart(2, '0') : '00';
  const mLabel = existingSamplesCount + 1;
  return { codigo: `${tag}-P${pLabel}-M${mLabel}`, rank: nearestRank };
}

// --- GEO CALCULATIONS ---

function calcPolygonArea(coords: Coordinate[]): number {
  if (!coords || coords.length < 3) return 0;
  const R = 6378137;
  let sumY = 0;
  for (const c of coords) sumY += c.latitude;
  const avgLat = (sumY / coords.length) * Math.PI / 180;

  const points = coords.map(c => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude * Math.PI / 180 * R
  }));

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return Math.abs(area / 2);
}

// ─────────────────────────────────────────────────────────────────────────────

// ── Navigation helpers ─────────────────────────────────────────────────────
function bearingTo(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const lat1 = fromLat * Math.PI / 180;
  const lat2 = toLat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function distanceMTo(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export default function ProspectorDashboard() {
  const mapRef = useRef<MapView>(null);
  const fieldModeButtonRef = useRef<FieldModeButtonHandle>(null);
  const { setGeologoBadge } = useBadge();

  // --- Chat IA (state kept for potential future use by geologo tab) ---
  const [chatMessages, setChatMessages] = useState<{role: string, content: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isTypingChat, setIsTypingChat] = useState(false);

  // --- Red y Sync ---
  const [isConnected, setIsConnected] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      // `isInternetReachable` es null mientras NetInfo aún no lo determina, y en
      // muchos dispositivos se queda así. Con la lógica anterior
      // (`isConnected && isInternetReachable`) ese null hacía online=false CON WIFI
      // ACTIVO, y eso apagaba en silencio la IA y el índice térmico.
      // null = "no se sabe" ⇒ se asume que hay red, igual que hace SyncEngine.
      const online = state.isConnected === true && state.isInternetReachable !== false;
      if (online && !isConnected && !isSyncing && autoSyncRef.current) {
         syncPendingAnalyses();
      }
      setIsConnected(!!online);
    });
    return () => unsubscribe();
  }, [isConnected, isSyncing]);

  const syncPendingAnalyses = async () => {
    if (isSyncing || !useAI) return;
    setIsSyncing(true);
    try {
      const pending = await getPendingPolygons();
      if (pending.length > 0) triggerHaptic('medium');
      for (const p of pending) {
         const poly: any = p;
         const coords = JSON.parse(poly.coordenadas);
         const offlineData = JSON.parse(poly.analisis_resultado || '[]');
         const claudeResults = await analyzeSpectralCandidatesBatch(offlineData, poly.mineral, poly.terrain, poly.rock_type || 'ignea');
         if (claudeResults && claudeResults.length > 0) {
            let finalPoints = offlineData.map((p: any) => {
               const cr = claudeResults.find((c: any) => c.id === p.id);
               if (cr) {
                 p.score = cr.score;
                 p.indices_analizados = cr.indices_analizados;
                 p.analisis_integral = cr.analisis_integral;
                 p.geologia_interpretada = cr.geologia_interpretada;
                 p.recomendacion = cr.recomendacion;
               }
               return p;
            });
            finalPoints.sort((a: any, b: any) => b.score - a.score);
            finalPoints.forEach((p: any, idx: number) => p.rank = idx + 1);
            
            await savePoligonoCache({
               id: poly.id, mineral: poly.mineral, terrain: poly.terrain, rock_type: poly.rock_type,
               coordenadas: coords, analisis_resultado: finalPoints, estado: 'SYNCED'
            });
         }
      }
      if (pending.length > 0) { triggerHaptic('success'); Alert.alert('Sincronización Completada', '¡Tus polígonos offline han sido actualizados por la IA!'); }
    } catch(e) { } finally { setIsSyncing(false); }
  };

  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [heading, setHeading] = useState<Location.LocationHeadingObject | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [mapCenter, setMapCenter] = useState<Region | null>(null);
  const [drawingType, setDrawingType] = useState<DrawingType>('none');
  
  const [polygonCoords, setPolygonCoords] = useState<Coordinate[]>([]);
  const [rectPointA, setRectPointA] = useState<Coordinate | null>(null);
  const [rectPointB, setRectPointB] = useState<Coordinate | null>(null);

  const [analysisPoints, setAnalysisPoints] = useState<any[]>([]);
  const [thermalData, setThermalData] = useState<ThermalResult | null>(null);
  const [zoneProspectivity, setZoneProspectivity] = useState<ZoneProspectivity | null>(null);
  const [knownOccurrences, setKnownOccurrences] = useState<KnownOccurrencesResult | null>(null);
  // #7 — Ingresar coordenada de partida (decimal / GMS / UTM)
  const [showCoordModal, setShowCoordModal] = useState(false);
  const [coordInput, setCoordInput] = useState('');
  const [coordError, setCoordError] = useState<string | null>(null);
  const [startMarker, setStartMarker] = useState<Coordinate | null>(null);
  const [asterData, setAsterData]         = useState<AsterSpectralResult | null>(null);
  const [emitData, setEmitData]           = useState<EmitSpectralResult | null>(null);
  const [structuralData, setStructuralData] = useState<StructuralResult | null>(null);
  const [deepAnalysis, setDeepAnalysis] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState('default');
  const [metalScores, setMetalScores] = useState<MetalScore[]>([]);
  const [showResults, setShowResults] = useState(false);
  // Panel de resultados colapsado (barra compacta) — arranca colapsado al restaurar;
  // se recuerda la elección del usuario durante la sesión.
  const [resultsCollapsed, setResultsCollapsed] = useState(true);
  const [satelliteData, setSatelliteData] = useState<MiningSpectralResult | null>(null);

  // Map tap point analysis
  const [tapPoint, setTapPoint] = useState<{lat: number; lng: number} | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<any>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState('');
  const [mapRotation, setMapRotation] = useState(0);
  const [showHeatmap, setShowHeatmap] = useState(false);
  // Capas del mapa (#6): tipo base (satélite/híbrido) + overlay OSM (ríos/caminos finos)
  // Default 'hybrid': Apple Maps muestra calles, poblados, ciudades, límites y ríos
  // principales sobre el satélite (contexto visible desde el arranque). El usuario
  // puede volver a 'satellite' puro o activar el detalle OSM (ríos/arroyos finos).
  const [mapLayer, setMapLayer] = useState<'satellite' | 'hybrid'>('hybrid');
  const [osmOverlay, setOsmOverlay] = useState(false);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [zoneColors, setZoneColors] = useState<any[]>([]);

  // Waypoints & Field Mode
  const [isFieldMode, setIsFieldMode] = useState(false);
  const [waypoints, setWaypoints] = useState<any[]>([]);
  const [showWaypointModal, setShowWaypointModal] = useState(false);
  const [waypointNote, setWaypointNote] = useState('');
  
  // AI & Camera States
  const [sampleBase64, setSampleBase64] = useState<string|null>(null);
  const [sampleCaptureType, setSampleCaptureType] = useState('normal'); 
  const [isAiProcessing, setIsAiProcessing] = useState(false);
  const [aiResult, setAiResult] = useState<ClaudeAnalysis | null>(null);

  // Settings & Configuration
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [activeProject, setActiveProject] = useState('Prospecto Alpha');
  const [selectedMineral, setSelectedMineral] = useState('oro');
  const [terrainType, setTerrainType] = useState('sierra');
  const [depth, setDepth] = useState('0-5m');
  const [rockType, setRockType] = useState('ignea');
  // De dónde salió el tipo de roca. 'default' = nadie lo eligió todavía.
  const [rockSource, setRockSource] = useState<RockSource>('default');
  const [rockProposal, setRockProposal] = useState<RockProposal | null>(null);
  // ¿Ya se leyó la roca guardada del proyecto? Hasta que sea true, la propuesta por
  // ubicación NO corre. En el arranque en frío se restaura `lastPolygon` ANTES de
  // conocer el proyecto: sin esta compuerta, el efecto salía disparado con
  // rockSource='default' y podía persistir la carta geológica encima de la
  // corrección del usuario justo antes de que esta se cargara de la base.
  const [rockHydrated, setRockHydrated] = useState(false);

  // Espejo síncrono de `rockSource`. El estado de React se ve en el siguiente render;
  // el guard de "no pisar al usuario" tiene que decidir JUSTO al volver de un await,
  // antes de eso. El ref siempre está al día, así que la comprobación no depende de
  // cuándo React haya decidido re-renderizar.
  const rockSourceRef = useRef<RockSource>('default');
  const applyRockSource = useCallback((v: RockSource) => {
    rockSourceRef.current = v;
    setRockSource(v);
  }, []);

  // El usuario manda: si toca el selector, su elección NO se pisa por una propuesta
  // posterior (mover un vértice no debe deshacer lo que él corrigió a mano).
  //
  // Y se PERSISTE en el acto, junto con su origen. Antes solo vivía en memoria: al
  // cerrar la app o cambiar de proyecto, `rockSource` volvía a 'default' y la carta
  // geológica pisaba la corrección en el siguiente arranque. La roca y su origen son
  // un solo dato y se guardan juntos, por proyecto.
  const handleSetRockType = useCallback((v: string) => {
    setRockType(v);
    applyRockSource('usuario');
    void saveProjectState(currentProjectId, { rock_type: v, rock_source: 'usuario' })
      .catch(e => console.warn('[Roca] no se pudo persistir la corrección:', e));
  }, [currentProjectId, applyRockSource]);
  
  // AI, Database & Hardware Configuration
  const [useAI, setUseAI] = useState(true);
  const [autoAnalyzeSample, setAutoAnalyzeSample] = useState(true);
  const [uvLamp, setUvLamp] = useState('Ninguna'); 
  const [microscopeConnected, setMicroscopeConnected] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  // Ref so the NetInfo closure always reads the latest autoSync value
  const autoSyncRef = useRef(false);
  useEffect(() => { autoSyncRef.current = autoSync; }, [autoSync]);

  // History & Apperance
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

  // Field mode offline package
  const [geologoResumen, setGeologoResumen] = useState('');

  // Report generation
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);

  // More sheet (secondary actions bottom sheet)
  const [showMoreSheet, setShowMoreSheet] = useState(false);

  // Onboarding tips (one-time, dismissable)
  const [activeTip, setActiveTip] = useState<1 | 2 | 3 | null>(null);

  // Navigation target HUD
  const [navTarget, setNavTarget] = useState<{ lat: number; lng: number } | null>(null);

  // Sample detail / label modals
  const [showSampleDetail, setShowSampleDetail] = useState(false);
  const [selectedSample, setSelectedSample] = useState<any | null>(null);
  const [showSampleLabel, setShowSampleLabel] = useState(false);

  // Field package info for field mode status bar
  const [fieldPackageInfo, setFieldPackageInfo] = useState<{ preparado_at: string; size_kb: number } | null>(null);
  const [hasAutoSuggestedField, setHasAutoSuggestedField] = useState(false);

  const handleGenerateReport = async () => {
    if (analysisPoints.length === 0) {
      Alert.alert('Sin análisis', 'Analiza una zona primero antes de generar el reporte.');
      return;
    }
    setIsGeneratingReport(true);
    triggerHaptic('medium');
    try {
      // Compute bbox from polygon coords or rect
      const coords = resolvedPolygonCoords.length > 0 ? resolvedPolygonCoords : [];
      const lats = coords.map(c => c.latitude);
      const lngs = coords.map(c => c.longitude);
      const lat_min = lats.length > 0 ? Math.min(...lats) : (mapCenter?.latitude ?? 0) - 0.05;
      const lat_max = lats.length > 0 ? Math.max(...lats) : (mapCenter?.latitude ?? 0) + 0.05;
      const lng_min = lngs.length > 0 ? Math.min(...lngs) : (mapCenter?.longitude ?? 0) - 0.05;
      const lng_max = lngs.length > 0 ? Math.max(...lngs) : (mapCenter?.longitude ?? 0) + 0.05;

      const centerLat = (lat_min + lat_max) / 2;
      const centerLng = (lng_min + lng_max) / 2;

      // Build satellites sources string
      let sourcesParts: string[] = [];
      if (satelliteData && satelliteData.data_source !== 'NO_DATA_OFFLINE') {
        sourcesParts.push('Sentinel-2');
      }
      if (asterData && asterData.data_source !== 'NO_DATA_OFFLINE') {
        sourcesParts.push('ASTER');
      }
      if (emitData && emitData.data_source !== 'NO_DATA_OFFLINE') {
        sourcesParts.push('EMIT');
      }
      if (structuralData && structuralData.data_source !== 'NO_DATA_OFFLINE') {
        sourcesParts.push('Sentinel-1 SAR');
      }
      const satelitesSources = sourcesParts.length > 0 ? sourcesParts.join(' · ') : 'Sentinel-2';

      const acquisitionDates = satelliteData?.acquisition_date || 'N/D';

      // Per-source acquisition dates — honest per-satellite metadata
      const sourceDates = {
        s2:        satelliteData?.acquisition_date || undefined,
        aster:     (asterData as any)?.archive_range || (asterData as any)?.acquisition_date || 'Archivo 2000–2008',
        emit:      (emitData as any)?.acquisition_date || undefined,
        sentinel1: (structuralData as any)?.acquisition_date || undefined,
      };

      const cellSizeM = satelliteData?.cell_size_m ?? 500;

      const geeServerUrl = process.env.EXPO_PUBLIC_SERVER_URL?.replace(/\/$/, '') ||
        'https://prospector-gee-server-production.up.railway.app';

      await generateAndShareReport({
        projectId: currentProjectId,
        projectName: activeProject,
        metalName: selectedMineral,
        terrainType,
        areaHa,
        analysisPoints,
        zoneProspectivity,
        metalScores,
        satelitesSources,
        acquisitionDates,
        sourceDates,
        cellSizeM,
        zoneCenter: { lat: centerLat, lng: centerLng },
        polygonCoords: resolvedPolygonCoords,
        lat_min,
        lat_max,
        lng_min,
        lng_max,
        geeServerUrl,
      });
      triggerHaptic('success');
    } catch (e: any) {
      Alert.alert('Error al generar reporte', e.message || 'Error desconocido.');
    } finally {
      setIsGeneratingReport(false);
    }
  };

  // ── Onboarding tips ────────────────────────────────────────────────────────
  const dismissTip = async () => {
    if (activeTip) {
      await AsyncStorage.setItem(`hasSeenTip_${activeTip}`, '1');
      setActiveTip(null);
    }
  };

  // ── Config persist handlers ────────────────────────────────────────────────
  const handleSetMineral = useCallback((v: string) => {
    setSelectedMineral(v);
    AsyncStorage.setItem('config_mineral', v);
  }, []);
  const handleSetTerrain = useCallback((v: string) => {
    setTerrainType(v);
    AsyncStorage.setItem('config_terrain', v);
  }, []);
  const handleSetDeepAnalysis = useCallback((v: boolean) => {
    setDeepAnalysis(v);
    AsyncStorage.setItem('config_deepAnalysis', String(v));
  }, []);

  const sendChatMessage = async () => {
    if (!chatInput.trim() || isTypingChat) return;
    const userMsg = { role: 'user', content: chatInput.trim() };
    const newContext = [...chatMessages, userMsg];
    setChatMessages(newContext);
    setChatInput('');
    setIsTypingChat(true);
    triggerHaptic('medium');
    try {
      const response = await askClaudeGeologist(newContext);
      setChatMessages([...newContext, { role: 'assistant', content: response }]);
      triggerHaptic('success');
    } catch(e: any) {
      Alert.alert('Error Chat IA', e.message);
    } finally {
      setIsTypingChat(false);
    }
  };



  // Live zoom level for label visibility (updated during pan/zoom)
  const [currentZoom, setCurrentZoom] = useState(0.5);

  const exportCSV = async () => {
    if (waypoints.length === 0) {
      Alert.alert('Vacío', 'No hay muestras en el historial para exportar.');
      return;
    }
    triggerHaptic('heavy');
    try {
      let csvContent = "ID,Proyecto,Fecha,Latitud,Longitud,Altitud,Mineral_IA,Score_IA,Notas\n";
      waypoints.forEach(wp => {
        const date = new Date(wp.fecha_hora || wp.timestamp).toISOString();
        const noteFixed = (wp.descripcion_texto || wp.note || '').replace(/,/g, ' ');
        const proj = wp.proyecto_id || wp.project || 'No Asignado';
        const lat = wp.lat || wp.latitude;
        const lng = wp.lng || wp.longitude;
        csvContent += `${wp.id},${proj},${date},${lat},${lng},${wp.altitud||0},${wp.mineral_detectado||'N/A'},${wp.score_ia||0},${noteFixed}\n`;
      });
      const fileUri = FileSystem.documentDirectory + 'ProspectorAI_Reporte.csv';
      await FileSystem.writeAsStringAsync(fileUri, csvContent, { encoding: FileSystem.EncodingType.UTF8 });
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(fileUri);
      } else {
        Alert.alert('Info', 'CSV Guardado en: ' + fileUri);
      }
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Fallo al exportar reporte.');
    }
  };

  const triggerHaptic = (type: 'light' | 'medium' | 'heavy' | 'success') => {
    if (!vibrationEnabled) return;
    if (type === 'heavy') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    else if (type === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (type === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // Location Watcher
  useEffect(() => {
    let posSub: Location.LocationSubscription;
    let headSub: Location.LocationSubscription;

    const startWatching = async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permisos de GPS denegados');
        return;
      }
      try {
        const initialLoc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setLocation(initialLoc);
        setMapCenter({
            latitude: initialLoc.coords.latitude,
            longitude: initialLoc.coords.longitude,
            latitudeDelta: 0.005,
            longitudeDelta: 0.005,
        });

        posSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 4000, 
            distanceInterval: 3,
          },
          (loc) => setLocation(loc)
        );

        headSub = await Location.watchHeadingAsync((head) => {
          setHeading(head);
        });
      } catch (err) {
        console.warn('GPS Error: ', err);
      }
    };
    startWatching();
    return () => {
      if (posSub) posSub.remove();
      if (headSub) headSub.remove();
    };
  }, []);

  // ── Tipo de roca propuesto por ubicación ────────────────────────────────────
  // Se pedía a ciegas justo el dato que el prospector no sabe. Ahora se propone desde
  // la carta geológica del centroide y él solo corrige si hace falta.
  // Se dispara al TENER polígono (≥3 vértices), no en cada render: la consulta va
  // cacheada por celda de ~0.05° dentro de lithologyService.
  const proposedForRef = useRef<string>('');
  useEffect(() => {
    if (!rockHydrated) return;                    // aún no sabemos qué eligió el usuario
    if (polygonCoords.length < 3) return;
    const c = centroidOf(polygonCoords as any);
    if (!c) return;
    const key = `${c.lat.toFixed(2)}_${c.lng.toFixed(2)}`;
    if (proposedForRef.current === key) return;   // ya se consultó esta zona
    proposedForRef.current = key;

    (async () => {
      const proposal = await proposeRockType(c.lat, c.lng);
      if (!proposal) return;                       // sin cobertura/red: se queda manual
      setRockProposal(proposal);
      // Si el usuario ya eligió a mano, se respeta: la propuesta solo se guarda para
      // poder medir después si acertaba (telemetría), pero NO pisa su decisión.
      // Se comprueba DESPUÉS del await, contra el ref: durante la consulta a la carta
      // el usuario pudo haber tocado el selector.
      if (rockSourceRef.current === 'usuario') return;
      setRockType(proposal.rock_type);
      applyRockSource(proposal.source);
      void saveProjectState(currentProjectId, {
        rock_type: proposal.rock_type, rock_source: proposal.source,
      }).catch(() => { /* la propuesta se recalcula sola en el próximo arranque */ });
    })();
  }, [polygonCoords, currentProjectId, rockHydrated, applyRockSource]);

  // Proyecto actualmente cargado en el mapa (para no recargar en cada foco).
  const loadedProjectRef = useRef<string | null>(null);

  // Carga un proyecto guardado en el mapa: su polígono/zona + análisis + config.
  const loadProjectIntoMap = useCallback(async (pid: string) => {
    loadedProjectRef.current = pid;
    setCurrentProjectId(pid);
    const proj = await loadProjectState(pid);
    setRockHydrated(true);   // se consultó la roca guardada (haya proyecto o no)
    if (!proj) {
      // Proyecto sin fila: no hay roca que restaurar. Se vuelve al default en vez de
      // heredar —y bloquear— la elección manual del proyecto anterior.
      setRockType('ignea');
      applyRockSource('default');
      setRockProposal(null);
      proposedForRef.current = '';
      return;
    }
    // El nombre SIEMPRE se deriva del proyecto cargado: es una etiqueta, no una
    // identidad. La identidad es `currentProjectId` y solo esa.
    if (proj.nombre) setActiveProject(proj.nombre);
    const coords = Array.isArray(proj.coordenadas) ? proj.coordenadas : [];
    if (coords.length > 0) {
      setPolygonCoords(coords as any);
      setTimeout(() => {
        try {
          mapRef.current?.fitToCoordinates(coords as any, {
            edgePadding: { top: 100, right: 80, bottom: 220, left: 80 }, animated: true,
          });
        } catch {}
      }, 400);
    }
    const pts = Array.isArray(proj.analisis_resultado) ? proj.analisis_resultado : [];
    setAnalysisPoints(pts);
    setZoneProspectivity((proj.prospectivity as any) ?? null);
    if (proj.mineral) setSelectedMineral(normalizeMaterialId(proj.mineral));
    if (proj.terrain) setTerrainType(proj.terrain);
    // La ROCA y su ORIGEN se restauran aquí, con todo lo demás del proyecto. Faltaban:
    // el proyecto guardaba `rock_type` pero nadie lo volvía a leer, así que al cambiar
    // de proyecto la roca del ANTERIOR se quedaba en pantalla — y el siguiente guardado
    // la escribía dentro del proyecto equivocado.
    if (proj.rock_type) setRockType(proj.rock_type);
    applyRockSource((proj.rock_source as RockSource) ?? 'default');
    // La propuesta pertenece a la zona del proyecto que se abre, no al anterior. Se
    // limpia y el efecto de arriba la vuelve a pedir (va cacheada por celda).
    setRockProposal(null);
    proposedForRef.current = '';
    setShowResults(pts.length > 0);
    if (proj.chat_history?.length) {
      const lastA = [...proj.chat_history].reverse().find((m: any) => m.role === 'assistant');
      if (lastA && typeof lastA.content === 'string') setGeologoResumen(lastA.content);
    }
    // Las muestras del mapa siguen al proyecto que se abre.
    const data = await getMuestras(pid);
    setWaypoints(data);
  }, [applyRockSource]);

  // Al enfocar Home: si el proyecto activo cambió (abriste uno desde Proyectos),
  // cárgalo en el mapa. Corrige "abrir proyecto → no lleva al mapa del proyecto".
  useFocusEffect(useCallback(() => {
    (async () => {
      const pid = (await AsyncStorage.getItem('currentProjectId')) || 'default';
      if (pid !== loadedProjectRef.current) {
        await loadProjectIntoMap(pid);
      }
    })();
  }, [loadProjectIntoMap]));

  useEffect(() => {
    const loadSaved = async () => {
      try {
        const saved = await AsyncStorage.getItem('lastPolygon');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.length > 0) setPolygonCoords(parsed);
        }
        await initDB();

        // Load geologist summary from current project's chat history
        const pid = (await AsyncStorage.getItem('currentProjectId')) || 'default';
        setCurrentProjectId(pid);
        loadedProjectRef.current = pid;
        // Después de resolver el proyecto: las muestras se cargan con ESE id (antes
        // se cargaban antes de conocerlo, con el valor obsoleto del estado).
        await loadMuestras(pid);
        const proj = await loadProjectState(pid);
        if (proj?.nombre) setActiveProject(proj.nombre);
        // Fix #8: el análisis y el Índice de zona se guardaban pero no se re-mostraban
        // al reabrir. Restaurarlos aquí (datos reales persistidos por proyecto).
        if (proj?.analisis_resultado && proj.analisis_resultado.length > 0) setAnalysisPoints(proj.analisis_resultado);
        if (proj?.prospectivity) setZoneProspectivity(proj.prospectivity);
        // Roca + origen del proyecto activo. Sin esto, el arranque en frío partía de
        // 'ignea'/'default' y la restauración de `lastPolygon` (arriba) disparaba la
        // propuesta automática, que pisaba en silencio la corrección de ayer.
        if (proj?.rock_type) setRockType(proj.rock_type);
        if (proj?.rock_source) applyRockSource(proj.rock_source as RockSource);
        setRockHydrated(true);   // ya se puede proponer sin riesgo de pisar nada
        if (proj?.chat_history && proj.chat_history.length > 0) {
          // Use the last assistant message as the resumen
          const lastAssistant = [...proj.chat_history]
            .reverse()
            .find((m: { role: string; content: string }) => m.role === 'assistant');
          if (lastAssistant) setGeologoResumen(lastAssistant.content);
        }

        // Restore persisted config settings
        const savedMineral = await AsyncStorage.getItem('config_mineral');
        const savedTerrain = await AsyncStorage.getItem('config_terrain');
        const savedDeepAnalysis = await AsyncStorage.getItem('config_deepAnalysis');
        if (savedMineral) setSelectedMineral(normalizeMaterialId(savedMineral));
        if (savedTerrain) setTerrainType(savedTerrain);
        if (savedDeepAnalysis) setDeepAnalysis(savedDeepAnalysis === 'true');

        // Show tip 1 if not seen
        const seen1 = await AsyncStorage.getItem('hasSeenTip_1');
        if (!seen1) setActiveTip(1);
      } catch (e) {
      } finally {
        // Pase lo que pase, la compuerta se abre: si la carga falló no hay nada que
        // pisar, y dejarla cerrada mataría la propuesta de roca para toda la sesión.
        setRockHydrated(true);
      }
    };
    loadSaved();
  }, []);

  useEffect(() => {
    if (fieldPackageInfo && !isConnected && !isFieldMode && !hasAutoSuggestedField) {
      setHasAutoSuggestedField(true);
      Alert.alert(
        '🎒 Campo disponible',
        'Este proyecto está listo y estás sin conexión. ¿Activar modo campo?',
        [
          { text: 'No ahora', style: 'cancel' },
          { text: 'Activar', onPress: () => setIsFieldMode(true) },
        ]
      );
    }
  }, [fieldPackageInfo, isConnected]);

  // Muestras DEL proyecto activo. Antes llamaba a getMuestras() sin id, así que el
  // mapa mezclaba las muestras de todos los proyectos.
  const loadMuestras = async (pid?: string) => {
    const data = await getMuestras(pid ?? currentProjectId);
    setWaypoints(data);
  };

  const takeSamplePhoto = async (type: string) => {
    setSampleCaptureType(type);
    
    // Solicitar permisos antes de abrir la cámara
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
    
    if (permissionResult.granted === false) {
      Alert.alert('Permiso Denegado', 'Se requiere acceso a la cámara para capturar muestras geológicas.');
      return;
    }

    try {
      let result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.6,
        base64: true,
      });

      if (!result.canceled && result.assets && result.assets[0].base64) {
        setSampleBase64(result.assets[0].base64);
        if (useAI && autoAnalyzeSample) {
           await runAI(result.assets[0].base64, type);
        }
      }
    } catch (e: any) {
      console.log("Error de Cámara:", e);
      Alert.alert('Error Cámara', 'Ocurrió un error al intentar abrir la cámara nativa.');
    }
  };

  const runAI = async (base64: string, type: string) => {
    setIsAiProcessing(true);
    triggerHaptic('medium');
    try {
      const analysis = await analyzeRockImageWithClaude(base64, type, selectedMineral);
      setAiResult(analysis);
      triggerHaptic('success');
    } catch (e: any) {
      console.warn("AI Analysis Error:", e);
      Alert.alert('Error IA', e.message || 'Error desconocido.');
    } finally {
      setIsAiProcessing(false);
    }
  };

  const saveWaypoint = async () => {
    // Prefer real GPS position for the sample location
    const sampleLat = location?.coords.latitude ?? mapCenter?.latitude;
    const sampleLng = location?.coords.longitude ?? mapCenter?.longitude;
    if (sampleLat == null || sampleLng == null) return;

    const wpId = Date.now().toString();

    // Guarda la foto como ARCHIVO persistente (antes solo se guardaban 100 chars
    // de base64 → foto rota). El SyncEngine la sube a Storage y guarda la URL,
    // para que sobreviva a la reinstalación.
    let fotoPath = '';
    if (sampleBase64) {
      try {
        const fileUri = `${FileSystem.documentDirectory}muestra_${wpId}.jpg`;
        await FileSystem.writeAsStringAsync(fileUri, sampleBase64, { encoding: FileSystem.EncodingType.Base64 });
        fotoPath = fileUri;
      } catch (_) { /* si falla el guardado de foto, la muestra igual se guarda */ }
    }

    const newWp = {
      id: wpId,
      // El ID real del proyecto, no su nombre. Antes iba `activeProject` (texto
      // libre), así que la muestra quedaba huérfana: la pantalla de Proyectos las
      // busca por id y siempre contaba 0, y en Supabase el project_client_id era
      // un nombre que no casaba con ningún proyecto.
      proyecto_id: currentProjectId,
      lat: sampleLat,
      lng: sampleLng,
      altitud: altitude,
      rumbo: trueHeading,
      fecha_hora: new Date().toISOString(),
      tipo_captura: sampleCaptureType,
      imagen_thumbnail: fotoPath,
      descripcion_texto: waypointNote,
      analisis_ia: aiResult,
      mineral_detectado: aiResult?.mineral_detectado || 'N/A',
      score_ia: aiResult?.probabilidad || 0,
    };

    await saveMuestra(newWp);

    // Generate sample code and UTM coords
    const utmComp = latLngToUTMComponents(sampleLat, sampleLng);
    const { codigo } = generateMuestraCodigo(activeProject, analysisPoints, sampleLat, sampleLng, waypoints.length);

    // Freeze spectral snapshot from nearest analysis point
    let spectralSnapshot: any = {};
    if (analysisPoints.length > 0) {
      let minDist = Infinity, nearest: any = null;
      for (const p of analysisPoints) {
        const d = Math.sqrt((p.lat - sampleLat) ** 2 + (p.lng - sampleLng) ** 2);
        if (d < minDist) { minDist = d; nearest = p; }
      }
      if (nearest) {
        spectralSnapshot = {
          consensus_level: nearest.consensus_level ?? nearest.consensus ?? '',
          evidence: nearest.evidence ?? '',
          base_score: nearest.base_score ?? 0,
          indices: nearest.indices ?? {},
        };
      }
    }

    await updateMuestraCodigo(newWp.id, codigo, utmComp.zona, utmComp.easting, utmComp.northing, spectralSnapshot);

    // Envío tras completar la muestra (código + UTM + snapshot ya escritos): así
    // sube la fila entera, no una versión a medias. El debounce agrupa ambas
    // escrituras en un solo push.
    scheduleFlush();

    setSampleBase64(null);
    setAiResult(null);
    setSampleCaptureType('normal');
    setWaypointNote('');
    setShowWaypointModal(false);
    triggerHaptic('success');
    await loadMuestras();
  };

  const handleRegionChangeComplete = (region: Region) => {
    setMapCenter(region);
  };

  const handleMapPress = (e: MapPressEvent) => {
    const coord = e.nativeEvent.coordinate;

    if (drawingType === 'rectangle') {
      setRectPointA(coord);
      setRectPointB(null);
      return;
    }

    if (drawingType === 'none') {
      const lat = coord.latitude;
      const lng = coord.longitude;
      setTapPoint({ lat, lng });
      setShowResults(false);
      triggerHaptic('light');
    }
  };

  const handlePanDrag = (e: PanDragEvent) => {
    if (drawingType === 'rectangle') {
      const coord = e.nativeEvent.coordinate;
      if (!rectPointA) {
        setRectPointA(coord);
      } else {
        setRectPointB(coord);
      }
    }
  };

  const selectMode = (type: DrawingType) => {
    setPolygonCoords([]);
    setRectPointA(null);
    setRectPointB(null);
    setAnalysisPoints([]);
    setZoneProspectivity(null);
    setZoneColors([]);
    setShowHeatmap(false);
    setShowResults(false);
    setTapPoint(null);
    setDrawingType(type);
  };

  const clearShapes = async () => {
    setPolygonCoords([]);
    setRectPointA(null);
    setRectPointB(null);
    setDrawingType('none');
    setAnalysisPoints([]);
    setZoneProspectivity(null);
    setZoneColors([]);
    setShowHeatmap(false);
    setShowResults(false);
    setTapPoint(null);
    triggerHaptic('light');
    await AsyncStorage.removeItem('lastPolygon');
  };

  const zoomIn = () => {
    if (mapCenter && mapRef.current) {
      mapRef.current.animateToRegion({
        ...mapCenter,
        latitudeDelta: Math.max(mapCenter.latitudeDelta / 2, 0.0001),
        longitudeDelta: Math.max(mapCenter.longitudeDelta / 2, 0.0001),
      }, 250);
    }
  };

  const zoomOut = () => {
    if (mapCenter && mapRef.current) {
      mapRef.current.animateToRegion({
        ...mapCenter,
        latitudeDelta: Math.min(mapCenter.latitudeDelta * 2, 90),
        longitudeDelta: Math.min(mapCenter.longitudeDelta * 2, 90),
      }, 250);
    }
  };

  const addPointFromCrosshair = () => {
    const center = mapCenter ?? (location ? {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      latitudeDelta: 0.005,
      longitudeDelta: 0.005,
    } : null);
    if (!center) return;
    triggerHaptic('heavy');
    const newPoint = { latitude: center.latitude, longitude: center.longitude };
    setPolygonCoords((prev) => {
      // Show tip 2 when adding the very first vertex
      if (prev.length === 0) {
        AsyncStorage.getItem('hasSeenTip_2').then(seen => { if (!seen) setActiveTip(2); });
      }
      return [...prev, newPoint];
    });
  };

  const finishDrawing = async (overrideCoords?: Coordinate[]) => {
    const finalCoords = overrideCoords || polygonCoords;

    // Tope duro de superficie: no salimos del modo trazado, para que el usuario
    // pueda seguir editando o borrando vértices sin perder lo que ya marcó.
    if (finalCoords.length >= 3) {
      const ha = calcPolygonArea(finalCoords) / 10_000;
      if (getAreaLevel(ha) === 'block') {
        triggerHaptic('heavy');
        Alert.alert('Zona muy grande', areaBlockMessage(ha));
        return;
      }
    }

    setDrawingType('none');
    if (finalCoords.length >= 3) {
      triggerHaptic('success');
      await AsyncStorage.setItem('lastPolygon', JSON.stringify(finalCoords));
      analyzeZone(finalCoords);
    }
  };

function getDrySeasonDates(centLat: number, centLng: number): { fecha_inicio?: string; fecha_fin?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  // NW Mexico arid zone: dry season Feb–May
  if (centLat >= 20 && centLat <= 32 && centLng >= -118 && centLng <= -103) {
    const startYear = m >= 5 ? y : y - 1; // if we're past May, this year's dry season just ended; else use last year
    return { fecha_inicio: `${startYear}-02-01`, fecha_fin: `${startYear}-05-31` };
  }
  // Tropical/south Mexico: dry season Nov–Apr (spans year boundary)
  if (centLat >= 14 && centLat < 20 && centLng >= -95 && centLng <= -86) {
    const startYear = m >= 4 ? y : y - 1;
    return { fecha_inicio: `${startYear}-11-01`, fecha_fin: `${startYear + 1}-04-30` };
  }
  // Other zones: let GEE auto-select (no override)
  return {};
}

  const analyzeZone = async (overrideCoords?: Coordinate[]) => {
    console.log('=== INICIO ANALISIS OFFLINE ===');
    const localCoords = overrideCoords || polygonCoords;
    
    if (localCoords.length < 3 && !(rectPointA && rectPointB)) {
      Alert.alert('Error', 'Dibuja un polígono o rectángulo primero');
      return;
    }
    
    let coordsToUse: Coordinate[] = [];
    if (drawingType === 'polygon' && localCoords.length >= 3) {
      coordsToUse = localCoords;
    } else if (drawingType === 'none' && localCoords.length >= 3) {
      coordsToUse = localCoords;
    } else if (rectPointA && rectPointB) {
      coordsToUse = [
        { latitude: rectPointA.latitude, longitude: rectPointA.longitude },
        { latitude: rectPointA.latitude, longitude: rectPointB.longitude },
        { latitude: rectPointB.latitude, longitude: rectPointB.longitude },
        { latitude: rectPointB.latitude, longitude: rectPointA.longitude },
      ];
    }

    // Tope duro de superficie (ver app/core/areaLimits.ts). Cubre polígono,
    // rectángulo y polígonos restaurados de AsyncStorage.
    const areaHaCheck = calcPolygonArea(coordsToUse) / 10_000;
    if (getAreaLevel(areaHaCheck) === 'block') {
      triggerHaptic('heavy');
      Alert.alert('Zona muy grande', areaBlockMessage(areaHaCheck));
      return;
    }

    setIsAnalyzing(true);
    setAnalysisStep('Consultando Sentinel-2...');

    try {
      await new Promise(resolve => setTimeout(resolve, 600));
      // ── Adaptive cell size based on polygon area ──────────────────────────────
      const polygonAreaHa = calcPolygonArea(coordsToUse) / 10_000;
      const cellSizeM     = computeAdaptiveCellSize(polygonAreaHa);

      // ── Fetch real satellite data (3-state: REAL / CACHED / NO_DATA_OFFLINE) ─
      let satData: MiningSpectralResult;
      try {
        const centLat = coordsToUse.reduce((s, c) => s + c.latitude, 0) / coordsToUse.length;
        const centLng = coordsToUse.reduce((s, c) => s + c.longitude, 0) / coordsToUse.length;
        const dryDates = getDrySeasonDates(centLat, centLng);
        satData = await fetchMiningSpectralGrid(coordsToUse, { cell_size_m: cellSizeM, ...dryDates });
      } catch (e: any) {
        // fetchMiningSpectralGrid never throws — this is a safety net
        satData = {
          cells: [], cellIndex: new Map(), acquisition_date: '', cloud_cover: 0,
          images_used: 0, cell_size_m: 500, coverage_pct: 0,
          data_source: 'NO_DATA_OFFLINE',
          source_label: '🔌 Sin datos. Conecta a internet para analizar esta zona.',
        };
      }
      setSatelliteData(satData);

      // Block analysis if no real data — show honest alert, no simulated fallback
      if (satData.data_source === 'NO_DATA_OFFLINE') {
        setIsAnalyzing(false);
        Alert.alert(
          'Sin datos satelitales',
          'Esta zona no tiene análisis guardados.\n\nConéctate a internet para obtener datos reales de Sentinel-2.\n\nNo se muestran datos simulados.',
          [{ text: 'Entendido', style: 'default' }]
        );
        return;
      }

      const analisisId = newAnalisisId();
      setCurrentAnalisis(analisisId);   // agrupa las llamadas de IA de este análisis
      const data = analyzeZoneLocal(coordsToUse, selectedMineral, terrainType, depth, rockType, waypoints, satData);

      if (data.success && data.top_points) {
        let finalPoints = data.top_points;
        let wasAnalyzed = false;
        let usedAster = false, usedEmit = false, usedStruct = false, usedThermal = false;   // fuentes disparadas (telemetría)
        
        if (useAI && isConnected) {
           try {
              setAnalysisStep('Analizando con IA... (1/4)');
              const claudeResults = await analyzeSpectralCandidatesBatch(data.top_points, selectedMineral, terrainType, rockType);
              if (claudeResults && claudeResults.length > 0) {
                 wasAnalyzed = true;
                 finalPoints = data.top_points.map(p => {
                    const cr = claudeResults.find(c => c.id === p.id);
                    if (cr) {
                      p.score = cr.score;
                      p.indices_analizados = cr.indices_analizados;
                      p.analisis_integral = cr.analisis_integral;
                      p.geologia_interpretada = cr.geologia_interpretada;
                      p.recomendacion = cr.recomendacion;
                    }
                    return p;
                 });
                 finalPoints.sort((a,b) => (b.score||0) - (a.score||0));
                 finalPoints.forEach((p, idx) => p.rank = idx + 1);
              }
           } catch (e) {
              console.log("Offline mode triggered due to AI error");
           }
        }

        // ── Optional ASTER + EMIT + structural deep analysis + consensus fusion
        if (deepAnalysis) {
          let asterResult: AsterSpectralResult | null = null;
          try {
            setAnalysisStep('Consultando ASTER... (2/4)');
            const asterCentLat = coordsToUse.reduce((s, c) => s + c.latitude,  0) / coordsToUse.length;
            const asterCentLng = coordsToUse.reduce((s, c) => s + c.longitude, 0) / coordsToUse.length;
            const coverage = await fetchAsterCoverage(asterCentLat, asterCentLng);
            if (coverage.coverage_ok) {
              const aster = await fetchMiningAsterGrid(coordsToUse, { cell_size_m: cellSizeM });
              setAsterData(aster);
              if (aster.has_coverage && aster.data_source !== 'NO_DATA_OFFLINE') {
                asterResult = aster;
                usedAster = true;
              }
            } else {
              Alert.alert('ASTER', `Sin cobertura en esta zona.\nAnálisis con solo Sentinel-2.\n\n${coverage.message}`);
            }
          } catch (asterErr: any) {
            console.warn('[analyzeZone] ASTER failed:', asterErr.message);
          }

          // ── EMIT hyperspectral grid ─────────────────────────────────────────
          let emitResult: EmitSpectralResult | null = null;
          try {
            setAnalysisStep('Consultando EMIT hiperspectral... (3/4)');
            const emitCoords = coordsToUse.map(c => ({ lat: c.latitude, lng: c.longitude }));
            const emit = await fetchEmitGrid(emitCoords, { cell_size_m: cellSizeM });
            setEmitData(emit);
            if (emit.data_source !== 'NO_DATA_OFFLINE') {
              emitResult = emit;
              usedEmit = true;
            }
          } catch (emitErr: any) {
            console.warn('[analyzeZone] EMIT failed:', emitErr.message);
          }

          // ── Structural grid (Sentinel-1 + DEM) ─────────────────────────────
          let structuralResult: StructuralResult | null = null;
          try {
            setAnalysisStep('Consultando Sentinel-1 + DEM... (4/4)');
            const structCoords = coordsToUse.map(c => ({ lat: c.latitude, lng: c.longitude }));
            const structural = await fetchStructuralGrid(structCoords, { cell_size_m: cellSizeM });
            setStructuralData(structural);
            if (structural.data_source !== 'NO_DATA_OFFLINE') {
              structuralResult = structural;
              usedStruct = true;
            }
          } catch (structErr: any) {
            console.warn('[analyzeZone] Structural failed:', structErr.message);
          }

          // Fuse all available layers
          if (asterResult || emitResult || structuralResult) {
            finalPoints = fuseAnalysisPoints(
              finalPoints, satData, asterResult, emitResult, structuralResult, selectedMineral
            ) as any[];
          }

          // ── Etapa B: enriquecer índices con dato REAL medido de ASTER/EMIT ──
          // Sube la señal de Cu/Zn/Pb donde hay cobertura (carbonato, propilítica,
          // argílica, ferric). Sin cobertura de celda → sin cambios (no se fabrica).
          const deepWeights = data.weights_used;
          if (deepWeights && (((asterResult?.cells?.length ?? 0) > 0) || ((emitResult?.cells?.length ?? 0) > 0))) {
            enrichPointsWithDeepData(finalPoints as any, asterResult?.cells, emitResult?.cells, deepWeights);
            if (data.all_points) enrichPointsWithDeepData(data.all_points as any, asterResult?.cells, emitResult?.cells, deepWeights);
            if (data.top_points) enrichPointsWithDeepData(data.top_points as any, asterResult?.cells, emitResult?.cells, deepWeights);
            // Re-ordenar por base_score enriquecido solo si no hubo ranking por IA.
            if (!wasAnalyzed) {
              finalPoints.sort((a: any, b: any) => (b.base_score || 0) - (a.base_score || 0));
              finalPoints.forEach((p: any, idx: number) => { p.rank = idx + 1; });
            }
          }
        }

        // ── Índice de sílice térmico (ASTER GED) ────────────────────────────
        // BAJO DEMANDA, por familia: solo para sílice/granito/cantera/pómez, que son
        // los únicos a los que la firma térmica del cuarzo aporta algo.
        //
        // Va FUERA de `deepAnalysis` a propósito: para estos materiales el térmico no
        // es un extra opcional, es LA evidencia. Esconderlo tras un toggle significaría
        // que su confianza nunca sube para quien no lo active.
        // No se condiciona a `isConnected`: fetchThermalGrid ya cae a caché y, si no
        // hay nada, devuelve NO_DATA_OFFLINE con quality_ok=false. Colgar la evidencia
        // principal de estos materiales de un flag de red frágil fue justo lo que la
        // dejó muerta.
        let thermalResult: ThermalResult | null = null;
        if (isThermalMaterial(selectedMineral)) {
          try {
            setAnalysisStep('Consultando índice de sílice térmico...');
            const thermalCoords = coordsToUse.map(c => ({ lat: c.latitude, lng: c.longitude }));
            const thermal = await fetchThermalGrid(thermalCoords, { cell_size_m: cellSizeM });
            setThermalData(thermal);
            if (thermal.data_source !== 'NO_DATA_OFFLINE') {
              thermalResult = thermal;
              usedThermal = true;
            }
          } catch (thermalErr: any) {
            console.warn('[analyzeZone] thermal failed:', thermalErr.message);
            setThermalData(null);
          }
        } else {
          // Material no térmico (o sin red): no se arrastra el resultado de un análisis
          // anterior, que hablaría de otra zona u otro material.
          setThermalData(null);
        }

        // Índice de Favorabilidad Exploratoria (SEÑAL + CONFIANZA) de la zona
        // `thermal` aquí SOLO matiza la redacción de las razones (ver
        // ZoneProspectivityOpts). El térmico no entra al score: sigue siendo evidencia
        // paralela que mueve la confianza, según la regla aprobada.
        const zp = computeZoneProspectivity(finalPoints, satData, {
          metal: selectedMineral,
          thermal: thermalResult
            ? { quality_ok: thermalResult.quality_ok, rock_pct: thermalResult.rock_pct }
            : null,
        });
        setZoneProspectivity(zp);

        // Caché local del polígono. OJO: `estado` describe CÓMO se analizó (con el
        // servidor o en modo offline), NO si subió a Supabase. Antes decía 'SYNCED'
        // aquí, lo que daba una falsa sensación de respaldo: nada se había subido.
        await savePoligonoCache({
           id: 'poly_' + Date.now(), mineral: selectedMineral, terrain: terrainType, rock_type: rockType,
           coordenadas: coordsToUse, analisis_resultado: finalPoints,
           estado: wasAnalyzed ? 'ANALIZADO_ONLINE' : 'OFFLINE',
           satdata_source: satData.data_source,
           acquisition_date: satData.acquisition_date,
           prospectivity: zp,
        });

        // El análisis se guarda DENTRO del proyecto activo y se encola a Supabase
        // automáticamente. Antes solo iba a poligonos_cache (tabla local, sin
        // proyecto y sin encolar): si el usuario no pulsaba "Guardar", el análisis
        // no existía para la pantalla de Proyectos ni llegaba nunca a la nube.
        try {
          await saveProjectState(currentProjectId, {
            mineral: selectedMineral,
            terrain: terrainType,
            depth,
            rock_type: rockType,
            rock_source: rockSource,   // la roca y su origen viajan juntos, siempre
            coordenadas: coordsToUse,
            analisis_resultado: finalPoints,
            area_ha: parseFloat(areaHa) || 0,
            satdata_source: satData.data_source,
            acquisition_date: satData.acquisition_date,
            prospectivity: zp,
          });
          // Pide el envío a Supabase. Sin esto, el análisis quedaba encolado en
          // SQLite y solo subía al reiniciar la app.
          scheduleFlush();
        } catch (e) {
          console.warn('[Analisis] no se pudo persistir en el proyecto:', e);
        }

        // Telemetría de costos: contexto del análisis (hectáreas + fuentes disparadas).
        logAnalisisZona({
          analisisId, hectareas: data.area_ha, material: selectedMineral,
          fuentes: { s2: true, aster: usedAster, emit: usedEmit, s1: usedStruct, dem: usedStruct, thermal: usedThermal },
          // Propuesta vs final: comparar ambas da la tasa de acierto de la carta.
          roca: { propuesta: rockProposal?.rock_type ?? null, final: rockType, origen: rockSource },
        });

        setAnalysisPoints(finalPoints);

        // #13 — Validación con yacimientos conocidos (USGS MRDS, base GLOBAL). No bloquea el análisis.
        setKnownOccurrences(null);
        (async () => {
          try {
            const oLats = coordsToUse.map((c: any) => c.latitude ?? c.lat).filter((n: any) => Number.isFinite(n)) as number[];
            const oLngs = coordsToUse.map((c: any) => c.longitude ?? c.lng).filter((n: any) => Number.isFinite(n)) as number[];
            if (oLats.length && oLngs.length) {
              setKnownOccurrences(await fetchKnownOccurrences({
                latMin: Math.min(...oLats), latMax: Math.max(...oLats),
                lngMin: Math.min(...oLngs), lngMax: Math.max(...oLngs),
              }));
            }
          } catch { /* MRDS no debe romper el análisis */ }
        })();
        // Scores por metal desde los índices S2 REALES de los puntos analizados (no centroide sintético)
        setMetalScores(computeAllMetalScores(data.all_points || data.top_points, terrainType));
        const zonas: any[] = [];
        const sourcePoints = data.all_points || data.top_points;
        const latStep = data.grid_size ? data.grid_size.latStep / 2 : 0.0005;
        const lngStep = data.grid_size ? data.grid_size.lngStep / 2 : 0.0005;

        sourcePoints.forEach((point: any) => {
          let color = 'rgba(68,255,68,0.4)'; // Verde (Baja prob)
          const score = point.base_score || point.score || 0;
          if (score > 80) color = 'rgba(255,68,68,0.6)';      // Rojo Intenso
          else if (score > 60) color = 'rgba(255,165,0,0.5)'; // Naranja
          else if (score > 40) color = 'rgba(255,221,68,0.4)'; // Amarillo
          
          zonas.push({
            coordinates: [
              { latitude: point.lat - latStep, longitude: point.lng - lngStep },
              { latitude: point.lat - latStep, longitude: point.lng + lngStep },
              { latitude: point.lat + latStep, longitude: point.lng + lngStep },
              { latitude: point.lat + latStep, longitude: point.lng - lngStep },
            ],
            color: color
          });
        });
        setZoneColors(zonas);
        setShowHeatmap(true);
        setShowResults(true);
        setResultsCollapsed(false); // análisis nuevo → mostrar resultados desplegados
        setGeologoBadge(true);
        triggerHaptic('success');
        
        mapRef.current?.animateToRegion({
          latitude: data.top_points[0].lat,
          longitude: data.top_points[0].lng,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }, 800);
        Alert.alert('Éxito', `Se descubrieron ${data.top_points.length} puntos potenciales`);
      } else {
        Alert.alert('Error', 'No se recibieron puntos');
      }
    } catch (error: any) {
      console.error('Error:', error);
      Alert.alert('Error', 'Conexión fallida: ' + error.message);
    } finally {
      setIsAnalyzing(false);
      setAnalysisStep('');
    }
  };

  // Geometry
  let resolvedPolygonCoords = polygonCoords;
  if (drawingType === 'rectangle' && rectPointA && rectPointB) {
    resolvedPolygonCoords = [
      { latitude: rectPointA.latitude, longitude: rectPointA.longitude },
      { latitude: rectPointA.latitude, longitude: rectPointB.longitude },
      { latitude: rectPointB.latitude, longitude: rectPointB.longitude },
      { latitude: rectPointB.latitude, longitude: rectPointA.longitude },
    ];
  }

  // Calc stats
  let areaM2 = 0;
  let infoText = "";
  
  if (resolvedPolygonCoords.length > 2 && (drawingType === 'polygon' || drawingType === 'none')) {
    areaM2 = calcPolygonArea(resolvedPolygonCoords);
    infoText = `Vértices: ${resolvedPolygonCoords.length}`;
  } else if (drawingType === 'rectangle' && rectPointA && rectPointB) {
    areaM2 = calcPolygonArea(resolvedPolygonCoords);
    infoText = `Área diametral`;
  }

  const areaHa = (areaM2 / 10000).toFixed(2);
  const areaKm2 = (areaM2 / 1000000).toFixed(4);
  const showStatsBox = areaM2 > 0;

  // Semáforo de superficie: normal → ámbar (>5.000 ha) → rojo (>10.000 ha).
  const areaHaNum = areaM2 / 10000;
  const areaLevel = getAreaLevel(areaHaNum);
  const areaColor = AREA_LEVEL_COLOR[areaLevel];
  const areaBlocked = areaLevel === 'block';

  if (errorMsg) return <View style={styles.center}><Text style={styles.errorText}>{errorMsg}</Text></View>;
  if (!location) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#FFD700" />
      <Text style={styles.loadingText}>Calibrando GPS...</Text>
    </View>
  );

  const { latitude, longitude, altitude } = location.coords;
  const trueHeading = heading ? heading.trueHeading || heading.magHeading : 0;
  const blockScroll = drawingType === 'rectangle';

  function fieldDaysSince(dateStr: string): number {
    if (!dateStr) return 0;
    const normalized = dateStr.replace(' ', 'T') + (dateStr.includes('T') ? '' : 'Z');
    return Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 86400000));
  }

  return (
    <View style={styles.container}>
      
      {/* 70% MAPA SUPERIOR */}
      <View style={styles.mapContainer}>
        <MapView
          ref={mapRef}
          style={styles.map}
          mapType={mapLayer}
          showsUserLocation={false}
          followsUserLocation={false}
          showsCompass={false}
          scrollEnabled={!blockScroll}
          region={mapCenter || undefined}
          onRegionChange={(region: any) => { if (region.heading !== undefined) { setMapRotation(region.heading); } setCurrentZoom(region.latitudeDelta); }}
          onRegionChangeComplete={handleRegionChangeComplete}
          onPress={handleMapPress}
          onPanDrag={handlePanDrag}
        >
          {/* Overlay OSM (ríos/arroyos/caminos finos). Va primero → queda detrás de
              polígonos, heatmap y marcadores. Cobertura/atribución © OpenStreetMap. */}
          {osmOverlay && (
            <UrlTile
              urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              maximumZ={19}
              tileSize={256}
              zIndex={-1}
            />
          )}
          {location && (
            <Marker coordinate={{latitude: location.coords.latitude, longitude: location.coords.longitude}} anchor={{x: 0.5, y: 0.5}} zIndex={100} flat>
              <View style={{alignItems: 'center'}}>
                {trueHeading !== null && trueHeading !== undefined && (
                  <View style={{ transform: [{ rotate: `${trueHeading}deg` }], marginBottom: -4, zIndex: -1 }}>
                    <MaterialCommunityIcons name="navigation" size={20} color="rgba(0,122,255,0.8)" />
                  </View>
                )}
                <View style={{width: 16, height: 16, borderRadius: 8, backgroundColor: '#007AFF', borderWidth: 2, borderColor: '#FFF', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3, elevation: 5}} />
              </View>
            </Marker>
          )}

          {resolvedPolygonCoords.length > 0 && (
            <Polygon
              coordinates={resolvedPolygonCoords}
              strokeColor={showHeatmap && zoneColors.length > 0 ? "rgba(255,255,255,0.8)" : "#FFD700"}
              fillColor={showHeatmap && zoneColors.length > 0 ? "transparent" : "rgba(255, 215, 0, 0.3)"}
              strokeWidth={showHeatmap ? 2 : 3}
              zIndex={3}
            />
          )}

          {showHeatmap && zoneColors.map((zona: any, idx: number) => (
            <Polygon 
              key={`heat-${idx}`} 
              coordinates={zona.coordinates} 
              strokeColor="transparent" 
              fillColor={zona.color} 
              strokeWidth={0} 
              zIndex={2} 
            />
          ))}

          {resolvedPolygonCoords.map((coord, i) => (
            <Marker key={`p-${i}`} coordinate={coord} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={[styles.numberedMarker, { backgroundColor: '#87CEFA', borderColor: '#FFF', width: 22, height: 22 }]}>
                <Text style={[styles.numberedMarkerText, { fontSize: 11 }]}>{i + 1}</Text>
              </View>
            </Marker>
          ))}

          {(currentZoom > 0.05 ? analysisPoints.filter(p => p.rank <= 10) : analysisPoints).map((point, idx) => (
            <Marker 
              key={idx} 
              coordinate={{latitude: point.lat, longitude: point.lng}}
              centerOffset={{x: 0, y: -14}}
              onPress={() => { setSelectedPoint(point); setTapPoint(null); }}
            >
              <View style={{alignItems: 'center'}}>
                 <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFD700', borderWidth: 1, borderColor: '#000', justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.6, shadowRadius: 3, elevation: 5 }}>
                   <Text style={{color:'#000', fontWeight:'bold', fontSize: 12}}>{point.rank}</Text>
                 </View>
                 <View style={{ width: 1.5, height: 8, backgroundColor: '#000' }} />
                 <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: '#FFD700', borderWidth: 1, borderColor: '#000' }} />
               </View>
            </Marker>
          ))}

          {waypoints.map((wp) => (
            <Marker key={wp.id} coordinate={{ latitude: wp.lat || wp.latitude || 0, longitude: wp.lng || wp.longitude || 0 }} title="MUESTRA" description={wp.note}>
              <View style={styles.waypointMarker}>
                <MaterialCommunityIcons name="pickaxe" size={20} color="#000" />
              </View>
            </Marker>
          ))}

          {/* #13 — Yacimientos conocidos USGS MRDS (validación global) */}
          {knownOccurrences?.occurrences?.map((occ, i) => (
            <Marker
              key={`mrds-${i}`}
              coordinate={{ latitude: occ.lat, longitude: occ.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={60}
              title={occ.name}
              description={[occ.commodity, occ.status].filter(Boolean).join(' · ') || 'USGS MRDS'}
            >
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#4FC3F7', borderWidth: 1.5, borderColor: '#0A0A0A', justifyContent: 'center', alignItems: 'center' }}>
                <MaterialCommunityIcons name="diamond-stone" size={13} color="#0A0A0A" />
              </View>
            </Marker>
          ))}

          {/* #7 — Marcador temporal del punto de partida ingresado por coordenada */}
          {startMarker && (
            <Marker coordinate={startMarker} anchor={{ x: 0.5, y: 1 }} zIndex={90} title="Punto de partida">
              <MaterialCommunityIcons name="map-marker" size={36} color="#FFD700" />
            </Marker>
          )}

        </MapView>

        {/* OVERLAYS DENTRO DEL MAPA */}

        {/* CHATBOT BUTTON REMOVED IN FAVOR OF DIRECT MAP TAP */}

        {/* CROSSHAIR */}
        {drawingType === 'polygon' && (
          <View style={styles.crosshairContainer} pointerEvents="none">
            <View style={{ alignItems: 'center', justifyContent: 'center' }}>
              {/* Horizontal line */}
              <View style={{ position: 'absolute', width: 64, height: 2, backgroundColor: 'rgba(255,215,0,0.7)' }} />
              {/* Vertical line */}
              <View style={{ position: 'absolute', width: 2, height: 64, backgroundColor: 'rgba(255,215,0,0.7)' }} />
              {/* Center dot */}
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFD700', borderWidth: 1, borderColor: '#000' }} />
            </View>
          </View>
        )}

        {/* CONFIG CHIP — mineral + terrain quick access */}
        <TouchableOpacity
          style={styles.configChip}
          onPress={() => setShowConfigModal(true)}
        >
          <Text style={styles.configChipText} numberOfLines={1}>
            {materialIcon(selectedMineral)} {materialLabel(selectedMineral)} · {terrainType}
          </Text>
        </TouchableOpacity>


        {/* MINI OVERLAY PANELES */}
        {!showStatsBox && (
          <View style={[styles.panel, styles.topPanel, { borderRadius: 12}]}>
            <View style={styles.row}>
              <MaterialCommunityIcons name="satellite-variant" size={16} color="#FFD700" />
              <Text style={[styles.titleText, {fontSize: 11}]}> GPS: LAT {latitude.toFixed(4)} | LON {longitude.toFixed(4)}</Text>
            </View>
          </View>
        )}

        {/* ZOOM BOTONES — ocultos durante trazado para no interferir con vértices */}
        {drawingType !== 'polygon' && (
          <View style={styles.zoomControlsContainer}>
            <TouchableOpacity style={styles.zoomBtn} onPress={zoomIn}>
              <MaterialCommunityIcons name="plus" size={24} color="#000" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.zoomBtn} onPress={zoomOut}>
              <MaterialCommunityIcons name="minus" size={24} color="#000" />
            </TouchableOpacity>
          </View>
        )}

        {/* Selector de CAPAS (#6) */}
        <TouchableOpacity style={styles.layerButton} onPress={() => setShowLayerMenu(v => !v)}>
          <MaterialCommunityIcons name="layers" size={22} color="#FFD700" />
        </TouchableOpacity>
        {showLayerMenu && (
          <View style={styles.layerMenu}>
            <Text style={styles.layerMenuTitle}>CAPAS DEL MAPA</Text>
            <TouchableOpacity style={styles.layerMenuItem} onPress={() => { setMapLayer('satellite'); setShowLayerMenu(false); }}>
              <MaterialCommunityIcons name={mapLayer === 'satellite' ? 'radiobox-marked' : 'radiobox-blank'} size={16} color="#FFD700" />
              <Text style={styles.layerMenuText}>Satélite</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.layerMenuItem} onPress={() => { setMapLayer('hybrid'); setShowLayerMenu(false); }}>
              <MaterialCommunityIcons name={mapLayer === 'hybrid' ? 'radiobox-marked' : 'radiobox-blank'} size={16} color="#FFD700" />
              <Text style={styles.layerMenuText}>Híbrido — calles · poblados · límites</Text>
            </TouchableOpacity>
            <View style={styles.layerMenuDivider} />
            <TouchableOpacity style={styles.layerMenuItem} onPress={() => setOsmOverlay(v => !v)}>
              <MaterialCommunityIcons name={osmOverlay ? 'checkbox-marked' : 'checkbox-blank-outline'} size={16} color="#FFD700" />
              <Text style={styles.layerMenuText}>Detalle OSM — ríos · arroyos · caminos</Text>
            </TouchableOpacity>
            <Text style={styles.layerMenuNote}>Ríos/arroyos finos vienen de OpenStreetMap; la cobertura varía por zona. © OpenStreetMap</Text>
          </View>
        )}

        <TouchableOpacity style={styles.locationButton} onPress={() => { if (location) { mapRef.current?.animateToRegion({ latitude: location.coords.latitude, longitude: location.coords.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 }, 500); } }}><MaterialCommunityIcons name="crosshairs-gps" size={24} color="#FFD700" /></TouchableOpacity>

        <View style={styles.northIndicator}><View style={[styles.northArrow, { transform: [{ rotate: `${-mapRotation}deg` }] }]}><MaterialCommunityIcons name="arrow-up" size={28} color="#FFD700" /><Text style={styles.northText}>N</Text></View></View>

        {/* STATUS PILL — Online/Offline · Capa ON/OFF (top right) */}
        <View style={styles.statusPill}>
          <TouchableOpacity
            onPress={() => Alert.alert('Conexión', isSyncing ? 'Sincronizando...' : (isConnected ? 'Online — Conectado a Claude' : 'Offline — Motor Local'))}
            style={styles.statusPillSide}
          >
            <View style={[styles.statusDot, { backgroundColor: isConnected ? '#44FF44' : '#666' }]} />
            <Text style={styles.statusPillText}>{isConnected ? 'Online' : 'Offline'}</Text>
          </TouchableOpacity>
          <View style={styles.statusPillDivider} />
          <TouchableOpacity onPress={() => setShowHeatmap(!showHeatmap)} style={styles.statusPillSide}>
            <Text style={[styles.statusPillText, { color: showHeatmap ? '#FFD700' : '#666' }]}>
              Capa {showHeatmap ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ALTITUDE — compact horizontal pill, bottom-left */}
        <View style={styles.hudCornerPill}>
          <MaterialCommunityIcons name="image-filter-hdr" size={13} color="#88CCFF" />
          <Text style={styles.hudCornerText}>{altitude != null ? `${altitude.toFixed(0)} m` : '—'}</Text>
        </View>

        {/* RUMBO — compact horizontal pill, bottom-right */}
        <View style={[styles.hudCornerPill, { left: undefined, right: 10 }]}>
          <MaterialCommunityIcons
            name="navigation"
            size={13}
            color="#00FFFF"
            style={trueHeading != null ? { transform: [{ rotate: `${trueHeading}deg` }] } : undefined}
          />
          <Text style={styles.hudCornerText}>{trueHeading != null ? `${Math.round(trueHeading)}°` : '—'}</Text>
        </View>

      </View>

      {/* CONSOLA INFERIOR COMPACTA */}
      {isFieldMode ? (
        /* ─── FIELD MODE CONSOLE ─────────────────────────────────── */
        <View style={fieldStyles.console}>
          {/* Status bar */}
          <View style={fieldStyles.statusBar}>
            <Text style={fieldStyles.statusText} numberOfLines={1}>
              {fieldPackageInfo
                ? `🎒 Modo campo · datos guardados hace ${fieldDaysSince(fieldPackageInfo.preparado_at)} días`
                : '🎒 Modo campo activo'}
            </Text>
            <TouchableOpacity
              style={fieldStyles.exitBtn}
              onPress={() => setIsFieldMode(false)}
              accessibilityLabel="Salir del modo campo"
            >
              <Text style={fieldStyles.exitBtnText}>✕ Salir</Text>
            </TouchableOpacity>
          </View>
          {/* Large action buttons */}
          <View style={fieldStyles.btnRow}>
            <TouchableOpacity
              style={fieldStyles.bigBtn}
              onPress={() => setShowWaypointModal(true)}
              activeOpacity={0.75}
            >
              <MaterialCommunityIcons name="camera-plus" size={30} color={Colors.fieldPrimary} />
              <Text style={fieldStyles.bigBtnLabel}>📷 MUESTRA</Text>
              <Text style={fieldStyles.bigBtnSub}>1 toque</Text>
            </TouchableOpacity>
            <View style={fieldStyles.btnDivider} />
            <TouchableOpacity
              style={fieldStyles.bigBtn}
              onPress={() => setShowHistoryModal(true)}
              activeOpacity={0.75}
            >
              <MaterialCommunityIcons name="history" size={30} color={Colors.fieldPrimary} />
              <Text style={fieldStyles.bigBtnLabel}>HISTORIAL</Text>
              <Text style={fieldStyles.bigBtnSub}>{waypoints.length} muestras</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* ─── NORMAL CONSOLE ─────────────────────────────────────── */
        <View style={styles.consoleContainer}>

          {/* ONBOARDING TIP BANNER */}
          {activeTip && (
            <TouchableOpacity
              onPress={dismissTip}
              style={{
                backgroundColor: 'rgba(255,215,0,0.12)',
                borderTopWidth: 1,
                borderColor: '#B8960C',
                paddingHorizontal: 16,
                paddingVertical: 10,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <Text style={{ flex: 1, fontSize: 13, color: '#FFD700', lineHeight: 18 }}>
                {activeTip === 1 && '1️⃣  Revisa el chip oro·sierra arriba — define qué mineral buscas en Ajustes'}
                {activeTip === 2 && '✏️  Marca mínimo 3 puntos y presiona ANALIZAR para ver resultados'}
                {activeTip === 3 && '🧑‍🔬  Siguiente: pregunta al Ing. Villegas en Geólogo y prepara el paquete en Más → Campo'}
              </Text>
              <Text style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>✕</Text>
            </TouchableOpacity>
          )}

          {/* BARRA DE HERRAMIENTAS FIJA */}
          <View style={styles.toolbarRow}>
            <TouchableOpacity style={styles.toolbarBtn} onPress={() => setShowConfigModal(true)}>
              <MaterialCommunityIcons name="cog" size={22} color="#FFD700" />
              <Text style={styles.toolbarBtnLabel} numberOfLines={1}>Ajustes</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.toolbarBtn} onPress={() => { setCoordError(null); setShowCoordModal(true); }}>
              <MaterialCommunityIcons name="map-marker-plus" size={22} color="#FFD700" />
              <Text style={styles.toolbarBtnLabel} numberOfLines={1}>Ir a</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolbarBtn, drawingType === 'polygon' && styles.toolbarBtnActive]}
              onPress={() => {
                if (drawingType === 'polygon') {
                  selectMode('none');
                } else if (resolvedPolygonCoords.length >= 3 && showResults) {
                  Alert.alert('Nuevo trazado', 'Hay un análisis sin guardar. ¿Descartar y trazar nueva zona?', [
                    { text: 'Cancelar', style: 'cancel' },
                    { text: 'Descartar y trazar', style: 'destructive', onPress: () => selectMode('polygon') },
                  ]);
                } else {
                  selectMode('polygon');
                }
              }}
              onLongPress={() => {
                if (drawingType === 'none') {
                  Alert.alert('Modo de trazado', 'Elige el tipo de zona a trazar:', [
                    { text: '⬠ Polígono libre', onPress: () => { setDrawingType('polygon'); triggerHaptic('medium'); } },
                    { text: '▭ Rectángulo', onPress: () => { setDrawingType('rectangle'); triggerHaptic('medium'); } },
                    { text: 'Cancelar', style: 'cancel' },
                  ]);
                }
              }}
            >
              <MaterialCommunityIcons
                name={drawingType === 'polygon' ? 'close-circle-outline' : resolvedPolygonCoords.length >= 3 ? 'vector-polygon' : 'draw-pen'}
                size={22}
                color={drawingType === 'polygon' ? '#000' : '#FFD700'}
              />
              <Text style={[styles.toolbarBtnLabel, drawingType === 'polygon' && { color: '#000' }]} numberOfLines={1}>
                {drawingType === 'polygon' ? 'Salir' : resolvedPolygonCoords.length >= 3 ? 'Nuevo' : 'Trazar'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.toolbarBtn} onPress={() => setShowMoreSheet(true)}>
              <MaterialCommunityIcons name="dots-horizontal-circle-outline" size={22} color="#FFD700" />
              <Text style={styles.toolbarBtnLabel} numberOfLines={1}>Más</Text>
            </TouchableOpacity>
          </View>

          {/* CONSOLA COMPACTA DE 1 LÍNEA */}
          {drawingType === 'polygon' ? (
            <View style={[
              styles.consoleBar,
              // Con aviso o bloqueo la barra crece para caber el mensaje.
              areaLevel !== 'ok' && polygonCoords.length >= 3 && {
                flexDirection: 'column', alignItems: 'stretch', maxHeight: undefined, minHeight: undefined, paddingVertical: 8,
              },
            ]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={styles.consoleBarLeft}>
                  <MaterialCommunityIcons name="vector-polygon" size={16} color={polygonCoords.length >= 3 ? areaColor : '#FFD700'} />
                  {/* La píldora lleva flexShrink:0: sin él se encogía hasta el ancho de
                      una letra dentro de la barra y el texto salía apilado en vertical,
                      una letra por línea. numberOfLines={1} lo remata. */}
                  {polygonCoords.length < 3 ? (
                    <View style={{ marginLeft: 6, flexShrink: 0, backgroundColor: 'rgba(255,215,0,0.15)', borderRadius: 12, borderWidth: 1, borderColor: '#B8960C', paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ color: '#FFD700', fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
                        {polygonCoords.length} de 3 puntos mínimos
                      </Text>
                    </View>
                  ) : (
                    <Text style={[styles.consoleBarText, { color: areaColor }]} numberOfLines={1}>
                      {' '}{areaHa} ha{areaLevel !== 'ok' ? ' ⚠️' : ''} · ~{Math.round(computeAdaptiveCellSize(parseFloat(areaHa) || 0))} m/celda
                    </Text>
                  )}
                </View>
                <View style={styles.consoleBarActions}>
                  <TouchableOpacity style={styles.consoleBtnSecondary} onPress={addPointFromCrosshair}>
                    <MaterialCommunityIcons name="target" size={14} color="#FFD700" />
                    <Text style={styles.consoleBtnSecondaryText}> MARCAR</Text>
                  </TouchableOpacity>
                  {/* ANALIZAR reserva su lugar siempre: invisible/deshabilitado hasta el 3er punto
                      para que el botón MARCAR no se desplace al aparecer. Si la zona supera el
                      tope de hectáreas se pinta como bloqueado; al tocarlo explica por qué. */}
                  <TouchableOpacity
                    style={[
                      styles.consoleBtnPrimary,
                      polygonCoords.length < 3 && { opacity: 0 },
                      areaBlocked && styles.consoleBtnBlocked,
                    ]}
                    onPress={() => finishDrawing()}
                    disabled={polygonCoords.length < 3}
                  >
                    <MaterialCommunityIcons name="radar" size={14} color={areaBlocked ? '#FFF' : '#000'} />
                    <Text style={[styles.consoleBtnPrimaryText, areaBlocked && { color: '#FFF' }]}> ANALIZAR</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.consoleBtnDanger} onPress={() => setPolygonCoords([])}>
                    <Text style={styles.consoleBtnDangerText}>LIMPIAR</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {polygonCoords.length >= 3 && areaLevel !== 'ok' && (
                <Text style={[styles.consoleAreaNote, { color: areaColor }]}>
                  {areaBlocked ? areaBlockMessage(areaHaNum) : AREA_WARN_MESSAGE}
                </Text>
              )}
            </View>
          ) : isAnalyzing ? (
            <View style={styles.consoleBar}>
              <ActivityIndicator size="small" color="#FFD700" style={{ marginRight: 8 }} />
              <Text style={styles.consoleBarText} numberOfLines={1}>
                {analysisStep || 'Consultando Sentinel-2...'}
              </Text>
            </View>
          ) : resolvedPolygonCoords.length >= 3 && !showResults ? (
            <View style={[styles.consoleBar, { flexDirection: 'column', alignItems: 'stretch', maxHeight: undefined, minHeight: undefined, paddingVertical: 8 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <MaterialCommunityIcons name="ruler-square" size={18} color={areaColor} />
                <Text style={[styles.consoleAreaMain, { marginLeft: 6, color: areaColor }]} numberOfLines={1}>
                  {areaHa} ha{areaLevel !== 'ok' ? '  ⚠️' : ''}
                </Text>
                <Text style={[styles.consoleAreaSub, { marginLeft: 10, flexShrink: 1 }]} numberOfLines={1}>
                  Resolución ~{Math.round(computeAdaptiveCellSize(parseFloat(areaHa) || 0))} m/celda
                </Text>
              </View>
              {areaLevel !== 'ok' && (
                <Text style={[styles.consoleAreaNote, { color: areaColor, marginBottom: 8 }]}>
                  {areaBlocked ? areaBlockMessage(areaHaNum) : AREA_WARN_MESSAGE}
                </Text>
              )}
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                <TouchableOpacity style={styles.consoleBtnDanger} onPress={clearShapes}>
                  <Text style={styles.consoleBtnDangerText}>BORRAR</Text>
                </TouchableOpacity>
                {/* Sobre el tope de hectáreas el botón se pinta bloqueado; al tocarlo
                    explica por qué y no dispara el análisis (guarda en analyzeZone). */}
                <Pressable
                  style={({ pressed }) => [styles.consoleBtnPrimary, areaBlocked && styles.consoleBtnBlocked, pressed && { opacity: 0.75 }]}
                  onPress={() => analyzeZone()}
                  disabled={isAnalyzing}
                >
                  <MaterialCommunityIcons name="brain" size={14} color={areaBlocked ? '#FFF' : '#000'} />
                  <Text style={[styles.consoleBtnPrimaryText, areaBlocked && { color: '#FFF' }]}> ANALIZAR</Text>
                </Pressable>
              </View>
            </View>
          ) : showResults ? (
            <View style={styles.consoleBar}>
              <View style={styles.consoleBarLeft}>
                <Text style={{ fontSize: 14 }}>✅</Text>
                <Text style={styles.consoleBarText} numberOfLines={1}>
                  {' '}{analysisPoints.length} zonas · celda {satelliteData?.cell_size_m ?? '—'} m · {selectedMineral.toUpperCase()}
                </Text>
              </View>
              <TouchableOpacity style={styles.consoleBtnSecondary} onPress={clearShapes}>
                <MaterialCommunityIcons name="refresh" size={14} color="#FFD700" />
                <Text style={styles.consoleBtnSecondaryText}> Nueva zona</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.consoleBar}>
              <MaterialCommunityIcons name="map-search-outline" size={16} color="#555" style={{ marginRight: 6 }} />
              <Text style={[styles.consoleBarText, { color: '#555' }]} numberOfLines={1}>
                Toca Trazar para delimitar una zona
              </Text>
            </View>
          )}
        </View>
      )}

      {showResults && !isAnalyzing && (
        <TouchableOpacity
          style={styles.nextStepBanner}
          onPress={() => router.push('/(tabs)/geologo')}
          activeOpacity={0.8}
        >
          <Text style={styles.nextStepText}>🧑‍🔬 Pregunta al geólogo sobre este análisis →</Text>
        </TouchableOpacity>
      )}

      {showResults && (
        <ResultsPanel
          thermalData={thermalData}
          rockType={rockType}
          rockSource={rockSource}
          rockProposal={rockProposal}
          satelliteData={satelliteData}
          metalScores={metalScores}
          analysisPoints={analysisPoints}
          zoneProspectivity={zoneProspectivity}
          knownOccurrences={knownOccurrences}
          selectedMineral={selectedMineral}
          terrainType={terrainType}
          areaHa={areaHa}
          mapRef={mapRef}
          collapsed={resultsCollapsed}
          onToggleCollapsed={() => setResultsCollapsed(v => !v)}
          onClose={() => {
            setShowResults(false);
            AsyncStorage.getItem('hasSeenTip_3').then(seen => { if (!seen) setActiveTip(3); });
          }}
          onNavigateTo={(lat, lng) => setNavTarget({ lat, lng })}
          onInterpret={async (context: string) => {
            await AsyncStorage.setItem('pendingGeologoInterpretation', context);
            router.push('/(tabs)/geologo');
          }}
        />
      )}

      {/* ── TAP POINT ANALYSIS PANEL ────────────────────────────────────────── */}
      {tapPoint && (
        <TapPanel
          tapPoint={tapPoint}
          satelliteData={satelliteData}
          onClose={() => setTapPoint(null)}
        />
      )}

      <SelectedPointModal
        selectedPoint={selectedPoint}
        satelliteData={satelliteData}
        thermalData={thermalData}
        rockType={rockType}
        rockSource={rockSource}
        rockProposal={rockProposal}
        selectedMineral={selectedMineral}
        terrainType={terrainType}
        mapRef={mapRef}
        allPoints={analysisPoints}
        onInterpret={async (context: string) => {
          await AsyncStorage.setItem('pendingGeologoInterpretation', context);
          setSelectedPoint(null);
          router.push('/(tabs)/geologo');
        }}
        onClose={() => setSelectedPoint(null)}
        onSaveSample={() => {
          mapRef.current?.animateToRegion({ latitude: selectedPoint?.lat, longitude: selectedPoint?.lng, latitudeDelta: 0.002, longitudeDelta: 0.002 }, 0);
          setSampleBase64(null); setAiResult(null); setWaypointNote('');
          setShowWaypointModal(true);
          setSelectedPoint(null);
        }}
      />

      <WaypointModal
        visible={showWaypointModal}
        isFieldMode={isFieldMode}
        activeProject={activeProject}
        mapCenterLat={mapCenter?.latitude}
        gpsLat={location?.coords.latitude}
        gpsLng={location?.coords.longitude}
        sampleBase64={sampleBase64}
        sampleCaptureType={sampleCaptureType}
        isAiProcessing={isAiProcessing}
        aiResult={aiResult}
        waypointNote={waypointNote}
        onWaypointNoteChange={setWaypointNote}
        onTakePhoto={takeSamplePhoto}
        onRunAI={() => sampleBase64 && runAI(sampleBase64, sampleCaptureType)}
        onRetry={() => { setSampleBase64(null); setAiResult(null); }}
        onSave={saveWaypoint}
        onClose={() => { setSampleBase64(null); setAiResult(null); setShowWaypointModal(false); }}
      />

      <HistoryModal
        visible={showHistoryModal}
        waypoints={waypoints}
        isFieldMode={isFieldMode}
        onClose={() => setShowHistoryModal(false)}
        onClear={async () => { await clearMuestras(); loadMuestras(); }}
        onExport={exportCSV}
        onViewDetail={(wp: any) => { setSelectedSample(wp); setShowSampleDetail(true); }}
      />

      {selectedSample && (
        <SampleDetailModal
          visible={showSampleDetail}
          onClose={() => { setShowSampleDetail(false); setSelectedSample(null); }}
          onLabelPress={() => { setShowSampleDetail(false); setShowSampleLabel(true); }}
          sample={selectedSample}
          projectId={activeProject}
          metalTarget={selectedMineral}
          onLabSaved={async () => { await loadMuestras(); }}
          onValidationSaved={async () => { await loadMuestras(); }}
        />
      )}
      {selectedSample && (
        <SampleLabelModal
          visible={showSampleLabel}
          onClose={() => { setShowSampleLabel(false); setSelectedSample(null); }}
          sample={selectedSample}
        />
      )}

      <MoreSheet
        visible={showMoreSheet}
        onClose={() => setShowMoreSheet(false)}
        projectName={activeProject}
        isFieldMode={isFieldMode}
        onCamara={() => setShowWaypointModal(true)}
        onToggleSolarNoche={() => setIsFieldMode(v => !v)}
        onHistorial={() => setShowHistoryModal(true)}
        onGuardar={async () => {
          try {
            await saveProjectState(currentProjectId, {
              mineral: selectedMineral,
              terrain: terrainType,
              depth,
              rock_type: rockType,
              rock_source: rockSource,   // la roca y su origen viajan juntos, siempre
              coordenadas: polygonCoords,
              analisis_resultado: analysisPoints,
              area_ha: parseFloat(areaHa) || 0,
              prospectivity: zoneProspectivity,
            });
            Alert.alert('Guardado', 'Proyecto actualizado correctamente.');
          } catch (e: any) {
            Alert.alert('Error', 'No se pudo guardar: ' + e.message);
          }
        }}
        onCampo={() => fieldModeButtonRef.current?.triggerPrepare()}
        onPDF={handleGenerateReport}
        onAjustes={() => setShowConfigModal(true)}
      />

      {/* FieldModeButton mounted off-screen so the ref + imperative handle works */}
      <View style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <FieldModeButton
          ref={fieldModeButtonRef}
          projectId={currentProjectId}
          analysisPoints={analysisPoints}
          geologoResumen={geologoResumen}
          zoneCoords={resolvedPolygonCoords.map(c => ({ lat: c.latitude, lng: c.longitude }))}
          isConnected={isConnected}
          onInfo={(info) => setFieldPackageInfo(info)}
        />
      </View>

      {/* NAV HUD — bearing + distance to selected ranking point */}
      {navTarget && location && (() => {
        const dist = distanceMTo(location.coords.latitude, location.coords.longitude, navTarget.lat, navTarget.lng);
        const bear = bearingTo(location.coords.latitude, location.coords.longitude, navTarget.lat, navTarget.lng);
        const relBear = (bear - (heading?.trueHeading ?? 0) + 360) % 360;
        const cardinalDir = ['N','NE','E','SE','S','SO','O','NO'][Math.round(bear / 45) % 8];
        const distStr = dist < 1000 ? `${Math.round(dist)} m` : `${(dist/1000).toFixed(1)} km`;
        return (
          <TouchableOpacity
            style={{ position: 'absolute', top: 136, right: 10, backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: 12, borderWidth: 1, borderColor: '#FFD700', paddingHorizontal: 10, paddingVertical: 8, zIndex: 25, alignItems: 'center' }}
            onPress={() => setNavTarget(null)}
          >
            <MaterialCommunityIcons name="navigation" size={20} color="#FFD700" style={{ transform: [{ rotate: `${relBear}deg` }] }} />
            <Text style={{ color: '#FFD700', fontSize: 13, fontWeight: '700' }}>{distStr}</Text>
            <Text style={{ color: '#AAA', fontSize: 10 }}>{cardinalDir} · tocar para cerrar</Text>
          </TouchableOpacity>
        );
      })()}

      <ConfigModal
        visible={showConfigModal}
        isFieldMode={isFieldMode}
        activeProject={activeProject}
        selectedMineral={selectedMineral}
        terrainType={terrainType}
        depth={depth}
        rockType={rockType}
        useAI={useAI}
        autoAnalyzeSample={autoAnalyzeSample}
        uvLamp={uvLamp}
        microscopeConnected={microscopeConnected}
        autoSync={autoSync}
        vibrationEnabled={vibrationEnabled}
        onClose={() => setShowConfigModal(false)}
        setActiveProject={setActiveProject}
        onProjectCreated={async (id, nombre) => {
          // UNA sola verdad: el proyecto recién creado pasa a ser el activo, y su id
          // es el que usarán análisis y muestras a partir de aquí.
          await AsyncStorage.setItem('currentProjectId', id);
          setCurrentProjectId(id);
          loadedProjectRef.current = id;
          setActiveProject(nombre);
          setAnalysisPoints([]);
          setZoneProspectivity(null);
          setShowResults(false);
          await loadMuestras();
        }}
        onRenameActiveProject={async (nombre) => {
          try {
            await renameProject(currentProjectId, nombre);
          } catch (e) {
            console.warn('[Proyecto] no se pudo renombrar:', e);
          }
        }}
        setSelectedMineral={handleSetMineral}
        setTerrainType={handleSetTerrain}
        setDepth={setDepth}
        setRockType={handleSetRockType}
        rockProposal={rockProposal}
        rockSource={rockSource}
        setUseAI={setUseAI}
        setAutoAnalyzeSample={setAutoAnalyzeSample}
        setUvLamp={setUvLamp}
        setMicroscopeConnected={setMicroscopeConnected}
        setAutoSync={setAutoSync}
        setIsFieldMode={setIsFieldMode}
        setVibrationEnabled={setVibrationEnabled}
        deepAnalysis={deepAnalysis}
        setDeepAnalysis={handleSetDeepAnalysis}
      />

      {/* #7 — Modal: ingresar coordenada de partida (decimal / GMS / UTM) */}
      <Modal visible={showCoordModal} transparent animationType="fade" onRequestClose={() => setShowCoordModal(false)}>
        <View style={styles.coordOverlay}>
          <View style={styles.coordCard}>
            <View style={styles.coordHeader}>
              <MaterialCommunityIcons name="map-marker-plus" size={20} color="#FFD700" />
              <Text style={styles.coordTitle}>Ir a coordenada</Text>
              <TouchableOpacity onPress={() => setShowCoordModal(false)} hitSlop={10}>
                <MaterialCommunityIcons name="close" size={22} color="#888" />
              </TouchableOpacity>
            </View>
            <Text style={styles.coordHint}>Decimal, GMS o UTM. Ejemplos:</Text>
            <Text style={styles.coordExample}>{'19.4326, -99.1332\n19°25\'57"N 99°07\'59"W\n14Q 478000 2148000'}</Text>
            <TextInput
              style={styles.coordInput}
              value={coordInput}
              onChangeText={(t) => { setCoordInput(t); if (coordError) setCoordError(null); }}
              placeholder="Pega o escribe la coordenada"
              placeholderTextColor="#666"
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
            />
            {coordError && <Text style={styles.coordError}>{coordError}</Text>}
            <TouchableOpacity
              style={styles.coordGoBtn}
              onPress={() => {
                const r = parseCoordinate(coordInput);
                if ('error' in r) { setCoordError(r.error); return; }
                const c = { latitude: r.lat, longitude: r.lng };
                setStartMarker(c);
                setShowCoordModal(false);
                triggerHaptic('success');
                mapRef.current?.animateToRegion({ latitude: r.lat, longitude: r.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 800);
              }}
            >
              <MaterialCommunityIcons name="crosshairs-gps" size={18} color="#000" />
              <Text style={styles.coordGoText}>IR Y CENTRAR</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, backgroundColor: '#000' },

  // #7 — Modal "Ir a coordenada"
  coordOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  coordCard: { width: '100%', maxWidth: 420, backgroundColor: '#111', borderWidth: 1, borderColor: '#FFD700', borderRadius: 14, padding: 16 },
  coordHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  coordTitle: { flex: 1, color: '#FFD700', fontSize: 16, fontWeight: '800', marginLeft: 8 },
  coordHint: { color: '#AAA', fontSize: 12, marginBottom: 4 },
  coordExample: { color: '#87CEFA', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', marginBottom: 12, lineHeight: 18 },
  coordInput: { backgroundColor: '#1c1c1c', borderWidth: 1, borderColor: '#444', borderRadius: 10, color: '#fff', padding: 12, fontSize: 15, minHeight: 48 },
  coordError: { color: '#FF6B6B', fontSize: 13, marginTop: 8 },
  coordGoBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFD700', borderRadius: 10, paddingVertical: 12, marginTop: 14, gap: 8 },
  coordGoText: { color: '#000', fontWeight: '900', fontSize: 15, letterSpacing: 1 },
  
  mapContainer: { flex: 1, position: 'relative' },
  consoleContainer: { backgroundColor: '#111', borderTopWidth: 2, borderTopColor: '#FFD700' },
  consoleContainerField: { backgroundColor: '#F0F0F0', borderTopColor: '#000' },
  topToolbar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', width: '100%', paddingVertical: 8, backgroundColor: '#222', borderBottomWidth: 1, borderBottomColor: '#333' },
  hudBtnBase: { alignItems: 'center', justifyContent: 'center', padding: 6, minWidth: 70 },
  hudBtnText: { color: '#FFD700', fontSize: 14, fontWeight: 'bold', marginTop: 4 },
  consoleContentArea: { flex: 1, padding: 10, justifyContent: 'center', width: '100%' },
  actionBox: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  instructionText: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginBottom: 10, letterSpacing: 1 },
  giantHitboxBtn: { backgroundColor: '#FFD700', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 70, width: '90%', borderRadius: 12, borderWidth: 2, borderColor: '#000', elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 4 },
  giantHitboxText: { color: '#000', fontWeight: '900', fontSize: 20, letterSpacing: 1, marginLeft: 10 },
  cancelDrawBtn: { marginTop: 15, padding: 10, backgroundColor: 'rgba(255, 85, 85, 0.2)', borderRadius: 8, borderWidth: 1, borderColor: '#FF5555' },
  cancelDrawText: { color: '#FF5555', fontSize: 16, fontWeight: 'bold' },
  selectorsRow: { flexDirection: 'row', width: '100%', justifyContent: 'space-between', paddingHorizontal: 5, marginBottom: 10 },
  halfSelector: { flex: 1, alignItems: 'center' },
  sectionLabel: { color: '#AAA', fontSize: 12, fontWeight: 'bold', marginBottom: 8, letterSpacing: 1 },
  chipsRow: { flexDirection: 'row', gap: 12 },
  chip: { backgroundColor: '#333', paddingVertical: 10, paddingHorizontal: 15, borderRadius: 8, borderWidth: 1, borderColor: '#555', elevation: 5 },
  chipActive: { backgroundColor: '#FFD700', borderColor: '#FFD700' },
  chipText: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  chipTextActive: { color: '#000' },
  analyzeHitboxBtn: { backgroundColor: '#FFD700', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 60, width: '90%', borderRadius: 12, borderWidth: 2, borderColor: '#000', marginTop: 15, elevation: 5 },
  analyzeHitboxText: { color: '#000', fontWeight: '900', fontSize: 18, letterSpacing: 1, marginLeft: 10 },
  
  loadingText: { marginTop: 15, color: '#FFD700', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  errorText: { color: '#FF5555', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  map: { ...StyleSheet.absoluteFillObject },
  
  numberedMarker: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFD700',
    borderWidth: 2, borderColor: '#000', justifyContent: 'center', alignItems: 'center',
  },
  numberedMarkerText: { color: '#000', fontSize: 12, fontWeight: '900' },

  crosshairContainer: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', zIndex: 10 },

  zoomControlsContainer: {
    position: 'absolute', right: 10, top: '35%',
    backgroundColor: 'rgba(255, 215, 0, 0.8)',
    borderRadius: 6, borderWidth: 1, borderColor: '#000', overflow: 'hidden',
  },
  zoomBtn: { padding: 10, justifyContent: 'center', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.3)' },

  panel: {
    position: 'absolute', backgroundColor: 'rgba(10, 10, 10, 0.75)',
    borderColor: '#FFD700', borderWidth: 1, borderRadius: 6,
    padding: 8, elevation: 5,
  },
  topPanel: { top: 40, alignSelf: 'center', width: 'auto', alignItems: 'center' },
  areaPanel: { top: 40, alignSelf: 'center', alignItems: 'center' },
  leftPanel: { bottom: 10, left: 10, alignItems: 'center', width: 70 },
  rightPanel: { bottom: 10, right: 10, alignItems: 'center', width: 70 },
  
  row: { flexDirection: 'row', alignItems: 'center' },
  titleText: { color: '#FFD700', fontSize: 12, fontWeight: 'bold' },
  dataTextLarge: { color: '#FFF', fontSize: 16, fontWeight: 'bold', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 2 },
  labelText: { color: '#FFD700', fontSize: 9, letterSpacing: 1 },
  
  statsTextHighlight: { color: '#FFD700', fontSize: 12, fontWeight: 'bold', marginBottom: 2 },
  statsTextArea: { color: '#FFD700', fontSize: 24, fontWeight: '900', letterSpacing: 1 },
  statsTextAreaSm: { color: '#AAA', fontSize: 12, marginTop: 1 },

  analysisMarker: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFD700',
    borderWidth: 2,
    borderColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
    elevation: 3,
  },
  analysisMarkerText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 14,
  },
  resultsPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '58%',
    backgroundColor: 'rgba(0,0,0,0.97)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 2,
    borderTopColor: '#FFD700',
    padding: 12,
    zIndex: 100,
  },
  metalCard: {
    backgroundColor: '#111',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 10,
    marginBottom: 8,
  },
  detectedBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  scoreBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  scoreBarLabel: {
    color: '#666',
    fontSize: 9,
    width: 72,
    letterSpacing: 0.4,
  },
  scoreBarTrack: {
    flex: 1,
    height: 6,
    backgroundColor: '#1A1A1A',
    borderRadius: 3,
    overflow: 'hidden',
  },
  scoreBarFill: {
    height: 6,
    borderRadius: 3,
  },
  scoreBarValue: {
    color: '#AAA',
    fontSize: 11,
    fontWeight: 'bold',
    width: 28,
    textAlign: 'right',
  },
  resultsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#FFD700',
    paddingBottom: 8,
  },
  resultsTitle: {
    color: '#FFD700',
    fontSize: 16,
    fontWeight: 'bold',
  },
  resultsList: {
    maxHeight: 300,
  },
  resultItem: {
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingVertical: 10,
  },
  resultRank: {
    color: '#FFD700',
    fontWeight: 'bold',
    fontSize: 14,
  },
  resultScore: {
    color: '#FFF',
    fontSize: 12,
    marginTop: 2,
  },
  resultInterpret: {
    color: '#AAA',
    fontSize: 11,
    marginTop: 2,
  },
  northIndicator: { position: 'absolute', top: 88, right: 10, width: 50, height: 50, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 25, borderWidth: 2, borderColor: '#FFD700', justifyContent: 'center', alignItems: 'center', zIndex: 20 },
  northArrow: { alignItems: 'center', justifyContent: 'center' },
  northText: { color: '#FFD700', fontSize: 10, fontWeight: 'bold', marginTop: -4 },
  compassContainer: { alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  compassArrow: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },

  heatmapLegend: { position: 'absolute', bottom: 10, left: 10, backgroundColor: 'rgba(0,0,0,0.85)', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#FFD700', zIndex: 25 },
  legendTitle: { color: '#FFD700', fontSize: 12, fontWeight: 'bold', marginBottom: 5, textAlign: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  legendColor: { width: 20, height: 20, borderRadius: 4, marginRight: 8 },
  legendText: { color: '#FFF', fontSize: 10 },
  locationButton: { position: 'absolute', bottom: 100, right: 10, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 30, padding: 10, borderWidth: 1, borderColor: '#FFD700', zIndex: 20 },
  layerButton: { position: 'absolute', bottom: 152, right: 10, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 30, padding: 10, borderWidth: 1, borderColor: '#FFD700', zIndex: 20 },
  layerMenu: { position: 'absolute', bottom: 152, right: 56, width: 232, backgroundColor: 'rgba(10,10,10,0.96)', borderRadius: 10, borderWidth: 1, borderColor: '#FFD700', padding: 10, zIndex: 30 },
  layerMenuTitle: { color: '#FFD700', fontSize: 11, fontWeight: '900', marginBottom: 6, letterSpacing: 1 },
  layerMenuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  layerMenuText: { color: '#FFF', fontSize: 12, flex: 1 },
  layerMenuDivider: { height: 1, backgroundColor: 'rgba(255,215,0,0.3)', marginVertical: 4 },
  layerMenuNote: { color: '#AAA', fontSize: 9, marginTop: 6, lineHeight: 12 },
  
  waypointMarker: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#00FFFF', borderWidth: 2, borderColor: '#000', justifyContent: 'center', alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { width: '100%', backgroundColor: '#111', borderRadius: 12, padding: 20, borderWidth: 2, borderColor: '#FFD700' },
  modalContentLight: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 },
  modalTitle: { color: '#FFD700', fontSize: 24, fontWeight: '900', marginBottom: 5 },
  modalTitleLight: { color: '#000000' },
  modalSub: { color: '#AAA', fontSize: 14, marginBottom: 15 },
  modalInput: { backgroundColor: '#222', color: '#FFF', borderRadius: 8, padding: 15, height: 120, textAlignVertical: 'top', fontSize: 18 },
  modalInputLight: { backgroundColor: '#EEE', color: '#000' },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, gap: 10 },
  modalBtnCancel: { flex: 1, backgroundColor: '#333', padding: 20, borderRadius: 8, alignItems: 'center' },
  modalBtnSave: { flex: 1, backgroundColor: '#FFD700', padding: 20, borderRadius: 8, alignItems: 'center' },
  modalBtnTextWhite: { color: '#FFF', fontWeight: 'bold', fontSize: 18 },
  modalBtnTextBlack: { color: '#000', fontWeight: 'bold', fontSize: 18 },
  
  resultRecom: { color: '#00FFFF', fontSize: 11, fontWeight: 'bold', marginTop: 2 },

  nextStepBanner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.primarySoft,
    borderTopWidth: 1,
    borderTopColor: Colors.primary,
    borderRadius: 0,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    marginHorizontal: 0,
    marginBottom: 0,
    minHeight: Touch.min,
    justifyContent: 'center',
    zIndex: 99,
  },
  nextStepText: {
    color: Colors.primary,
    fontSize: Typography.bodyBold.fontSize,
    fontWeight: Typography.bodyBold.fontWeight,
    lineHeight: Typography.bodyBold.lineHeight,
    textAlign: 'center',
  },
  sectionLabelModal: { color: '#FFD700', fontSize: 12, fontWeight: 'bold', marginTop: 15, marginBottom: 8, letterSpacing: 1 },
  sectionHeader: { fontSize: 15, marginTop: 15, marginBottom: 5, letterSpacing: 0.5 },
  chipsRowModal: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipModal: { backgroundColor: '#333', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#555' },
  chipTextModal: { color: '#FFF', fontSize: 14, fontWeight: 'bold', textTransform: 'capitalize' },
  prefsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, marginTop: 10 },
  separator: { height: 1, backgroundColor: '#444' },

  // ── Tap-point analysis panel ───────────────────────────────────────────────
  tapPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '62%',
    backgroundColor: 'rgba(0,0,0,0.97)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 2,
    borderTopColor: '#00FFFF',
    padding: 12,
    zIndex: 101,
  },
  indicatorsBox: {
    backgroundColor: '#0C0C0C',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#252525',
    padding: 12,
    marginBottom: 8,
  },
  indicatorsTitle: {
    color: '#AAA',
    fontWeight: '900',
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 8,
  },
  indicatorRow: {
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  indicatorText: {
    fontSize: 12,
    fontWeight: '600',
  },

  // ── Compact toolbar ────────────────────────────────────────────────────────
  toolbarRow: {
    flexDirection: 'row',
    width: '100%',
    backgroundColor: '#000',
    borderBottomWidth: 1,
    borderBottomColor: '#FFD700',
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 6,
  },
  toolbarRowField: {
    backgroundColor: '#E0E0E0',
    borderBottomColor: '#000',
  },
  toolbarBtn: {
    flex: 1,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FFD700',
    minWidth: 44,
  },
  toolbarBtnActive: {
    backgroundColor: '#FFD700',
    borderColor: '#FFD700',
  },
  toolbarBtnField: {
    backgroundColor: '#FFF',
    borderColor: '#000',
  },
  toolbarBtnLabel: {
    color: '#FFD700',
    fontSize: 12,
    fontWeight: 'bold',
    marginTop: 3,
  },

  // ── Compact console bar ────────────────────────────────────────────────────
  consoleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 50,
    maxHeight: 60,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#111',
  },
  consoleBarField: {
    backgroundColor: '#F0F0F0',
  },
  consoleBarLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  consoleBarText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  consoleAreaMain: {
    color: '#FFD700',
    fontSize: 16,
    fontWeight: '800',
  },
  consoleAreaSub: {
    color: '#AAA',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
  consoleAreaNote: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 15,
    marginTop: 4,
  },
  consoleBtnBlocked: {
    backgroundColor: '#8A2622',
  },
  consoleBarHint: {
    flex: 1,
    color: '#555',
    fontSize: 13,
    textAlign: 'center',
  },
  consoleBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 8,
  },
  consoleBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFD700',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    minHeight: 34,
  },
  consoleBtnPrimaryField: {
    backgroundColor: '#000',
  },
  consoleBtnPrimaryText: {
    color: '#000',
    fontSize: 11,
    fontWeight: '900',
  },
  consoleBtnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FFD700',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 8,
    minHeight: 34,
  },
  consoleBtnSecondaryField: {
    borderColor: '#000',
  },
  consoleBtnSecondaryText: {
    color: '#FFD700',
    fontSize: 11,
    fontWeight: '700',
  },
  consoleBtnDanger: {
    borderWidth: 1,
    borderColor: '#FF3B30',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 8,
    minHeight: 34,
    justifyContent: 'center',
  },
  consoleBtnDangerField: {
    backgroundColor: '#FFF',
    borderWidth: 2,
  },
  consoleBtnDangerText: {
    color: '#FF3B30',
    fontSize: 11,
    fontWeight: '900',
  },

  // ── Config chip ────────────────────────────────────────────────────────────
  configChip: {
    position: 'absolute',
    top: 44,
    left: 10,
    backgroundColor: 'rgba(20,20,20,0.88)',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    minHeight: 30,
    justifyContent: 'center',
    zIndex: 10,
  },
  configChipText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },

  // ── Status pill (top-right) ─────────────────────────────────────────────
  statusPill: {
    position: 'absolute',
    top: 44,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    zIndex: 30,
  },
  statusPillSide: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusPillDivider: {
    width: 1,
    height: 12,
    backgroundColor: '#444',
    marginHorizontal: 8,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#FFFFFF',
  },

  // ── HUD corner pills (altitude + rumbo) ─────────────────────────────────
  hudCornerPill: {
    position: 'absolute',
    bottom: 12,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.70)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    columnGap: 4,
    minHeight: 28,
  },
  hudCornerText: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: '#FFFFFF',
  },

  // ── Ranking section ────────────────────────────────────────────────────────
  rankingSection: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#222',
    paddingTop: 12,
  },
  rankingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  rankingTitle: {
    color: '#FFD700',
    fontWeight: '900',
    fontSize: 10,
    letterSpacing: 0.8,
    flex: 1,
  },
  rankingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  rankingRank: {
    color: '#FFD700',
    fontWeight: '900',
    fontSize: 12,
    width: 24,
  },
  rankingCoord: {
    color: '#555',
    fontSize: 9,
    marginBottom: 4,
    fontFamily: 'monospace',
  },
  rankingTrack: {
    width: '100%',
    height: 5,
    backgroundColor: '#111',
    borderRadius: 3,
    overflow: 'hidden',
  },
  rankingFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 3,
    opacity: 0.85,
  },
  rankingScore: {
    fontWeight: '900',
    fontSize: 12,
  },
  rankingPct: {
    color: '#555',
    fontSize: 9,
    marginTop: 2,
  },
});

const fieldStyles = StyleSheet.create({
  console: {
    backgroundColor: Colors.fieldBg,
    borderTopWidth: 2,
    borderTopColor: Colors.fieldPrimary,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    backgroundColor: Colors.fieldSurface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.fieldBorder,
  },
  statusText: {
    flex: 1,
    fontSize: 12,
    color: Colors.fieldTextSub,
    fontWeight: '600',
  },
  exitBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minHeight: Touch.min,
    justifyContent: 'center',
  },
  exitBtnText: {
    fontSize: 13,
    color: Colors.fieldPrimary,
    fontWeight: '700',
  },
  btnRow: {
    flexDirection: 'row',
    height: Touch.field,
  },
  bigBtn: {
    flex: 1,
    height: Touch.field,
    backgroundColor: Colors.fieldSurface,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  bigBtnLabel: {
    fontSize: 15,
    fontWeight: '900',
    color: Colors.fieldPrimary,
    letterSpacing: 0.5,
  },
  bigBtnSub: {
    fontSize: 11,
    color: Colors.fieldTextSub,
    marginLeft: 4,
    alignSelf: 'flex-end',
    marginBottom: 2,
  },
  btnDivider: {
    width: 1,
    backgroundColor: Colors.fieldBorder,
    marginVertical: 10,
  },
});


