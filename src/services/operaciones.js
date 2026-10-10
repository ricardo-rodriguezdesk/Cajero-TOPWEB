/**
 * Bitácora de operaciones del cajero (tabla atm_operaciones).
 *
 * Cada intento se registra como 'pendiente' ANTES de hacer nada y al final se resuelve con
 * su resultado. Así queda rastro incluso de lo que el cajero rechazó por su cuenta o de
 * lo que falló por comunicación. La base de datos impide borrar o alterar registros resueltos.
 */
const crypto = require('crypto');
const { query } = require('../db');
const { AtmError } = require('../errors');

const ERRORES_DE_COMUNICACION = ['CENTRAL_TIMEOUT', 'CENTRAL_NO_DISPONIBLE', 'RESPUESTA_INVALIDA'];

const mascara = (cuenta) => '••••' + String(cuenta).slice(-4);
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function crear({ tipo, cuenta, monto, idempotencyKey }) {
  const { rows } = await query(
    `insert into atm_operaciones (tipo, cuenta_mascara, monto, idempotency_key)
     values ($1, $2, $3, $4) returning id`,
    [tipo, mascara(cuenta), monto, idempotencyKey]
  );
  return Number(rows[0].id);
}

async function resolver(id, { estado, codigo = null, mensaje = null, transaccionId = null, efectivo = null }) {
  await query(
    `update atm_operaciones
        set estado = $2, codigo = $3, mensaje = $4, transaccion_central_id = $5,
            efectivo_despues = coalesce($6, (select efectivo from atm_config where id = 1)),
            resuelta_en = now()
      where id = $1 and estado = 'pendiente'`,
    [id, estado, codigo, mensaje, transaccionId, efectivo]
  );
}

function estadoDeError(error) {
  if (!(error instanceof AtmError)) return 'error_comunicacion';
  if (error.origen === 'cajero') return 'rechazada_cajero';
  if (ERRORES_DE_COMUNICACION.includes(error.codigo)) return 'error_comunicacion';
  return 'rechazada_central';
}

/**
 * Ejecuta una operación dejándola registrada en la bitácora.
 * `ejecutar(idempotencyKey)` debe devolver { transaccionId?, efectivo?, ... }.
 */
async function registrar(tipo, cuenta, montoBruto, ejecutar) {
  const idempotencyKey = crypto.randomUUID();
  const valor = montoBruto === null || montoBruto === '' ? NaN : Number(montoBruto);
  const monto = Number.isFinite(valor) && Math.abs(valor) < 1e12 ? valor : null;
  const id = await crear({ tipo, cuenta, monto, idempotencyKey });

  try {
    const resultado = await ejecutar(idempotencyKey);
    await resolver(id, {
      estado: 'aprobada',
      transaccionId: resultado.transaccionId ?? null,
      efectivo: resultado.efectivo ?? null,
    });
    return { ...resultado, operacionId: id };
  } catch (error) {
    await resolver(id, { estado: estadoDeError(error), codigo: error.codigo || 'ERROR_INTERNO', mensaje: error.message }).catch(
      (e) => console.error('No se pudo cerrar la operación', id, e.message)
    );
    throw error;
  }
}

async function listar({ estado, tipo, limite = 50 } = {}) {
  const filtros = [];
  const params = [];
  if (estado) {
    params.push(estado);
    filtros.push(`estado = $${params.length}`);
  }
  if (tipo) {
    params.push(tipo);
    filtros.push(`tipo = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limite) || 50, 1), 200));
  const { rows } = await query(
    `select * from atm_operaciones
      ${filtros.length ? 'where ' + filtros.join(' and ') : ''}
      order by creada_en desc, id desc
      limit $${params.length}`,
    params
  );
  return rows.map((r) => ({
    id: Number(r.id),
    tipo: r.tipo,
    cuenta: r.cuenta_mascara,
    monto: num(r.monto),
    estado: r.estado,
    codigo: r.codigo,
    mensaje: r.mensaje,
    folio_central: num(r.transaccion_central_id),
    efectivo_despues: num(r.efectivo_despues),
    fecha: r.creada_en,
  }));
}

/** Resumen de las operaciones de hoy (hora de Ciudad de México). */
async function resumenHoy() {
  const zona = process.env.ATM_ZONA_HORARIA || 'America/Mexico_City';
  const { rows } = await query(
    `select
        count(*) filter (where tipo = 'retiro'   and estado = 'aprobada')                    as retiros,
        coalesce(sum(monto) filter (where tipo = 'retiro'   and estado = 'aprobada'), 0)     as monto_retiros,
        count(*) filter (where tipo = 'deposito' and estado = 'aprobada')                    as depositos,
        coalesce(sum(monto) filter (where tipo = 'deposito' and estado = 'aprobada'), 0)     as monto_depositos,
        count(*) filter (where tipo = 'consulta' and estado = 'aprobada')                    as consultas,
        count(*) filter (where estado = 'rechazada_cajero')                                  as rechazadas_cajero,
        count(*) filter (where estado = 'rechazada_central')                                 as rechazadas_central,
        count(*) filter (where estado = 'error_comunicacion')                                as errores_comunicacion
       from atm_operaciones
      where (creada_en at time zone $1)::date = (now() at time zone $1)::date`,
    [zona]
  );
  const r = rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

module.exports = { registrar, listar, resumenHoy };
