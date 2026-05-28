import { pool } from '../db/pool.js';
import { ApiError } from '../utils/http.js';

export async function getFavorites(url: URL) {
  const uid = Number(url.searchParams.get('uid'));
  if (!Number.isFinite(uid)) throw new ApiError(400, 'uid is required');
  const { rows } = await pool.query('SELECT image_url FROM user_favorites WHERE user_id = $1 ORDER BY created_at DESC', [uid]);
  return { status: true, data: rows.map((row) => row.image_url) };
}

export async function addFavorite(body: unknown) {
  const input = body as { user_id?: number | string; image_url?: string };
  const userId = Number(input.user_id);
  const imageUrl = String(input.image_url ?? '').trim();
  if (!Number.isFinite(userId) || !imageUrl) throw new ApiError(400, 'user_id and image_url are required');
  await pool.query('INSERT INTO user_favorites (user_id, image_url) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, imageUrl]);
  return { status: true };
}

export async function removeFavorite(body: unknown) {
  const input = body as { user_id?: number | string; image_url?: string };
  const userId = Number(input.user_id);
  const imageUrl = String(input.image_url ?? '').trim();
  if (!Number.isFinite(userId) || !imageUrl) throw new ApiError(400, 'user_id and image_url are required');
  await pool.query('DELETE FROM user_favorites WHERE user_id = $1 AND image_url = $2', [userId, imageUrl]);
  return { status: true };
}

export async function syncFavorites(body: unknown) {
  const input = body as { uid?: number | string; data?: string[] };
  const uid = Number(input.uid);
  if (!Number.isFinite(uid) || !Array.isArray(input.data)) throw new ApiError(400, 'uid and data are required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_favorites WHERE user_id = $1', [uid]);
    for (const url of input.data) {
      await client.query('INSERT INTO user_favorites (user_id, image_url) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, url]);
    }
    await client.query('COMMIT');
    return { status: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
