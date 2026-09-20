/**
 * metro.config.js — config por defecto de Expo. SOLO con PROSPECTOR_WEB=1 (export de la
 * PWA de consulta) sustituye, en la plataforma web, módulos que solo tienen sentido en la
 * app nativa. Sin la variable esto es exactamente getDefaultConfig: la app nativa y los
 * OTA no cambian.
 *
 * Por qué hace falta: ResultsPanel (reutilizado en la PWA) importa SatelliteEngine, que
 * importa Database (expo-sqlite), y externalNav (Alert/Linking nativos). La PWA no tiene
 * SQLite ni cola de sync, y Alert.alert es un no-op en react-native-web.
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (process.env.PROSPECTOR_WEB === '1') {
  const STUBS = {
    Database: path.join(__dirname, 'web-lib', 'stubs', 'Database.ts'),
    externalNav: path.join(__dirname, 'web-lib', 'stubs', 'externalNav.ts'),
    'react-native-maps': path.join(__dirname, 'web-lib', 'stubs', 'react-native-maps.ts'),
  };
  const upstream = config.resolver.resolveRequest;

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform === 'web') {
      // './Database', '../core/externalNav', 'react-native-maps' → stub. Solo módulos de la app
      // (no de node_modules) para no capturar paquetes con el mismo nombre.
      const base = moduleName.split('/').pop();
      const fromApp = !context.originModulePath.includes(`${path.sep}node_modules${path.sep}`);
      const isMaps = moduleName === 'react-native-maps';
      if ((isMaps || (fromApp && (base === 'Database' || base === 'externalNav'))) && STUBS[isMaps ? moduleName : base]) {
        return { type: 'sourceFile', filePath: STUBS[isMaps ? moduleName : base] };
      }
    }
    return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
