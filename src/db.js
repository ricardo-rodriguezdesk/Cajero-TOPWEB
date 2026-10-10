/**
 * Conexión a la base de datos PROPIA del cajero (PostgreSQL).
 *
 * Recomendado: un proyecto de Supabase solo para el cajero, separado del Banco Central.
 * En Vercel usa la cadena del "Transaction pooler" (puerto 6543), pensada para serverless.
 */
const { Pool } = require('pg');
const { AtmError } = require('./errors');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 3),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
  // Supabase exige SSL. Para un Postgres local sin SSL: DB_SSL=false
  ssl: String(process.env.DB_SSL).toLowerCase() === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => console.error('Error en la conexión a la base de datos del cajero:', err.message));

function asegurarConfigurada() {
  if (!connectionString) {
    throw new AtmError(503, 'BD_NO_CONFIGURADA', 'Falta configurar DATABASE_URL (base de datos del cajero)');
  }
}

async function query(texto, params) {
  asegurarConfigurada();
  try {
    return await pool.query(texto, params);
  } catch (error) {
    if (error instanceof AtmError) throw error;
    console.error('Error de base de datos:', error.message);
    throw new AtmError(503, 'BD_NO_DISPONIBLE', 'La base de datos del cajero no está disponible');
  }
}

module.exports = { pool, query };
