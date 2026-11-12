import { Pool } from 'pg';

export const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'collector',
  password: process.env.PGPASSWORD || 'collector',
  database: process.env.PGDATABASE || 'collector',
  max: 10,
});

export async function q<T = any>(text: string, params?: any[]): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}
export async function one<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
