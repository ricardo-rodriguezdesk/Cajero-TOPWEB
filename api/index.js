/**
 * Entrada para Vercel: exporta la app de Express como función serverless.
 * vercel.json redirige aquí todas las rutas que no son archivos estáticos.
 */
module.exports = require('../src/app');
