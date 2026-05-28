import { config } from '../config/env.js';
import { getLatestMessageId, getMessagesAfter } from './messagesApi.js';
import { getLatestNotificationId, getNotificationsAfter } from './notificationsService.js';
import type { WsHub } from '../ws/hub.js';

export class DbTailer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMessageId = 0;
  private lastNotificationId = 0;
  private running = false;

  constructor(private readonly hub: WsHub) {}

  async start() {
    if (!config.tailer.enabled || this.timer) return;
    this.lastMessageId = await getLatestMessageId();
    this.lastNotificationId = await getLatestNotificationId();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.tailer.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  markSeenMessageId(id: number) {
    if (id > this.lastMessageId) this.lastMessageId = id;
  }

  markSeenNotificationId(id: number) {
    if (id > this.lastNotificationId) this.lastNotificationId = id;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const messages = await getMessagesAfter(this.lastMessageId, config.tailer.batchSize);
      if (messages.length > 0) {
        this.lastMessageId = Math.max(...messages.map((message) => message.id));
        this.hub.broadcastNewMessages(messages);
      }

      const notifications = await getNotificationsAfter(this.lastNotificationId, config.tailer.batchSize);
      if (notifications.length > 0) {
        this.lastNotificationId = Math.max(...notifications.map((notification) => notification.id));
        for (const notification of notifications) {
          this.hub.sendToUser(notification.user_id, { type: 'notification', payload: notification.payload });
        }
      }
    } catch (err) {
      console.warn('[tailer] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}
