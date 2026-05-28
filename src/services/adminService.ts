import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { ApiError } from '../utils/http.js';

type BlocklistKind = 'global' | 'bot';

const tableByKind: Record<BlocklistKind, string> = {
  global: 'global_blocklist',
  bot: 'bot_blocklist',
};

function requireAdmin(body: unknown) {
  if (!config.adminPassword) throw new ApiError(501, 'Admin API is not configured');
  const password = String((body as { admin_password?: string }).admin_password ?? '');
  if (password !== config.adminPassword) throw new ApiError(403, 'Forbidden');
}

function parseUserId(value: unknown) {
  const userId = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new ApiError(400, 'Invalid user ID format');
  return userId;
}

export async function getBlocklist(kind: BlocklistKind) {
  const table = tableByKind[kind];
  const { rows } = await pool.query(`SELECT user_id FROM ${table} ORDER BY user_id ASC`);
  return { status: true, blocklist: rows.map((row) => String(row.user_id)) };
}

export async function addBlock(kind: BlocklistKind, body: unknown) {
  requireAdmin(body);
  const input = body as { user_id_to_block?: unknown };
  const userId = parseUserId(input.user_id_to_block);
  const table = tableByKind[kind];
  await pool.query(`INSERT INTO ${table} (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  return { success: true, message: `User ${userId} has been added to the ${kind} blocklist.` };
}

export async function removeBlock(kind: BlocklistKind, body: unknown) {
  requireAdmin(body);
  const input = body as { user_id_to_unblock?: unknown };
  const userId = parseUserId(input.user_id_to_unblock);
  const table = tableByKind[kind];
  const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  return {
    success: Boolean(rowCount),
    message: rowCount
      ? `User ${userId} has been removed from the ${kind} blocklist.`
      : 'User is not in the blocklist.',
  };
}

export function assertAdminConfiguredForDebug(body: unknown) {
  requireAdmin(body);
}
