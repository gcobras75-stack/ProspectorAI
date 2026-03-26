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
  TextInput,
  Animated,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import MapView, { UrlTile, Marker } from 'react-native-maps';

import {
  BAND_CONFIGS,
  DATASET_LABELS,
  EMIT_BAND_IDS,
  MULTISPECTRAL_BAND_IDS,
  getDefaultDateRange,
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
  const [dateRange, setDateRange] = useState(getDefaultDateRange());
  const [maxCloud, setMaxCloud] = useState<number>(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Panel
  const [panelExpanded, setPanelExpanded] = useState(false);
  const panelAnim = useRef(new Animated.Value(0)).current;

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

  // Days-back per dataset — always computed fresh from today
  const DAYS_BACK: Record<GEEDataset, number> = { SENTINEL2: 30, LANDSAT8: 30, LANDSAT9: 30, EMIT: 180 };

  // Reset band and date range when switching between EMIT and multispectral
  const handleDatasetChange = useCallback((ds: GEEDataset) => {
    const switchingToEmit = ds === 'EMIT';
    const currentIsEmit = selectedDataset === 'EMIT';
    if (switchingToEmit !== currentIsEmit) {
      setSelectedBand(switchingToEmit ? 'EMIT_AL_CLAY' : 'IRON_OXIDE');
    }
    setDateRange(getDefaultDateRange(DAYS_BACK[ds]));
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

  const fetchTiles = useCallback(async () => {
    if (!userLocation) return;
    setLoading(true);
    setPixelValues(null);
    setError(null);
    try {
      // Always use fresh dates computed from today — ensures most recent imagery
      const freshRange = getDefaultDateRange(DAYS_BACK[selectedDataset]);
      setDateRange(freshRange);

      const config = await getGEETileConfig(
        userLocation.lat,
        userLocation.lng,
        selectedBand,
        selectedDataset,
        freshRange.start,
        freshRange.end,
        maxCloud
      );
      setTileConfig(config);

      // Fetch pixel value at GPS point in parallel (non-blocking for tile display)
      const VISUAL_ONLY: BandIndex[] = ['TRUE_COLOR', 'FALSE_COLOR'];
      if (!VISUAL_ONLY.includes(selectedBand)) {
        setPixelLoading(true);
        getGEEPixelValues(
          userLocation.lat,
          userLocation.lng,
          selectedBand,
          selectedDataset,
          freshRange.start,
          freshRange.end
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
  }, [userLocation, selectedBand, selectedDataset, dateRange, maxCloud]);

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
  // Expanded panel height — full controls (extra for EMIT note)
  const expandedHeight = selectedDataset === 'EMIT' ? 290 : 280;

  // ---------------------------------------------------------------------------
  // Render sub-sections
  // ---------------------------------------------------------------------------

  function renderBandSelector() {
    const isEmit = selectedDataset === 'EMIT';
    const visibleIds = isEmit ? EMIT_BAND_IDS : MULTISPECTRAL_BAND_IDS;
    const bands = visibleIds.map((id) => BAND_CONFIGS[id]);

    return (
      <View style={geeStyles.bandSelectorContainer}>
        {isEmit && (
          <View style={geeStyles.emitBadge}>
            <MaterialCommunityIcons name="flask-outline" size={11} color="#00CCFF" />
            <Text style={geeStyles.emitBadgeText}>HIPERESPECTRAL · 285 BANDAS · 60 M</Text>
          </View>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={geeStyles.bandScrollContent}
        >
          {bands.map((band) => {
            const isActive = band.id === selectedBand;
            return (
              <TouchableOpacity
                key={band.id}
                style={[
                  geeStyles.bandChip,
                  isActive && geeStyles.bandChipActive,
                  isEmit && geeStyles.bandChipEmit,
                  isActive && isEmit && geeStyles.bandChipEmitActive,
                ]}
                onPress={() => setSelectedBand(band.id)}
                activeOpacity={0.75}
              >
                <MaterialCommunityIcons
                  name={band.icon as any}
                  size={15}
                  color={isActive ? '#000' : isEmit ? '#00CCFF' : '#FFD700'}
                  style={geeStyles.bandChipIcon}
                />
                <Text
                  style={[
                    geeStyles.bandChipText,
                    isActive && geeStyles.bandChipTextActive,
                    isEmit && !isActive && geeStyles.bandChipTextEmit,
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
                  {tileConfig.acquisitionDate || dateRange.end}
                </Text>
                <View style={geeStyles.cloudBadge}>
                  <MaterialCommunityIcons name="cloud-outline" size={12} color="#AAA" />
                  <Text style={geeStyles.cloudBadgeText}>{tileConfig.cloudCover ?? maxCloud}%</Text>
                </View>
              </>
            ) : (
              <Text style={geeStyles.panelSummaryDate}>{dateRange.end}</Text>
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
              {(['SENTINEL2', 'LANDSAT8', 'LANDSAT9', 'EMIT'] as GEEDataset[]).map((ds) => {
                const isActive = ds === selectedDataset;
                const shortLabels: Record<GEEDataset, string> = {
                  SENTINEL2: 'S-2',
                  LANDSAT8: 'L8',
                  LANDSAT9: 'L9',
                  EMIT: 'EMIT',
                };
                const isEmitDs = ds === 'EMIT';
                return (
                  <TouchableOpacity
                    key={ds}
                    style={[
                      geeStyles.dsButton,
                      isActive && geeStyles.dsButtonActive,
                      isEmitDs && geeStyles.dsButtonEmit,
                      isActive && isEmitDs && geeStyles.dsButtonEmitActive,
                    ]}
                    onPress={() => handleDatasetChange(ds)}
                    activeOpacity={0.75}
                  >
                    <Text
                      style={[
                        geeStyles.dsButtonText,
                        isActive && geeStyles.dsButtonTextActive,
                        isEmitDs && !isActive && geeStyles.dsButtonTextEmit,
                      ]}
                    >
                      {shortLabels[ds]}
                    </Text>
                    <Text
                      style={[
                        geeStyles.dsResText,
                        isActive && geeStyles.dsButtonTextActive,
                        isEmitDs && !isActive && geeStyles.dsButtonTextEmit,
                      ]}
                    >
                      {DATASET_LABELS[ds].resolution}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Date range */}
            <View style={geeStyles.dateRow}>
              <View style={geeStyles.dateField}>
                <Text style={geeStyles.controlLabel}>Desde</Text>
                <TextInput
                  style={geeStyles.dateInput}
                  value={dateRange.start}
                  onChangeText={(v) => setDateRange((prev) => ({ ...prev, start: v }))}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#555"
                  keyboardType="numeric"
                  maxLength={10}
                />
              </View>
              <View style={geeStyles.dateField}>
                <Text style={geeStyles.controlLabel}>Hasta</Text>
                <TextInput
                  style={geeStyles.dateInput}
                  value={dateRange.end}
                  onChangeText={(v) => setDateRange((prev) => ({ ...prev, end: v }))}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#555"
                  keyboardType="numeric"
                  maxLength={10}
                />
              </View>
            </View>

            {/* Cloud cover — hidden for EMIT (uses quality mask, not cloud %) */}
            {selectedDataset !== 'EMIT' ? (
              <View style={geeStyles.cloudRow}>
                <Text style={geeStyles.controlLabel}>
                  Cobertura nube máx:{' '}
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

            {/* Analyze button */}
            <TouchableOpacity
              style={geeStyles.analyzeButton}
              onPress={() => {
                setPanelExpanded(false);
                fetchTiles();
              }}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#000" />
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

    return (
      <View style={geeStyles.resultsCard}>
        {/* Acquisition date — prominent header */}
        {acqDate && (
          <View style={geeStyles.acqDateRow}>
            <MaterialCommunityIcons name="calendar-check" size={14} color="#FFD700" style={{ marginRight: 5 }} />
            <Text style={geeStyles.acqDateLabel}>IMAGEN DEL</Text>
            <Text style={geeStyles.acqDateValue}>{acqLabel}</Text>
            <View style={geeStyles.acqDaysAgo}>
              <Text style={geeStyles.acqDaysAgoText}>{acqDaysAgo}</Text>
            </View>
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
  dsResText: {
    color: '#666',
    fontSize: 9,
    marginTop: 1,
  },
  // Date range
  dateRow: {
    flexDirection: 'row',
    gap: 10,
  },
  dateField: {
    flex: 1,
  },
  dateInput: {
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#FFD700',
    borderRadius: 8,
    color: '#FFF',
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
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
