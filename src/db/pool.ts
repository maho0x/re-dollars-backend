import { Pool } from 'pg';
import { config } from '../config/env.js';

export const pool = new Pool(config.db);

export const searchPool = new Pool(config.searchDb);

// Helper to get a client from the pool (useful for transactions)
export const getClient = async () => {
    const client = await pool.connect();
    return client;
};
