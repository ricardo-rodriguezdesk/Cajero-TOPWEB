/**
 * Aplicación Express del cajero. No llama a app.listen():
 *   - en local la arranca server.js
 *   - en Vercel la exporta api/index.js como función serverless
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const { AtmError } = require('./errors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) }));
}

app.use('/api', require('./routes/atm'));
app.use('/admin/api', require('./routes/admin'));

// Interfaz (en Vercel estos archivos se sirven como estáticos; esto es para local).
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// Rutas de API que no existen
app.use(['/api', '/admin/api'], (req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada', codigo: 'RUTA_NO_ENCONTRADA', origen: 'cajero' });
});

// Manejo central de errores
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AtmError) {
    return res.status(err.status).json(err.toJSON());
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido', codigo: 'DATOS_INVALIDOS', origen: 'cajero' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del cajero', codigo: 'ERROR_INTERNO', origen: 'cajero' });
});

module.exports = app;
