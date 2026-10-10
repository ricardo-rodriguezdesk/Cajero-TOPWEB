/**
 * Simulador del Banco Central (se activa con USE_MOCK=true).
 *
 * Responde exactamente como dice contrato-central-atm.yaml, para poder desarrollar el cajero
 * sin esperar a la API real de la Persona 1. Los datos viven en memoria y se reinician
 * cuando se reinicia el servidor.
 *
 * API Key válida del simulador: atm_demo_key
 *
 * Cuentas de prueba:
 *   1000000001  Juan Pérez     $1,000   activa      ← la de la demo (retiro de $300 → $700)
 *   1000000002  María García   $5,000   bloqueada   ← para probar CUENTA_BLOQUEADA
 *   1000000003  Pedro Ruiz     $50,000  activa      ← para probar que el cajero se quede sin efectivo
 */

const MOCK_API_KEY = 'atm_demo_key';

const estado = {
  nodo: {
    id: 7,
    nombre: 'Cajero Demo (simulado)',
    tipo: 'cajero',
    estado: 'activo',
    responsable: 'Equipo 4',
    efectivo_disponible: 10000,
  },
  cuentas: {
    '1000000001': { numero_cuenta: '1000000001', titular: 'Juan Pérez', saldo: 1000, estado: 'activa' },
    '1000000002': { numero_cuenta: '1000000002', titular: 'María García', saldo: 5000, estado: 'bloqueada' },
    '1000000003': { numero_cuenta: '1000000003', titular: 'Pedro Ruiz', saldo: 50000, estado: 'activa' },
  },
  transacciones: [],
  siguienteId: 151,
  idempotencia: new Map(),
};

function falla(status, codigo, error) {
  const e = new Error(error);
  e.status = status;
  e.codigo = codigo;
  throw e;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const redondear = (n) => Math.round(n * 100) / 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reglas de Idempotency-Key (iguales a las del Central real):
 *  - Debe ser un UUID; si no, 400 DATOS_INVALIDOS.
 *  - Misma key + mismo cuerpo → se devuelve la respuesta original sin cobrar de nuevo.
 *  - Misma key con otra cuenta, monto o tipo → 422 IDEMPOTENCY_CONFLICT.
 *  - Si la operación falla, la key no se guarda (se puede reintentar con la misma).
 */
function operar(tipo, body, idempotencyKey) {
  const { numero_cuenta: numero, monto } = body || {};

  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (!UUID.test(String(idempotencyKey))) {
      falla(400, 'DATOS_INVALIDOS', 'Idempotency-Key debe ser un UUID válido');
    }
    const previa = estado.idempotencia.get(idempotencyKey);
    if (previa) {
      if (previa.tipo !== tipo || previa.numero !== numero || previa.monto !== monto) {
        falla(422, 'IDEMPOTENCY_CONFLICT', 'La Idempotency-Key ya se usó con otra operación');
      }
      return previa.respuesta;
    }
  }
  if (typeof numero !== 'string' || typeof monto !== 'number') {
    falla(400, 'DATOS_INVALIDOS', 'Los campos numero_cuenta (texto) y monto (número) son obligatorios');
  }
  if (!(monto > 0)) falla(422, 'MONTO_INVALIDO', 'El monto debe ser mayor a 0');

  const cuenta = estado.cuentas[numero];
  if (!cuenta) falla(404, 'CUENTA_NO_ENCONTRADA', 'La cuenta no existe');
  if (cuenta.estado !== 'activa') falla(422, 'CUENTA_BLOQUEADA', 'La cuenta está bloqueada');

  const nodo = estado.nodo;
  if (tipo === 'retiro') {
    if (cuenta.saldo < monto) falla(422, 'FONDOS_INSUFICIENTES', 'Fondos insuficientes');
    if (nodo.efectivo_disponible < monto) {
      falla(422, 'EFECTIVO_NODO_INSUFICIENTE', 'El cajero no tiene efectivo suficiente');
    }
    cuenta.saldo = redondear(cuenta.saldo - monto);
    nodo.efectivo_disponible = redondear(nodo.efectivo_disponible - monto);
  } else {
    cuenta.saldo = redondear(cuenta.saldo + monto);
    nodo.efectivo_disponible = redondear(nodo.efectivo_disponible + monto);
  }

  const transaccion = {
    id: estado.siguienteId++,
    tipo,
    numero_cuenta: numero,
    monto,
    node_id: nodo.id,
    created_at: new Date().toISOString(),
  };
  estado.transacciones.push(transaccion);

  const respuesta = { transaccion, saldo_nuevo: cuenta.saldo, efectivo_nodo: nodo.efectivo_disponible };
  if (idempotencyKey) estado.idempotencia.set(idempotencyKey, { tipo, numero, monto, respuesta });
  return respuesta;
}

/**
 * Atiende una petición como lo haría la API core del Banco Central.
 * Devuelve el body de la respuesta o lanza un error con { status, codigo, message }.
 */
async function request(method, path, { apiKey, body, idempotencyKey } = {}) {
  await espera(250); // simula la latencia de red

  if (apiKey !== MOCK_API_KEY) falla(401, 'API_KEY_INVALIDA', 'API Key inválida');
  if (estado.nodo.estado !== 'activo') falla(403, 'NODO_INACTIVO', 'El cajero está desactivado');

  if (method === 'GET' && path === '/api/node/me') {
    return { ...estado.nodo };
  }

  const cuentaMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (method === 'GET' && cuentaMatch) {
    const cuenta = estado.cuentas[decodeURIComponent(cuentaMatch[1])];
    if (!cuenta) falla(404, 'CUENTA_NO_ENCONTRADA', 'La cuenta no existe');
    return { ...cuenta };
  }

  if (method === 'POST' && path === '/api/withdraw') return operar('retiro', body, idempotencyKey);
  if (method === 'POST' && path === '/api/deposit') return operar('deposito', body, idempotencyKey);

  falla(404, 'RUTA_NO_ENCONTRADA', `Ruta no encontrada en el simulador: ${method} ${path}`);
}

module.exports = { request, MOCK_API_KEY };
