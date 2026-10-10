/**
 * Panel administrativo del cajero: conexión con el Banco Central (API Key),
 * cuadre de efectivo y consulta de la bitácora guardada en la base de datos del cajero.
 */
const express = require('express');
const config = require('../services/config');
const central = require('../services/central');
const operaciones = require('../services/operaciones');
const { login, logout, requireAdmin } = require('../middleware/adminAuth');
const { AtmError } = require('../errors');

const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);

router.use(requireAdmin);

async function estadoActual() {
  const e = await config.getEstado();
  return {
    en_servicio: e.tieneApiKey && e.efectivo !== null,
    central_url: e.centralUrl,
    api_key: e.apiKeyFinal ? `••••••••${e.apiKeyFinal}` : null,
    efectivo_local: e.efectivo,
    sincronizado_en: e.sincronizadoEn,
    nodo: e.nodo,
    modo: central.usarMock() ? 'simulador' : 'real',
    base_de_datos: 'conectada',
  };
}

/**
 * Consulta al Central (/api/node/me) y copia su efectivo oficial.
 * Devuelve el cuadre: cuánto creía tener el cajero y cuánto dice el Central.
 */
async function sincronizar(motivo) {
  const nodo = await central.getNodo();
  if (nodo.tipo && nodo.tipo !== 'cajero') {
    throw new AtmError(422, 'TIPO_DE_NODO_INCORRECTO', `Esta API Key pertenece a una ${nodo.tipo}, no a un cajero`, 'cajero');
  }
  const anterior = await config.sincronizar(nodo);
  const cuadre = {
    efectivo_local: anterior,
    efectivo_central: Number(nodo.efectivo_disponible),
    diferencia: anterior === null ? null : Number((Number(nodo.efectivo_disponible) - anterior).toFixed(2)),
  };
  await config.registrarEvento('sincronizacion', { motivo, nodo: nodo.nombre, ...cuadre });
  return { nodo, cuadre };
}

router.get('/config', async (req, res) => {
  res.json(await estadoActual());
});

/** Guarda URL y/o API Key; luego intenta conectarse y sincronizar el efectivo. */
router.put('/config', async (req, res) => {
  const { central_url: centralUrl, api_key: apiKey } = req.body || {};
  const cambios = {};

  if (centralUrl !== undefined && centralUrl !== '') {
    let url;
    try {
      url = new URL(String(centralUrl).trim());
    } catch {
      throw new AtmError(400, 'DATOS_INVALIDOS', 'La URL del Banco Central no es válida');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new AtmError(400, 'DATOS_INVALIDOS', 'La URL debe empezar con http:// o https://');
    }
    cambios.centralUrl = url.toString().replace(/\/+$/, '');
  }

  if (apiKey !== undefined && apiKey !== '') {
    const limpia = String(apiKey).trim();
    if (limpia.length < 8) throw new AtmError(400, 'DATOS_INVALIDOS', 'La API Key es demasiado corta');
    cambios.apiKey = limpia;
  }

  if (Object.keys(cambios).length === 0) {
    throw new AtmError(400, 'DATOS_INVALIDOS', 'No hay cambios que guardar');
  }

  await config.saveConfig(cambios);
  await config.registrarEvento('configuracion', {
    url_cambiada: Boolean(cambios.centralUrl),
    api_key_cambiada: Boolean(cambios.apiKey),
    ...(cambios.apiKey ? { api_key_final: cambios.apiKey.slice(-4) } : {}),
  });

  let conexion;
  try {
    const { nodo } = await sincronizar('Configuración nueva');
    conexion = { ok: true, nodo };
  } catch (error) {
    conexion = { ok: false, error: error.message, codigo: error.codigo };
    await config.registrarEvento('conexion_fallida', { codigo: error.codigo, error: error.message });
  }

  res.json({ ...(await estadoActual()), conexion });
});

/** "Probar conexión": valida la key contra el Central sin modificar nada. */
router.post('/test', async (req, res) => {
  try {
    const nodo = await central.getNodo();
    res.json({ ok: true, nodo });
  } catch (error) {
    await config.registrarEvento('conexion_fallida', { codigo: error.codigo, error: error.message });
    throw error;
  }
});

/** "Sincronizar efectivo" (cuadre): el Central manda; la copia local se reemplaza. */
router.post('/sync', async (req, res) => {
  const { cuadre } = await sincronizar('Sincronización manual');
  res.json({ ...(await estadoActual()), cuadre });
});

/** "Poner fuera de servicio": borra la API Key del cajero. */
router.delete('/config', async (req, res) => {
  await config.reset();
  await config.registrarEvento('fuera_de_servicio', { motivo: 'Desde el panel administrativo' });
  res.json(await estadoActual());
});

/** Bitácora de operaciones con filtros opcionales ?estado=&tipo=&limite= */
router.get('/operaciones', async (req, res) => {
  const ESTADOS = ['pendiente', 'aprobada', 'rechazada_cajero', 'rechazada_central', 'error_comunicacion'];
  const TIPOS = ['consulta', 'retiro', 'deposito'];
  const { estado, tipo, limite } = req.query;
  if (estado && !ESTADOS.includes(estado)) throw new AtmError(400, 'DATOS_INVALIDOS', 'Estado no válido');
  if (tipo && !TIPOS.includes(tipo)) throw new AtmError(400, 'DATOS_INVALIDOS', 'Tipo no válido');
  res.json(await operaciones.listar({ estado, tipo, limite }));
});

/** Totales del día. */
router.get('/resumen', async (req, res) => {
  res.json(await operaciones.resumenHoy());
});

/** Bitácora administrativa (configuraciones, cuadres, fallas de conexión). */
router.get('/eventos', async (req, res) => {
  res.json(await config.listarEventos(Number(req.query.limite) || 20));
});

module.exports = router;
