/**
 * Reglas de negocio que decide el CAJERO (operación descentralizada).
 *
 *   RN1  Sin API Key configurada, el cajero está fuera de servicio.
 *   RN4  El monto debe ser mayor que 0.
 *   RN6  El cajero debe tener efectivo físico suficiente ANTES de llamar al Central.
 *   Extra: monto múltiplo de ATM_MULTIPLO y con un máximo por operación.
 *
 * RN2 (cuenta activa), RN3 (saldo nunca negativo) y RN5 (saldo suficiente) NO se validan aquí:
 * las valida el Banco Central y el cajero solo muestra su respuesta (delegación).
 */
const config = require('./config');
const { AtmError } = require('../errors');

const MULTIPLO = Number(process.env.ATM_MULTIPLO || 50);
const MAX_RETIRO = Number(process.env.ATM_MAX_RETIRO || 10000);
const MAX_DEPOSITO = Number(process.env.ATM_MAX_DEPOSITO || 20000);

const pesos = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** RN1: el cajero debe estar configurado y sincronizado para operar. */
async function verificarEnServicio() {
  const estado = await config.getEstado();
  if (!estado.tieneApiKey) {
    throw new AtmError(503, 'CAJERO_NO_CONFIGURADO', 'Cajero fuera de servicio');
  }
  if (estado.efectivo === null) {
    throw new AtmError(503, 'CAJERO_NO_SINCRONIZADO', 'Cajero fuera de servicio: falta sincronizar el efectivo');
  }
  return estado.efectivo;
}

function validarCuenta(numero) {
  const limpio = String(numero ?? '').trim();
  if (!/^[A-Za-z0-9-]{1,30}$/.test(limpio)) {
    throw new AtmError(400, 'DATOS_INVALIDOS', 'Número de cuenta inválido');
  }
  return limpio;
}

/** RN4 + reglas extra del cajero. Devuelve el monto como número. */
function validarMonto(valor, tipo) {
  const monto = typeof valor === 'string' ? Number(valor) : valor;
  if (typeof monto !== 'number' || !Number.isFinite(monto)) {
    throw new AtmError(400, 'DATOS_INVALIDOS', 'El monto debe ser un número');
  }
  if (monto <= 0) {
    throw new AtmError(422, 'MONTO_INVALIDO', 'El monto debe ser mayor a 0');
  }
  if (monto % MULTIPLO !== 0) {
    throw new AtmError(422, 'MONTO_NO_MULTIPLO', `El cajero solo maneja billetes: el monto debe ser múltiplo de ${pesos(MULTIPLO)}`);
  }
  const maximo = tipo === 'retiro' ? MAX_RETIRO : MAX_DEPOSITO;
  if (monto > maximo) {
    throw new AtmError(422, 'MONTO_EXCEDE_LIMITE', `El monto máximo por ${tipo} es ${pesos(maximo)}`);
  }
  return monto;
}

/**
 * RN6: el efectivo del cajero debe alcanzar. Se valida en la base de datos del cajero,
 * sin consultar al Central, y de forma atómica: si alcanza, el monto queda apartado.
 */
async function reservarEfectivo(monto) {
  const restante = await config.reservarEfectivo(monto);
  if (restante === null) {
    throw new AtmError(422, 'CAJERO_SIN_EFECTIVO', 'Este cajero no tiene efectivo suficiente para ese monto');
  }
  return restante;
}

module.exports = {
  verificarEnServicio,
  validarCuenta,
  validarMonto,
  reservarEfectivo,
  pesos,
  limites: { MULTIPLO, MAX_RETIRO, MAX_DEPOSITO },
};
