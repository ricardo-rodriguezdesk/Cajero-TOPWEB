/**
 * Arranque local: node server.js  (o npm run dev)
 */
require('dotenv').config({ quiet: true });
const app = require('./src/app');
const { pool } = require('./src/db');

const PORT = Number(process.env.PORT || 3000);

async function revisarBaseDeDatos() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠  Falta DATABASE_URL: el cajero no puede operar sin su base de datos.');
    return;
  }
  try {
    const { rows } = await pool.query("select to_regclass('atm_config') as tabla");
    if (!rows[0].tabla) {
      console.warn('⚠  La base de datos no tiene las tablas del cajero. Ejecuta: npm run db:setup');
    } else {
      console.log('Base de datos del cajero: conectada');
    }
  } catch (error) {
    console.warn('⚠  No se pudo conectar a la base de datos del cajero:', error.message);
  }
}

app.listen(PORT, async () => {
  console.log(`Cajero ATM en http://localhost:${PORT}`);
  console.log(`Panel admin en http://localhost:${PORT}/admin`);
  if (String(process.env.USE_MOCK).toLowerCase() === 'true') {
    console.log('Modo SIMULADOR: usa la API Key "atm_demo_key"');
  }
  await revisarBaseDeDatos();
});
