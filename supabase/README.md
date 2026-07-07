# ProspectorAI · Supabase (Etapa 2)

Backend de cuentas con **código de invitación** + **aislamiento de datos por usuario (RLS)**.

## Qué hay
- `migrations/0001_prospectorai_init.sql` — esquema completo:
  - `profiles`, `invite_codes`, `projects`, `samples`, `analyses`, `validation_pairs`, `ai_usage`.
  - RLS estricto: cada usuario **solo ve/edita lo suyo**; `invite_codes` solo admin.
  - Registro **blindado por código** (trigger `handle_new_user` sobre `auth.users`).
  - RPCs: `generate_invite_code`, `revoke_invite_code` (admin), `check_and_increment_ai_usage` (servidor), `ping` (keep-alive).
  - Seed: código de arranque `PROSP-START` (5 usos).

## Aplicar
Sobre el proyecto `prospectorai` (una vez creado), aplicar el SQL de la migración
(vía el asistente con `apply_migration`, o pegándolo en el SQL Editor del dashboard).

## Bootstrap del admin (Antonio) — Checkpoint B
1. Antonio se registra en la app con el código **`PROSP-START`**.
2. Promuévelo a admin (SQL Editor), sustituyendo su email:
   ```sql
   update public.profiles
     set role = 'admin'
     where id = (select id from auth.users where email = 'ANTONIO@EMAIL.COM');
   ```
3. A partir de ahí, Antonio genera códigos desde la pantalla admin de la app
   (que llama a `generate_invite_code`).

## Probar auth con código (Checkpoint A) — vía REST/curl
Necesitas la `SUPABASE_URL` y la **anon key** del proyecto.

```bash
URL="https://<REF>.supabase.co"
ANON="<ANON_KEY>"

# 1) Registro SIN código → debe FALLAR (INVITE_CODE_REQUIRED)
curl -s -X POST "$URL/auth/v1/signup" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"test1@example.com","password":"Test123!","data":{"nombre":"Test"}}'

# 2) Registro con código INVÁLIDO → debe FALLAR (INVITE_CODE_INVALID)
curl -s -X POST "$URL/auth/v1/signup" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"test2@example.com","password":"Test123!","data":{"invite_code":"NOEXISTE","nombre":"Test"}}'

# 3) Registro con PROSP-START → debe FUNCIONAR (crea usuario + profile, uses+1)
curl -s -X POST "$URL/auth/v1/signup" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"test3@example.com","password":"Test123!","data":{"invite_code":"PROSP-START","nombre":"Test"}}'
```
Verificación en SQL:
```sql
select code, uses, max_uses, active from public.invite_codes;   -- PROSP-START.uses debe haber subido
select id, nombre, codigo_usado, role from public.profiles;      -- una fila por el registro exitoso
```
Aislamiento RLS: iniciando sesión como dos usuarios distintos, cada uno solo debe
ver sus propias filas en `projects`/`samples` (probar con la anon key + el JWT de cada sesión).

## Keep-alive (free tier, cron en Hermes cada 6 h)
Ver snippet en la respuesta del asistente / al final de la Etapa 2. Llama a `rpc/ping`.
