import { Redirect } from 'expo-router';

// En la PWA no hay pantalla de captura/análisis (eso es la app nativa): la entrada es Proyectos.
export default function IndexWeb() {
  return <Redirect href={'/(tabs)/proyectos' as any} />;
}
