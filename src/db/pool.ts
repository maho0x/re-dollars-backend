import pg from 'pg';
import { config } from '../config/env.js';

export const pool = new pg.Pool(config.db);
export const searchPool = new pg.Pool(config.searchDb ?? config.db);

export async function closePools() {
  await Promise.all([pool.end(), searchPool.end()]);
}
