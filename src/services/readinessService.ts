import type { Pool } from 'pg';
import { config } from '../config/env.js';
import { pool, searchPool } from '../db/pool.js';

const REQUIRED_TABLES = [
  'messages',
  'notifications',
  'message_reactions',
  'user_read_state',
  'auth_tokens',
  'user_favorites',
  'image_metadata',
  'video_metadata',
  'video_processing_queue',
  'scheduled_reminders',
  'link_previews',
  'user_lookup_cache',
  'user_profiles',
  'global_blocklist',
  'bot_blocklist',
  'user_memories',
  'bot_replied_posts',
  'scraper_state',
] as const;

const SEARCH_TABLES = ['users'] as const;

interface ConnectionCheck {
  ok: boolean;
  error?: string;
}

interface TableFailure {
  table: string;
  error: string;
}

interface TableCheck {
  ok: boolean;
  required: string[];
  missing: string[];
  inaccessible: TableFailure[];
}

interface SearchDbCheck extends TableCheck {
  configured: boolean;
  skipped?: boolean;
  connection?: ConnectionCheck;
}

export interface ReadinessResult {
  status: boolean;
  ready: boolean;
  name: 're-dollars-backend-next';
  checks: {
    db: ConnectionCheck;
    tables: TableCheck;
    searchDb: SearchDbCheck;
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function quoteIdentifier(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function checkConnection(dbPool: Pool): Promise<ConnectionCheck> {
  try {
    await dbPool.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function checkTables(dbPool: Pool, tables: readonly string[]): Promise<TableCheck> {
  const required = [...tables];
  const missing: string[] = [];
  const inaccessible: TableFailure[] = [];

  await Promise.all(tables.map(async (table) => {
    try {
      await dbPool.query(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`);
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') {
        missing.push(table);
        return;
      }
      inaccessible.push({ table, error: errorMessage(error) });
    }
  }));

  missing.sort();
  inaccessible.sort((a, b) => a.table.localeCompare(b.table));

  return {
    ok: missing.length === 0 && inaccessible.length === 0,
    required,
    missing,
    inaccessible,
  };
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const [db, tables] = await Promise.all([
    checkConnection(pool),
    checkTables(pool, REQUIRED_TABLES),
  ]);

  let searchDb: SearchDbCheck;
  if (config.searchDb) {
    const [connection, searchTables] = await Promise.all([
      checkConnection(searchPool),
      checkTables(searchPool, SEARCH_TABLES),
    ]);
    searchDb = {
      configured: true,
      connection,
      ...searchTables,
      ok: connection.ok && searchTables.ok,
    };
  } else {
    searchDb = {
      configured: false,
      skipped: true,
      ok: true,
      required: [...SEARCH_TABLES],
      missing: [],
      inaccessible: [],
    };
  }

  const ready = db.ok && tables.ok && searchDb.ok;

  return {
    status: ready,
    ready,
    name: 're-dollars-backend-next',
    checks: {
      db,
      tables,
      searchDb,
    },
  };
}
