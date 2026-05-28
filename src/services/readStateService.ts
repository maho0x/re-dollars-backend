import { pool } from '../db/pool.js';
import { ApiError } from '../utils/http.js';
import type { WsHub } from '../ws/hub.js';

export async function getReadState(url: URL) {
  const userId = Number(url.searchParams.get('user_id'));
  const channelId = url.searchParams.get('channel_id') ?? 'global';
  if (!Number.isFinite(userId)) throw new ApiError(400, 'Invalid or missing user_id');

  const { rows } = await pool.query(
    'SELECT last_read_id, last_updated_at FROM user_read_state WHERE user_id = $1 AND channel_id = $2',
    [userId, channelId],
  );

  if (!rows[0]) return { status: true, last_read_id: 0 };
  return { status: true, last_read_id: Number(rows[0].last_read_id), last_updated_at: rows[0].last_updated_at };
}

export async function updateReadState(body: unknown, hub: WsHub) {
  const input = body as { user_id?: number; last_read_id?: number; channel_id?: string };
  const userId = Number(input.user_id);
  const lastReadId = Number(input.last_read_id);
  const channelId = input.channel_id ?? 'global';
  if (!Number.isFinite(userId)) throw new ApiError(400, 'Invalid or missing user_id');
  if (!Number.isFinite(lastReadId) || lastReadId < 0) throw new ApiError(400, 'Invalid last_read_id');

  const { rows } = await pool.query(
    `INSERT INTO user_read_state (user_id, channel_id, last_read_id, last_updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, channel_id)
     DO UPDATE SET
       last_read_id = GREATEST(user_read_state.last_read_id, EXCLUDED.last_read_id),
       last_updated_at = NOW()
     RETURNING last_read_id`,
    [userId, channelId, lastReadId],
  );
  const effective = Number(rows[0]?.last_read_id ?? lastReadId);
  hub.sendToUser(String(userId), { type: 'read_state_update', payload: { user_id: userId, last_read_id: effective } });
  return { status: true, effective_last_read_id: effective };
}
