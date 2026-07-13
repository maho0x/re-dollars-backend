import { pool } from '../db/pool.js';
import { ApiError } from '../utils/http.js';
import type { WsHub } from '../ws/hub.js';
import { assertAdminConfiguredForDebug } from './adminService.js';
import { sendPushToUser } from './pushService.js';

export async function testNotification(body: unknown, hub: WsHub) {
  assertAdminConfiguredForDebug(body);
  const input = body as { target_uid?: string | number; content?: string; type?: 'mention' | 'reply' };
  const targetUid = Number(input.target_uid);
  if (!Number.isSafeInteger(targetUid) || targetUid <= 0) throw new ApiError(400, 'target_uid is required');
  const type = input.type === 'reply' ? 'reply' : 'mention';
  const content = String(input.content ?? 'Test').trim() || 'Test';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const messageResult = await client.query(
      `INSERT INTO messages (bangumi_id, uid, nickname, avatar, message, "timestamp")
       VALUES ($1, 560875, 'Black娘', '//lain.bgm.tv/pic/user/c/000/56/08/560875_3oimd.jpg', $2, $3)
       RETURNING *`,
      [String(-Date.now()), content, Math.floor(Date.now() / 1000)],
    );
    const message = messageResult.rows[0];
    const notificationResult = await client.query(
      `INSERT INTO notifications (user_id, sender_id, message_id, type)
       VALUES ($1, 560875, $2, $3)
       RETURNING id`,
      [targetUid, message.id, type],
    );
    await client.query('COMMIT');

    const payload = {
      id: Number(notificationResult.rows[0].id),
      message_id: Number(message.id),
      uid: String(message.uid),
      nickname: message.nickname,
      avatar: message.avatar,
      content: message.message,
      timestamp: Number(message.timestamp),
      type,
    };
    hub.sendToUser(String(targetUid), { type: 'notification', payload });
    void sendPushToUser(targetUid, payload);

    return { status: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
