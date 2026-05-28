import type { EnrichedMessage } from '../types.js';

export type SocketData = {
  uid: string | null;
  name?: string;
  nickname?: string;
  avatar?: string;
  open: boolean;
  sharePresence: boolean;
  subscriptions: Set<string>;
};

export type ClientWebSocket = Bun.ServerWebSocket<SocketData>;

export interface PendingMessageSignal {
  uid: string | null;
  tempId?: string;
  content?: string;
}

export interface SyntheticPresenceInput {
  uid: number | string;
  active: boolean;
  name?: string;
  nickname?: string;
  avatar?: string;
  ttlMs?: number;
}

export interface SyntheticTypingInput {
  uid: number | string;
  typing: boolean;
  name?: string;
  nickname?: string;
  avatar?: string;
}

export interface WsHubOptions {
  onPendingMessage?: (message: PendingMessageSignal) => void;
}

type HubEventListener = (payload: unknown) => void;

interface TrackedPendingMessage {
  tempId: string;
  contentHash: string;
  createdAt: number;
}

interface SyntheticPresence {
  name?: string;
  nickname?: string;
  avatar?: string;
  expiresAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export const MESSAGE_CONFIRM_WINDOW_MS = 10_000;

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(input: string) {
  return input.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z\d]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x')) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (key.startsWith('#')) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return HTML_ENTITY_MAP[key] ?? match;
  });
}

export function normalizeMessageForMatch(input: unknown): string {
  return decodeHtmlEntities(String(input ?? ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashContent(content: string): string {
  const normalized = normalizeMessageForMatch(content);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(36);
}

function publicUser(input: { id: string; name?: string; nickname?: string; avatar?: string }) {
  const displayName = input.name || input.nickname || input.id;
  return {
    id: input.id,
    name: displayName,
    nickname: input.nickname || displayName,
    ...(input.avatar ? { avatar: input.avatar } : {}),
  };
}

export class WsHub {
  private readonly clients = new Set<ClientWebSocket>();
  private readonly users = new Map<string, Set<ClientWebSocket>>();
  private readonly pendingMessages = new Map<string, TrackedPendingMessage[]>();
  private readonly syntheticUsers = new Map<string, SyntheticPresence>();
  private readonly eventListeners = new Set<HubEventListener>();

  constructor(private readonly options: WsHubOptions = {}) {}

  add(ws: ClientWebSocket) {
    this.clients.add(ws);
  }

  remove(ws: ClientWebSocket) {
    this.clients.delete(ws);
    if (ws.data.uid) {
      const sockets = this.users.get(ws.data.uid);
      sockets?.delete(ws);
      if (sockets?.size === 0) this.users.delete(ws.data.uid);
      this.broadcastPresence(ws.data.uid);
    } else {
      this.broadcastOnlineCount();
    }
  }

  identify(ws: ClientWebSocket, uid: string) {
    const previousUid = ws.data.uid;
    const wasSharingPresence = ws.data.sharePresence;
    if (previousUid && previousUid !== uid) {
      const previousSockets = this.users.get(previousUid);
      previousSockets?.delete(ws);
      if (previousSockets?.size === 0) this.users.delete(previousUid);
      ws.data.sharePresence = false;
      if (wasSharingPresence) this.broadcastPresence(previousUid);
    }
    ws.data.uid = uid;
    const sockets = this.users.get(uid) ?? new Set<ClientWebSocket>();
    sockets.add(ws);
    this.users.set(uid, sockets);
    this.broadcastOnlineCount();
  }

  join(ws: ClientWebSocket, user: { id?: string; name?: string; nickname?: string; avatar?: string }) {
    if (user.id) this.identify(ws, String(user.id));
    const displayName = user.name ?? user.nickname;
    if (displayName != null) {
      ws.data.name = displayName;
      ws.data.nickname = user.nickname ?? displayName;
    } else {
      delete ws.data.name;
      delete ws.data.nickname;
    }
    if (user.avatar != null) {
      ws.data.avatar = user.avatar;
    } else {
      delete ws.data.avatar;
    }
    ws.data.sharePresence = true;
    if (ws.data.uid) this.broadcastPresence(ws.data.uid);
  }

  setOpen(ws: ClientWebSocket, open: boolean) {
    ws.data.open = open;
  }

  subscribe(ws: ClientWebSocket, uids: string[]) {
    for (const uid of uids) ws.data.subscriptions.add(String(uid));
  }

  unsubscribe(ws: ClientWebSocket, uids?: string[]) {
    if (!uids) {
      ws.data.subscriptions.clear();
      return;
    }
    for (const uid of uids) ws.data.subscriptions.delete(String(uid));
  }

  sendPresenceResult(ws: ClientWebSocket, uids: string[]) {
    this.send(ws, {
      type: 'presence_result',
      users: uids.map((uid) => this.presenceUser(String(uid))),
    });
  }

  broadcastPresence(uid: string) {
    const message = { type: 'presence_update', user: this.presenceUser(uid) };
    for (const client of this.clients) {
      if (client.data.open && client.data.subscriptions.has(uid)) this.send(client, message);
    }
    this.broadcast({ type: 'online_count_update', count: this.onlineCount() });
  }

  sendTyping(ws: ClientWebSocket, typing: boolean) {
    if (!ws.data.uid || !ws.data.sharePresence) return;
    const payload = {
      type: typing ? 'typing_start' : 'typing_stop',
      user: publicUser({
        id: ws.data.uid,
        ...(ws.data.name ? { name: ws.data.name } : {}),
        ...(ws.data.nickname ? { nickname: ws.data.nickname } : {}),
        ...(ws.data.avatar ? { avatar: ws.data.avatar } : {}),
      }),
    };
    this.emit(payload);
    for (const client of this.clients) {
      if (client !== ws) this.send(client, payload);
    }
  }

  broadcastNewMessages(messages: EnrichedMessage[]) {
    if (messages.length === 0) return;
    const payload = messages.map((message) => {
      const tempId = this.matchPendingMessage(message.uid, message.message);
      return tempId ? { ...message, tempId } : message;
    });
    this.broadcast({ type: 'new_messages', payload });
  }

  matchPendingMessage(uid: number | string, content: string) {
    const uidKey = String(uid);
    const pending = this.pendingMessages.get(uidKey);
    if (!pending?.length) return null;

    const cutoff = Date.now() - MESSAGE_CONFIRM_WINDOW_MS;
    const contentHash = hashContent(content);
    let matchedTempId: string | null = null;
    const remaining: TrackedPendingMessage[] = [];

    for (const item of pending) {
      if (item.createdAt <= cutoff) continue;
      if (matchedTempId === null && item.contentHash === contentHash) {
        matchedTempId = item.tempId;
        continue;
      }
      remaining.push(item);
    }

    if (remaining.length === 0) {
      this.pendingMessages.delete(uidKey);
    } else {
      this.pendingMessages.set(uidKey, remaining);
    }

    return matchedTempId;
  }

  sendToUser(uid: string, payload: unknown) {
    const sockets = this.users.get(uid);
    if (!sockets) return 0;
    let sent = 0;
    for (const ws of sockets) {
      if (this.send(ws, payload)) sent++;
    }
    return sent;
  }

  broadcast(payload: unknown) {
    this.emit(payload);
    let sent = 0;
    for (const ws of this.clients) {
      if (this.send(ws, payload)) sent++;
    }
    return sent;
  }

  subscribeEvents(listener: HubEventListener) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  setSyntheticPresence(input: SyntheticPresenceInput) {
    const uid = String(input.uid);
    const existing = this.syntheticUsers.get(uid);
    if (existing?.timer) clearTimeout(existing.timer);

    if (!input.active) {
      this.syntheticUsers.delete(uid);
      this.broadcastPresence(uid);
      return { active: false, onlineCount: this.onlineCount() };
    }

    const ttlMs = input.ttlMs ?? 120_000;
    const presence: SyntheticPresence = {
      expiresAt: Date.now() + ttlMs,
      timer: setTimeout(() => {
        this.syntheticUsers.delete(uid);
        this.broadcastPresence(uid);
      }, ttlMs),
    };
    if (input.name || input.nickname) {
      const displayName = input.name || input.nickname;
      if (displayName) {
        presence.name = displayName;
        presence.nickname = input.nickname || displayName;
      }
    }
    if (input.avatar) presence.avatar = input.avatar;

    this.syntheticUsers.set(uid, presence);
    this.broadcastPresence(uid);
    return { active: true, onlineCount: this.onlineCount() };
  }

  emitSyntheticTyping(input: SyntheticTypingInput) {
    const payload = {
      type: input.typing ? 'typing_start' : 'typing_stop',
      user: publicUser({
        id: String(input.uid),
        ...(input.name ? { name: input.name } : {}),
        ...(input.nickname ? { nickname: input.nickname } : {}),
        ...(input.avatar ? { avatar: input.avatar } : {}),
      }),
    };
    this.emit(payload);
    let sent = 0;
    for (const client of this.clients) {
      if (this.send(client, payload)) sent++;
    }
    return { sent };
  }

  handleMessage(ws: ClientWebSocket, raw: string | Buffer) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (data.type) {
      case 'identify':
        if (data.uid != null) this.identify(ws, String(data.uid));
        break;
      case 'join':
        this.join(
          ws,
          (data.user ?? {}) as { id?: string; name?: string; nickname?: string; avatar?: string },
        );
        break;
      case 'presence':
        this.setOpen(ws, Boolean(data.open));
        break;
      case 'presence_subscribe':
        this.subscribe(ws, Array.isArray(data.uids) ? data.uids.map(String) : []);
        break;
      case 'presence_unsubscribe':
        this.unsubscribe(ws, Array.isArray(data.uids) ? data.uids.map(String) : undefined);
        break;
      case 'presence_query':
        this.sendPresenceResult(ws, Array.isArray(data.uids) ? data.uids.map(String) : []);
        break;
      case 'typing_start':
        this.sendTyping(ws, true);
        break;
      case 'typing_stop':
        this.sendTyping(ws, false);
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
      case 'pending_message':
        this.notifyPendingMessage(ws, data);
        break;
      case 'ack':
        break;
    }
  }

  private notifyPendingMessage(ws: ClientWebSocket, data: Record<string, unknown>) {
    const pending: PendingMessageSignal = { uid: ws.data.uid };
    const tempId = data.tempId == null ? null : String(data.tempId);
    const content = data.content == null ? null : String(data.content);

    if (tempId) pending.tempId = tempId;
    if (content) pending.content = content;
    if (ws.data.uid && tempId && content) this.trackPendingMessage(ws.data.uid, tempId, content);

    this.options.onPendingMessage?.(pending);
  }

  private trackPendingMessage(uid: string, tempId: string, content: string) {
    const cutoff = Date.now() - MESSAGE_CONFIRM_WINDOW_MS;
    const pending = (this.pendingMessages.get(uid) ?? []).filter((item) => item.createdAt > cutoff);
    pending.push({
      tempId,
      contentHash: hashContent(content),
      createdAt: Date.now(),
    });
    this.pendingMessages.set(uid, pending);
  }

  private emit(payload: unknown) {
    for (const listener of this.eventListeners) {
      try {
        listener(payload);
      } catch {
        // Internal listeners must not break browser WebSocket delivery.
      }
    }
  }

  private presenceUser(uid: string) {
    const synthetic = this.syntheticUsers.get(uid);
    const active = this.isUserOnline(uid);
    return {
      id: uid,
      active,
      ...(active && synthetic?.name ? { name: synthetic.name } : {}),
      ...(active && synthetic?.avatar ? { avatar: synthetic.avatar } : {}),
    };
  }

  private isUserOnline(uid: string) {
    return this.isSyntheticUserOnline(uid) || this.hasVisibleSocket(uid);
  }

  private isSyntheticUserOnline(uid: string) {
    const synthetic = this.syntheticUsers.get(uid);
    return Boolean(synthetic && (synthetic.expiresAt === null || synthetic.expiresAt > Date.now()));
  }

  private hasVisibleSocket(uid: string) {
    return [...(this.users.get(uid) ?? [])].some((socket) => socket.data.sharePresence);
  }

  private onlineCount() {
    const identifiedUsers = this.users.size;
    const anonymous = [...this.clients].filter((client) => !client.data.uid).length;
    const syntheticOnly = [...this.syntheticUsers.keys()].filter(
      (uid) => this.isSyntheticUserOnline(uid) && !this.users.has(uid),
    ).length;
    return identifiedUsers + syntheticOnly + anonymous;
  }

  private broadcastOnlineCount() {
    this.broadcast({ type: 'online_count_update', count: this.onlineCount() });
  }

  private send(ws: ClientWebSocket, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
}

export function createSocketData(): SocketData {
  return {
    uid: null,
    open: false,
    sharePresence: false,
    subscriptions: new Set(),
  };
}
