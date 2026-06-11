import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { router } from 'expo-router';
import { StyleSheet, View, Text, ActivityIndicator, Platform, TouchableOpacity, Alert, Pressable, ScrollView, Dimensions } from 'react-native';
import MapView, { Marker, Polygon, Region, MapPressEvent, PanDragEvent } from 'react-native-maps';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as ImagePicker from 'expo-image-picker';
import NetInfo from '@react-native-community/netinfo';
import { analyzeZoneLocal, computeAllMetalScores, MetalScore } from '../core/GeologicalEngine';
import { Colors, Typography, Spacing, Radii, Touch } from '../core/theme';
import { fetchMiningSpectralGrid, fetchMiningAsterGrid, fetchAsterCoverage, fetchStructuralGrid, fetchEmitGrid, computeAdaptiveCellSize, type MiningSpectralResult, type AsterSpectralResult, type StructuralResult, type EmitSpectralResult } from '../core/SatelliteEngine';
import { fuseAnalysisPoints } from '../core/ConsensusFusion';
import ChatModal from '../components/ChatModal';
import FieldModeButton from '../components/FieldModeButton';
import HistoryModal from '../components/HistoryModal';
import ConfigModal from '../components/ConfigModal';
import MoreSheet from '../components/MoreSheet';
import { TAP_METAL_META } from '../core/spectralHelpers';
import TapPanel from '../components/TapPanel';
import SelectedPointModal from '../components/SelectedPointModal';
import WaypointModal from '../components/WaypointModal';
import ResultsPanel from '../components/ResultsPanel';
import { initDB, getMuestras, saveMuestra, clearMuestras, savePoligonoCache, getPendingPolygons, saveProjectState, loadProjectState, listProjects, createProject } from '../core/Database';
import { analyzeRockImageWithClaude, ClaudeAnalysis, analyzeSpectralCandidatesBatch, askClaudeGeologist } from '../core/ClaudeServices';
import { generateAndShareReport } from '../core/ReportGenerator';

type Coordinate = { latitude: number; longitude: number };
type DrawingType = 'none' | 'polygon' | 'rectangle';

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

export default function ProspectorDashboard() {
  const mapRef = useRef<MapView>(null);
  
  // --- Chat IA ---
  const [showChatModal, setShowChatModal] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role: string, content: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isTypingChat, setIsTypingChat] = useState(false);

  // --- Red y Sync ---
  const [isConnected, setIsConnected] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const online = state.isConnected && state.isInternetReachable;
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
  const [asterData, setAsterData]         = useState<AsterSpectralResult | null>(null);
  const [emitData, setEmitData]           = useState<EmitSpectralResult | null>(null);
  const [structuralData, setStructuralData] = useState<StructuralResult | null>(null);
  const [deepAnalysis, setDeepAnalysis] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState('default');
  const [metalScores, setMetalScores] = useState<MetalScore[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [satelliteData, setSatelliteData] = useState<MiningSpectralResult | null>(null);

  // Map tap point analysis
  const [tapPoint, setTapPoint] = useState<{lat: number; lng: number} | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<any>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState('');
  const [mapRotation, setMapRotation] = useState(0);
  const [showHeatmap, setShowHeatmap] = useState(false);
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

  useEffect(() => {
    const loadSaved = async () => {
      try {
        const saved = await AsyncStorage.getItem('lastPolygon');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.length > 0) setPolygonCoords(parsed);
        }
        await initDB();
        await loadMuestras();

        // Load geologist summary from current project's chat history
        const pid = (await AsyncStorage.getItem('currentProjectId')) || 'default';
        setCurrentProjectId(pid);
        const proj = await loadProjectState(pid);
        if (proj?.chat_history && proj.chat_history.length > 0) {
          // Use the last assistant message as the resumen
          const lastAssistant = [...proj.chat_history]
            .reverse()
            .find((m: { role: string; content: string }) => m.role === 'assistant');
          if (lastAssistant) setGeologoResumen(lastAssistant.content);
        }
      } catch (e) {}
    };
    loadSaved();
  }, []);

  const loadMuestras = async () => {
    const data = await getMuestras();
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
      const analysis = await analyzeRockImageWithClaude(base64, type);
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
    if (!mapCenter) return;
    
    const newWp = {
      id: Date.now().toString(),
      proyecto_id: activeProject,
      lat: mapCenter.latitude,
      lng: mapCenter.longitude,
      altitud: altitude,
      rumbo: trueHeading,
      fecha_hora: new Date().toISOString(),
      tipo_captura: sampleCaptureType,
      imagen_thumbnail: sampleBase64 ? 'data:image/jpeg;base64,' + sampleBase64.substring(0, 100) : '',
      descripcion_texto: waypointNote,
      analisis_ia: aiResult,
      mineral_detectado: aiResult?.mineral_detectado || 'N/A',
      score_ia: aiResult?.probabilidad || 0,
    };
    
    await saveMuestra(newWp);
    
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
    setPolygonCoords((prev) => [...prev, newPoint]);
  };

  const finishDrawing = async (overrideCoords?: Coordinate[]) => {
    setDrawingType('none');
    const finalCoords = overrideCoords || polygonCoords;
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

      const data = analyzeZoneLocal(coordsToUse, selectedMineral, terrainType, depth, rockType, waypoints, satData);
      
      if (data.success && data.top_points) {
        let finalPoints = data.top_points;
        let wasAnalyzed = false;
        
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
        }

        await savePoligonoCache({
           id: 'poly_' + Date.now(), mineral: selectedMineral, terrain: terrainType, rock_type: rockType,
           coordenadas: coordsToUse, analisis_resultado: finalPoints, estado: wasAnalyzed ? 'SYNCED' : 'OFFLINE',
           satdata_source: satData.data_source,
           acquisition_date: satData.acquisition_date,
        });

        setAnalysisPoints(finalPoints);
        setMetalScores(computeAllMetalScores(coordsToUse, terrainType));
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

  return (
    <View style={styles.container}>
      
      {/* 70% MAPA SUPERIOR */}
      <View style={styles.mapContainer}>
        <MapView
          ref={mapRef}
          style={styles.map}
          mapType="satellite"
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

        </MapView>

        {/* OVERLAYS DENTRO DEL MAPA */}

        {/* CHATBOT BUTTON REMOVED IN FAVOR OF DIRECT MAP TAP */}

        {/* CROSSHAIR */}
        {drawingType === 'polygon' && (
          <View style={styles.crosshairContainer} pointerEvents="none">
            <MaterialCommunityIcons name="crosshairs" size={50} color="#FFD700" />
          </View>
        )}

        {/* CONFIG CHIP — mineral + terrain quick access */}
        <TouchableOpacity
          style={styles.configChip}
          onPress={() => setShowConfigModal(true)}
        >
          <Text style={styles.configChipText} numberOfLines={1}>
            {TAP_METAL_META[selectedMineral]?.icon ?? '⛏'} {selectedMineral} · {terrainType}
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

        <TouchableOpacity style={styles.locationButton} onPress={() => { if (location) { mapRef.current?.animateToRegion({ latitude: location.coords.latitude, longitude: location.coords.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 }, 500); } }}><MaterialCommunityIcons name="crosshairs-gps" size={24} color="#FFD700" /></TouchableOpacity>

        <TouchableOpacity style={styles.northIndicator} onPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }} onLongPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }}><View style={[styles.northArrow, { transform: [{ rotate: `${-mapRotation}deg` }] }]}><MaterialCommunityIcons name="arrow-up" size={28} color="#FFD700" /><Text style={styles.northText}>N</Text></View></TouchableOpacity>

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
      <View style={[styles.consoleContainer, isFieldMode && styles.consoleContainerField]}>

        {/* BARRA DE HERRAMIENTAS FIJA — 3 botones: Ajustes · Trazar · Más
            Flujo natural: configurar → trazar → analizar                   */}
        <View style={[styles.toolbarRow, isFieldMode && styles.toolbarRowField]}>

          {/* ① Ajustes — va primero: se definen parámetros antes de trazar */}
          <TouchableOpacity
            style={[styles.toolbarBtn, isFieldMode && styles.toolbarBtnField]}
            onPress={() => setShowConfigModal(true)}
          >
            <MaterialCommunityIcons name="cog" size={22} color={isFieldMode ? '#000' : '#FFD700'} />
            <Text style={[styles.toolbarBtnLabel, isFieldMode && { color: '#000' }]} numberOfLines={1}>Ajustes</Text>
          </TouchableOpacity>

          {/* ② Trazar / Nuevo trazado / Salir — estado-aware */}
          <TouchableOpacity
            style={[
              styles.toolbarBtn,
              drawingType === 'polygon' && styles.toolbarBtnActive,
              isFieldMode && styles.toolbarBtnField,
            ]}
            onPress={() => {
              if (drawingType === 'polygon') {
                // Cancelar dibujo en curso
                selectMode('none');
              } else if (resolvedPolygonCoords.length >= 3 && showResults) {
                // Hay análisis: pedir confirmación antes de descartar
                Alert.alert(
                  'Nuevo trazado',
                  'Hay un análisis sin guardar. ¿Descartar y trazar nueva zona?',
                  [
                    { text: 'Cancelar', style: 'cancel' },
                    { text: 'Descartar y trazar', style: 'destructive', onPress: () => selectMode('polygon') },
                  ]
                );
              } else if (resolvedPolygonCoords.length >= 3) {
                // Hay polígono pero sin análisis: empezar nuevo directo
                selectMode('polygon');
              } else {
                // Sin polígono: iniciar dibujo
                selectMode('polygon');
              }
            }}
          >
            <MaterialCommunityIcons
              name={
                drawingType === 'polygon'
                  ? 'close-circle-outline'
                  : resolvedPolygonCoords.length >= 3
                  ? 'vector-polygon'
                  : 'draw-pen'
              }
              size={22}
              color={drawingType === 'polygon' ? '#000' : (isFieldMode ? '#000' : '#FFD700')}
            />
            <Text
              style={[styles.toolbarBtnLabel, drawingType === 'polygon' && { color: '#000' }, isFieldMode && { color: '#000' }]}
              numberOfLines={1}
            >
              {drawingType === 'polygon'
                ? 'Salir'
                : resolvedPolygonCoords.length >= 3
                ? 'Nuevo'
                : 'Trazar'}
            </Text>
          </TouchableOpacity>

          {/* ③ Más — Cámara, Solar/Noche, Historial, Guardar, Campo, PDF */}
          <TouchableOpacity
            style={[styles.toolbarBtn, isFieldMode && styles.toolbarBtnField]}
            onPress={() => setShowMoreSheet(true)}
          >
            <MaterialCommunityIcons name="dots-horizontal-circle-outline" size={22} color={isFieldMode ? '#000' : '#FFD700'} />
            <Text style={[styles.toolbarBtnLabel, isFieldMode && { color: '#000' }]} numberOfLines={1}>Más</Text>
          </TouchableOpacity>

        </View>

        {/* CONSOLA COMPACTA DE 1 LÍNEA */}
        {drawingType === 'polygon' ? (
          /* Estado: dibujando polígono */
          <View style={[styles.consoleBar, isFieldMode && styles.consoleBarField]}>
            <View style={styles.consoleBarLeft}>
              <MaterialCommunityIcons name="vector-polygon" size={16} color={isFieldMode ? '#333' : '#FFD700'} />
              <Text style={[styles.consoleBarText, isFieldMode && { color: '#333' }]} numberOfLines={1}>
                {' '}Polígono — {polygonCoords.length} vértices
              </Text>
            </View>
            <View style={styles.consoleBarActions}>
              <TouchableOpacity
                style={[styles.consoleBtnSecondary, isFieldMode && styles.consoleBtnSecondaryField]}
                onPress={addPointFromCrosshair}
              >
                <MaterialCommunityIcons name="target" size={14} color={isFieldMode ? '#000' : '#FFD700'} />
                <Text style={[styles.consoleBtnSecondaryText, isFieldMode && { color: '#000' }]}> MARCAR</Text>
              </TouchableOpacity>
              {polygonCoords.length >= 3 && (
                <TouchableOpacity
                  style={[styles.consoleBtnPrimary, isFieldMode && styles.consoleBtnPrimaryField]}
                  onPress={() => finishDrawing()}
                >
                  <MaterialCommunityIcons name="radar" size={14} color="#000" />
                  <Text style={styles.consoleBtnPrimaryText}> ANALIZAR</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.consoleBtnDanger, isFieldMode && styles.consoleBtnDangerField]}
                onPress={() => setPolygonCoords([])}
              >
                <Text style={styles.consoleBtnDangerText}>LIMPIAR</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : isAnalyzing ? (
          /* Estado: analizando */
          <View style={[styles.consoleBar, isFieldMode && styles.consoleBarField]}>
            <ActivityIndicator size="small" color={isFieldMode ? '#333' : '#FFD700'} style={{ marginRight: 8 }} />
            <Text style={[styles.consoleBarText, isFieldMode && { color: '#333' }]} numberOfLines={1}>
              {analysisStep || 'Consultando Sentinel-2...'}
            </Text>
          </View>
        ) : resolvedPolygonCoords.length >= 3 && !showResults ? (
          /* Estado: zona cargada, sin resultados aún */
          <View style={[styles.consoleBar, isFieldMode && styles.consoleBarField]}>
            <View style={styles.consoleBarLeft}>
              <MaterialCommunityIcons name="ruler-square" size={16} color={isFieldMode ? '#333' : '#FFD700'} />
              <Text style={[styles.consoleBarText, isFieldMode && { color: '#333' }]} numberOfLines={1}>
                {' '}{areaHa} ha · {resolvedPolygonCoords.length} vértices
              </Text>
              {parseFloat(areaHa) > 50_000 && (
                <Text style={{ color: '#FF9800', fontSize: 10, marginLeft: 4 }}>⚠️</Text>
              )}
            </View>
            <View style={styles.consoleBarActions}>
              <TouchableOpacity
                style={[styles.consoleBtnDanger, isFieldMode && styles.consoleBtnDangerField]}
                onPress={clearShapes}
              >
                <Text style={styles.consoleBtnDangerText}>BORRAR</Text>
              </TouchableOpacity>
              <Pressable
                style={({ pressed }) => [
                  styles.consoleBtnPrimary,
                  isFieldMode && styles.consoleBtnPrimaryField,
                  pressed && { opacity: 0.75 },
                ]}
                onPress={() => analyzeZone()}
                disabled={isAnalyzing}
              >
                <MaterialCommunityIcons name="brain" size={14} color="#000" />
                <Text style={styles.consoleBtnPrimaryText}> ANALIZAR</Text>
              </Pressable>
            </View>
          </View>
        ) : showResults ? (
          /* Estado: resultados disponibles */
          <View style={[styles.consoleBar, isFieldMode && styles.consoleBarField]}>
            <View style={styles.consoleBarLeft}>
              <Text style={{ fontSize: 14 }}>✅</Text>
              <Text style={[styles.consoleBarText, isFieldMode && { color: '#333' }]} numberOfLines={1}>
                {' '}{analysisPoints.length} zonas · {selectedMineral.toUpperCase()} · {terrainType.toUpperCase()}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.consoleBtnSecondary, isFieldMode && styles.consoleBtnSecondaryField]}
              onPress={clearShapes}
            >
              <MaterialCommunityIcons name="refresh" size={14} color={isFieldMode ? '#000' : '#FFD700'} />
              <Text style={[styles.consoleBtnSecondaryText, isFieldMode && { color: '#000' }]}> Nueva zona</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* Estado: sin zona trazada */
          <View style={[styles.consoleBar, isFieldMode && styles.consoleBarField]}>
            <MaterialCommunityIcons name="map-search-outline" size={16} color={isFieldMode ? '#555' : '#555'} style={{ marginRight: 6 }} />
            <Text style={[styles.consoleBarText, { color: isFieldMode ? '#555' : '#555' }]} numberOfLines={1}>
              Toca Trazar para delimitar una zona
            </Text>
          </View>
        )}
      </View>

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
          satelliteData={satelliteData}
          metalScores={metalScores}
          analysisPoints={analysisPoints}
          selectedMineral={selectedMineral}
          terrainType={terrainType}
          areaHa={areaHa}
          mapRef={mapRef}
          onClose={() => setShowResults(false)}
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
        selectedMineral={selectedMineral}
        terrainType={terrainType}
        mapRef={mapRef}
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

      <ChatModal
        visible={showChatModal}
        messages={chatMessages}
        isTypingChat={isTypingChat}
        input={chatInput}
        onInputChange={setChatInput}
        onSend={sendChatMessage}
        onClose={() => setShowChatModal(false)}
        isFieldMode={isFieldMode}
      />

      <HistoryModal
        visible={showHistoryModal}
        waypoints={waypoints}
        isFieldMode={isFieldMode}
        onClose={() => setShowHistoryModal(false)}
        onClear={async () => { await clearMuestras(); loadMuestras(); }}
        onExport={exportCSV}
      />

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
              coordenadas: polygonCoords,
              analisis_resultado: analysisPoints,
              area_ha: parseFloat(areaHa) || 0,
            });
            Alert.alert('Guardado', 'Proyecto actualizado correctamente.');
          } catch (e: any) {
            Alert.alert('Error', 'No se pudo guardar: ' + e.message);
          }
        }}
        onCampo={() => {/* FieldModeButton handles its own logic */}}
        onPDF={handleGenerateReport}
        onAjustes={() => setShowConfigModal(true)}
      />

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
        setSelectedMineral={setSelectedMineral}
        setTerrainType={setTerrainType}
        setDepth={setDepth}
        setRockType={setRockType}
        setUseAI={setUseAI}
        setAutoAnalyzeSample={setAutoAnalyzeSample}
        setUvLamp={setUvLamp}
        setMicroscopeConnected={setMicroscopeConnected}
        setAutoSync={setAutoSync}
        setIsFieldMode={setIsFieldMode}
        setVibrationEnabled={setVibrationEnabled}
        deepAnalysis={deepAnalysis}
        setDeepAnalysis={setDeepAnalysis}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, backgroundColor: '#000' },
  
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


