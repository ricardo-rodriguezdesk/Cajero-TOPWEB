/**
 * Protección del panel administrativo.
 *
 * El login compara la contraseña con ADMIN_PASSWORD y entrega una cookie firmada (HMAC)
 * que vence en 8 horas. No necesita guardar sesiones, por eso funciona en Vercel.
 */
const crypto = require('crypto');
const { AtmError } = require('../errors');

const COOKIE = 'atm_admin';
const DURACION_MS = 8 * 60 * 60 * 1000;

function secreto() {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    throw new AtmError(503, 'ADMIN_NO_CONFIGURADO', 'Falta configurar la variable ADMIN_PASSWORD en el servidor');
  }
  return (process.env.ATM_SECRET || '') + '|' + pass;
}

const firmar = (texto) => crypto.createHmac('sha256', secreto()).update(texto).digest('hex');

function iguales(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function leerCookie(req, nombre) {
  const header = req.headers.cookie || '';
  for (const parte of header.split(';')) {
    const [clave, ...resto] = parte.trim().split('=');
    if (clave === nombre) return decodeURIComponent(resto.join('='));
  }
  return null;
}

function opcionesCookie(maxAgeSeg) {
  const seguro = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeg}${seguro}`;
}

function login(req, res) {
  secreto(); // lanza un error claro si ADMIN_PASSWORD no está configurada
  const password = req.body?.password;
  if (typeof password !== 'string' || !iguales(password, process.env.ADMIN_PASSWORD)) {
    throw new AtmError(401, 'CREDENCIALES_INVALIDAS', 'Contraseña incorrecta');
  }
  const vence = String(Date.now() + DURACION_MS);
  const token = `${vence}.${firmar(vence)}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${opcionesCookie(DURACION_MS / 1000)}`);
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${opcionesCookie(0)}`);
  res.json({ ok: true });
}

function requireAdmin(req, res, next) {
  const token = leerCookie(req, COOKIE);
  const [vence, firma] = (token || '').split('.');
  if (!vence || !firma || !iguales(firma, firmar(vence)) || Number(vence) < Date.now()) {
    throw new AtmError(401, 'SESION_INVALIDA', 'Inicia sesión en el panel administrativo');
  }
  next();
}

module.exports = { login, logout, requireAdmin };
