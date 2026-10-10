/**
 * Cliente de la API core del Banco Central.
 *
 * - Agrega el header X-API-Key a cada petición.
 * - Usa un timeout por intento.
 * - Retiros y depósitos llevan Idempotency-Key (un UUID por operación del cliente).
 *   Si el Central no responde o falla del lado del servidor, se REINTENTA la MISMA operación
 *   con la MISMA key: si el Central ya la había aplicado, devuelve la respuesta original
 *   sin cobrar dos veces. Una operación nueva siempre usa una key nueva.
 * - Convierte cualquier error en un AtmError con origen 'central'.
 * - Con USE_MOCK=true usa el simulador en lugar de la API real.
 */
const config = require('./config');
const mock = require('./centralMock');
const { AtmError } = require('../errors');

const TIMEOUT_MS = Number(process.env.CENTRAL_TIMEOUT_MS || 6000);
const REINTENTOS = Math.max(0, Number(process.env.CENTRAL_REINTENTOS ?? 2));
const ESPERA_ENTRE_INTENTOS_MS = 400;

function usarMock() {
  return String(process.env.USE_MOCK).toLowerCase() === 'true';
}

const CODIGO_POR_STATUS = {
  400: 'DATOS_INVALIDOS',
  401: 'API_KEY_INVALIDA',
  403: 'NODO_INACTIVO',
  404: 'CUENTA_NO_ENCONTRADA',
  422: 'REGLA_DE_NEGOCIO',
  500: 'ERROR_INTERNO',
};

const MENSAJES = {
  IDEMPOTENCY_CONFLICT: 'La operación no coincide con un intento anterior. Inicie la operación de nuevo.',
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ¿Vale la pena reintentar? Solo cuando no sabemos si el Central aplicó la operación
 * (no respondió, se cortó la conexión o falló del lado del servidor).
 * Los 4xx son respuestas definitivas: no se reintentan.
 */
function esReintentable(error) {
  return ['CENTRAL_TIMEOUT', 'CENTRAL_NO_DISPONIBLE', 'RESPUESTA_INVALIDA'].includes(error.codigo) || error.status >= 500;
}

/** Un solo intento HTTP contra la API real. */
async function intentar(url, method, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'TimeoutError') {
      throw new AtmError(504, 'CENTRAL_TIMEOUT', 'El Banco Central no respondió a tiempo. Operación cancelada.', 'central');
    }
    throw new AtmError(502, 'CENTRAL_NO_DISPONIBLE', 'No se pudo conectar con el Banco Central. Operación cancelada.', 'central');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // respuesta vacía o que no es JSON
  }

  if (!res.ok) {
    const codigo = (data && data.codigo) || CODIGO_POR_STATUS[res.status] || 'ERROR_CENTRAL';
    throw new AtmError(
      res.status,
      codigo,
      MENSAJES[codigo] || (data && data.error) || `El Banco Central respondió con error ${res.status}`,
      'central'
    );
  }

  if (data === null) {
    throw new AtmError(502, 'RESPUESTA_INVALIDA', 'El Banco Central envió una respuesta inválida', 'central');
  }
  return data;
}

async function llamar(method, path, { body, idempotencyKey } = {}) {
  const { apiKey, centralUrl } = await config.getConfig();

  if (!apiKey) {
    throw new AtmError(503, 'CAJERO_NO_CONFIGURADO', 'Cajero fuera de servicio: falta configurar la API Key', 'cajero');
  }

  if (usarMock()) {
    try {
      return await mock.request(method, path, { apiKey, body, idempotencyKey });
    } catch (e) {
      throw new AtmError(e.status || 500, e.codigo || 'ERROR_INTERNO', MENSAJES[e.codigo] || e.message, 'central');
    }
  }

  if (!centralUrl) {
    throw new AtmError(503, 'CAJERO_NO_CONFIGURADO', 'Cajero fuera de servicio: falta la URL del Banco Central', 'cajero');
  }

  const url = centralUrl.replace(/\/+$/, '') + path;
  const headers = {
    Accept: 'application/json',
    'X-API-Key': apiKey,
    'ngrok-skip-browser-warning': 'true', // por si el Central se expone con un túnel de ngrok
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  // Las consultas (GET) siempre se pueden repetir; los POST solo si llevan Idempotency-Key.
  const puedeReintentar = method === 'GET' || Boolean(idempotencyKey);
  const maxIntentos = puedeReintentar ? 1 + REINTENTOS : 1;

  let ultimoError;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await intentar(url, method, headers, body); // mismo body y misma key en cada intento
    } catch (error) {
      ultimoError = error;
      if (!esReintentable(error) || intento === maxIntentos) break;
      console.warn(`Central sin respuesta (${error.codigo}); reintento ${intento}/${REINTENTOS} de ${method} ${path}`);
      await espera(ESPERA_ENTRE_INTENTOS_MS * intento);
    }
  }
  throw ultimoError;
}

module.exports = {
  usarMock,
  getNodo: () => llamar('GET', '/api/node/me'),
  getCuenta: (numero) => llamar('GET', `/api/accounts/${encodeURIComponent(numero)}`),
  retirar: (numero, monto, idempotencyKey) =>
    llamar('POST', '/api/withdraw', { body: { numero_cuenta: numero, monto }, idempotencyKey }),
  depositar: (numero, monto, idempotencyKey) =>
    llamar('POST', '/api/deposit', { body: { numero_cuenta: numero, monto }, idempotencyKey }),
};
