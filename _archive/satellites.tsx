/**
 * satellites.tsx
 * Dual-mode satellite screen for ProspectorAI.
 *
 * Mode ORBITAL  — N2YO real-time satellite tracking (original code, unchanged).
 * Mode GEE      — Google Earth Engine spectral imagery via local backend proxy.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
  TouchableOpacity,
  Animated,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import MapView, { UrlTile, Marker, Polygon, Circle } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  BAND_CONFIGS,
  DATASET_LABELS,
  EMIT_BAND_IDS,
  MULTISPECTRAL_BAND_IDS,
  ASTER_BAND_IDS,
  ASTER_EXTRA_BAND_IDS,
  getGEETileConfig,
  getGEEPixelValues,
  type BandIndex,
  type GEEDataset,
  type GEETileConfig,
  type GEEPixelValues,
} from '../core/GEEService';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type AppMode = 'orbital' | 'gee';

type Satellite = {
  satid: number;
  satname: string;
  intDesignator: string;
  launchDate: string;
  satlat: number;
  satlng: number;
  satalt: number;
};

const CLOUD_STEPS = [5, 10, 20, 30, 50];
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// ---------------------------------------------------------------------------
// Index interpretation thresholds for mineral prospecting
// ---------------------------------------------------------------------------

type AnomalyLevel = 'ALTA' | 'MODERADA' | 'BAJA' | 'ANÓMALO' | 'VISUAL';

interface Interpretation {
  level: AnomalyLevel;
  label: string;
  color: string;
  detail: string;
}

function interpretIndex(index: BandIndex, value: number): Interpretation {
  switch (index) {
    case 'IRON_OXIDE':
      if (value > 2.5)  return { level: 'ALTA',     color: '#FF4400', label: 'ANOMALÍA ALTA',     detail: 'Posible gossan o halo de oxidación de sulfuros' };
      if (value > 1.8)  return { level: 'MODERADA', color: '#FFAA00', label: 'ANOMALÍA MODERADA', detail: 'Óxidos de hierro presentes, zona a prospectar' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',               detail: 'Sin respuesta significativa de Fe³⁺' };

    case 'CLAY_MINERALS':
      if (value > 1.25) return { level: 'ALTA',     color: '#FF4400', label: 'ALTERACIÓN INTENSA', detail: 'Arcillas argílicas avanzadas — halo de sistema epitermal' };
      if (value > 0.95) return { level: 'MODERADA', color: '#FFAA00', label: 'ALTERACIÓN MOD.',    detail: 'Arcillas propilíticas o serícitas presentes' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',                detail: 'Sin alteración argílica significativa' };

    case 'FERROUS_IRON':
      if (value > 2.5)  return { level: 'ALTA',     color: '#4488FF', label: 'ULTRAMÁFICAS',       detail: 'Rocas ultramáficas — potencial Ni/Co/Cr/PGE' };
      if (value > 1.8)  return { level: 'MODERADA', color: '#88AAFF', label: 'MÁFICAS MOD.',        detail: 'Silicatos máficos con Fe²⁺ (olivino, piroxeno)' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',                detail: 'Sin respuesta significativa de Fe²⁺' };

    case 'NDVI':
      if (value < 0.05) return { level: 'ANÓMALO',  color: '#FF4400', label: 'ZONA SIN VEGETACIÓN', detail: 'Suelo tóxico o roca desnuda — halo geoquímico posible' };
      if (value < 0.20) return { level: 'MODERADA', color: '#FFAA00', label: 'VEGETACIÓN ESCASA',   detail: 'Suelo parcialmente desnudo, posible afloramiento' };
      return               { level: 'BAJA',     color: '#4CAF50', label: 'VEGETADO',             detail: 'Cobertura vegetal normal — sin anomalía NDVI' };

    case 'SWIR_MINERAL':
      if (value > 0.25) return { level: 'ALTA',     color: '#00AACC', label: 'ALTERACIÓN SWIR ALTA', detail: 'Fuerte respuesta hidrotermal en SWIR' };
      if (value > 0.12) return { level: 'MODERADA', color: '#FFAA00', label: 'ALTERACIÓN MOD.',       detail: 'Respuesta SWIR moderada — posible alteración' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',                  detail: 'Sin respuesta SWIR significativa' };

    case 'EMIT_AL_CLAY':
      if (value > 0.10) return { level: 'ALTA',     color: '#DDAA44', label: 'Al-OH INTENSO',  detail: 'Caolinita/Alunita abundante — epitermal Au-Ag probable' };
      if (value > 0.05) return { level: 'MODERADA', color: '#FFAA00', label: 'Al-OH MODERADO', detail: 'Arcillas alumínicas presentes — zona de alteración' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',           detail: 'Sin absorción Al-OH significativa a 2200 nm' };

    case 'EMIT_MG_CLAY':
      if (value > 0.08) return { level: 'ALTA',     color: '#00AA55', label: 'Mg-OH INTENSO',  detail: 'Clorita/Serpentina abundante — propilítico o ultramáficas' };
      if (value > 0.04) return { level: 'MODERADA', color: '#FFAA00', label: 'Mg-OH MODERADO', detail: 'Minerales Mg-OH presentes' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',           detail: 'Sin absorción Mg-OH significativa a 2300 nm' };

    case 'EMIT_CARBONATE':
      if (value > 0.08) return { level: 'ALTA',     color: '#3366CC', label: 'CARBONATOS ALTOS', detail: 'Calcita/Dolomita abundante — posible skarn o carbonatita' };
      if (value > 0.04) return { level: 'MODERADA', color: '#FFAA00', label: 'CARBONATOS MOD.',  detail: 'Carbonatos presentes — carbonatización hidrotermal' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',             detail: 'Sin absorción CO₃ significativa a 2350 nm' };

    case 'EMIT_FERRIC':
      if (value > 0.08) return { level: 'ALTA',     color: '#FF5500', label: 'Fe³⁺ INTENSO',  detail: 'Hematita/Goethita — gossan confirmado hiperespectral' };
      if (value > 0.04) return { level: 'MODERADA', color: '#FFAA00', label: 'Fe³⁺ MODERADO', detail: 'Óxidos férricos presentes — halo de oxidación' };
      return               { level: 'BAJA',     color: '#444',    label: 'BAJA',          detail: 'Sin absorción Fe³⁺ significativa a 870 nm' };

    default:
      return { level: 'VISUAL', color: '#666', label: 'VISUAL', detail: 'Composición visual — interpretar por color en el mapa' };
  }
}

// ---------------------------------------------------------------------------
// Polygon analysis types & helpers
// ---------------------------------------------------------------------------

type MapCoord = { latitude: number; longitude: number };

interface PolygonSample {
  coord: MapCoord;
  value: number;
  interpretation: Interpretation;
}

interface PolygonAnalysisResult {
  samples: PolygonSample[];
  avgValue: number;
  maxValue: number;
  hotspots: PolygonSample[];   // samples with level ALTA or MODERADA
  dominantMineral: string;
  dominantDetail: string;
  bandLabel: string;
}

/** Ray-casting point-in-polygon test */
function pointInPolygon(pt: MapCoord, poly: MapCoord[]): boolean {
  let inside = false;
  const { latitude: y, longitude: x } = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].longitude, yi = poly[i].latitude;
    const xj = poly[j].longitude, yj = poly[j].latitude;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Returns centroid of a polygon */
function polygonCentroid(poly: MapCoord[]): MapCoord {
  const lat = poly.reduce((s, c) => s + c.latitude, 0) / poly.length;
  const lng = poly.reduce((s, c) => s + c.longitude, 0) / poly.length;
  return { latitude: lat, longitude: lng };
}

/** Generates up to `maxPoints` sample coordinates inside the polygon using a grid */
function samplePointsInPolygon(poly: MapCoord[], maxPoints = 9): MapCoord[] {
  const lats = poly.map(c => c.latitude);
  const lngs = poly.map(c => c.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  const gridN = Math.ceil(Math.sqrt(maxPoints * 2)) + 1;
  const inside: MapCoord[] = [];
  for (let i = 0; i < gridN && inside.length < maxPoints; i++) {
    for (let j = 0; j < gridN && inside.length < maxPoints; j++) {
      const lat = minLat + ((i + 0.5) / gridN) * (maxLat - minLat);
      const lng = minLng + ((j + 0.5) / gridN) * (maxLng - minLng);
      const pt = { latitude: lat, longitude: lng };
      if (pointInPolygon(pt, poly)) inside.push(pt);
    }
  }
  // Always include centroid
  const c = polygonCentroid(poly);
  if (inside.length === 0) return [c];
  if (!inside.some(p => Math.abs(p.latitude - c.latitude) < 1e-6)) {
    inside.unshift(c);
  }
  return inside.slice(0, maxPoints);
}

/** Color for anomaly overlay circles */
function hotspotColor(level: AnomalyLevel): string {
  switch (level) {
    case 'ALTA':     return '#FF3300';
    case 'ANÓMALO':  return '#FF3300';
    case 'MODERADA': return '#FF9900';
    default:         return 'transparent';
  }
}

// ---------------------------------------------------------------------------
// ModeSwitcher
// ---------------------------------------------------------------------------

interface ModeSwitcherProps {
  mode: AppMode;
  onChangeMode: (mode: AppMode) => void;
}

function ModeSwitcher({ mode, onChangeMode }: ModeSwitcherProps) {
  return (
    <View style={modeStyles.container}>
      <TouchableOpacity
        style={[modeStyles.pill, mode === 'orbital' && modeStyles.pillActive]}
        onPress={() => onChangeMode('orbital')}
        activeOpacity={0.75}
      >
        <MaterialCommunityIcons
          name="satellite-variant"
          size={16}
          color={mode === 'orbital' ? '#000' : '#FFD700'}
          style={modeStyles.pillIcon}
        />
        <Text style={[modeStyles.pillText, mode === 'orbital' && modeStyles.pillTextActive]}>
          ORBITAL
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[modeStyles.pill, mode === 'gee' && modeStyles.pillActive]}
        onPress={() => onChangeMode('gee')}
        activeOpacity={0.75}
      >
        <MaterialCommunityIcons
          name="earth"
          size={16}
          color={mode === 'gee' ? '#000' : '#FFD700'}
          style={modeStyles.pillIcon}
        />
        <Text style={[modeStyles.pillText, mode === 'gee' && modeStyles.pillTextActive]}>
          IMÁGENES GEE
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const modeStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#0A0A0A',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    gap: 10,
  },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: '#FFD700',
    backgroundColor: 'transparent',
  },
  pillActive: {
    backgroundColor: '#FFD700',
  },
  pillIcon: {
    marginRight: 6,
  },
  pillText: {
    color: '#FFD700',
    fontWeight: '700',
    fontSize: 13,
    letterSpacing: 1,
  },
  pillTextActive: {
    color: '#000',
  },
});

// ---------------------------------------------------------------------------
// OrbitalView  — 100% original N2YO code, unchanged
// ---------------------------------------------------------------------------

function OrbitalView() {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permiso de GPS denegado');
        setLoading(false);
        return;
      }
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setLocation(loc);

        // Fetch N2YO
        // Endpoint: /rest/v1/satellite/above/{lat}/{lng}/{alt}/{search_radius}/{category}/&apiKey=...
        const apiKey = process.env.EXPO_PUBLIC_N2YO_API_KEY;
        if (!apiKey) {
          setErrorMsg('API Key de N2YO no configurada correctamente en .env');
          setLoading(false);
          return;
        }

        const lat = loc.coords.latitude;
        const lng = loc.coords.longitude;
        const alt = loc.coords.altitude || 0;

        // Category 0 fetches all visible satellites within 45 degrees
        const url = `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lng}/${alt}/45/0/&apiKey=${apiKey}`;
        const resText = await fetch(url);
        const data = await resText.json();

        if (data && data.above) {
          setSatellites(data.above);
        } else {
          setSatellites([]);
        }
      } catch (err: any) {
        setErrorMsg('Error de conexión a N2YO: ' + err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const renderItem = ({ item }: { item: Satellite }) => (
    <View style={orbitalStyles.satCard}>
      <View style={orbitalStyles.satIconBox}>
        <MaterialCommunityIcons name="satellite-variant" size={28} color="#FFD700" />
      </View>
      <View style={orbitalStyles.satInfo}>
        <Text style={orbitalStyles.satTitle}>{item.satname}</Text>
        <Text style={orbitalStyles.satSub}>NORAD ID: {item.satid}</Text>
        <View style={orbitalStyles.satCoordsRow}>
          <Text style={orbitalStyles.satCoordText}>LAT: {item.satlat?.toFixed(2)}°</Text>
          <Text style={orbitalStyles.satCoordText}>LON: {item.satlng?.toFixed(2)}°</Text>
          <Text style={orbitalStyles.satCoordText}>ALT: {item.satalt?.toFixed(1)} km</Text>
        </View>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={orbitalStyles.center}>
        <ActivityIndicator size="large" color="#FFD700" />
        <Text style={orbitalStyles.loadingText}>Escaneando bóveda celeste local (N2YO)...</Text>
      </View>
    );
  }

  if (errorMsg) {
    return (
      <View style={orbitalStyles.center}>
        <MaterialCommunityIcons name="alert-circle-outline" size={50} color="#FF5555" />
        <Text style={orbitalStyles.errorText}>{errorMsg}</Text>
      </View>
    );
  }

  if (satellites.length === 0) {
    return (
      <View style={orbitalStyles.center}>
        <MaterialCommunityIcons name="telescope" size={50} color="#FFD700" />
        <Text style={orbitalStyles.emptyText}>
          No hay satélites transitando a 45° de elevación en este momento.
        </Text>
      </View>
    );
  }

  return (
    <View style={orbitalStyles.content}>
      <View style={orbitalStyles.statusBar}>
        <Text style={orbitalStyles.statusText}>
          <Text style={orbitalStyles.statusCount}>{satellites.length}</Text> satélites detectados
          sobre ti
        </Text>
        <MaterialCommunityIcons name="check-network" size={20} color="#4CAF50" />
      </View>
      <FlatList
        data={satellites}
        keyExtractor={(item) => item.satid.toString()}
        renderItem={renderItem}
        contentContainerStyle={orbitalStyles.listContainer}
        indicatorStyle="white"
      />
    </View>
  );
}

const orbitalStyles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 30,
  },
  loadingText: {
    marginTop: 15,
    color: '#FFD700',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    textAlign: 'center',
  },
  errorText: {
    marginTop: 10,
    color: '#FF5555',
    fontSize: 15,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  emptyText: {
    marginTop: 15,
    color: '#CCC',
    fontSize: 16,
    textAlign: 'center',
  },
  content: {
    flex: 1,
  },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#000',
  },
  statusText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  statusCount: {
    color: '#FFD700',
    fontSize: 18,
  },
  listContainer: {
    padding: 15,
    paddingBottom: 40,
  },
  satCard: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderRadius: 10,
    padding: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
  },
  satIconBox: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255, 215, 0, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  satInfo: {
    flex: 1,
  },
  satTitle: {
    color: '#FFD700',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  satSub: {
    color: '#AAA',
    fontSize: 12,
    marginBottom: 4,
  },
  satCoordsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#000',
    padding: 6,
    borderRadius: 5,
    marginTop: 4,
  },
  satCoordText: {
    color: '#FFF',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

// ---------------------------------------------------------------------------
// GEEView  — Google Earth Engine spectral imagery
// ---------------------------------------------------------------------------

function GEEView() {
  const insets = useSafeAreaInsets();

  // Location
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  // GEE state
  const [tileConfig, setTileConfig] = useState<GEETileConfig | null>(null);
  const [pixelValues, setPixelValues] = useState<GEEPixelValues | null>(null);
  const [pixelLoading, setPixelLoading] = useState(false);
  const [selectedBand, setSelectedBand] = useState<BandIndex>('IRON_OXIDE');
  const [selectedDataset, setSelectedDataset] = useState<GEEDataset>('SENTINEL2');
  const [maxCloud, setMaxCloud] = useState<number>(20);

  // Default date window: last 90 days → today (used as fallback if auto-latest mode fails)
  const [geeStartDate] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 90); return d.toISOString().split('T')[0];
  });
  const [geeEndDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [nextPassDate, setNextPassDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Polygon (loaded from HOME screen via AsyncStorage)
  const [polygon, setPolygon] = useState<MapCoord[] | null>(null);
  const [polygonAnalysis, setPolygonAnalysis] = useState<PolygonAnalysisResult | null>(null);
  const [polygonAnalyzing, setPolygonAnalyzing] = useState(false);

  // Panel
  const [panelExpanded, setPanelExpanded] = useState(false);
  const panelAnim = useRef(new Animated.Value(0)).current;

  // Load polygon drawn in HOME screen
  useEffect(() => {
    const load = async () => {
      try {
        const saved = await AsyncStorage.getItem('lastPolygon');
        if (saved) setPolygon(JSON.parse(saved));
      } catch { /* ignore */ }
    };
    load();
  }, []);

  // Location permission on mount
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Permiso de GPS denegado. Habilítalo para usar imágenes GEE.');
        return;
      }
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setUserLocation({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
        });
      } catch (err: any) {
        setError('No se pudo obtener la ubicación GPS: ' + err.message);
      }
    })();
  }, []);

  // Reset band when switching datasets
  const handleDatasetChange = useCallback((ds: GEEDataset) => {
    const switchingToEmit  = ds === 'EMIT';
    const switchingToAster = ds === 'ASTER';
    const currentIsEmit    = selectedDataset === 'EMIT';
    const currentIsAster   = selectedDataset === 'ASTER';

    if (switchingToEmit && !currentIsEmit) {
      setSelectedBand('EMIT_AL_CLAY');
    } else if (!switchingToEmit && currentIsEmit) {
      setSelectedBand(switchingToAster ? 'IRON_OXIDE' : 'IRON_OXIDE');
    } else if (switchingToAster && !currentIsAster) {
      setSelectedBand('IRON_OXIDE'); // default to Fe-Ox (VNIR-only, always works for ASTER)
    }
    setNextPassDate(null);
    setSelectedDataset(ds);
  }, [selectedDataset]);

  // Auto-fetch tiles whenever band, dataset, or location changes
  useEffect(() => {
    if (userLocation) {
      fetchTiles();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLocation, selectedBand, selectedDataset]);

  // Panel expand/collapse animation
  useEffect(() => {
    Animated.timing(panelAnim, {
      toValue: panelExpanded ? 1 : 0,
      duration: 260,
      useNativeDriver: false,
    }).start();
  }, [panelExpanded, panelAnim]);

  // Auto-refresh when next satellite pass is expected (+2 days for GEE processing)
  useEffect(() => {
    if (!nextPassDate || !userLocation) return;
    const passTime  = new Date(nextPassDate + 'T12:00:00Z').getTime();
    const refreshAt = passTime + 2 * 86_400_000; // +48 h for processing
    const delay     = refreshAt - Date.now();
    if (delay <= 0) {
      fetchTiles();
      return;
    }
    const timer = setTimeout(fetchTiles, Math.min(delay, 24 * 60 * 60 * 1000));
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextPassDate]);

  const fetchTiles = useCallback(async () => {
    if (!userLocation) return;
    setLoading(true);
    setPixelValues(null);
    setError(null);
    setNextPassDate(null);
    try {
      // Auto-latest mode: no explicit dates → server finds the most recent
      // cloud-free image automatically (tries 20 → 35 → 50 → 80% cloud thresholds)
      const config = await getGEETileConfig(
        userLocation.lat,
        userLocation.lng,
        selectedBand,
        selectedDataset,
        geeStartDate,
        geeEndDate,
        maxCloud
      );
      setTileConfig(config);
      if (config.nextPassDate) setNextPassDate(config.nextPassDate);

      // Fetch pixel value at GPS point in parallel (non-blocking for tile display)
      const VISUAL_ONLY: BandIndex[] = ['TRUE_COLOR', 'FALSE_COLOR'];
      if (!VISUAL_ONLY.includes(selectedBand)) {
        setPixelLoading(true);
        getGEEPixelValues(
          userLocation.lat,
          userLocation.lng,
          selectedBand,
          selectedDataset,
          geeStartDate,
          geeEndDate
        )
          .then((pv) => setPixelValues(pv))
          .catch(() => setPixelValues(null))
          .finally(() => setPixelLoading(false));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [userLocation, selectedBand, selectedDataset, maxCloud]);

  /** Samples up to 9 points across the polygon and computes zone statistics */
  const analyzePolygon = useCallback(async () => {
    if (!polygon || polygon.length < 3) return;
    const VISUAL_ONLY: BandIndex[] = ['TRUE_COLOR', 'FALSE_COLOR'];
    if (VISUAL_ONLY.includes(selectedBand)) return;

    setPolygonAnalyzing(true);
    setPolygonAnalysis(null);
    setPanelExpanded(false);

    const sampleCoords = samplePointsInPolygon(polygon, 9);

    try {
      const results = await Promise.all(
        sampleCoords.map(coord =>
          getGEEPixelValues(
            coord.latitude, coord.longitude,
            selectedBand, selectedDataset,
            geeStartDate,
            geeEndDate
          ).then(pv => ({
            coord,
            value: pv.computedIndex,
            interpretation: interpretIndex(selectedBand, pv.computedIndex),
          } as PolygonSample))
          .catch(() => null)
        )
      );

      const valid = results.filter((r): r is PolygonSample => r !== null);
      if (valid.length === 0) {
        setPolygonAnalyzing(false);
        return;
      }

      const values = valid.map(r => r.value);
      const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
      const maxValue = Math.max(...values);
      const hotspots = valid.filter(r => r.interpretation.level === 'ALTA' || r.interpretation.level === 'ANÓMALO' || r.interpretation.level === 'MODERADA');

      // Dominant interpretation = highest-value sample
      const maxSample = valid.reduce((a, b) => a.value > b.value ? a : b);
      const avgInterpretation = interpretIndex(selectedBand, avgValue);

      setPolygonAnalysis({
        samples: valid,
        avgValue,
        maxValue,
        hotspots,
        dominantMineral: maxSample.interpretation.label,
        dominantDetail: avgInterpretation.detail,
        bandLabel: BAND_CONFIGS[selectedBand].label,
      });
    } catch { /* ignore */ } finally {
      setPolygonAnalyzing(false);
    }
  }, [polygon, selectedBand, selectedDataset]);

  const handleCloudStep = (direction: 'up' | 'down') => {
    const idx = CLOUD_STEPS.indexOf(maxCloud);
    if (direction === 'up' && idx < CLOUD_STEPS.length - 1) {
      setMaxCloud(CLOUD_STEPS[idx + 1]);
    } else if (direction === 'down' && idx > 0) {
      setMaxCloud(CLOUD_STEPS[idx - 1]);
    }
  };

  const currentBandCfg = BAND_CONFIGS[selectedBand];
  const currentDatasetCfg = DATASET_LABELS[selectedDataset];

  // Collapsed panel height — shows only summary
  const collapsedHeight = 54;
  // Expanded panel height — adapted per dataset
  const expandedHeight = selectedDataset === 'EMIT' ? 270 : selectedDataset === 'ASTER' ? 280 : 260;

  // ---------------------------------------------------------------------------
  // Render sub-sections
  // ---------------------------------------------------------------------------

  function renderBandSelector() {
    const isEmit  = selectedDataset === 'EMIT';
    const isAster = selectedDataset === 'ASTER';
    const visibleIds = isEmit ? EMIT_BAND_IDS : (isAster ? ASTER_BAND_IDS : MULTISPECTRAL_BAND_IDS);
    const bands = visibleIds.map((id) => BAND_CONFIGS[id]);

    return (
      <View style={geeStyles.bandSelectorContainer}>
        {isEmit && (
          <View style={geeStyles.emitBadge}>
            <MaterialCommunityIcons name="flask-outline" size={11} color="#00CCFF" />
            <Text style={geeStyles.emitBadgeText}>HIPERESPECTRAL · 285 BANDAS · 60 M</Text>
          </View>
        )}
        {isAster && (
          <View style={[geeStyles.emitBadge, { paddingTop: 5 }]}>
            <MaterialCommunityIcons name="history" size={11} color="#FF9900" />
            <Text style={[geeStyles.emitBadgeText, { color: '#FF9900' }]}>
              VNIR 15 M · SWIR HISTÓRICO 2000-2008 · 30 M
            </Text>
          </View>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={geeStyles.bandScrollContent}
        >
          {bands.map((band) => {
            const isActive     = band.id === selectedBand;
            const isAsterExtra = ASTER_EXTRA_BAND_IDS.includes(band.id);
            return (
              <TouchableOpacity
                key={band.id}
                style={[
                  geeStyles.bandChip,
                  isActive && geeStyles.bandChipActive,
                  isEmit && geeStyles.bandChipEmit,
                  isActive && isEmit && geeStyles.bandChipEmitActive,
                  isAsterExtra && geeStyles.bandChipAster,
                  isActive && isAsterExtra && geeStyles.bandChipAsterActive,
                ]}
                onPress={() => setSelectedBand(band.id)}
                activeOpacity={0.75}
              >
                <MaterialCommunityIcons
                  name={band.icon as any}
                  size={15}
                  color={isActive ? '#000' : isEmit ? '#00CCFF' : isAsterExtra ? '#FF9900' : '#FFD700'}
                  style={geeStyles.bandChipIcon}
                />
                <Text
                  style={[
                    geeStyles.bandChipText,
                    isActive && geeStyles.bandChipTextActive,
                    isEmit && !isActive && geeStyles.bandChipTextEmit,
                    isAsterExtra && !isActive && geeStyles.bandChipTextAster,
                  ]}
                  numberOfLines={1}
                >
                  {band.shortLabel}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  function renderLegend() {
    if (!tileConfig && !loading) return null;
    const gradientColors = currentBandCfg.gradientColors;
    const gradientLabels = currentBandCfg.gradientLabels;

    return (
      <View style={geeStyles.legendContainer} pointerEvents="none">
        <Text style={geeStyles.legendTitle}>{currentBandCfg.label}</Text>
        {gradientColors.map((color, i) => (
          <View key={i} style={geeStyles.legendRow}>
            <View style={[geeStyles.legendSwatch, { backgroundColor: color }]} />
            <Text style={geeStyles.legendLabel} numberOfLines={1}>
              {gradientLabels[i] ?? ''}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  function renderControlPanel() {
    const bottomPad = insets.bottom;
    return (
      <Animated.View style={[geeStyles.controlPanel, { height: panelAnim.interpolate({ inputRange: [0, 1], outputRange: [collapsedHeight + bottomPad, expandedHeight + bottomPad] }) }]}>
        {/* Panel header — always visible */}
        <TouchableOpacity
          style={geeStyles.panelHeader}
          onPress={() => setPanelExpanded((v) => !v)}
          activeOpacity={0.8}
        >
          <View style={geeStyles.panelSummary}>
            <Text style={geeStyles.panelSummaryDataset}>{currentDatasetCfg.label}</Text>
            {tileConfig ? (
              <>
                <Text style={geeStyles.panelSummaryDate}>
                  {tileConfig.acquisitionDate}
                </Text>
                {(() => {
                  const cc = tileConfig.cloudCover ?? 0;
                  const cloudColor = cc < 10 ? '#44BB44' : cc < 30 ? '#FFDD00' : cc < 60 ? '#FF9900' : '#FF4444';
                  return (
                    <View style={[geeStyles.cloudBadge, { borderWidth: 1, borderColor: cloudColor + '66' }]}>
                      <MaterialCommunityIcons name="cloud-outline" size={12} color={cloudColor} />
                      <Text style={[geeStyles.cloudBadgeText, { color: cloudColor }]}>{cc}%</Text>
                    </View>
                  );
                })()}
              </>
            ) : (
              <Text style={geeStyles.panelSummaryDate}>Cargando...</Text>
            )}
          </View>
          <MaterialCommunityIcons
            name={panelExpanded ? 'chevron-down' : 'chevron-up'}
            size={22}
            color="#FFD700"
          />
        </TouchableOpacity>

        {/* Expanded controls */}
        {panelExpanded && (
          <ScrollView
            style={geeStyles.panelBody}
            contentContainerStyle={[geeStyles.panelBodyContent, { paddingBottom: insets.bottom + 10 }]}
            scrollEnabled={false}
          >
            {/* Dataset selector */}
            <Text style={geeStyles.controlLabel}>Satélite / Sensor</Text>
            <View style={geeStyles.datasetRow}>
              {(['SENTINEL2', 'LANDSAT9', 'ASTER', 'EMIT'] as GEEDataset[]).map((ds) => {
                const isActive = ds === selectedDataset;
                const shortLabels: Record<GEEDataset, string> = {
                  SENTINEL2: 'S-2',
                  LANDSAT8:  'L8',
                  LANDSAT9:  'L9',
                  ASTER:     'ASTER',
                  EMIT:      'EMIT',
                };
                const isEmitDs  = ds === 'EMIT';
                const isAsterDs = ds === 'ASTER';
                return (
                  <TouchableOpacity
                    key={ds}
                    style={[
                      geeStyles.dsButton,
                      isActive && geeStyles.dsButtonActive,
                      isEmitDs && geeStyles.dsButtonEmit,
                      isActive && isEmitDs && geeStyles.dsButtonEmitActive,
                      isAsterDs && geeStyles.dsButtonAster,
                      isActive && isAsterDs && geeStyles.dsButtonAsterActive,
                    ]}
                    onPress={() => handleDatasetChange(ds)}
                    activeOpacity={0.75}
                  >
                    <Text
                      style={[
                        geeStyles.dsButtonText,
                        isActive && geeStyles.dsButtonTextActive,
                        isEmitDs  && !isActive && geeStyles.dsButtonTextEmit,
                        isAsterDs && !isActive && geeStyles.dsButtonTextAster,
                      ]}
                    >
                      {shortLabels[ds]}
                    </Text>
                    <Text
                      style={[
                        geeStyles.dsResText,
                        isActive && geeStyles.dsButtonTextActive,
                        isEmitDs  && !isActive && geeStyles.dsButtonTextEmit,
                        isAsterDs && !isActive && geeStyles.dsButtonTextAster,
                      ]}
                    >
                      {DATASET_LABELS[ds].resolution}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Auto-latest status + next pass */}
            <View style={geeStyles.autoLatestRow}>
              <MaterialCommunityIcons name="refresh-auto" size={13} color="#44BB44" />
              <Text style={geeStyles.autoLatestText}>
                Imagen más reciente automática
                {tileConfig?.acquisitionDate
                  ? ` · ${tileConfig.acquisitionDate}`
                  : ''}
              </Text>
            </View>
            {nextPassDate && (
              <View style={geeStyles.nextPassRow}>
                <MaterialCommunityIcons name="satellite-uplink" size={13} color="#888" />
                <Text style={geeStyles.nextPassText}>
                  Próximo paso estimado: {nextPassDate}
                  {` · Revisita: ${currentDatasetCfg.revisit}`}
                </Text>
              </View>
            )}

            {/* Cloud cover — hidden for EMIT (uses quality mask, not cloud %) */}
            {selectedDataset !== 'EMIT' ? (
              <View style={geeStyles.cloudRow}>
                <Text style={geeStyles.controlLabel}>
                  Nubes máx preferidas:{' '}
                  <Text style={geeStyles.cloudValue}>{maxCloud}%</Text>
                </Text>
                <View style={geeStyles.cloudButtons}>
                  <TouchableOpacity
                    style={geeStyles.cloudStepBtn}
                    onPress={() => handleCloudStep('down')}
                    activeOpacity={0.75}
                  >
                    <MaterialCommunityIcons name="minus" size={18} color="#FFD700" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={geeStyles.cloudStepBtn}
                    onPress={() => handleCloudStep('up')}
                    activeOpacity={0.75}
                  >
                    <MaterialCommunityIcons name="plus" size={18} color="#FFD700" />
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={geeStyles.emitCoverageNote}>
                <MaterialCommunityIcons name="information-outline" size={13} color="#00CCFF" />
                <Text style={geeStyles.emitCoverageText}>
                  EMIT no requiere filtro de nubes · Cobertura ISS ±51.6° lat · Datos desde 2022
                </Text>
              </View>
            )}
            {selectedDataset === 'ASTER' && (
              <View style={[geeStyles.emitCoverageNote, { borderColor: 'rgba(255,153,0,0.3)', backgroundColor: 'rgba(255,153,0,0.06)' }]}>
                <MaterialCommunityIcons name="history" size={13} color="#FF9900" />
                <Text style={[geeStyles.emitCoverageText, { color: '#FF9900' }]}>
                  ASTER VNIR (15 m): imágenes recientes · SWIR mineral (30 m): archivo 2000-2008 (detector SWIR inactivo desde 2008)
                </Text>
              </View>
            )}

            {/* Analyze button */}
            <TouchableOpacity
              style={[geeStyles.analyzeButton, polygon && geeStyles.analyzeButtonPolygon]}
              onPress={() => {
                if (polygon && polygon.length >= 3) {
                  analyzePolygon();
                } else {
                  setPanelExpanded(false);
                  fetchTiles();
                }
              }}
              activeOpacity={0.85}
            >
              {loading || polygonAnalyzing ? (
                <ActivityIndicator size="small" color="#000" />
              ) : polygon && polygon.length >= 3 ? (
                <>
                  <MaterialCommunityIcons name="vector-polygon" size={18} color="#000" style={{ marginRight: 6 }} />
                  <Text style={geeStyles.analyzeButtonText}>ANALIZAR POLÍGONO</Text>
                </>
              ) : (
                <>
                  <MaterialCommunityIcons name="magnify-scan" size={18} color="#000" style={{ marginRight: 6 }} />
                  <Text style={geeStyles.analyzeButtonText}>ANALIZAR ZONA</Text>
                </>
              )}
            </TouchableOpacity>

            {/* Mineral application */}
            <Text style={geeStyles.mineralUseText} numberOfLines={2}>
              {currentBandCfg.mineralUse}
            </Text>
          </ScrollView>
        )}
      </Animated.View>
    );
  }

  function renderResultsCard() {
    const isVisual = selectedBand === 'TRUE_COLOR' || selectedBand === 'FALSE_COLOR';
    if (isVisual) return null;

    const interpretation = pixelValues
      ? interpretIndex(selectedBand, pixelValues.computedIndex)
      : null;

    const serverDesc = tileConfig?.bandDescription;
    const serverApp  = tileConfig?.mineralApplication;

    // Format acquisition date and compute "X days ago"
    const acqDate = tileConfig?.acquisitionDate;
    let acqLabel = '';
    let acqDaysAgo = '';
    if (acqDate) {
      const d = new Date(acqDate);
      acqLabel = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
      const diffMs = Date.now() - d.getTime();
      const diffDays = Math.round(diffMs / 86_400_000);
      acqDaysAgo = diffDays <= 1 ? 'Hoy' : `Hace ${diffDays} días`;
    }

    const cloudCover = tileConfig?.cloudCover ?? 0;
    const cloudColor = cloudCover < 10 ? '#44BB44' : cloudCover < 30 ? '#FFDD00' : cloudCover < 60 ? '#FF9900' : '#FF4444';
    const cloudLabel = cloudCover < 10 ? 'EXCELENTE' : cloudCover < 30 ? 'BUENA' : cloudCover < 60 ? 'REGULAR' : 'ALTA';

    return (
      <View style={geeStyles.resultsCard}>
        {/* Acquisition date + cloud quality row */}
        {acqDate && (
          <View style={geeStyles.acqDateRow}>
            <MaterialCommunityIcons name="calendar-check" size={14} color="#FFD700" style={{ marginRight: 5 }} />
            <Text style={geeStyles.acqDateLabel}>IMAGEN DEL</Text>
            <Text style={geeStyles.acqDateValue}>{acqLabel}</Text>
            <View style={geeStyles.acqDaysAgo}>
              <Text style={geeStyles.acqDaysAgoText}>{acqDaysAgo}</Text>
            </View>
            {/* Cloud quality badge */}
            <View style={[geeStyles.cloudQualityBadge, { borderColor: cloudColor + '66', backgroundColor: cloudColor + '18' }]}>
              <MaterialCommunityIcons name="cloud-outline" size={11} color={cloudColor} />
              <Text style={[geeStyles.cloudQualityText, { color: cloudColor }]}>
                {cloudCover}% · {cloudLabel}
              </Text>
            </View>
          </View>
        )}
        {/* Next pass estimate */}
        {nextPassDate && (
          <View style={geeStyles.nextPassInfoRow}>
            <MaterialCommunityIcons name="satellite-uplink" size={11} color="#555" />
            <Text style={geeStyles.nextPassInfoText}>
              Próximo paso: {nextPassDate} · {currentDatasetCfg.revisit} revisita
            </Text>
          </View>
        )}

        {/* Index value row */}
        <View style={geeStyles.resultsRow}>
          <View style={geeStyles.resultsLeft}>
            <Text style={geeStyles.resultsLabel}>ÍNDICE EN TU UBICACIÓN GPS</Text>
            {pixelLoading ? (
              <View style={geeStyles.resultsValueRow}>
                <ActivityIndicator size="small" color="#FFD700" style={{ marginRight: 8 }} />
                <Text style={geeStyles.resultsValueLoading}>Muestreando pixel...</Text>
              </View>
            ) : pixelValues ? (
              <View style={geeStyles.resultsValueRow}>
                <Text style={geeStyles.resultsValue}>
                  {pixelValues.computedIndex.toFixed(4)}
                </Text>
                {interpretation && (
                  <View style={[geeStyles.anomalyBadge, { backgroundColor: interpretation.color + '22', borderColor: interpretation.color }]}>
                    <Text style={[geeStyles.anomalyText, { color: interpretation.color }]}>
                      {interpretation.label}
                    </Text>
                  </View>
                )}
              </View>
            ) : tileConfig ? (
              <Text style={geeStyles.resultsNoData}>Sin datos de pixel para esta zona/fecha</Text>
            ) : null}
          </View>
        </View>

        {/* Interpretation detail */}
        {interpretation && pixelValues && (
          <Text style={geeStyles.resultsDetail}>{interpretation.detail}</Text>
        )}

        {/* Server band description + mineral application */}
        {(serverDesc || serverApp) && tileConfig && (
          <View style={geeStyles.resultsMeta}>
            {serverDesc && <Text style={geeStyles.resultsMetaDesc} numberOfLines={2}>{serverDesc}</Text>}
            {serverApp  && <Text style={geeStyles.resultsMetaApp}  numberOfLines={3}>{serverApp}</Text>}
          </View>
        )}
      </View>
    );
  }

  function renderPolygonResultsCard() {
    const isVisual = selectedBand === 'TRUE_COLOR' || selectedBand === 'FALSE_COLOR';
    if (isVisual) return null;

    // Show analyzing spinner
    if (polygonAnalyzing) {
      return (
        <View style={geeStyles.polygonCard}>
          <View style={geeStyles.polygonCardHeader}>
            <MaterialCommunityIcons name="vector-polygon" size={14} color="#FFD700" />
            <Text style={geeStyles.polygonCardTitle}>ANALIZANDO POLÍGONO...</Text>
            <ActivityIndicator size="small" color="#FFD700" style={{ marginLeft: 8 }} />
          </View>
          <Text style={geeStyles.polygonCardSub}>Muestreando puntos del área seleccionada</Text>
        </View>
      );
    }

    // No polygon drawn
    if (!polygon || polygon.length < 3) {
      return (
        <View style={geeStyles.polygonCard}>
          <View style={geeStyles.polygonCardHeader}>
            <MaterialCommunityIcons name="vector-polygon" size={14} color="#555" />
            <Text style={[geeStyles.polygonCardTitle, { color: '#555' }]}>SIN POLÍGONO</Text>
          </View>
          <Text style={geeStyles.polygonCardSub}>Dibuja un polígono en la pantalla HOME y vuelve aquí para analizar toda la zona</Text>
        </View>
      );
    }

    // Polygon exists but not yet analyzed
    if (!polygonAnalysis) {
      return (
        <View style={geeStyles.polygonCard}>
          <View style={geeStyles.polygonCardHeader}>
            <MaterialCommunityIcons name="vector-polygon" size={14} color="#FFD700" />
            <Text style={geeStyles.polygonCardTitle}>POLÍGONO CARGADO · {polygon.length} VÉRTICES</Text>
          </View>
          <Text style={geeStyles.polygonCardSub}>Toca "ANALIZAR POLÍGONO" para calcular el índice promedio y detectar anomalías en toda la zona</Text>
        </View>
      );
    }

    // Full results
    const { avgValue, maxValue, hotspots, dominantMineral, dominantDetail, samples } = polygonAnalysis;
    const avgInterp = interpretIndex(selectedBand, avgValue);
    const highCount = hotspots.filter(h => h.interpretation.level === 'ALTA' || h.interpretation.level === 'ANÓMALO').length;

    return (
      <View style={[geeStyles.polygonCard, geeStyles.polygonCardResult]}>
        {/* Header */}
        <View style={geeStyles.polygonCardHeader}>
          <MaterialCommunityIcons name="vector-polygon" size={14} color="#FFD700" />
          <Text style={geeStyles.polygonCardTitle}>ANÁLISIS DE ZONA · {samples.length} PUNTOS</Text>
          {hotspots.length > 0 && (
            <View style={[geeStyles.anomalyBadge, { backgroundColor: '#FF330022', borderColor: '#FF3300', marginLeft: 8 }]}>
              <Text style={[geeStyles.anomalyText, { color: '#FF3300' }]}>
                {highCount} ALTA{highCount !== 1 ? 'S' : ''}
              </Text>
            </View>
          )}
        </View>

        {/* Stats row */}
        <View style={geeStyles.polygonStatsRow}>
          <View style={geeStyles.polygonStat}>
            <Text style={geeStyles.polygonStatLabel}>ÍNDICE PROM.</Text>
            <Text style={[geeStyles.polygonStatValue, { color: avgInterp.color }]}>
              {avgValue.toFixed(4)}
            </Text>
          </View>
          <View style={geeStyles.polygonStatDivider} />
          <View style={geeStyles.polygonStat}>
            <Text style={geeStyles.polygonStatLabel}>MÁXIMO</Text>
            <Text style={geeStyles.polygonStatValue}>{maxValue.toFixed(4)}</Text>
          </View>
          <View style={geeStyles.polygonStatDivider} />
          <View style={geeStyles.polygonStat}>
            <Text style={geeStyles.polygonStatLabel}>ANOMALÍAS</Text>
            <Text style={[geeStyles.polygonStatValue, { color: hotspots.length > 0 ? '#FF9900' : '#444' }]}>
              {hotspots.length}/{samples.length}
            </Text>
          </View>
        </View>

        {/* Dominant mineral */}
        <View style={[geeStyles.anomalyBadge, { backgroundColor: avgInterp.color + '22', borderColor: avgInterp.color, alignSelf: 'flex-start' }]}>
          <Text style={[geeStyles.anomalyText, { color: avgInterp.color }]}>{dominantMineral}</Text>
        </View>
        <Text style={geeStyles.polygonCardSub}>{dominantDetail}</Text>

        {/* Heatmap legend */}
        {hotspots.length > 0 && (
          <View style={geeStyles.hotspotLegend}>
            <View style={geeStyles.hotspotLegendItem}>
              <View style={[geeStyles.hotspotDot, { backgroundColor: '#FF3300' }]} />
              <Text style={geeStyles.hotspotLegendText}>Anomalía alta</Text>
            </View>
            <View style={geeStyles.hotspotLegendItem}>
              <View style={[geeStyles.hotspotDot, { backgroundColor: '#FF9900' }]} />
              <Text style={geeStyles.hotspotLegendText}>Anomalía moderada</Text>
            </View>
            <View style={geeStyles.hotspotLegendItem}>
              <View style={[geeStyles.hotspotDot, { backgroundColor: '#555' }]} />
              <Text style={geeStyles.hotspotLegendText}>Baja respuesta</Text>
            </View>
          </View>
        )}
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Main GEEView render
  // ---------------------------------------------------------------------------

  return (
    <View style={geeStyles.container}>
      {/* Map area */}
      <View style={geeStyles.mapContainer}>
        {userLocation ? (
          <MapView
            style={geeStyles.map}
            mapType="satellite"
            initialRegion={{
              latitude: userLocation.lat,
              longitude: userLocation.lng,
              latitudeDelta: 0.08,
              longitudeDelta: 0.08,
            }}
          >
            {tileConfig?.tileUrl ? (
              <UrlTile
                urlTemplate={tileConfig.tileUrl}
                zIndex={1}
                maximumZ={18}
                flipY={false}
                opacity={0.85}
              />
            ) : null}

            {/* Polygon from HOME screen */}
            {polygon && polygon.length >= 3 && (
              <Polygon
                coordinates={polygon}
                strokeColor="#FFD700"
                strokeWidth={2}
                fillColor="rgba(255,215,0,0.12)"
              />
            )}

            {/* Hotspot anomaly circles */}
            {polygonAnalysis?.samples.map((s, i) => {
              const color = hotspotColor(s.interpretation.level);
              if (color === 'transparent') return null;
              return (
                <Circle
                  key={i}
                  center={s.coord}
                  radius={200}
                  strokeColor={color}
                  strokeWidth={2}
                  fillColor={color + '55'}
                />
              );
            })}

            {/* Low-signal sample markers (small dots) */}
            {polygonAnalysis?.samples.map((s, i) => {
              if (s.interpretation.level !== 'BAJA') return null;
              return (
                <Circle
                  key={'low_' + i}
                  center={s.coord}
                  radius={80}
                  strokeColor="#444"
                  strokeWidth={1}
                  fillColor="rgba(80,80,80,0.25)"
                />
              );
            })}

            <Marker
              coordinate={{ latitude: userLocation.lat, longitude: userLocation.lng }}
              title="Tu ubicación"
              pinColor="#FFD700"
            />
          </MapView>
        ) : (
          <View style={geeStyles.mapPlaceholder}>
            {error ? (
              <MaterialCommunityIcons name="map-marker-off" size={50} color="#FF5555" />
            ) : (
              <ActivityIndicator size="large" color="#FFD700" />
            )}
          </View>
        )}

        {/* Loading overlay */}
        {loading && (
          <View style={geeStyles.mapLoadingOverlay} pointerEvents="none">
            <View style={geeStyles.mapLoadingCard}>
              <ActivityIndicator size="small" color="#FFD700" />
              <Text style={geeStyles.mapLoadingText}>Cargando datos GEE...</Text>
            </View>
          </View>
        )}

        {/* Error overlay */}
        {error && !loading && (
          <View style={geeStyles.mapErrorOverlay}>
            <View style={geeStyles.mapErrorCard}>
              <MaterialCommunityIcons name="alert-circle-outline" size={32} color="#FF5555" />
              <Text style={geeStyles.mapErrorText}>{error}</Text>
              <TouchableOpacity style={geeStyles.retryButton} onPress={fetchTiles} activeOpacity={0.8}>
                <Text style={geeStyles.retryButtonText}>REINTENTAR</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Legend overlay — bottom-left, above control panel */}
        <View style={geeStyles.legendAnchor}>{renderLegend()}</View>
      </View>

      {/* Results card — index value + interpretation at GPS point */}
      {renderResultsCard()}

      {/* Polygon analysis card */}
      {renderPolygonResultsCard()}

      {/* Band selector */}
      {renderBandSelector()}

      {/* Control panel (absolute) */}
      {renderControlPanel()}
    </View>
  );
}

const PANEL_BOTTOM_OFFSET = 0;

const geeStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  mapContainer: {
    flex: 1,
    position: 'relative',
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  mapPlaceholder: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapLoadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(17,17,17,0.95)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#333',
    gap: 10,
  },
  mapLoadingText: {
    color: '#FFD700',
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  mapErrorOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 30,
  },
  mapErrorCard: {
    backgroundColor: '#111',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FF5555',
    padding: 24,
    alignItems: 'center',
    maxWidth: 320,
    gap: 10,
  },
  mapErrorText: {
    color: '#FF7777',
    fontSize: 13,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
  },
  retryButton: {
    marginTop: 8,
    backgroundColor: '#FFD700',
    paddingHorizontal: 24,
    paddingVertical: 8,
    borderRadius: 20,
  },
  retryButtonText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 1,
  },
  legendAnchor: {
    position: 'absolute',
    bottom: 64,
    left: 12,
  },
  legendContainer: {
    backgroundColor: 'rgba(13,13,13,0.92)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
    padding: 10,
    minWidth: 150,
    maxWidth: 200,
  },
  legendTitle: {
    color: '#FFD700',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
    gap: 6,
  },
  legendSwatch: {
    width: 14,
    height: 14,
    borderRadius: 3,
    flexShrink: 0,
  },
  legendLabel: {
    color: '#CCC',
    fontSize: 9,
    flex: 1,
  },
  // Acquisition date row
  acqDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    marginBottom: 4,
    gap: 4,
  },
  acqDateLabel: {
    color: '#555',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  acqDateValue: {
    color: '#FFD700',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    flex: 1,
  },
  acqDaysAgo: {
    backgroundColor: '#1A1500',
    borderWidth: 1,
    borderColor: '#FFD70044',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  acqDaysAgoText: {
    color: '#FFD700',
    fontSize: 10,
    fontWeight: '700',
  },
  cloudQualityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 3,
    marginLeft: 2,
  },
  cloudQualityText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  nextPassInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingTop: 2,
  },
  nextPassInfoText: {
    color: '#555',
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Results card
  resultsCard: {
    backgroundColor: '#0D0D0D',
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  resultsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  resultsLeft: {
    flex: 1,
    gap: 4,
  },
  resultsLabel: {
    color: '#555',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  resultsValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  resultsValue: {
    color: '#FFD700',
    fontSize: 22,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    letterSpacing: 1,
  },
  resultsValueLoading: {
    color: '#666',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  resultsNoData: {
    color: '#555',
    fontSize: 11,
    fontStyle: 'italic',
  },
  anomalyBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
  },
  anomalyText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  resultsDetail: {
    color: '#888',
    fontSize: 11,
    lineHeight: 15,
  },
  resultsMeta: {
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
    paddingTop: 6,
    gap: 3,
    marginTop: 2,
  },
  resultsMetaDesc: {
    color: '#666',
    fontSize: 10,
    lineHeight: 14,
    fontStyle: 'italic',
  },
  resultsMetaApp: {
    color: '#888',
    fontSize: 10,
    lineHeight: 14,
  },
  // EMIT badge + coverage note
  emitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 5,
    gap: 5,
  },
  emitBadgeText: {
    color: '#00CCFF',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  emitCoverageNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(0,204,255,0.07)',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,204,255,0.2)',
  },
  emitCoverageText: {
    color: '#00CCFF',
    fontSize: 10,
    flex: 1,
    lineHeight: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Polygon analysis card
  polygonCard: {
    backgroundColor: '#0A0A0A',
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
  },
  polygonCardResult: {
    borderTopColor: '#FFD70033',
  },
  polygonCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  polygonCardTitle: {
    color: '#FFD700',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    flex: 1,
  },
  polygonCardSub: {
    color: '#666',
    fontSize: 10,
    lineHeight: 14,
  },
  polygonStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
  polygonStat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  polygonStatLabel: {
    color: '#555',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  polygonStatValue: {
    color: '#FFD700',
    fontSize: 15,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  polygonStatDivider: {
    width: 1,
    height: 28,
    backgroundColor: '#222',
  },
  analyzeButtonPolygon: {
    backgroundColor: '#FF9900',
  },
  hotspotLegend: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 2,
  },
  hotspotLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  hotspotDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  hotspotLegendText: {
    color: '#666',
    fontSize: 9,
  },

  // Band selector
  bandSelectorContainer: {
    backgroundColor: '#0A0A0A',
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
    paddingBottom: 4,
  },
  bandScrollContent: {
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  bandChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  bandChipActive: {
    backgroundColor: '#FFD700',
    borderColor: '#FFD700',
  },
  bandChipEmit: {
    borderColor: '#004455',
    backgroundColor: '#001A22',
  },
  bandChipEmitActive: {
    backgroundColor: '#00CCFF',
    borderColor: '#00CCFF',
  },
  bandChipAster: {
    borderColor: '#553300',
    backgroundColor: '#1A0D00',
  },
  bandChipAsterActive: {
    backgroundColor: '#FF9900',
    borderColor: '#FF9900',
  },
  bandChipTextAster: {
    color: '#FF9900',
  },
  bandChipIcon: {
    marginRight: 5,
  },
  bandChipText: {
    color: '#FFD700',
    fontSize: 12,
    fontWeight: '600',
  },
  bandChipTextActive: {
    color: '#000',
  },
  bandChipTextEmit: {
    color: '#00CCFF',
  },
  // Control panel
  controlPanel: {
    backgroundColor: '#0D0D0D',
    borderTopWidth: 1,
    borderTopColor: '#FFD700',
    overflow: 'hidden',
  },
  panelHeader: {
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  panelSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  panelSummaryDataset: {
    color: '#FFD700',
    fontWeight: '700',
    fontSize: 13,
  },
  panelSummaryDate: {
    color: '#AAA',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  cloudBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 4,
  },
  cloudBadgeText: {
    color: '#AAA',
    fontSize: 11,
  },
  panelBody: {
    flex: 1,
  },
  panelBodyContent: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  controlLabel: {
    color: '#AAA',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  // Dataset buttons
  datasetRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  dsButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444',
    backgroundColor: '#1A1A1A',
  },
  dsButtonActive: {
    backgroundColor: 'rgba(255,215,0,0.15)',
    borderColor: '#FFD700',
  },
  dsButtonText: {
    color: '#AAA',
    fontWeight: '700',
    fontSize: 13,
  },
  dsButtonTextActive: {
    color: '#FFD700',
  },
  dsButtonEmit: {
    borderColor: '#004455',
    backgroundColor: '#001A22',
  },
  dsButtonEmitActive: {
    backgroundColor: 'rgba(0,204,255,0.15)',
    borderColor: '#00CCFF',
  },
  dsButtonTextEmit: {
    color: '#00CCFF',
  },
  dsButtonAster: {
    borderColor: '#553300',
    backgroundColor: '#1A0D00',
  },
  dsButtonAsterActive: {
    backgroundColor: 'rgba(255,153,0,0.15)',
    borderColor: '#FF9900',
  },
  dsButtonTextAster: {
    color: '#FF9900',
  },
  dsResText: {
    color: '#666',
    fontSize: 9,
    marginTop: 1,
  },
  // Auto-latest info row
  autoLatestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(68,187,68,0.07)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(68,187,68,0.25)',
  },
  autoLatestText: {
    color: '#44BB44',
    fontSize: 10,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  nextPassRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
  },
  nextPassText: {
    color: '#666',
    fontSize: 10,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Cloud cover
  cloudRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cloudValue: {
    color: '#FFD700',
    fontWeight: '700',
  },
  cloudButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  cloudStepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Analyze button
  analyzeButton: {
    flexDirection: 'row',
    backgroundColor: '#FFD700',
    borderRadius: 10,
    paddingVertical: 11,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
  },
  analyzeButtonText: {
    color: '#000',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 1.5,
  },
  mineralUseText: {
    color: '#666',
    fontSize: 10,
    lineHeight: 14,
    fontStyle: 'italic',
  },
});

// ---------------------------------------------------------------------------
// Root screen component
// ---------------------------------------------------------------------------

export default function SatellitesScreen() {
  const [mode, setMode] = useState<AppMode>('orbital');
  const insets = useSafeAreaInsets();

  return (
    <View style={[rootStyles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={rootStyles.header}>
        <MaterialCommunityIcons
          name="radar"
          size={32}
          color="#FFD700"
          style={rootStyles.radarIcon}
        />
        <View>
          <Text style={rootStyles.headerTitle}>RASTREO ORBITAL</Text>
          <Text style={rootStyles.headerSub}>
            Satélites transitando zona vertical prospectora
          </Text>
        </View>
      </View>

      {/* Mode switcher */}
      <ModeSwitcher mode={mode} onChangeMode={setMode} />

      {/* Mode views */}
      {mode === 'orbital' && <OrbitalView />}
      {mode === 'gee' && <GEEView />}
    </View>
  );
}

const rootStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    // paddingTop driven by useSafeAreaInsets in the component
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 215, 0, 0.3)',
    backgroundColor: '#111',
  },
  radarIcon: {
    marginRight: 15,
  },
  headerTitle: {
    color: '#FFD700',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2,
  },
  headerSub: {
    color: '#AAA',
    fontSize: 12,
    fontWeight: '500',
  },
});
