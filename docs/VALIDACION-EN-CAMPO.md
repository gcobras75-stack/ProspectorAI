# Validación en campo (PWA) — Fase 1

Botón **"✔ Validar en campo"** en cada tarjeta de punto del panel de resultados de la PWA. El usuario marca qué encontró al visitar el punto y se guarda el par **predicción-realidad** en `validation_pairs` (Supabase).

> **Solo registra. NADA ajusta el análisis con estos pares** (hoy no hay ningún código que los use para calibrar). Con pocos pares no se puede concluir nada, y hay sesgo de selección: la gente visita los puntos que parecen prometedores.

## Qué ve el usuario
- En cada tarjeta de punto (los 3 mejores): **✔ Validar en campo** (o **✔ Cambiar veredicto** si ya hay uno).
- Hoja anclada arriba (el teclado del iPhone no la tapa): **Confirmado en campo / Parcial / No encontré nada** + nota corta (máx. 280 caracteres) + Guardar/Actualizar + "Quitar veredicto".
- **"No encontré nada" se explica siempre como "EN MI VISITA no lo encontré. No prueba que no exista"**; la insignia dice "❌ No lo encontré (en mi visita)". La hoja avisa: "Es tu observación en esta visita. Por ahora solo se registra: no cambia el análisis."
- Insignia con el veredicto (y la nota citada) en la tarjeta.

## Qué se guarda (`validation_pairs`, upsert por `user_id, client_id`)
| Campo | Contenido |
|---|---|
| `client_id` | `web:<proyecto>:<lat5>,<lng5>` — la identidad del punto viaja aquí (un par por punto; guardar de nuevo actualiza el mismo) |
| `project_client_id` | el proyecto |
| `predicted` | `consensus`, `evidence`, `base_score`, `indices`, `metal` (como la nativa) + `score`, `rank` (extras PWA). Lo ausente va en `null`, no en 0 |
| `actual` | `{ verdict, comment, threshold: 0.5 }`, `verdict` ∈ `CONFIRMED` / `PARTIAL` / `NOT_CONFIRMED` (**mismas claves que la app nativa**) |
| `data` | `muestra_id: ''`, `created_at`, `lat`, `lng`, `rank`, `origen: 'pwa'`, `nota_alcance`, `analisis: {fecha, fuentes}` |

Sin migración: el esquema ya alcanza. Seguridad: RLS `validation_own` (cada usuario solo ve/escribe lo suyo).

## Compatibilidad con la app nativa
- `ResultsPanel` es compartido: el botón, la insignia y las propiedades (`onValidate`, `validations`, `validationKey`) son **opcionales**; la app nativa no las pasa y su tarjeta no cambia.
- La nativa, al iniciar sesión, **descarga** estos pares (`upsertValidationFromRemote`); su lectura de esta fila está probada (`scripts/test-validation-pairs.mjs`). Su `ValidationView` los omite (hace `JOIN` con muestras).
- **Riesgo conocido (Fase 2):** una vez por usuario, la nativa **re-sube** sus pares reconstruyendo el payload solo desde sus columnas locales: eso borraría lo que la PWA puso en `data` y los extras de `predicted`. Por eso la identidad (lat/lng) viaja en el `client_id`; `verdict` y `comment` sí sobreviven. La Fase 2 hace que la nativa no reescriba los pares `web:` (requiere OTA).

## Código
- `web-lib/validationPairs.ts` — claves, formato y reglas (módulo puro, con 11 tests: `node --test scripts/test-validation-pairs.mjs`).
- `web-lib/validationStore.ts` — lectura / guardado / quitar con la sesión del usuario.
- `web-lib/ValidationSheet.tsx` — la hoja.
- `app/components/ResultsPanel.tsx` — botón e insignia opcionales.
- `app-web/proyecto/[id].tsx` — carga de veredictos y cableado.

## Pendiente (no incluido)
- Fase 2: alineación con la nativa (no reescribir pares `web:`, mostrarlos en `ValidationView`).
- Fase 3: lectura de resultados (aciertos por nivel de consenso) — solo con muestra suficiente y declarando el sesgo de selección.
