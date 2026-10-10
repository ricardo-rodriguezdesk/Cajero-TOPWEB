/**
 * Crea (o actualiza) las tablas del cajero en su base de datos.
 * Uso: npm run db:setup   (lee DATABASE_URL del archivo .env)
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    const { rows } = await pool.query(
      "select table_name from information_schema.tables where table_name like 'atm_%' order by 1"
    );
    console.log('Base de datos del cajero lista. Tablas:', rows.map((r) => r.table_name).join(', '));
  } catch (error) {
    console.error('No se pudo crear el esquema:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
