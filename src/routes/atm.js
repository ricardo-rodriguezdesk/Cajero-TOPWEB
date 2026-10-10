/**
 * Endpoints públicos del cajero (los usa la interfaz del cliente).
 * Cada consulta, retiro y depósito queda registrado en la bitácora del cajero (atm_operaciones).
 */
const express = require('express');
const config = require('../services/config');
const central = require('../services/central');
const rules = require('../services/rules');
const operaciones = require('../services/operaciones');

const router = express.Router();

/** Estado del cajero, para que la interfaz sepa si mostrar "Fuera de servicio". */
router.get('/status', async (req, res) => {
  let estado = null;
  try {
    estado = await config.getEstado();
  } catch {
    // sin base de datos el cajero no puede operar
  }
  res.json({
    en_servicio: Boolean(estado && estado.tieneApiKey && estado.efectivo !== null),
    nombre: estado?.nodo?.nombre || null,
    modo: central.usarMock() ? 'simulador' : 'real',
    limites: rules.limites,
  });
});

/** Consulta de saldo: la responde el Banco Central; el cajero solo registra que hubo consulta. */
router.get('/balance/:cuenta', async (req, res) => {
  await rules.verificarEnServicio();
  const numero = rules.validarCuenta(req.params.cuenta);

  const { cuenta } = await operaciones.registrar('consulta', numero, null, async () => ({
    cuenta: await central.getCuenta(numero),
  }));

  res.json({
    numero_cuenta: cuenta.numero_cuenta,
    titular: cuenta.titular,
    saldo: cuenta.saldo,
    estado: cuenta.estado,
  });
});

/**
 * Retiro. El orden importa:
 *   1. RN1  ¿Cajero en servicio?
 *   2. RN4  ¿Monto válido?
 *   3. RN6  ¿Alcanza el efectivo del cajero? Se aparta en SU base de datos (sin llamar al Central).
 *   4.      El Central valida cuenta y saldo, descuenta y registra la transacción oficial.
 *   5. RN7  Si el Central rechaza o no responde, el efectivo apartado se devuelve.
 *           Si aprueba, el cajero toma el efectivo oficial que reporta el Central.
 */
router.post('/withdraw', async (req, res) => {
  await rules.verificarEnServicio();
  const numero = rules.validarCuenta(req.body?.numero_cuenta);

  const r = await operaciones.registrar('retiro', numero, req.body?.monto, async (idempotencyKey) => {
    const monto = rules.validarMonto(req.body?.monto, 'retiro');
    await rules.reservarEfectivo(monto);

    let resultado;
    try {
      resultado = await central.retirar(numero, monto, idempotencyKey);
    } catch (error) {
      await config.liberarEfectivo(monto); // RN7: no se entregó dinero
      if (error.codigo === 'EFECTIVO_NODO_INSUFICIENTE') await resincronizar();
      throw error;
    }

    await config.setEfectivo(resultado.efectivo_nodo);
    return { monto, resultado, transaccionId: resultado.transaccion.id, efectivo: resultado.efectivo_nodo };
  });

  res.json(respuesta(r, `Retire su efectivo: ${rules.pesos(r.monto)}`));
});

/** Depósito: el Central valida la cuenta; si aprueba, sube el efectivo del cajero. */
router.post('/deposit', async (req, res) => {
  await rules.verificarEnServicio();
  const numero = rules.validarCuenta(req.body?.numero_cuenta);

  const r = await operaciones.registrar('deposito', numero, req.body?.monto, async (idempotencyKey) => {
    const monto = rules.validarMonto(req.body?.monto, 'deposito');
    const resultado = await central.depositar(numero, monto, idempotencyKey);
    await config.setEfectivo(resultado.efectivo_nodo);
    return { monto, resultado, transaccionId: resultado.transaccion.id, efectivo: resultado.efectivo_nodo };
  });

  res.json(respuesta(r, `Depósito recibido: ${rules.pesos(r.monto)}`));
});

function respuesta({ monto, resultado, operacionId }, mensaje) {
  return {
    mensaje,
    monto,
    saldo_nuevo: resultado.saldo_nuevo,
    operacion_local: operacionId,
    transaccion: {
      id: resultado.transaccion.id,
      tipo: resultado.transaccion.tipo,
      fecha: resultado.transaccion.created_at,
    },
  };
}

/** Si el Central dice que el efectivo no alcanza, gana el Central: se copia su valor. */
async function resincronizar() {
  try {
    const nodo = await central.getNodo();
    const anterior = await config.sincronizar(nodo);
    await config.registrarEvento('sincronizacion', {
      motivo: 'El Central reportó efectivo insuficiente',
      efectivo_local: anterior,
      efectivo_central: nodo.efectivo_disponible,
    });
  } catch {
    // se conserva la copia local; el admin puede sincronizar manualmente
  }
}

module.exports = router;
