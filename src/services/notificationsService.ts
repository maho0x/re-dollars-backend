import { pool } from '../db/pool.js';
import { ApiError } from '../utils/http.js';

export async function listNotifications(url: URL) {
  const uid = Number(url.searchParams.get('uid'));
  if (!Number.isFinite(uid)) throw new ApiError(400, 'uid is required');
  const { rows } = await pool.query(
    `SELECT n.id, n.type, n.is_read, n.created_at, m.id as mid, m.uid as muid, m.nickname, m.avatar, m.message
     FROM notifications n
     JOIN messages m ON n.message_id = m.id
     WHERE n.user_id = $1 AND n.is_read = FALSE
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [uid],
  );

  return {
    status: true,
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.type,
      timestamp: Math.floor(new Date(row.created_at).getTime() / 1000),
      message_id: row.mid,
      message: {
        id: String(row.mid),
        uid: String(row.muid),
        nickname: row.nickname,
        avatar: row.avatar,
        content: row.message,
      },
    })),
  };
}

export async function markNotificationRead(id: number, body: unknown) {
  const uid = Number((body as { uid?: string | number }).uid);
  if (!Number.isFinite(id) || !Number.isFinite(uid)) throw new ApiError(400, 'id and uid are required');
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [id, uid]);
  return { status: true };
}

export async function markAllNotificationsRead(body: unknown) {
  const uid = Number((body as { uid?: string | number }).uid);
  if (!Number.isFinite(uid)) throw new ApiError(400, 'uid is required');
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [uid]);
  return { status: true };
}

export async function getLatestNotificationId() {
  const { rows } = await pool.query('SELECT id FROM notifications ORDER BY id DESC LIMIT 1');
  return Number(rows[0]?.id ?? 0);
}

export async function getNotificationsAfter(id: number, limit: number) {
  const { rows } = await pool.query(
    `SELECT n.id, n.user_id, n.type, n.created_at, m.id as message_id, m.uid, m.nickname, m.avatar, m.message
     FROM notifications n
     JOIN messages m ON n.message_id = m.id
     WHERE n.id > $1
     ORDER BY n.id ASC
     LIMIT $2`,
    [id, limit],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    user_id: String(row.user_id),
    payload: {
      id: Number(row.id),
      message_id: Number(row.message_id),
      uid: String(row.uid),
      nickname: row.nickname,
      avatar: row.avatar,
      content: row.message,
      timestamp: Math.floor(new Date(row.created_at).getTime() / 1000),
      type: row.type,
    },
  }));
}
