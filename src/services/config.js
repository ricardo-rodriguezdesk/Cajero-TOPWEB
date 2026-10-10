/**
 * Configuración y efectivo del cajero, guardados en SU PROPIA base de datos (tabla atm_config).
 *
 * El cajero NUNCA guarda saldos ni transacciones oficiales de clientes: eso vive en el Banco Central.
 */
const { query } = require('../db');
const { cifrar, descifrar } = require('../cifrado');

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Fila completa de configuración (sin descifrar la key). */
async function getEstado() {
  const { rows } = await query('select * from atm_config where id = 1');
  const fila = rows[0] || {};
  return {
    centralUrl: fila.central_url || process.env.CENTRAL_API_URL || null,
    tieneApiKey: Boolean(fila.api_key_cifrada),
    apiKeyFinal: fila.api_key_final || null,
    efectivo: num(fila.efectivo),
    sincronizadoEn: fila.sincronizado_en || null,
    nodo: fila.nodo_id
      ? {
          id: Number(fila.nodo_id),
          nombre: fila.nodo_nombre,
          estado: fila.nodo_estado,
          responsable: fila.responsable,
        }
      : null,
  };
}

/** Datos para hablar con el Central (con la key descifrada). */
async function getConfig() {
  const { rows } = await query('select central_url, api_key_cifrada from atm_config where id = 1');
  const fila = rows[0] || {};
  return {
    apiKey: fila.api_key_cifrada ? descifrar(fila.api_key_cifrada) : null,
    centralUrl: fila.central_url || process.env.CENTRAL_API_URL || null,
  };
}

/**
 * Guarda URL y/o API Key. Una key nueva borra los datos sincronizados con la anterior,
 * porque pertenecen a otro nodo.
 */
async function saveConfig({ apiKey, centralUrl }) {
  if (centralUrl !== undefined) {
    await query('update atm_config set central_url = $1, actualizado_en = now() where id = 1', [centralUrl]);
  }
  if (apiKey !== undefined) {
    await query(
      `update atm_config
          set api_key_cifrada = $1, api_key_final = $2,
              nodo_id = null, nodo_nombre = null, nodo_estado = null, responsable = null,
              efectivo = null, sincronizado_en = null, actualizado_en = now()
        where id = 1`,
      [cifrar(apiKey), apiKey.slice(-4)]
    );
  }
}

/** Guarda lo que dijo el Central (/api/node/me). Devuelve el efectivo local anterior para el cuadre. */
async function sincronizar(nodo) {
  const { rows } = await query(
    `update atm_config c
        set nodo_id = $1, nodo_nombre = $2, nodo_estado = $3, responsable = $4,
            efectivo = $5, sincronizado_en = now(), actualizado_en = now()
       from (select efectivo as anterior from atm_config where id = 1) a
      where c.id = 1
  returning a.anterior`,
    [nodo.id, nodo.nombre, nodo.estado, nodo.responsable ?? null, nodo.efectivo_disponible]
  );
  return num(rows[0]?.anterior);
}

/** Pone el cajero fuera de servicio (conserva la URL). */
async function reset() {
  await query(
    `update atm_config
        set api_key_cifrada = null, api_key_final = null,
            nodo_id = null, nodo_nombre = null, nodo_estado = null, responsable = null,
            efectivo = null, sincronizado_en = null, actualizado_en = now()
      where id = 1`
  );
}

/**
 * RN6 de forma atómica: aparta el efectivo SOLO si alcanza.
 * Devuelve el efectivo restante, o null si no alcanzó (no se modificó nada).
 */
async function reservarEfectivo(monto) {
  const { rows } = await query(
    `update atm_config set efectivo = efectivo - $1, actualizado_en = now()
      where id = 1 and efectivo >= $1
  returning efectivo`,
    [monto]
  );
  return rows.length ? num(rows[0].efectivo) : null;
}

/** Devuelve el efectivo apartado si el Central rechazó o no respondió (RN7). */
async function liberarEfectivo(monto) {
  await query('update atm_config set efectivo = efectivo + $1, actualizado_en = now() where id = 1', [monto]);
}

/** El Central tiene el efectivo oficial: tras cada operación aprobada se toma su valor. */
async function setEfectivo(valor) {
  await query('update atm_config set efectivo = $1, actualizado_en = now() where id = 1', [valor]);
}

async function registrarEvento(tipo, detalle = {}) {
  try {
    await query('insert into atm_eventos (tipo, detalle) values ($1, $2)', [tipo, JSON.stringify(detalle)]);
  } catch (error) {
    console.error('No se pudo registrar el evento:', error.message);
  }
}

async function listarEventos(limite = 20) {
  const { rows } = await query(
    'select id, tipo, detalle, creado_en from atm_eventos order by creado_en desc, id desc limit $1',
    [Math.min(Math.max(Number(limite) || 20, 1), 100)]
  );
  return rows.map((r) => ({ id: Number(r.id), tipo: r.tipo, detalle: r.detalle, fecha: r.creado_en }));
}

module.exports = {
  getEstado,
  getConfig,
  saveConfig,
  sincronizar,
  reset,
  reservarEfectivo,
  liberarEfectivo,
  setEfectivo,
  registrarEvento,
  listarEventos,
};
