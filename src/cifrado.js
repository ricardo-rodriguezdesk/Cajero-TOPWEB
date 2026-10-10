/**
 * Cifrado de la API Key antes de guardarla en la base de datos del cajero.
 *
 * El cajero necesita la key original para enviarla al Banco Central, así que no se puede
 * guardar solo un hash: se cifra con AES-256-GCM usando la variable ATM_SECRET.
 * Si alguien lee la tabla, no obtiene la key.
 */
const crypto = require('crypto');
const { AtmError } = require('./errors');

function llave() {
  const secreto = process.env.ATM_SECRET;
  if (!secreto || secreto.length < 16) {
    throw new AtmError(503, 'SECRETO_NO_CONFIGURADO', 'Falta configurar ATM_SECRET (mínimo 16 caracteres)');
  }
  return crypto.createHash('sha256').update(secreto).digest();
}

/** Devuelve "iv.tag.datos" en base64url. */
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', llave(), iv);
  const datos = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), datos].map((b) => b.toString('base64url')).join('.');
}

function descifrar(paquete) {
  try {
    const [iv, tag, datos] = paquete.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', llave(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(datos), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof AtmError) throw error;
    throw new AtmError(503, 'API_KEY_ILEGIBLE', 'No se pudo leer la API Key guardada (¿cambió ATM_SECRET?). Captúrala de nuevo.');
  }
}

module.exports = { cifrar, descifrar };
