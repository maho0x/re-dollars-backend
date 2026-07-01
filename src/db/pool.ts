import pg from 'pg';
import { config } from '../config/env.js';

export const pool = new pg.Pool(config.db);
export const searchPool = new pg.Pool(config.searchDb ?? config.db);

// pg.Pool emits 'error' for idle clients that drop (e.g. DB restart, 57P03
// "starting up"). Without a listener these become uncaught exceptions that
// crash the process; the pool recovers on its own, so just log and continue.
pool.on('error', (err) => console.warn('[db] idle client error:', err.message));
searchPool.on('error', (err) => console.warn('[db:search] idle client error:', err.message));

export async function closePools() {
  await Promise.all([pool.end(), searchPool.end()]);
}
