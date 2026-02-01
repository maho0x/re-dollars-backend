import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

const WS_PATH = process.env.WS_PATH || '/ws';
const SWEEP_EVERY_MS = parseInt(process.env.PRESENCE_SWEEP_MS || '15000', 10);
const WS_PING_EVERY_MS = parseInt(process.env.WS_PING_EVERY_MS || '30000', 10);
const RETRY_TICK_MS = 150;
const OFFLINE_GRACE_PERIOD_MS = 30 * 60 * 1000;
const ACK_TIMEOUT_MS_BASE = 3000; // 增加初始超时至3秒，适应移动端网络
const MAX_RETRIES = 10; // 更多重试次数，覆盖更长的网络波动
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4MB 高水位
const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024; // 1MB 低水位
const MAX_RETRY_WINDOW_MS = 60000; // 最长重试窗口 60 秒

const now = () => Date.now();

// Types
interface WSUser {
    uid: string;
    name?: string;
    avatar?: string;
    connections: Set<WebSocket>;
    active: boolean;
    lastSeen: number;
}

interface UnackedMessage {
    payloadStr: string;
    nextRetry: number;
    retries: number;
    firstSentAt: number;
    lastSentAt: number;
    wasSent: boolean; // 标记是否真正发送过
}

interface WSMeta {
    id: number;
    uid: string | null;
    open: boolean;
    subs: Set<string>;
    unackedMessages: Map<number, UnackedMessage>;
    isTerminated?: boolean;
    backpressure: boolean; // 背压状态
    pendingQueue: Array<{ ackId: number; payloadStr: string }>; // 背压时的待发送队列
}

interface UserPublic {
    id: string;
    name?: string;
    avatar?: string;
}

// Pending message tracking for optimistic update matching
interface PendingMessage {
    tempId: string;
    uid: string;
    contentHash: string;  // Simple hash of message content for matching
    createdAt: number;
}

// Simple hash function for content matching
function hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const chr = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return hash.toString(36);
}

// Pending messages: uid -> array of pending messages
const pendingMessages = new Map<string, PendingMessage[]>();
const PENDING_MESSAGE_TTL_MS = 30000; // 30 seconds TTL

// Augment WebSocket
declare module 'ws' {
    interface WebSocket {
        meta: WSMeta;
        isAlive: boolean;
    }
}

const users = new Map<string, WSUser>();
const allClients = new Set<WebSocket>();
// 记录最近断开的匿名连接 ID => 断开时间
const recentAnonDisconnects = new Map<number, number>();
let nextConnId = 1;
let nextMessageId = 1;

// Helpers

/**
 * 检查并处理背压状态
 */
function checkBackpressure(ws: WebSocket): boolean {
    const buffered = ws.bufferedAmount;

    if (ws.meta.backpressure) {
        // 当前处于背压状态，检查是否可以恢复
        if (buffered < BUFFER_LOW_WATERMARK) {
            ws.meta.backpressure = false;
            console.warn(`[WS] Backpressure OFF for ${ws.meta?.uid || 'anon'}`);
            // 恢复后立即尝试发送待发送队列
            drainPendingQueue(ws);
        }
        return ws.meta.backpressure;
    } else {
        // 检查是否需要进入背压状态
        if (buffered > BUFFER_HIGH_WATERMARK) {
            ws.meta.backpressure = true;
            console.warn(`[WS] Backpressure ON for ${ws.meta?.uid || 'anon'} (${buffered} bytes)`);
            return true;
        }
        return false;
    }
}

/**
 * 排空待发送队列
 */
function drainPendingQueue(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;

    while (ws.meta.pendingQueue.length > 0 && !ws.meta.backpressure) {
        const item = ws.meta.pendingQueue.shift()!;
        const entry = ws.meta.unackedMessages.get(item.ackId);

        if (entry && !entry.wasSent) {
            try {
                ws.send(item.payloadStr);
                entry.wasSent = true;
                entry.lastSentAt = now();
            } catch (e) {
                // 发送失败，放回队列头部
                ws.meta.pendingQueue.unshift(item);
                break;
            }
        }

        // 重新检查背压
        checkBackpressure(ws);
    }
}

function safeSend(ws: WebSocket, data: string): boolean {
    try {
        if (ws.readyState === WebSocket.OPEN) {
            // 检查背压状态
            if (checkBackpressure(ws)) {
                return false;
            }
            ws.send(data);
            return true;
        }
    } catch (e) {
        console.error('[WS] Send error:', e);
    }
    return false;
}

function sendReliable(ws: WebSocket, messageOrStr: string | any) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const ackId = nextMessageId++;
    let payloadStr: string;

    if (typeof messageOrStr === 'string') {
        try {
            const parsed = JSON.parse(messageOrStr);
            parsed.ackId = ackId;
            payloadStr = JSON.stringify(parsed);
        } catch {
            payloadStr = JSON.stringify({ message: messageOrStr, ackId });
        }
    } else {
        payloadStr = JSON.stringify({ ...messageOrStr, ackId });
    }

    const currentTime = now();
    const entry: UnackedMessage = {
        payloadStr,
        nextRetry: currentTime + ACK_TIMEOUT_MS_BASE,
        retries: 0,
        firstSentAt: currentTime,
        lastSentAt: currentTime,
        wasSent: false
    };
    ws.meta.unackedMessages.set(ackId, entry);

    // 检查背压状态
    if (checkBackpressure(ws)) {
        // 背压状态下，加入待发送队列
        ws.meta.pendingQueue.push({ ackId, payloadStr });
        return;
    }

    // 尝试发送
    try {
        ws.send(payloadStr);
        entry.wasSent = true;
        entry.lastSentAt = now();
    } catch (e) {
        // 发送失败，加入待发送队列等待重试
        ws.meta.pendingQueue.push({ ackId, payloadStr });
        console.error('[WS] Initial send failed:', e);
    }
}

function getOrCreateUser(uid: string): WSUser {
    let u = users.get(uid);
    if (!u) {
        u = {
            uid,
            connections: new Set(),
            active: false,
            lastSeen: now()
        };
        users.set(uid, u);
    }
    return u;
}

function getOnlineCount(): number {
    const onlineUserIds = new Set<string>();
    const currentTime = now();

    for (const user of users.values()) {
        if (!user.active && (currentTime - user.lastSeen < OFFLINE_GRACE_PERIOD_MS)) {
            onlineUserIds.add(user.uid);
        }
    }

    for (const ws of allClients) {
        if (ws.readyState === WebSocket.OPEN) {
            const identifier = ws.meta.uid != null ? String(ws.meta.uid) : `anon_${ws.meta.id}`;
            onlineUserIds.add(identifier);
        }
    }
    return onlineUserIds.size;
}

function computeActive(u: WSUser | undefined): boolean {
    if (!u) return false;
    return [...u.connections].some(c => c.readyState === WebSocket.OPEN);
}

function recalcAndNotifyPresence(uid: string) {
    const u = users.get(uid);
    if (!u) return;

    const wasActive = !!u.active;
    const isActive = computeActive(u);
    u.active = isActive;

    if (isActive) u.lastSeen = now();

    if (wasActive === isActive) return;

    const updateMsg = JSON.stringify({ type: 'presence_update', user: { id: u.uid, active: u.active } });

    for (const ws of allClients) {
        if (ws.meta?.open && ws.meta.subs && ws.meta.subs.has(uid)) {
            safeSend(ws, updateMsg);
        }
    }
}

function notifyPresenceResult(ws: WebSocket, uids: string[]) {
    const res = [];
    for (const uid of uids) {
        const u = users.get(uid);
        res.push({ id: uid, active: computeActive(u) });
    }
    safeSend(ws, JSON.stringify({ type: 'presence_result', users: res }));
}

function pickUserPublic(u: WSUser): UserPublic {
    return { id: u.uid, name: u.name, avatar: u.avatar };
}

export type WSManager = ReturnType<typeof initWebSocket>;

export function initWebSocket(server: Server) {
    const wss = new WebSocketServer({ server, path: WS_PATH });

    const retryTicker = setInterval(() => {
        const currentTime = now();

        for (const ws of allClients) {
            if (ws.readyState !== WebSocket.OPEN) continue;

            // 主动检查背压状态，防止死锁
            if (ws.meta.backpressure) {
                checkBackpressure(ws);
            }

            // 先尝试排空待发送队列
            if (ws.meta.pendingQueue.length > 0) {
                drainPendingQueue(ws);
            }

            if (ws.meta.unackedMessages.size === 0) continue;

            for (const [ackId, entry] of ws.meta.unackedMessages) {
                // 如果消息从未成功发送过，且在待发送队列中，跳过
                if (!entry.wasSent && ws.meta.pendingQueue.some(p => p.ackId === ackId)) {
                    continue;
                }

                // 超过最大重试窗口，放弃
                if (currentTime - entry.firstSentAt > MAX_RETRY_WINDOW_MS) {
                    console.warn(`[WS] Message ${ackId} to ${ws.meta.uid || 'anon'} expired after ${MAX_RETRY_WINDOW_MS}ms`);
                    ws.meta.unackedMessages.delete(ackId);
                    continue;
                }

                if (currentTime >= entry.nextRetry) {
                    if (entry.retries >= MAX_RETRIES) {
                        // 超过最大重试次数
                        console.warn(`[WS] Message ${ackId} to ${ws.meta.uid || 'anon'} failed after ${MAX_RETRIES} retries`);
                        ws.meta.unackedMessages.delete(ackId);
                    } else {
                        entry.retries++;
                        // 指数退避：600ms -> 900ms -> 1350ms -> 2025ms -> ...，上限 8 秒
                        const backoff = Math.min(ACK_TIMEOUT_MS_BASE * Math.pow(1.5, entry.retries), 8000);
                        entry.nextRetry = currentTime + backoff;

                        // 检查背压
                        if (!checkBackpressure(ws)) {
                            try {
                                ws.send(entry.payloadStr);
                                entry.wasSent = true;
                                entry.lastSentAt = currentTime;
                            } catch (e) {
                                // 发送失败，下次重试
                            }
                        } else {
                            // 背压状态，加入待发送队列
                            if (!ws.meta.pendingQueue.some(p => p.ackId === ackId)) {
                                ws.meta.pendingQueue.push({ ackId, payloadStr: entry.payloadStr });
                            }
                        }
                    }
                }
            }
        }
    }, RETRY_TICK_MS);

    const pingTimer = setInterval(() => {
        for (const ws of allClients) {
            if (ws.meta.isTerminated) continue;
            if (ws.isAlive === false) {
                ws.meta.isTerminated = true;
                try { ws.terminate(); } catch { }
                continue;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch { }
        }
    }, WS_PING_EVERY_MS);

    let lastOnlineCount = -1;
    const sweepTimer = setInterval(() => {
        for (const uid of users.keys()) recalcAndNotifyPresence(uid);

        const cnt = getOnlineCount();
        if (cnt !== lastOnlineCount) {
            lastOnlineCount = cnt;
            const countMsg = JSON.stringify({ type: 'online_count_update', count: cnt });
            for (const ws of allClients) {
                if (ws.meta?.open && ws.readyState === WebSocket.OPEN) {
                    safeSend(ws, countMsg);
                }
            }
        }

        const currentTime = now();
        for (const [uid, u] of users.entries()) {
            if (u.connections.size === 0 && currentTime - u.lastSeen > OFFLINE_GRACE_PERIOD_MS) {
                users.delete(uid);
            }
        }
        for (const ws of allClients) {
            if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
                allClients.delete(ws);
            }
        }
    }, SWEEP_EVERY_MS);

    wss.on('connection', (ws: WebSocket) => {
        ws.meta = {
            id: nextConnId++,
            uid: null,
            open: true,
            subs: new Set(),
            unackedMessages: new Map(),
            backpressure: false,
            pendingQueue: []
        };
        ws.isAlive = true;
        allClients.add(ws);

        ws.on('pong', () => {
            ws.isAlive = true;
            const uid = ws.meta?.uid;
            if (uid != null) {
                const u = users.get(String(uid));
                if (u) u.lastSeen = now();
            }
        });

        ws.on('message', (buf: Buffer) => {
            let data: any;
            try { data = JSON.parse(buf.toString()); } catch { return; }

            if (!data || typeof data !== 'object') return;

            switch (data.type) {
                case 'identify': {
                    if (data.uid) ws.meta.uid = String(data.uid);
                    break;
                }
                case 'ack': {
                    const ackId = data.ackId;
                    if (ackId) ws.meta.unackedMessages.delete(ackId);
                    break;
                }
                case 'join': {
                    const user = data.user || {};
                    if (user.id == null) return;
                    const uid = String(user.id);
                    ws.meta.uid = uid;

                    const u = getOrCreateUser(uid);
                    u.lastSeen = now();
                    if (user.name) u.name = user.name;
                    if (user.avatar) u.avatar = user.avatar;
                    u.connections.add(ws);
                    recalcAndNotifyPresence(uid);
                    safeSend(ws, JSON.stringify({ type: 'online_count_update', count: getOnlineCount() }));
                    break;
                }
                case 'presence': {
                    ws.meta.open = !!data.open;
                    const uid = ws.meta?.uid;
                    if (uid != null) recalcAndNotifyPresence(uid);
                    safeSend(ws, JSON.stringify({ type: 'online_count_update', count: getOnlineCount() }));
                    break;
                }
                case 'presence_subscribe': {
                    const list: string[] = Array.isArray(data.uids) ? data.uids.map(String) : [];
                    for (const id of list) ws.meta.subs.add(id);
                    break;
                }
                case 'presence_unsubscribe': {
                    ws.meta.subs.clear();
                    break;
                }
                case 'presence_query': {
                    const list: string[] = Array.isArray(data.uids) ? data.uids.map(String) : [];
                    notifyPresenceResult(ws, list);
                    break;
                }
                case 'typing_start': {
                    const uid = ws.meta?.uid;
                    if (uid == null) return;
                    const u = getOrCreateUser(uid);
                    u.lastSeen = now();
                    const payload = JSON.stringify({ type: 'typing_start', user: pickUserPublic(u) });
                    for (const c of allClients) if (c.readyState === WebSocket.OPEN) safeSend(c, payload);
                    break;
                }
                case 'typing_stop': {
                    const uid = ws.meta?.uid;
                    if (uid == null) return;
                    const u = getOrCreateUser(uid);
                    const payload = JSON.stringify({ type: 'typing_stop', user: pickUserPublic(u) });
                    for (const c of allClients) if (c.readyState === WebSocket.OPEN) safeSend(c, payload);
                    break;
                }
                case 'ping': {
                    safeSend(ws, '{"type":"pong"}');
                    break;
                }
                case 'pending_message': {
                    // Client is sending a pending (optimistic) message for matching
                    const uid = ws.meta?.uid;
                    if (!uid || !data.tempId || !data.content) break;

                    const pending: PendingMessage = {
                        tempId: String(data.tempId),
                        uid: String(uid),
                        contentHash: hashContent(String(data.content)),
                        createdAt: now()
                    };

                    // Add to pending list for this user
                    const userPending = pendingMessages.get(pending.uid) || [];
                    userPending.push(pending);
                    pendingMessages.set(pending.uid, userPending);

                    // Cleanup old pending messages (TTL)
                    const cutoff = now() - PENDING_MESSAGE_TTL_MS;
                    pendingMessages.set(pending.uid, userPending.filter(p => p.createdAt > cutoff));
                    break;
                }
            }
        });

        const cleanupConnection = () => {
            ws.meta.unackedMessages.clear();
            ws.meta.pendingQueue = [];
            const uid = ws.meta?.uid;
            if (uid != null) {
                const u = users.get(String(uid));
                if (u) {
                    u.connections.delete(ws);
                    recalcAndNotifyPresence(uid);
                }
            }
            allClients.delete(ws);
        };

        ws.on('close', cleanupConnection);
        ws.on('error', (err) => {
            console.error(`WebSocket error on connection ${ws.meta.id}:`, err);
            cleanupConnection();
        });
    });

    const broadcast = (message: string | any) => {
        let messageStr: string;
        let objType: string | undefined;

        if (typeof message === 'string') {
            messageStr = message;
            try { objType = JSON.parse(message).type; } catch { }
        } else {
            messageStr = JSON.stringify(message);
            objType = message.type;
        }

        const isReliable =
            objType === 'new_messages' ||
            objType === 'reaction_add' ||
            objType === 'reaction_remove' ||
            objType === 'message_delete' ||
            objType === 'message_edit';

        for (const ws of allClients) {
            if (ws.readyState === WebSocket.OPEN) {
                if (isReliable) {
                    sendReliable(ws, messageStr);
                } else {
                    safeSend(ws, messageStr);
                }
            }
        }
    };

    const sendToUser = (uid: string, message: any): number => {
        const targetUid = String(uid);
        let sentCount = 0;
        for (const ws of allClients) {
            if (ws.readyState === WebSocket.OPEN && String(ws.meta.uid) === targetUid) {
                sendReliable(ws, message);
                sentCount++;
            }
        }
        return sentCount;
    };

    const shutdown = () => {
        clearInterval(retryTicker);
        clearInterval(pingTimer);
        clearInterval(sweepTimer);
        try { wss.close(); } catch { }
        for (const ws of allClients) {
            try { ws.terminate(); } catch { }
        }
        allClients.clear();
        users.clear();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    /**
     * Match a newly scraped message with a pending (optimistic) message.
     * If matched, returns the tempId; otherwise returns null.
     * The pending message is consumed (removed) upon match.
     */
    const matchPendingMessage = (uid: string | number, content: string): string | null => {
        const uidStr = String(uid);
        const userPending = pendingMessages.get(uidStr);
        if (!userPending || userPending.length === 0) return null;

        const contentHash = hashContent(content);
        const cutoff = now() - PENDING_MESSAGE_TTL_MS;

        // Find matching pending message (same uid and content hash, not expired)
        const matchIndex = userPending.findIndex(p =>
            p.contentHash === contentHash && p.createdAt > cutoff
        );

        if (matchIndex === -1) return null;

        // Found a match - consume it
        const [matched] = userPending.splice(matchIndex, 1);
        if (userPending.length === 0) {
            pendingMessages.delete(uidStr);
        }

        return matched?.tempId ?? null;
    };

    return { broadcast, sendToUser, getOnlineCount, matchPendingMessage };
}
