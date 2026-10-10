/**
 * Error de negocio del cajero.
 *
 * `origen` indica quién rechazó la operación:
 *   - 'cajero'  → regla local (operación descentralizada)
 *   - 'central' → regla del Banco Central (consolidación centralizada)
 * La interfaz lo muestra para que se vea qué nodo tomó la decisión.
 */
class AtmError extends Error {
  constructor(status, codigo, mensaje, origen = 'cajero') {
    super(mensaje);
    this.name = 'AtmError';
    this.status = status;
    this.codigo = codigo;
    this.origen = origen;
  }

  toJSON() {
    return { error: this.message, codigo: this.codigo, origen: this.origen };
  }
}

module.exports = { AtmError };
