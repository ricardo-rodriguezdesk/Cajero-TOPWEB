-- =====================================================================
--  Base de datos PROPIA del Cajero Automático (ATM)
--
--  Es independiente de la base del Banco Central. Aquí el cajero guarda
--  lo que necesita para operar por su cuenta (operación descentralizada):
--    • atm_config       → su configuración y su efectivo físico
--    • atm_operaciones  → bitácora (journal) de cada operación del cajero
--    • atm_eventos      → bitácora administrativa (configuración, cuadres…)
--
--  Lo que NO guarda: saldos de clientes ni el registro oficial de
--  transacciones. Eso vive solo en el Banco Central (consolidación
--  centralizada). La bitácora local solo referencia el folio del Central.
--
--  Se puede ejecutar varias veces sin romper nada.
--  Uso: pegar en el SQL Editor de Supabase (proyecto del cajero) o
--       ejecutar `npm run db:setup`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Configuración y efectivo del cajero (siempre una sola fila, id = 1)
-- ---------------------------------------------------------------------
create table if not exists atm_config (
  id               smallint primary key default 1 check (id = 1),
  central_url      text,
  api_key_cifrada  text,            -- AES-256-GCM, nunca en texto plano
  api_key_final    text,            -- últimos 4 caracteres, solo para mostrar
  nodo_id          bigint,          -- id del cajero en el Banco Central
  nodo_nombre      text,
  nodo_estado      text,
  responsable      text,
  efectivo         numeric(14,2) check (efectivo >= 0),   -- null = sin sincronizar
  sincronizado_en  timestamptz,
  actualizado_en   timestamptz not null default now()
);

insert into atm_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Bitácora de operaciones (journal electrónico del cajero)
--    Registra TODO intento: aprobado, rechazado por el cajero,
--    rechazado por el Central o con falla de comunicación.
-- ---------------------------------------------------------------------
create table if not exists atm_operaciones (
  id                      bigserial primary key,
  tipo                    text not null check (tipo in ('consulta', 'retiro', 'deposito')),
  cuenta_mascara          text not null,           -- ej. ••••0001 (no se guarda la cuenta completa)
  monto                   numeric(14,2),
  estado                  text not null default 'pendiente'
                          check (estado in ('pendiente', 'aprobada', 'rechazada_cajero',
                                            'rechazada_central', 'error_comunicacion')),
  codigo                  text,                    -- código de error, si hubo
  mensaje                 text,
  transaccion_central_id  bigint,                  -- folio del Banco Central (si se aprobó)
  idempotency_key         uuid not null unique,    -- se envía al Central para evitar dobles cargos
  efectivo_despues        numeric(14,2),           -- efectivo del cajero al terminar
  creada_en               timestamptz not null default now(),
  resuelta_en             timestamptz
);

create index if not exists atm_operaciones_creada_idx on atm_operaciones (creada_en desc);
create index if not exists atm_operaciones_estado_idx on atm_operaciones (estado);

-- ---------------------------------------------------------------------
-- 3. Bitácora administrativa
-- ---------------------------------------------------------------------
create table if not exists atm_eventos (
  id         bigserial primary key,
  tipo       text not null check (tipo in ('configuracion', 'sincronizacion', 'conexion_fallida',
                                            'fuera_de_servicio')),
  detalle    jsonb not null default '{}'::jsonb,
  creado_en  timestamptz not null default now()
);

create index if not exists atm_eventos_creado_idx on atm_eventos (creado_en desc);

-- ---------------------------------------------------------------------
-- 4. Bitácora inmutable
--    • No se puede borrar ninguna operación ni evento.
--    • Una operación solo se puede actualizar mientras está 'pendiente'
--      (para registrar su resultado). Después queda congelada.
-- ---------------------------------------------------------------------
create or replace function atm_bloquear_borrado() returns trigger
language plpgsql as $$
begin
  raise exception 'La bitácora del cajero es inmutable: no se permite modificar ni borrar registros';
end;
$$;

create or replace function atm_proteger_operacion() returns trigger
language plpgsql as $$
begin
  if old.estado <> 'pendiente' then
    raise exception 'La operación % ya fue resuelta y no se puede modificar', old.id;
  end if;
  -- solo se permite registrar el resultado; los datos de origen no cambian
  if new.tipo is distinct from old.tipo
     or new.cuenta_mascara is distinct from old.cuenta_mascara
     or new.monto is distinct from old.monto
     or new.idempotency_key is distinct from old.idempotency_key
     or new.creada_en is distinct from old.creada_en then
    raise exception 'Solo se puede registrar el resultado de la operación %', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists atm_operaciones_no_borrar on atm_operaciones;
create trigger atm_operaciones_no_borrar
  before delete on atm_operaciones
  for each row execute function atm_bloquear_borrado();

drop trigger if exists atm_operaciones_solo_resolver on atm_operaciones;
create trigger atm_operaciones_solo_resolver
  before update on atm_operaciones
  for each row execute function atm_proteger_operacion();

drop trigger if exists atm_eventos_no_modificar on atm_eventos;
create trigger atm_eventos_no_modificar
  before update or delete on atm_eventos
  for each row execute function atm_bloquear_borrado();

-- ---------------------------------------------------------------------
-- 5. Seguridad (Supabase)
--    RLS activado y sin políticas: nadie puede leer ni escribir con las
--    llaves públicas (anon / authenticated). Solo el backend del cajero,
--    que se conecta con el usuario de la base de datos.
-- ---------------------------------------------------------------------
alter table atm_config      enable row level security;
alter table atm_operaciones enable row level security;
alter table atm_eventos     enable row level security;
