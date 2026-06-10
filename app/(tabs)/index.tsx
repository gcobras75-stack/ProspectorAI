import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Platform, TouchableOpacity, Alert, Pressable, Modal, TextInput, ScrollView, Switch, Image } from 'react-native';
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
import { fetchMiningSpectralGrid, findNearestCell, computeAdaptiveCellSize, type MiningSpectralResult, type MiningSpectralCell } from '../core/SatelliteEngine';
import { TAP_METAL_META, cellAnomalyScore, anomalyFromPct, tapMessage } from '../core/spectralHelpers';
import ScoreCard, { METAL_COLORS } from '../components/ScoreCard';
import { initDB, getMuestras, saveMuestra, clearMuestras, savePoligonoCache, getPendingPolygons } from '../core/Database';
import { analyzeRockImageWithClaude, ClaudeAnalysis, analyzeSpectralCandidatesBatch, askClaudeGeologist } from '../core/ClaudeServices';

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
      if (online && !isConnected && !isSyncing) {
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
  const [metalScores, setMetalScores] = useState<MetalScore[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [satelliteData, setSatelliteData] = useState<MiningSpectralResult | null>(null);

  // Map tap point analysis
  const [tapPoint, setTapPoint] = useState<{lat: number; lng: number} | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<any>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
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

  // History & Apperance
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);


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
    
    try {
      await new Promise(resolve => setTimeout(resolve, 600));
      // ── Adaptive cell size based on polygon area ──────────────────────────────
      const polygonAreaHa = calcPolygonArea(coordsToUse) / 10_000;
      const cellSizeM     = computeAdaptiveCellSize(polygonAreaHa);

      // ── Fetch real satellite data (3-state: REAL / CACHED / NO_DATA_OFFLINE) ─
      let satData: MiningSpectralResult;
      try {
        satData = await fetchMiningSpectralGrid(coordsToUse, { cell_size_m: cellSizeM });
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
        
        await savePoligonoCache({
           id: 'poly_' + Date.now(), mineral: selectedMineral, terrain: terrainType, rock_type: rockType,
           coordenadas: coordsToUse, analisis_resultado: finalPoints, estado: wasAnalyzed ? 'SYNCED' : 'OFFLINE'
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

          {analysisPoints.map((point, idx) => (
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

        {/* DEBUG VERSION TAG */}
        <View style={{ position: 'absolute', top: 44, left: 10, backgroundColor: 'rgba(0,0,0,0.8)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, zIndex: 50, maxWidth: 220 }}>
          <Text style={{ color: '#4CAF50', fontSize: 9, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>v9.0</Text>
          <Text style={{ color: '#888', fontSize: 7, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 1 }} numberOfLines={1}>{process.env.EXPO_PUBLIC_SERVER_URL || 'ENV:null→fallback'}</Text>
        </View>


        {/* MINI OVERLAY PANELES */}
        {!showStatsBox && (
          <View style={[styles.panel, styles.topPanel, { borderRadius: 12}]}>
            <View style={styles.row}>
              <MaterialCommunityIcons name="satellite-variant" size={16} color="#FFD700" />
              <Text style={[styles.titleText, {fontSize: 11}]}> GPS: LAT {latitude.toFixed(4)} | LON {longitude.toFixed(4)}</Text>
            </View>
          </View>
        )}

        {/* ÁREA EN PANTALLA FIJA */}
        {showStatsBox && (
          <View style={[styles.panel, { top: 50, left: 10, backgroundColor: 'rgba(0,0,0,0.7)', paddingVertical: 4, paddingHorizontal: 8, alignItems: 'flex-start', borderRadius: 8 }]}>
            <Text style={[styles.statsTextHighlight, {fontSize: 10, marginBottom: 0}]}>ZONA SELECCIONADA</Text>
            <Text style={[styles.statsTextArea, {fontSize: 14}]}>{areaHa} ha</Text>
            <Text style={[styles.statsTextAreaSm, {fontSize: 8, marginTop: 0}]}>{areaKm2} km² | {infoText}</Text>
          </View>
        )}

        {/* ZOOM BOTONES */}
        <View style={styles.zoomControlsContainer}>
          <TouchableOpacity style={styles.zoomBtn} onPress={zoomIn}>
            <MaterialCommunityIcons name="plus" size={24} color="#000" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={zoomOut}>
            <MaterialCommunityIcons name="minus" size={24} color="#000" />
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.locationButton} onPress={() => { if (location) { mapRef.current?.animateToRegion({ latitude: location.coords.latitude, longitude: location.coords.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 }, 500); } }}><MaterialCommunityIcons name="crosshairs-gps" size={24} color="#FFD700" /></TouchableOpacity>

        <TouchableOpacity style={styles.northIndicator} onPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }} onLongPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }}><View style={[styles.northArrow, { transform: [{ rotate: `${-mapRotation}deg` }] }]}><MaterialCommunityIcons name="arrow-up" size={28} color="#FFD700" /><Text style={styles.northText}>N</Text></View></TouchableOpacity>

        {/* CONNECTION & SPECTRAL INDICATOR (TOP RIGHT) */}
        <View style={{ position: 'absolute', top: 50, right: 10, backgroundColor: 'rgba(0,0,0,0.7)', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, flexDirection: 'row', alignItems: 'center', zIndex: 30, borderWidth: 1, borderColor: '#333' }}>
           <TouchableOpacity onPress={() => Alert.alert('Conexión', isSyncing ? 'Sincronizando...' : (isConnected ? 'Online (Conectado a Claude)' : 'Offline (Motor Local)'))} style={{flexDirection: 'row', alignItems: 'center'}}>
             <View style={{width: 8, height: 8, borderRadius: 4, backgroundColor: isConnected ? '#44FF44' : '#888', marginRight: 6}} />
             <Text style={{color: '#FFF', fontSize: 10, fontWeight: 'bold'}}>Online</Text>
           </TouchableOpacity>
           <View style={{width: 1, height: 12, backgroundColor: '#555', marginHorizontal: 8}} />
           <TouchableOpacity onPress={() => setShowHeatmap(!showHeatmap)} style={{flexDirection: 'row', alignItems: 'center'}}>
             <Text style={{color: showHeatmap ? '#FFD700' : '#888', fontSize: 10, fontWeight: 'bold'}}>🌈 Capa {showHeatmap ? 'ON' : 'OFF'}</Text>
           </TouchableOpacity>
        </View>

        {/* ALTITUDE & COMPASS (CORNERS) */}
        <View style={[styles.panel, { bottom: 10, left: 10, width: 50, height: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.7)', padding: 0 }]}>
          <Text style={[styles.labelText, {fontSize: 8}]}>ALTITUD</Text>
          <Text style={[styles.dataTextLarge, {fontSize: 12, marginTop: 4}]}>{altitude !== null && altitude !== undefined ? `${altitude.toFixed(0)}m` : '---'}</Text>
        </View>

        <View style={[styles.panel, { bottom: 10, right: 10, width: 60, height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.7)', padding: 0 }]}>
          <Text style={[styles.labelText, {fontSize: 8}]}>RUMBO</Text>
          <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 4}}>
             {trueHeading !== null && trueHeading !== undefined && (
               <MaterialCommunityIcons name="navigation" size={12} color="#00FFFF" style={{ transform: [{ rotate: `${trueHeading}deg` }], marginRight: 4 }} />
             )}
            <Text style={[styles.dataTextLarge, {fontSize: 12, marginTop: 0}]}>{trueHeading !== null && trueHeading !== undefined ? `${Math.round(trueHeading)}°` : '---'}</Text>
          </View>
        </View>

      </View>

      {/* 30% CONSOLA DE MANDO INFERIOR */}
      <View style={[styles.consoleContainer, isFieldMode && { backgroundColor: '#F0F0F0', borderTopColor: '#000' }]}>
        
        {/* BARRA DE HERRAMIENTAS PERMANENTE */}
        <View style={[{ width: '100%', backgroundColor: '#000', borderBottomWidth: 1, borderBottomColor: '#FFD700', paddingVertical: 8 }, isFieldMode && { backgroundColor: '#E0E0E0', borderBottomColor: '#000' }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 }}>
            
            <TouchableOpacity 
              style={[{ width: 55, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#FFD700' }, drawingType === 'polygon' && { backgroundColor: '#FFD700' }, isFieldMode && { backgroundColor: '#FFF', borderColor: '#000' }]} 
              onPress={() => drawingType === 'polygon' ? selectMode('none') : selectMode('polygon')}
            >
              <MaterialCommunityIcons name="draw-pen" size={20} color={drawingType === 'polygon' ? '#000' : (isFieldMode ? '#000' : '#FFD700')} />
              <Text style={[{ color: '#FFD700', fontSize: 11, fontWeight: 'bold', marginTop: 4 }, drawingType === 'polygon' && { color: '#000' }, isFieldMode && drawingType !== 'polygon' && { color: '#000' }]}>
                {drawingType === 'polygon' ? 'Trazando' : 'Trazar'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={[{ width: 55, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#FFD700' }, isFieldMode && { backgroundColor: '#FFF', borderColor: '#000' }]} onPress={() => setShowWaypointModal(true)}>
               <MaterialCommunityIcons name="camera-plus" size={20} color={isFieldMode ? "#000" : "#FFD700"} />
               <Text style={[{ color: '#FFD700', fontSize: 11, fontWeight: 'bold', marginTop: 4 }, isFieldMode && { color: '#000' }]}>Cámara</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[{ width: 55, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#FFD700' }, isFieldMode && { backgroundColor: '#FFF', borderColor: '#000' }]} onPress={() => setIsFieldMode(!isFieldMode)}>
               <MaterialCommunityIcons name={isFieldMode ? "weather-night" : "white-balance-sunny"} size={20} color={isFieldMode ? "#000" : "#888"} />
               <Text style={[{ color: '#FFD700', fontSize: 11, fontWeight: 'bold', marginTop: 4 }, isFieldMode && { color: '#000' }]}>{isFieldMode ? 'Noche' : 'Solar'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[{ width: 55, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#FFD700' }, isFieldMode && { backgroundColor: '#FFF', borderColor: '#000' }]} onPress={() => setShowHistoryModal(true)}>
               <MaterialCommunityIcons name="history" size={20} color={isFieldMode ? "#000" : "#FFD700"} />
               <Text style={[{ color: '#FFD700', fontSize: 11, fontWeight: 'bold', marginTop: 4 }, isFieldMode && { color: '#000' }]}>Historial</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={[{ width: 55, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#FFD700' }, isFieldMode && { backgroundColor: '#FFF', borderColor: '#000' }]} onPress={() => setShowConfigModal(true)}>
               <MaterialCommunityIcons name="cog" size={20} color={isFieldMode ? "#000" : "#FFD700"} />
               <Text style={[{ color: '#FFD700', fontSize: 11, fontWeight: 'bold', marginTop: 4 }, isFieldMode && { color: '#000' }]}>Ajustes</Text>
            </TouchableOpacity>

          </ScrollView>
        </View>

        {/* ÁREA DINÁMICA DE TRABAJO */}
        <View style={styles.consoleContentArea}>
          {drawingType === 'polygon' ? (
             <View style={styles.actionBox}>
               <Text style={[styles.instructionText, isFieldMode && { color: '#333' }, {fontSize: 10, marginBottom: 5}]}>NUEVO POLÍGONO ({polygonCoords.length} VERTICES)</Text>
               
               <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center', marginTop: 5, paddingHorizontal: 10, gap: 8 }}>
                 <TouchableOpacity
                   style={[
                     { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 8, borderWidth: 2, borderColor: '#000', backgroundColor: '#FFD700', elevation: 5 },
                     isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000' } : null,
                   ]}
                   onPress={addPointFromCrosshair}
                 >
                    <MaterialCommunityIcons name="target" size={20} color="#000" />
                    <Text style={{ color: '#000', fontWeight: '900', fontSize: 11, marginLeft: 6 }}> MARCAR PUNTO ({polygonCoords.length})</Text>
                 </TouchableOpacity>

                 {polygonCoords.length >= 3 && (
                   <TouchableOpacity
                     style={[
                       { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 8, borderWidth: 2, borderColor: '#000', backgroundColor: '#FFD700', elevation: 5 },
                       isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000' } : null,
                     ]}
                     onPress={() => finishDrawing()}
                   >
                      <MaterialCommunityIcons name="radar" size={20} color="#000" />
                      <Text style={{ color: '#000', fontWeight: '900', fontSize: 11, marginLeft: 6 }}> ANALIZAR POLÍGONO</Text>
                   </TouchableOpacity>
                 )}
               </View>

               <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 10 }}>
                 <TouchableOpacity style={[styles.cancelDrawBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#FF3B30', borderWidth: 2 } : null, { flex: 1, marginRight: 8, height: 35, borderRadius: 8, justifyContent: 'center', padding: 0, marginTop: 0 }]} onPress={() => setPolygonCoords([])}>
                    <Text style={[styles.cancelDrawText, { textAlign: 'center', fontSize: 10 }]}>LIMPIAR</Text>
                 </TouchableOpacity>
                 <TouchableOpacity style={[styles.cancelDrawBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#FF3B30', borderWidth: 2 } : null, { flex: 1, height: 35, borderRadius: 8, justifyContent: 'center', padding: 0, marginTop: 0 }]} onPress={() => selectMode('none')}>
                    <Text style={[styles.cancelDrawText, { textAlign: 'center', fontSize: 10 }]}>SALIR</Text>
                 </TouchableOpacity>
               </View>
             </View>
          ) : (
             <View style={styles.actionBox}>
               {(polygonCoords.length >= 3) ? (
                 <>
                   <Text style={[styles.instructionText, isFieldMode && { color: '#444' }, { fontSize: 10, marginBottom: 5 }]}>ZONA CARGADA: {selectedMineral.toUpperCase()}</Text>
                   <View style={{flexDirection: 'row', width: '100%', justifyContent: 'center', gap: 8, paddingHorizontal: 10}}>
                     <Pressable 
                       style={({ pressed }) => [{ backgroundColor: '#FFD700', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 40, flex: 1, borderRadius: 8, borderWidth: 1, borderColor: '#000' }, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 2 } : null, pressed && { opacity: 0.7 }, isAnalyzing && { backgroundColor: '#555' }]} 
                       onPress={() => analyzeZone()} 
                       disabled={isAnalyzing}
                     >
                       {isAnalyzing ? <ActivityIndicator color={isFieldMode ? "#000" : "#FFF"} size="small" /> : <MaterialCommunityIcons name="brain" size={16} color="#000" />}
                       <Text style={[{ color: '#000', fontWeight: 'bold', fontSize: 10, marginLeft: 5 }, isFieldMode ? { color: '#000000' } : null]}>{isAnalyzing ? ' CALCULANDO...' : ' ANALIZAR ZONA CARGADA'}</Text>
                     </Pressable>
                     <TouchableOpacity style={[{ backgroundColor: 'rgba(255, 60, 60, 0.2)', borderWidth: 1, borderColor: '#FF3B30', height: 40, flex: 0.5, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#FF3B30', borderWidth: 2 } : null]} onPress={clearShapes}>
                        <Text style={[{ color: '#FF3B30', fontWeight: 'bold', fontSize: 10 }]}>BORRAR</Text>
                     </TouchableOpacity>
                   </View>
                 </>
               ) : (
                 <Text style={[styles.instructionText, { color: '#888' }]}>Toca "Trazar" para delimitar una zona de 3 vértices</Text>
               )}
             </View>
          )}
        </View>
      </View>

      {showResults && (() => {
        // Regional average for the selected mineral (from grid points)
        const regionalAvg = analysisPoints.length > 0
          ? analysisPoints.reduce((s, p) => s + (p.base_score || 0), 0) / analysisPoints.length
          : undefined;
        // Global max for selected mineral (for ranking section)
        const selMs = metalScores.find(ms => ms.metal === selectedMineral);
        const selGlobalMax = selMs?.score_maximo ?? 100;
        const selColor = METAL_COLORS[selectedMineral] ?? '#FFD700';

        return (
          <View style={styles.resultsPanel}>
            {/* ── Header ─────────────────────────────────────────────────── */}
            <View style={styles.resultsHeader}>
              <View>
                <Text style={styles.resultsTitle}>📊 ANÁLISIS MINERAL</Text>
                <Text style={{color: '#666', fontSize: 10, marginTop: 1}}>
                  {selectedMineral.toUpperCase()} · {terrainType.toUpperCase()}
                  {analysisPoints.length > 0 ? `  ·  ${analysisPoints.length} puntos` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowResults(false)}>
                <MaterialCommunityIcons name="close" size={24} color="#FFD700" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{maxHeight: 400}} showsVerticalScrollIndicator={false}>

              {/* ── Fuente de datos + malla adaptativa ──────────────────── */}
              {satelliteData && (() => {
                const csm  = satelliteData.cell_size_m || computeAdaptiveCellSize(parseFloat(areaHa));
                const isLarge = parseFloat(areaHa) > 50_000;
                return (
                  <View style={{
                    backgroundColor: satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90
                      ? '#2A2A00' : '#0A2A0A',
                    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6,
                    marginHorizontal: 8, marginBottom: 8,
                  }}>
                    <Text style={{ fontSize: 11, color: '#DDDDDD', textAlign: 'center' }}>
                      {satelliteData.source_label}
                    </Text>
                    <Text style={{ fontSize: 10, color: '#4CAF50', textAlign: 'center', marginTop: 3 }}>
                      Malla: {csm >= 1000 ? `${csm / 1000} km` : `${csm} m`} × {csm >= 1000 ? `${csm / 1000} km` : `${csm} m`}
                      {analysisPoints.length > 0 ? `  ·  ${analysisPoints.length} puntos` : ''}
                    </Text>
                    {satelliteData.cache_age_days !== undefined && satelliteData.cache_age_days > 90 && (
                      <Text style={{ fontSize: 10, color: '#FF9800', textAlign: 'center', marginTop: 2 }}>
                        ⚠️ Datos de hace {satelliteData.cache_age_days} días — actualiza con conexión
                      </Text>
                    )}
                    {isLarge && (
                      <Text style={{ fontSize: 10, color: '#FF9800', textAlign: 'center', marginTop: 3 }}>
                        Zona amplia — dibuja un polígono más chico sobre las anomalías para ver detalle de 20 m
                      </Text>
                    )}
                  </View>
                );
              })()}

              {/* ── ScoreCards por metal ──────────────────────────────────── */}
              {metalScores.map((ms) => (
                <ScoreCard
                  key={ms.metal}
                  metal={ms.metal}
                  terrain={terrainType}
                  metalLabel={ms.label}
                  metalIcon={ms.icon}
                  pointScore={ms.score_poligono}
                  globalMax={ms.score_maximo}
                  regionalAvg={ms.metal === selectedMineral ? regionalAvg : undefined}
                  guideMineral={ms.guideMineral}
                  warning={ms.warning}
                />
              ))}

              {/* ── Ranking por intensidad de anomalía ────────────────────── */}
              {analysisPoints.length > 0 && (
                <View style={styles.rankingSection}>
                  <View style={styles.rankingHeader}>
                    <Text style={styles.rankingTitle}>
                      ZONAS PRIORITARIAS — {selectedMineral.toUpperCase()} {terrainType.toUpperCase()}
                    </Text>
                  </View>

                  {analysisPoints.slice(0, 5).map((p, i) => {
                    const score = Math.round(p.score || p.base_score || 0);
                    const pct   = Math.round((score / selGlobalMax) * 100);
                    const anomalyLevel = pct >= 65 ? 'ALTA' : pct >= 35 ? 'MEDIA' : 'BAJA';
                    const anomalyColor = pct >= 65 ? '#E53935' : pct >= 35 ? '#FFA000' : '#546E7A';
                    return (
                      <TouchableOpacity
                        key={i}
                        style={styles.rankingItem}
                        onPress={() => {
                          mapRef.current?.animateToRegion({
                            latitude: p.lat,
                            longitude: p.lng,
                            latitudeDelta: 0.005,
                            longitudeDelta: 0.005,
                          }, 500);
                        }}
                      >
                        <Text style={styles.rankingRank}>#{p.rank}</Text>
                        <View style={{flex: 1, marginHorizontal: 10}}>
                          <Text style={styles.rankingCoord}>
                            {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                          </Text>
                          <View style={styles.rankingTrack}>
                            {/* anomaly intensity bar */}
                            <View style={[styles.rankingFill, {width: `${pct}%`, backgroundColor: anomalyColor}]} />
                          </View>
                        </View>
                        <View style={{alignItems: 'flex-end', minWidth: 56}}>
                          <Text style={[styles.rankingScore, {color: anomalyColor, fontSize: 11}]}>{anomalyLevel}</Text>
                          <Text style={styles.rankingPct}>alteración</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              <View style={{height: 14}} />
            </ScrollView>
          </View>
        );
      })()}

      {/* ── TAP POINT ANALYSIS PANEL ────────────────────────────────────────── */}
      {tapPoint && (
        <View style={styles.tapPanel}>

          {/* Header */}
          {(() => {
            const nearestCell = satelliteData?.cells?.length
              ? findNearestCell(tapPoint.lat, tapPoint.lng, satelliteData.cells)
              : null;
            const hasReal = nearestCell !== null;
            return (
              <>
                <View style={styles.resultsHeader}>
                  <View style={{flex: 1}}>
                    <Text style={styles.resultsTitle}>📍 PUNTO TOCADO</Text>
                    <Text style={{
                      fontSize: 10, marginTop: 2,
                      color: hasReal ? '#4CAF50' : '#FF6B35',
                    }}>
                      {hasReal
                        ? `✅ Sentinel-2 real · celda a ${
                            Math.round(Math.sqrt(
                              ((nearestCell!.lat - tapPoint.lat)**2 + (nearestCell!.lng - tapPoint.lng)**2)
                            ) * 111000)
                          } m`
                        : '⚠️ Sin datos reales — dibuja un polígono sobre esta zona'}
                    </Text>
                    <Text style={{color: '#555', fontSize: 10, marginTop: 2, fontFamily: 'monospace'}}>
                      {tapPoint.lat.toFixed(6)}, {tapPoint.lng.toFixed(6)}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setTapPoint(null)} hitSlop={{top:10,bottom:10,left:10,right:10}}>
                    <MaterialCommunityIcons name="close" size={24} color="#FFD700" />
                  </TouchableOpacity>
                </View>

                <ScrollView style={{maxHeight: 420}} showsVerticalScrollIndicator={false}>
                  {hasReal ? (
                    // ── REAL DATA: anomaly from nearest Sentinel-2 cell ────────
                    (() => {
                      const cell = nearestCell!;
                      const BARS = 20;
                      return (
                        <>
                          {(['oro', 'plata', 'cobre', 'litio', 'hierro'] as const).map(metal => {
                            const score        = cellAnomalyScore(cell, metal);
                            const { level, color: aColor } = anomalyFromPct(score);
                            const msg          = tapMessage(score);
                            const meta         = TAP_METAL_META[metal];
                            const ptBars       = Math.round((score / 100) * BARS);
                            return (
                              <View key={metal} style={{marginBottom: 14, paddingBottom: 14,
                                borderBottomWidth: 1, borderBottomColor: '#1C1C1C'}}>
                                <View style={{flexDirection: 'row', alignItems: 'center',
                                  marginBottom: 8, justifyContent: 'space-between'}}>
                                  <Text style={{fontWeight: '900', fontSize: 14,
                                    color: meta?.color ?? '#FFD700', letterSpacing: 0.4}}>
                                    {meta?.icon}  {meta?.label}
                                  </Text>
                                  <View style={{borderWidth: 1.5, borderColor: aColor,
                                    borderRadius: 5, paddingHorizontal: 8, paddingVertical: 2,
                                    backgroundColor: `${aColor}22`}}>
                                    <Text style={{color: aColor, fontWeight: '900',
                                      fontSize: 11, letterSpacing: 0.5}}>{level}</Text>
                                  </View>
                                </View>
                                <View style={{flexDirection: 'row', alignItems: 'center', marginBottom: 5}}>
                                  <Text style={{fontSize: 10, color: '#666', width: 116}}>
                                    Alteración:
                                  </Text>
                                  <Text style={{fontFamily: 'monospace', fontSize: 11,
                                    color: aColor, flex: 1}}>
                                    {'█'.repeat(ptBars) + '░'.repeat(BARS - ptBars)}
                                  </Text>
                                </View>
                                <Text style={{fontSize: 11, color: msg.color, marginLeft: 116}}>
                                  {msg.text}
                                </Text>
                              </View>
                            );
                          })}
                          {/* Raw spectral indices for transparency */}
                          <View style={{backgroundColor: '#0A0A0A', borderRadius: 8,
                            borderWidth: 1, borderColor: '#1E1E1E', padding: 10, marginTop: 4}}>
                            <Text style={{color: '#444', fontSize: 9, letterSpacing: 0.8, marginBottom: 6}}>
                              ÍNDICES SENTINEL-2 (celda {cell.lat.toFixed(4)}, {cell.lng.toFixed(4)})
                            </Text>
                            {[
                              { label: 'Óxido de Fe (B4/B2)', value: cell.iron_oxide.toFixed(3) },
                              { label: 'Arcilla (B11/B12)',   value: cell.clay.toFixed(3)       },
                              { label: 'Ferroso (B11/B8)',    value: cell.ferroso.toFixed(3)    },
                              { label: 'NDVI',                value: cell.ndvi.toFixed(3)       },
                            ].map(({ label, value }) => (
                              <View key={label} style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3}}>
                                <Text style={{color: '#555', fontSize: 10}}>{label}</Text>
                                <Text style={{color: '#888', fontSize: 10, fontFamily: 'monospace'}}>{value}</Text>
                              </View>
                            ))}
                            {cell.masked_by_vegetation && (
                              <Text style={{color: '#FF9800', fontSize: 9, marginTop: 4}}>
                                ⚠️ NDVI alto — señal mineral puede estar atenuada por vegetación
                              </Text>
                            )}
                          </View>
                          <Text style={{color: '#333', fontSize: 9, marginTop: 10, fontStyle: 'italic'}}>
                            Indicador exploratorio — requiere verificación en campo
                          </Text>
                          <View style={{height: 14}} />
                        </>
                      );
                    })()
                  ) : (
                    // ── NO DATA: invite to draw polygon ────────────────────────
                    <View style={{alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16}}>
                      <Text style={{fontSize: 28, marginBottom: 12}}>🛰️</Text>
                      <Text style={{color: '#888', fontSize: 13, fontWeight: '700',
                        textAlign: 'center', marginBottom: 8}}>
                        Sin datos reales en esta zona
                      </Text>
                      <Text style={{color: '#555', fontSize: 11, textAlign: 'center', lineHeight: 17}}>
                        Dibuja un polígono sobre esta área y presiona{' '}
                        <Text style={{color: '#FFD700', fontWeight: '700'}}>ANALIZAR</Text>
                        {' '}para ver anomalías reales de Sentinel-2.
                      </Text>
                      <Text style={{color: '#3A3A3A', fontSize: 10, textAlign: 'center',
                        marginTop: 12, fontStyle: 'italic'}}>
                        No se muestran scores sin datos satelitales reales.
                      </Text>
                    </View>
                  )}
                </ScrollView>
              </>
            );
          })()}
        </View>
      )}

      <Modal visible={!!selectedPoint} transparent animationType="slide">
        <View style={[styles.modalOverlay, {backgroundColor: 'rgba(0,0,0,0.85)'}]}>
          <View style={{backgroundColor: '#000', borderColor: '#FFD700', borderWidth: 2, borderRadius: 20, padding: 20, width: '92%', maxHeight: '85%'}}>
            
            {/* ── HEADER ─────────────────────────────────────────────────────── */}
            <View style={{borderBottomWidth: 1, borderBottomColor: '#333', paddingBottom: 10, marginBottom: 14}}>
              <Text style={{color: '#FFD700', fontSize: 18, fontWeight: '900', letterSpacing: 0.5}}>
                PUNTO #{selectedPoint?.rank}
              </Text>
              <Text style={{color: '#FFF', fontSize: 11, marginTop: 4, fontFamily: 'monospace'}}>
                📍 Lat: {selectedPoint?.lat.toFixed(6)} | Lng: {selectedPoint?.lng.toFixed(6)}
              </Text>
              <Text style={{color: '#888', fontSize: 11, marginTop: 2}}>
                Terreno: {terrainType.charAt(0).toUpperCase() + terrainType.slice(1)}{'  |  '}Metal: {selectedMineral.toUpperCase()}
              </Text>
            </View>

            <ScrollView style={{maxHeight: '100%'}}>
              {selectedPoint && (() => {
                const BARS      = 18;
                // selectedPoint.base_score is real (derived from Sentinel-2 in analyzeZoneLocal)
                const realScore = Math.round(selectedPoint.base_score || selectedPoint.score || 0);
                const { level: primLevel, color: primColor } = anomalyFromPct(realScore);
                // Use nearest cell for multi-metal breakdown (point IS inside the polygon)
                const nearestCell = satelliteData?.cells?.length
                  ? findNearestCell(selectedPoint.lat, selectedPoint.lng, satelliteData.cells)
                  : null;

                return (
                  <>
                    {/* ── Data source label ────────────────────────────── */}
                    <Text style={{fontSize: 10, color: '#4CAF50', marginBottom: 12}}>
                      ✅ Datos Sentinel-2 reales · {satelliteData?.source_label ?? ''}
                    </Text>

                    {/* ── Primary mineral (from real grid score) ───────── */}
                    <View style={{backgroundColor: '#0D1A0D', borderRadius: 8, borderWidth: 1,
                      borderColor: '#1E3A1E', padding: 12, marginBottom: 12}}>
                      <Text style={{color: '#888', fontSize: 9, letterSpacing: 0.8, marginBottom: 6}}>
                        MINERAL SELECCIONADO — {selectedMineral.toUpperCase()}
                      </Text>
                      <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8}}>
                        <Text style={{color: METAL_COLORS[selectedMineral] ?? '#FFD700',
                          fontWeight: '900', fontSize: 16}}>
                          {TAP_METAL_META[selectedMineral]?.icon}  {TAP_METAL_META[selectedMineral]?.label}
                        </Text>
                        <View style={{borderWidth: 1.5, borderColor: primColor, borderRadius: 5,
                          paddingHorizontal: 10, paddingVertical: 3, backgroundColor: `${primColor}22`}}>
                          <Text style={{color: primColor, fontWeight: '900', fontSize: 13}}>{primLevel}</Text>
                        </View>
                      </View>
                      <View style={{height: 6, backgroundColor: '#1A1A1A', borderRadius: 3, overflow: 'hidden', marginBottom: 6}}>
                        <View style={{height: '100%', width: `${realScore}%`,
                          backgroundColor: primColor, borderRadius: 3}} />
                      </View>
                      <Text style={{color: '#555', fontSize: 9, fontStyle: 'italic'}}>
                        Intensidad de alteración calculada de índices espectrales reales
                      </Text>
                    </View>

                    {/* ── Other metals from nearest cell ───────────────── */}
                    {nearestCell && (
                      <>
                        <Text style={{color: '#444', fontSize: 9, letterSpacing: 0.8, marginBottom: 8}}>
                          OTROS METALES — celda Sentinel-2 más cercana
                        </Text>
                        {(['oro', 'plata', 'cobre', 'litio', 'hierro'] as const)
                          .filter(m => m !== selectedMineral)
                          .map(metal => {
                            const score        = cellAnomalyScore(nearestCell, metal);
                            const { level, color: aColor } = anomalyFromPct(score);
                            const meta         = TAP_METAL_META[metal];
                            const ptBars       = Math.round((score / 100) * BARS);
                            return (
                              <View key={metal} style={{flexDirection: 'row', alignItems: 'center',
                                marginBottom: 9, paddingBottom: 9,
                                borderBottomWidth: 1, borderBottomColor: '#151515'}}>
                                <Text style={{color: meta?.color ?? '#888', fontWeight: '700',
                                  fontSize: 12, width: 80}}>
                                  {meta?.icon} {meta?.label}
                                </Text>
                                <Text style={{fontFamily: 'monospace', fontSize: 10,
                                  color: aColor, flex: 1}}>
                                  {'█'.repeat(ptBars) + '░'.repeat(BARS - ptBars)}
                                </Text>
                                <View style={{borderWidth: 1, borderColor: aColor, borderRadius: 4,
                                  paddingHorizontal: 6, paddingVertical: 1, marginLeft: 6,
                                  backgroundColor: `${aColor}22`}}>
                                  <Text style={{color: aColor, fontWeight: '700', fontSize: 9}}>{level}</Text>
                                </View>
                              </View>
                            );
                          })}
                      </>
                    )}

                    <Text style={{color: '#333', fontSize: 9, marginTop: 8, marginBottom: 16, fontStyle: 'italic'}}>
                      Indicador exploratorio — requiere verificación en campo
                    </Text>
                  </>
                );
              })()}

              {/* Botones */}
              <TouchableOpacity style={{backgroundColor: '#FFD700', minWidth: 140, padding: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12}} onPress={() => { 
                  mapRef.current?.animateToRegion({latitude: selectedPoint?.lat, longitude: selectedPoint?.lng, latitudeDelta: 0.002, longitudeDelta: 0.002}, 800); 
                  setSelectedPoint(null);
              }}>
                 <Text style={{color: '#000', fontWeight: 'bold', fontSize: 14}}>NAVEGAR A COORDENADAS</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={{backgroundColor: '#FFD700', minWidth: 140, padding: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12}} onPress={() => {
                  mapRef.current?.animateToRegion({latitude: selectedPoint?.lat, longitude: selectedPoint?.lng, latitudeDelta: 0.002, longitudeDelta: 0.002}, 0);
                  setSampleBase64(null); setAiResult(null); setWaypointNote('');
                  setShowWaypointModal(true);
                  setSelectedPoint(null);
              }}>
                 <Text style={{color: '#000', fontWeight: 'bold', fontSize: 14}}>GUARDAR COMO MUESTRA</Text>
              </TouchableOpacity>

              <TouchableOpacity style={{backgroundColor: 'transparent', borderColor: '#FFD700', borderWidth: 2, minWidth: 140, padding: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center'}} onPress={() => setSelectedPoint(null)}>
                  <Text style={{color: '#FFD700', fontWeight: 'bold', fontSize: 14}}>CERRAR</Text>
              </TouchableOpacity>
              
              <View style={{height: 20}} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* CAMARA MODAL */}
      <Modal 
        visible={showWaypointModal} 
        animationType="slide" 
        presentationStyle="pageSheet"
        onRequestClose={() => { setSampleBase64(null); setAiResult(null); setShowWaypointModal(false); }}
      >
        <View style={[styles.modalOverlay, {backgroundColor: 'rgba(0,0,0,0.85)'}]}>
          <ScrollView style={[styles.modalContent, { maxHeight: '100%', flex: 1, backgroundColor: '#000', borderColor: '#FFD700', borderWidth: 2, padding: 20, borderRadius: 20 }, isFieldMode && styles.modalContentLight]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <Text style={[styles.modalTitle, isFieldMode && styles.modalTitleLight, {fontSize: 18, marginBottom: 0}]}>📸 CAPTURA DE MUESTRA</Text>
              <TouchableOpacity onPress={() => { setSampleBase64(null); setAiResult(null); setShowWaypointModal(false); }}>
                <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? "#000" : "#FFD700"} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.modalSub, {fontSize: 12, color: '#FFF'}]}>Proyecto: {activeProject} | GPS: {mapCenter?.latitude.toFixed(5)}</Text>
            
            {!sampleBase64 ? (
              <View style={{marginTop: 20}}>
                <Text style={{color: isFieldMode ? '#444' : '#888', fontSize: 14, marginBottom: 15}}>Selecciona el tipo de lente para abrir la cámara:</Text>
                
                <TouchableOpacity style={[styles.giantHitboxBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null, { height: 60, marginBottom: 15, backgroundColor: '#222', borderRadius: 8, width: '100%', borderColor: '#444' }]} onPress={() => takeSamplePhoto('normal')}>
                  <MaterialCommunityIcons name="camera" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                  <Text style={[styles.giantHitboxText, isFieldMode ? { color: '#000000' } : null, {fontSize: 14, color: '#FFF'}]}> FOTO NORMAL</Text>
                </TouchableOpacity>

                <View style={{backgroundColor: '#111', padding: 10, borderRadius: 8, marginBottom: 15}}>
                   <Text style={{color: '#FFD700', fontSize: 12, marginBottom: 10}}>* Monta el lente macro Carson sobre la cámara antes de disparar.</Text>
                   <TouchableOpacity style={[styles.giantHitboxBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null, { height: 60, backgroundColor: '#222', borderRadius: 8, width: '100%', borderColor: '#444' }]} onPress={() => takeSamplePhoto('microscopio')}>
                     <MaterialCommunityIcons name="microscope" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                     <Text style={[styles.giantHitboxText, isFieldMode ? { color: '#000000' } : null, {fontSize: 14, color: '#FFF'}]}> MICROSCOPIO</Text>
                   </TouchableOpacity>
                </View>

                <View style={{backgroundColor: '#111', padding: 10, borderRadius: 8, marginBottom: 15}}>
                   <Text style={{color: '#00FFFF', fontSize: 12, marginBottom: 10}}>* Apaga la luz blanca. Ilumina con linterna UV a 10cm de la roca.</Text>
                   <TouchableOpacity style={[styles.giantHitboxBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null, { height: 60, backgroundColor: '#222', borderRadius: 8, width: '100%', borderColor: '#444', marginBottom: 10 }]} onPress={() => takeSamplePhoto('uv_365')}>
                     <MaterialCommunityIcons name="flashlight" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                     <Text style={[styles.giantHitboxText, isFieldMode ? { color: '#000000' } : null, {fontSize: 14, color: '#FFF'}]}> UV 365nm (Onda Larga)</Text>
                   </TouchableOpacity>
                   <TouchableOpacity style={[styles.giantHitboxBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null, { height: 60, backgroundColor: '#222', borderRadius: 8, width: '100%', borderColor: '#444' }]} onPress={() => takeSamplePhoto('uv_254')}>
                     <MaterialCommunityIcons name="flashlight" size={24} color={isFieldMode ? '#000' : '#FFF'} />
                     <Text style={[styles.giantHitboxText, isFieldMode ? { color: '#000000' } : null, {fontSize: 14, color: '#FFF'}]}> UV 254nm (Onda Corta)</Text>
                   </TouchableOpacity>
                </View>

                <TouchableOpacity style={[styles.modalBtnCancel, {marginTop: 20, backgroundColor: '#FF3B30'}]} onPress={() => setShowWaypointModal(false)}>
                  <Text style={[styles.modalBtnTextWhite, {fontSize: 14}]}>CANCELAR</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{marginTop: 10}}>
                <View style={{ height: 260, backgroundColor: '#000', borderRadius: 8, marginBottom: 15, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }}>
                   <Image source={{uri: `data:image/jpeg;base64,${sampleBase64}`}} style={{width: '100%', height: '100%'}} resizeMode="contain" />
                </View>

                {!aiResult && (
                   <TouchableOpacity style={[styles.giantHitboxBtn, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null, { height: 60, marginBottom: 15, backgroundColor: '#FFD700', borderRadius: 8, width: '100%' }]} onPress={() => runAI(sampleBase64, sampleCaptureType)} disabled={isAiProcessing}>
                     {isAiProcessing ? (
                       <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                         <ActivityIndicator color={isFieldMode ? "#000" : "#000"} style={{ marginRight: 8 }} />
                         <Text style={[styles.giantHitboxText, isFieldMode ? { color: '#000000' } : null, {fontSize: 14, marginLeft: 0}]}>ANALIZANDO CON IA...</Text>
                       </View>
                     ) : (
                       <Text style={[styles.giantHitboxText, isFieldMode ? { color: '#000000' } : null, {fontSize: 14, color: '#FFF'}]}>⚠️ ANALIZAR CON IA</Text>
                     )}
                   </TouchableOpacity>
                )}

                {aiResult && (
                   <View style={[{ backgroundColor: '#222', padding: 15, borderRadius: 8, marginBottom: 15, borderWidth: 1, borderColor: '#FFD700' }, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null]}>
                     <Text style={[{color: '#FFD700', fontWeight: 'bold', fontSize: 16}, isFieldMode ? {color: '#000'} : null]}>{aiResult.mineral_detectado.toUpperCase()} ({aiResult.probabilidad}%)</Text>
                     
                     <Text style={{color: '#AAA', fontSize: 11, marginTop: 10, letterSpacing: 1}}>ALTERACIÓN / PARAGÉNESIS</Text>
                     <Text style={[{color: '#FFF', fontSize: 13, marginTop: 2}, isFieldMode ? {color: '#000'} : null]}>{aiResult.alteracion}</Text>
                     
                     <Text style={{color: '#AAA', fontSize: 11, marginTop: 10, letterSpacing: 1}}>INDICADORES CLAVE</Text>
                     <Text style={[{color: '#FFF', fontSize: 13, marginTop: 2}, isFieldMode ? {color: '#000'} : null]}>{aiResult.indicadores?.join(', ')}</Text>

                     {(aiResult.fluorescencia_uv && aiResult.fluorescencia_uv !== 'N/A') && (
                       <View>
                         <Text style={{color: '#00FFFF', fontSize: 11, marginTop: 10, letterSpacing: 1}}>FLUORESCENCIA UV</Text>
                         <Text style={[{color: '#FFF', fontSize: 13, marginTop: 2}, isFieldMode ? {color: '#000'} : null]}>{aiResult.fluorescencia_uv}</Text>
                       </View>
                     )}

                     <Text style={{color: '#AAA', fontSize: 11, marginTop: 10, letterSpacing: 1}}>ANÁLISIS TÁCTICO</Text>
                     <Text style={[{color: '#DDD', fontSize: 13, lineHeight: 18, marginTop: 2}, isFieldMode ? {color: '#000'} : null]}>{aiResult.analisis_detallado}</Text>
                     
                     <Text style={[{color: '#FFD700', backgroundColor: '#111', padding: 12, borderRadius: 6, fontSize: 14, fontWeight: 'bold', marginTop: 15}, isFieldMode ? {color: '#000', backgroundColor: '#EEE'} : null]}>{'>>> '} {aiResult.recomendacion}</Text>
                   </View>
                )}

                <TextInput 
                  style={[styles.modalInput, isFieldMode ? styles.modalInputLight : null, { height: 60, fontSize: 14, marginBottom: 15 }]} 
                  placeholder="Notas geológicas manuales (opcional)..." 
                  placeholderTextColor="#888"
                  value={waypointNote} 
                  onChangeText={setWaypointNote} 
                  multiline 
                />
                
                <View style={{flexDirection: 'row', justifyContent: 'center', marginTop: 20, gap: 12}}>
                  <TouchableOpacity style={{flex: 1, minWidth: 100, backgroundColor: 'transparent', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 2, borderColor: '#FF3B30', alignItems: 'center'}} onPress={() => { setSampleBase64(null); setAiResult(null); setShowWaypointModal(false); }}>
                    <Text style={{color: '#FF3B30', fontSize: 14, fontWeight: 'bold'}}>CANCELAR</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={{flex: 1, minWidth: 100, backgroundColor: 'transparent', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 2, borderColor: '#FFD700', alignItems: 'center'}} onPress={() => { setSampleBase64(null); setAiResult(null); }}>
                    <Text style={{color: '#FFD700', fontSize: 14, fontWeight: 'bold'}}>REINTENTAR</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[{flex: 1, minWidth: 100, backgroundColor: '#FFD700', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 2, borderColor: '#000', alignItems: 'center'}, isFieldMode ? { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 3 } : null]} onPress={saveWaypoint}>
                    <Text style={[{color: '#000', fontSize: 14, fontWeight: 'bold'}, isFieldMode ? { color: '#000000' } : null]}>GUARDAR</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* CHAT EXPERTO MODAL */}
      <Modal visible={showChatModal} transparent animationType="slide">
        <View style={[styles.modalOverlay, {backgroundColor: 'rgba(0,0,0,0.85)'}]}>
          <View style={[{backgroundColor: '#000', borderColor: '#00FF00', borderWidth: 2, borderRadius: 20, padding: 20, width: '95%', height: '80%'}, isFieldMode && styles.modalContentLight]}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, borderBottomWidth: 1, borderBottomColor: '#333', paddingBottom: 10 }}>
               <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#00FF00' }}>👨🏻‍💻 DEV IA (Admin)</Text>
               <TouchableOpacity onPress={() => setShowChatModal(false)}>
                 <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? "#000" : "#FFD700"} />
               </TouchableOpacity>
            </View>
            <ScrollView style={{flex: 1, marginBottom: 15}}>
              {chatMessages.length === 0 && (
                <Text style={{color: '#888', textAlign: 'center', marginTop: 20}}>¡Hola! Soy tu asistente de campo. Hazme preguntas técnicas de mineralogía, estratigrafía o uso de equipo.</Text>
              )}
              {chatMessages.map((msg, idx) => (
                <View key={idx} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? '#333' : '#FFD700', padding: 12, borderRadius: 12, maxWidth: '80%', marginBottom: 10 }}>
                  <Text style={{ color: msg.role === 'user' ? '#FFF' : '#000', fontSize: 14 }}>{msg.content}</Text>
                </View>
              ))}
              {isTypingChat && <ActivityIndicator color="#FFD700" style={{alignSelf: 'flex-start', marginTop: 10}} />}
            </ScrollView>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
              <TextInput 
                style={[
                  {flex: 1, padding: 12, borderRadius: 8, borderWidth: 1},
                  isFieldMode ? { backgroundColor: '#F5F5F5', color: '#000', borderColor: '#CCC' } : { backgroundColor: '#222', color: '#FFF', borderColor: '#444' }
                ]} 
                placeholder="Escribe tu consulta al motor IA..." 
                placeholderTextColor={isFieldMode ? "#888" : "#666"} 
                value={chatInput} 
                onChangeText={setChatInput} 
              />
              <TouchableOpacity onPress={sendChatMessage} style={{backgroundColor: '#FFD700', padding: 12, borderRadius: 8}}>
                 <MaterialCommunityIcons name="send" size={24} color="#000" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* HISTORY MODAL */}
      <Modal visible={showHistoryModal} transparent animationType="slide">
        <View style={[styles.modalOverlay, {backgroundColor: 'rgba(0,0,0,0.85)'}]}>
          <View style={[{backgroundColor: '#000', borderColor: '#FFD700', borderWidth: 2, borderRadius: 20, padding: 20, width: '92%', maxHeight: '85%', flex: 1}, isFieldMode && styles.modalContentLight]}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, borderBottomWidth: 1, borderBottomColor: '#333', paddingBottom: 10 }}>
               <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#FFD700' }}>📋 HISTORIAL</Text>
               <TouchableOpacity onPress={() => setShowHistoryModal(false)}>
                 <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? "#000" : "#FFD700"} />
               </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 12, color: '#FFF', marginBottom: 10 }}>{waypoints.length} Muestras almacenadas localmente.</Text>
            
            <ScrollView style={{flex: 1, marginBottom: 20}}>
              {waypoints.map((wp, i) => (
                 <View key={i} style={{paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#333', marginBottom: 8}}>
                    <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
                      <Text style={{color: '#888', fontSize: 11}}>{new Date(wp.fecha_hora || wp.timestamp).toLocaleString()}</Text>
                      <Text style={{color: '#000', fontSize: 10, fontWeight: 'bold', backgroundColor: '#00FFFF', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4}}>{wp.proyecto_id || wp.project || 'Sin Proyecto'}</Text>
                    </View>
                    <Text style={{color: '#FFF', fontSize: 11, marginTop: 5}}>Lat: {parseFloat(wp.lat || wp.latitude || 0).toFixed(6)} | Lng: {parseFloat(wp.lng || wp.longitude || 0).toFixed(6)}</Text>
                    <Text style={{color: '#FFD700', fontSize: 12, fontWeight: 'bold', marginTop: 4}}>{wp.mineral_detectado ? `💎 ${wp.mineral_detectado.toUpperCase()} (${wp.score_ia}%)` : (wp.descripcion_texto || wp.note || 'Muestra sin IA')}</Text>
                 </View>
              ))}
              {waypoints.length === 0 && <Text style={{color: '#888', textAlign: 'center', marginTop: 50, fontSize: 12}}>Aún no capturas ninguna muestra</Text>}
            </ScrollView>

            <View style={{flexDirection: 'row', justifyContent: 'space-between', gap: 10}}>
              <TouchableOpacity style={{ flex: 1, backgroundColor: 'transparent', borderColor: '#FF3B30', borderWidth: 2, minWidth: 120, padding: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }} onPress={async () => { await clearMuestras(); loadMuestras(); }}>
                 <Text style={{color: '#FF3B30', fontWeight: 'bold', fontSize: 14}}>Borrar BD</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ flex: 1, backgroundColor: '#000', borderColor: '#FFD700', borderWidth: 2, minWidth: 120, padding: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }} onPress={exportCSV}>
                  <Text style={{color: '#FFD700', fontWeight: 'bold', fontSize: 14}}>Exportar CSV</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* CONFIGURATION MODAL */}
      <Modal visible={showConfigModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <ScrollView style={[styles.modalContent, { maxHeight: '85%' }, isFieldMode && styles.modalContentLight]}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
               <Text style={[styles.modalTitle, isFieldMode && styles.modalTitleLight, { marginBottom: 0 }]}>⚙️ CONFIGURACIÓN</Text>
               <TouchableOpacity onPress={() => setShowConfigModal(false)}>
                  <MaterialCommunityIcons name="close" size={28} color={isFieldMode ? "#000" : "#FFD700"} />
               </TouchableOpacity>
            </View>

            <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 20, fontWeight: 'bold' }]}>0. GESTIÓN LOCAL</Text>
            <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }]}>PROYECTO ACTIVO</Text>
            <TextInput 
              style={[styles.modalInput, isFieldMode && styles.modalInputLight, { height: 44, marginBottom: 10, fontSize: 15, fontWeight: 'bold' }]} 
              value={activeProject} 
              onChangeText={setActiveProject} 
              placeholder="Ej: Concesión Norte" 
              placeholderTextColor="#888"
            />

            <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 20, fontWeight: 'bold' }]}>1. GEOLOGÍA ESTRUCTURAL</Text>

            <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }]}>MINERAL OBJETIVO</Text>
            <View style={styles.chipsRowModal}>
              {['oro','plata','cobre','zinc','plomo'].map(m => (
                <TouchableOpacity key={m} style={[styles.chipModal, selectedMineral === m && styles.chipActive]} onPress={() => setSelectedMineral(m)}>
                  <Text style={[styles.chipTextModal, selectedMineral === m && styles.chipTextActive]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }]}>TIPO DE TERRENO</Text>
            <View style={styles.chipsRowModal}>
              {['sierra','playa'].map(m => (
                <TouchableOpacity key={m} style={[styles.chipModal, terrainType === m && styles.chipActive]} onPress={() => setTerrainType(m)}>
                  <Text style={[styles.chipTextModal, terrainType === m && styles.chipTextActive]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }]}>PROFUNDIDAD EST.</Text>
            <View style={styles.chipsRowModal}>
              {['0-5m','5-20m','20m+'].map(m => (
                <TouchableOpacity key={m} style={[styles.chipModal, depth === m && styles.chipActive]} onPress={() => setDepth(m)}>
                  <Text style={[styles.chipTextModal, depth === m && styles.chipTextActive]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }]}>TIPO DE ROCA MASIVA</Text>
            <View style={styles.chipsRowModal}>
              {['ignea','sedimentaria','metamorfica'].map(m => (
                <TouchableOpacity key={m} style={[styles.chipModal, rockType === m && styles.chipActive]} onPress={() => setRockType(m)}>
                  <Text style={[styles.chipTextModal, rockType === m && styles.chipTextActive]}>{m === 'metamorfica' ? 'metamórfica' : m}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30, fontWeight: 'bold' }]}>2. ANÁLISIS ÓPTICO / IA</Text>
            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }, { marginBottom: 0, marginTop: 0 }]}>Claude Vision On/Off</Text>
              <Switch value={useAI} onValueChange={setUseAI} trackColor={{ true: '#FFD700' }} />
            </View>
            {useAI && <Text style={{color: '#888', fontSize: 11}}>Modelo Activo: claude-haiku-4-5-20251001</Text>}
            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }, { marginBottom: 0, marginTop: 0 }]}>Auto-Análisis AI en Muestreo</Text>
              <Switch value={autoAnalyzeSample} onValueChange={setAutoAnalyzeSample} trackColor={{ true: '#FFD700' }} />
            </View>

            <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30, fontWeight: 'bold' }]}>3. HARDWARE EXTERNO</Text>
            <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }]}>LÁMPARA UV / FLUORESCENCIA</Text>
            <View style={styles.chipsRowModal}>
              {['Ninguna','365nm','254nm'].map(m => (
                <TouchableOpacity key={m} style={[styles.chipModal, uvLamp === m && styles.chipActive]} onPress={() => setUvLamp(m)}>
                  <Text style={[styles.chipTextModal, uvLamp === m && styles.chipTextActive]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }, { marginBottom: 0, marginTop: 0 }]}>Microscopio USB-C Carson</Text>
              <TouchableOpacity style={{padding: 6, backgroundColor: microscopeConnected ? '#00FF00' : '#333', borderRadius: 8}} onPress={() => setMicroscopeConnected(!microscopeConnected)}>
                 <Text style={{color: microscopeConnected ? '#000' : '#FFF', fontWeight: 'bold'}}>{microscopeConnected ? 'CONECTADO' : 'INACTIVO'}</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30, fontWeight: 'bold' }]}>4. BASE DE DATOS Y NUBE</Text>
            <View style={styles.prefsRow}>
               <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }, { marginBottom: 0, marginTop: 0 }]}>Sincronización Cloud Automática</Text>
               <Switch value={autoSync} onValueChange={setAutoSync} trackColor={{ true: '#FFD700' }} />
            </View>
            <Text style={[styles.sectionHeader, { color: '#00FFFF', marginTop: 30, fontWeight: 'bold' }]}>5.SISTEMA / INTERFAZ</Text>
            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }, { marginBottom: 0, marginTop: 0 }]}>Modo Solar Alto Contraste</Text>
              <Switch value={isFieldMode} onValueChange={setIsFieldMode} trackColor={{ true: '#FFD700' }} />
            </View>
            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, isFieldMode && { color: '#444' }, { marginBottom: 0, marginTop: 0 }]}>Motor Háptico (Vibración)</Text>
              <Switch value={vibrationEnabled} onValueChange={setVibrationEnabled} trackColor={{ true: '#FFD700' }} />
            </View>

            <View style={[styles.modalActions, { marginTop: 30 }]}>
              <TouchableOpacity style={styles.modalBtnSave} onPress={() => setShowConfigModal(false)}>
                <Text style={styles.modalBtnTextBlack}>Guardar Parámetros Globales</Text>
              </TouchableOpacity>
            </View>
            <View style={{height: 40}} /> 
          </ScrollView>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, backgroundColor: '#000' },
  
  mapContainer: { flex: 0.70, position: 'relative' },
  consoleContainer: { flex: 0.30, backgroundColor: '#111', borderTopWidth: 2, borderTopColor: '#FFD700' },
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
  northIndicator: { position: 'absolute', top: 60, right: 10, width: 50, height: 50, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 25, borderWidth: 2, borderColor: '#FFD700', justifyContent: 'center', alignItems: 'center', zIndex: 20 },
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


