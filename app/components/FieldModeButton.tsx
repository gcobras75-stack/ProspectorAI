import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { View, Text, TouchableOpacity, Alert, ActivityIndicator, StyleSheet } from 'react-native';
import { loadFieldPackage, saveFieldPackage } from '../core/Database';
import { fetchZoneMapImage } from '../core/SatelliteEngine';

export interface FieldModeButtonHandle {
  triggerPrepare: () => void;
}

interface FieldModeButtonProps {
  projectId: string;
  analysisPoints: any[];
  geologoResumen: string;
  zoneCoords: { lat: number; lng: number }[];
  isConnected: boolean;
}

function daysSince(dateStr: string): number {
  if (!dateStr) return 0;
  // SQLite datetime('now') returns "2026-06-10 23:11:40" (no 'T', no 'Z')
  // Force UTC parsing by replacing space with 'T' and appending 'Z'
  const normalized = dateStr.replace(' ', 'T') + (dateStr.includes('T') ? '' : 'Z');
  const ms = Date.now() - new Date(normalized).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

const FieldModeButton = forwardRef<FieldModeButtonHandle, FieldModeButtonProps>(function FieldModeButton({
  projectId,
  analysisPoints,
  geologoResumen,
  zoneCoords,
  isConnected,
}, ref) {
  const [packageInfo, setPackageInfo] = useState<{
    preparado_at: string;
    size_kb: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadFieldPackage(projectId).then(pkg => {
      if (cancelled) return;
      if (pkg && pkg.preparado_at) {
        setPackageInfo({ preparado_at: pkg.preparado_at, size_kb: pkg.size_kb });
      } else {
        setPackageInfo(null);
      }
      setInitialized(true);
    }).catch(() => {
      if (!cancelled) setInitialized(true);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  const handlePress = useCallback(async () => {
    if (!isConnected) return;
    if (analysisPoints.length === 0) {
      Alert.alert('Sin datos', 'Primero analiza una zona para poder preparar el paquete de campo.');
      return;
    }

    const analisisKb = JSON.stringify(analysisPoints).length / 1024;
    const imagenKb = 150; // estimado
    const totalKb = Math.round(analisisKb + imagenKb);

    Alert.alert(
      'Preparar para campo',
      `Se guardarán ~${totalKb} KB localmente.\n\n` +
      `Incluye:\n• ${analysisPoints.length} puntos de análisis\n• Imagen de mapa (si está disponible)\n• Resumen del Dr. Ruiz\n\n` +
      'Disponible sin conexión en campo.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Continuar',
          onPress: async () => {
            setIsLoading(true);
            try {
              // 1. Download zone map image (graceful — can fail)
              let mapa_b64 = '';
              if (zoneCoords.length > 0) {
                const img = await fetchZoneMapImage(zoneCoords, 600);
                mapa_b64 = img ?? '';
              }

              // 2. Serialize analysis
              const analisis_json = JSON.stringify(analysisPoints);

              // 3. Calculate real size
              const totalBytes =
                analisis_json.length +
                mapa_b64.length +
                geologoResumen.length;
              const size_kb = Math.round(totalBytes / 1024);

              // 4. Save to DB
              await saveFieldPackage(projectId, {
                resumen_geologo: geologoResumen,
                analisis_json,
                mapa_b64,
                size_kb,
              });

              setPackageInfo({
                preparado_at: new Date().toISOString(),
                size_kb,
              });
            } catch (err: any) {
              Alert.alert('Error', 'No se pudo guardar el paquete: ' + err.message);
            } finally {
              setIsLoading(false);
            }
          },
        },
      ]
    );
  }, [isConnected, analysisPoints, geologoResumen, zoneCoords, projectId]);

  useImperativeHandle(ref, () => ({ triggerPrepare: handlePress }), [handlePress]);

  if (!initialized) return null;

  // Determine button state
  const hasPackage = packageInfo !== null;
  const canPrepare = isConnected && analysisPoints.length > 0;

  let btnColor = '#FF9800';
  let btnLabel = 'Preparar para campo';
  let btnIcon = '';
  let subLabel = '';

  if (hasPackage) {
    const days = daysSince(packageInfo!.preparado_at);
    btnColor = '#4CAF50';
    btnIcon = '';
    const whenLabel = days === 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`;
    btnLabel = `✅ Listo para campo · ${whenLabel}`;
    subLabel = `${packageInfo!.size_kb} KB`;
  } else if (!isConnected) {
    btnColor = '#FF5722';
    btnIcon = '';
    btnLabel = 'Requiere conexión';
    subLabel = 'conecta para preparar';
  }

  return (
    <TouchableOpacity
      style={[styles.button, { borderColor: btnColor, backgroundColor: 'rgba(0,0,0,0.6)' }]}
      onPress={handlePress}
      disabled={isLoading || (!canPrepare && !hasPackage)}
      activeOpacity={0.75}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color={btnColor} />
      ) : (
        <View style={styles.inner}>
          <Text style={[styles.label, { color: btnColor }]}>
            {btnIcon ? `${btnIcon} ` : ''}{btnLabel}
          </Text>
          {subLabel ? (
            <Text style={[styles.sub, { color: btnColor }]}>{subLabel}</Text>
          ) : null}
        </View>
      )}
    </TouchableOpacity>
  );
});

export default FieldModeButton;

const styles = StyleSheet.create({
  button: {
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 46,
  },
  inner: {
    alignItems: 'center',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  sub: {
    fontSize: 8,
    marginTop: 1,
    opacity: 0.85,
  },
});
