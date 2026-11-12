import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({ ...env.pg, max: 8 });

export async function q<T = any>(text: string, params?: any[]): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}
export async function one<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
