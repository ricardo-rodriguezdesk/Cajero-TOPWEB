# Nodo Cajero Automático (ATM)

Parte del **Sistema Bancario Distribuido**. Este nodo es un backend ligero en **Express** con **su propia base de datos PostgreSQL** (Supabase), una interfaz de cajero y un panel administrativo, desplegado en **Vercel**.

- **Cajero:** https://cajero-topweb.vercel.app
- **Panel administrativo:** https://cajero-topweb.vercel.app/admin
- **Responsable del nodo:** Ricardo Rodríguez Arellano

## Equipo

| Integrante | Rol |
|---|---|
| Jorge Laurencio Sánchez Rojas | Persona 1 · Banco Central: base de datos (Supabase) y API core |
| Emmanuel Reynaldo Gaspar Lara | Persona 2 · Banco Central: panel administrativo y despliegue |
| Victor Manuel Mendoza Lara | Persona 3 · Sucursal administrativa (Nodo 2) |
| **Ricardo Rodríguez Arellano** | **Persona 4 · Cajero automático ATM (Nodo 3)** |

## Nodos del sistema

| Nodo | Tecnología | Despliegue | Repositorio |
|---|---|---|---|
| Banco Central (panel + API core) | Laravel + Supabase | https://banco-central-panel.onrender.com | https://github.com/ReynaldoEGL/ExamenTWBancoCentral |
| Sucursal (Nodo 2) | Sucursal administrativa | https://sucursal-nodo2-nyl2.onrender.com/dashboard | https://github.com/Victorml55/sucursal-nodo2-TOPWEB |
| **Cajero ATM (Nodo 3)** | **Express + Supabase propio** | **https://cajero-topweb.vercel.app** | **https://github.com/ricardo-rodriguezdesk/Cajero-TOPWEB** |

## Arquitectura del sistema

```
                 ┌──────────────────────────────────────┐
                 │  SUPABASE DEL BANCO CENTRAL          │
                 │  cuentas · saldos · transacciones    │
                 │  nodos · api_keys · auth             │
                 └──────────────────▲───────────────────┘
                                    │ (solo el servidor del Central)
                 ┌──────────────────┴───────────────────┐
                 │  BANCO CENTRAL (Laravel)             │
                 │  Panel admin + API core              │  → Render
                 └───────▲──────────────────────▲───────┘
               X-API-Key │                      │ X-API-Key
        ┌────────────────┴──────┐      ┌────────┴──────────────┐
        │  SUCURSAL (Nodo 2)    │      │  CAJERO ATM (Nodo 3)  │  → Vercel
        │  Apertura de cuentas  │      │  Express              │
        │  Consultas, reportes  │      │  Retiros, depósitos   │
        └───────────────────────┘      └──────────┬────────────┘
                 → Render                         │
                                       ┌──────────▼────────────┐
                                       │  SUPABASE DEL CAJERO  │
                                       │  config · efectivo ·  │
                                       │  bitácora · eventos   │
                                       └───────────────────────┘
```

Los nodos nunca se comunican entre sí: cada uno habla **solo con el Banco Central**, que valida su API Key y consolida todos los movimientos.

## Papel del cajero en el sistema

- **Descentralizado para la operación:** el cajero tiene su propia base de datos, su propia interfaz y su propio despliegue. Valida montos y su efectivo **sin consultar al Central**, y registra en su bitácora todo lo que pasa por él.
- **Centralizado para la consolidación:** el cajero **no guarda saldos de clientes ni las transacciones oficiales**. Cada retiro o depósito lo aprueba y registra el Banco Central; la bitácora local solo guarda el folio que devolvió el Central.

## Base de datos del cajero

Esquema en [`database/schema.sql`](database/schema.sql).

| Tabla | Para qué |
|---|---|
| `atm_config` | Una sola fila: URL del Central, **API Key cifrada** (AES-256-GCM), datos del nodo y **efectivo físico** del cajero |
| `atm_operaciones` | **Bitácora (journal)**: cada consulta, retiro y depósito, con su resultado, código de error y folio del Central |
| `atm_eventos` | Bitácora administrativa: configuraciones, sincronizaciones (cuadres) y fallas de conexión |

Reglas que impone la propia base de datos:
- El efectivo del cajero nunca puede ser negativo (`check`).
- La bitácora es **inmutable**: no se puede borrar nada, y una operación solo se puede actualizar mientras está `pendiente` (para registrar su resultado). Lo hacen triggers.
- **RLS** activado sin políticas: las llaves públicas de Supabase no pueden leer ni escribir; solo el backend del cajero.
- Las cuentas se guardan enmascaradas (`••••0001`), no completas.

Estados de una operación: `pendiente` → `aprobada` · `rechazada_cajero` · `rechazada_central` · `error_comunicacion`.

## Reglas de negocio

| Regla | Quién decide | Descripción |
|---|---|---|
| RN1 | Cajero | Sin API Key o sin efectivo sincronizado, el cajero está fuera de servicio |
| RN2 | Central | Solo cuentas activas pueden operar |
| RN4 | Cajero | El monto debe ser mayor a 0 (además: múltiplo de $50 y máximo por operación) |
| RN5 | Central | El saldo debe alcanzar para el retiro |
| RN6 | Cajero | El efectivo físico del cajero debe alcanzar, **antes** de llamar al Central |
| RN7 | Cajero | Si el Central rechaza o no responde, el efectivo del cajero no cambia |

### Idempotencia

Cada retiro o depósito genera una `Idempotency-Key` (UUID) **nueva** y la guarda en la bitácora. Si el Central no responde o falla del lado del servidor, el cajero **reintenta la misma operación con la misma key** (`CENTRAL_REINTENTOS`, por defecto 2). El Central reconoce la key y devuelve la respuesta original, así que **nunca se cobra dos veces**. Las respuestas definitivas (4xx, como fondos insuficientes) no se reintentan.

Cada error indica su `origen` (`cajero` o `central`); la interfaz y la bitácora lo muestran para que se vea qué nodo tomó la decisión.

### Flujo del retiro

```
Cliente pide $300
   │
   ├─ RN1 ¿Cajero en servicio? ───────── no ─→ "Fuera de servicio"
   ├─ Bitácora: operación 'pendiente'
   ├─ RN4 ¿Monto válido? ──────────────── no ─→ rechazada_cajero
   ├─ RN6 Apartar $300 del efectivo ──── no alcanza ─→ rechazada_cajero (no se llama al Central)
   │      (UPDATE atómico en la BD del cajero)
   ├─ POST /api/withdraw al Banco Central (X-API-Key, Idempotency-Key nueva, timeout 6 s)
   │     ├─ no responde ─→ reintenta hasta 2 veces con la MISMA key: si el Central ya lo había
   │     │                 aplicado, devuelve la respuesta original sin cobrar dos veces
   │     ├─ rechaza ─────→ se devuelve el efectivo apartado (RN7) → rechazada_central
   │     ├─ sigue sin responder ─→ se devuelve el efectivo apartado (RN7) → error_comunicacion
   │     └─ aprueba ─────→ saldo y transacción oficial registrados en el Central
   │
   └─ El cajero toma el efectivo oficial (efectivo_nodo) → aprobada, con folio del Central
```

## Estructura

```
atm-node/
├── api/index.js              # entrada para Vercel (función serverless)
├── server.js                 # arranque local
├── database/schema.sql       # base de datos del cajero
├── scripts/setup-db.js       # npm run db:setup
├── src/
│   ├── app.js                # Express: rutas, estáticos y manejo de errores
│   ├── db.js                 # conexión a PostgreSQL
│   ├── cifrado.js            # cifrado de la API Key
│   ├── errors.js             # AtmError (status, código, origen)
│   ├── routes/
│   │   ├── atm.js            # /api/status, /api/balance, /api/withdraw, /api/deposit
│   │   └── admin.js          # /admin/api/* (configuración, bitácora, resumen)
│   ├── services/
│   │   ├── central.js        # cliente de la API del Banco Central
│   │   ├── centralMock.js    # simulador del Banco Central (USE_MOCK=true)
│   │   ├── config.js         # tabla atm_config y atm_eventos
│   │   ├── operaciones.js    # tabla atm_operaciones (bitácora)
│   │   └── rules.js          # reglas de negocio del cajero
│   └── middleware/
│       └── adminAuth.js      # login del panel (cookie firmada)
├── public/                   # interfaz: index.html (cajero) y admin.html (panel)
├── openapi.yaml              # API de este nodo
├── contrato-central-atm.yaml # contrato con la API del Banco Central
└── vercel.json
```

## Puesta en marcha

### 1. Crear la base de datos del cajero (Supabase)

1. En supabase.com crea un **proyecto nuevo solo para el cajero** (no el del Banco Central).
2. Abre **SQL Editor**, pega el contenido de `database/schema.sql` y ejecútalo.
3. En **Connect** copia la cadena del **Transaction pooler** (puerto 6543) y reemplaza `[YOUR-PASSWORD]` por la contraseña del proyecto.

### 2. Correr en local

Requisitos: Node.js 18 o superior.

```bash
npm install
copy .env.example .env      # en Mac/Linux: cp .env.example .env
```

Edita `.env`: pega tu `DATABASE_URL` y pon un `ATM_SECRET` y un `ADMIN_PASSWORD` propios. Luego:

```bash
npm run db:setup            # opcional: crea las tablas si no usaste el SQL Editor
npm run dev
```

La consola debe decir `Base de datos del cajero: conectada`.

- Cajero: http://localhost:3000
- Panel: http://localhost:3000/admin

### 3. Probar con el simulador del Banco Central

Con `USE_MOCK=true`, en el panel pega la API Key **`atm_demo_key`** y presiona *Guardar y conectar*.

| Cuenta | Titular | Saldo | Estado | Sirve para probar |
|---|---|---|---|---|
| 1000000001 | Juan Pérez | $1,000 | activa | La demo: retiro de $300 → $700 |
| 1000000002 | María García | $5,000 | bloqueada | `CUENTA_BLOQUEADA` |
| 1000000003 | Pedro Ruiz | $50,000 | activa | Vaciar el cajero (`CAJERO_SIN_EFECTIVO`) |

El simulador guarda sus datos en memoria y se reinicia junto con el servidor; la base de datos del cajero sí conserva todo.

### 4. Conectar con el Banco Central real

1. Cambia `USE_MOCK=false`.
2. En el panel captura la URL de la API del Banco Central y la API Key que generó su panel.
3. *Guardar y conectar*: el cajero valida la key con `GET /api/node/me` y descarga su efectivo asignado.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | PostgreSQL del cajero (Supabase, Transaction pooler) |
| `DB_SSL` | `true` (Supabase) o `false` (Postgres local sin SSL) |
| `ATM_SECRET` | Cifra la API Key y firma la sesión del panel (mín. 16 caracteres) |
| `ADMIN_PASSWORD` | Contraseña del panel administrativo |
| `USE_MOCK` | `true` usa el simulador; `false` la API real |
| `CENTRAL_API_URL` | URL inicial del Banco Central (también se captura en el panel) |
| `CENTRAL_TIMEOUT_MS` | Tiempo máximo de espera al Central por intento (6000) |
| `CENTRAL_REINTENTOS` | Reintentos con la misma Idempotency-Key si el Central no responde (2) |
| `ATM_MULTIPLO` | Múltiplo de los montos (50) |
| `ATM_MAX_RETIRO` / `ATM_MAX_DEPOSITO` | Máximos por operación (10000 / 20000) |
| `ATM_ZONA_HORARIA` | Zona para el resumen del día (America/Mexico_City) |

La API Key **no** va en variables de entorno: se captura en el panel y se guarda cifrada en la base de datos del cajero.

## Despliegue en Vercel (despliegue continuo)

1. Sube el repositorio a GitHub.
2. En Vercel: **Add New → Project**, importa el repositorio. *Framework Preset*: **Other** (ya viene en `vercel.json`).
3. En **Settings → Environment Variables** agrega `DATABASE_URL`, `ATM_SECRET`, `ADMIN_PASSWORD`, `USE_MOCK` y `CENTRAL_API_URL`.
4. Despliega. A partir de ahí, cada `git push` a `main` despliega automáticamente.

## Documentación de la API

- `openapi.yaml`: endpoints de este cajero.
- `contrato-central-atm.yaml`: endpoints del Banco Central que consume este cajero.

Se pueden abrir en https://editor.swagger.io.