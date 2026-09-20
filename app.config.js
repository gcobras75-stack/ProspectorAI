/**
 * app.config.js — envuelve app.json (que sigue siendo la fuente de la app nativa).
 *
 * Con PROSPECTOR_WEB=1 (solo para `expo export -p web` de la PWA de consulta) el
 * router usa `app-web/` como raíz en vez de `app/`. Así el bundle web contiene
 * ÚNICAMENTE lo que las pantallas de app-web importan: nada de react-native-maps,
 * expo-sqlite, SyncEngine ni de los prompts del cliente (ClaudeServices). Sin la
 * variable, la config es idéntica a app.json → la app nativa y los OTA no cambian.
 */
module.exports = ({ config }) => {
  if (process.env.PROSPECTOR_WEB !== '1') return config;
  return {
    ...config,
    web: { ...config.web, output: 'single' },
    extra: { ...config.extra, router: { ...config.extra?.router, root: 'app-web' } },
  };
};
