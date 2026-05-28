import { describe, expect, it } from 'bun:test';
import {
  createSocketData,
  MESSAGE_CONFIRM_WINDOW_MS,
  normalizeMessageForMatch,
  type ClientWebSocket,
  WsHub,
} from './hub.js';

function fakeSocket(uid: string | null = null, sent: unknown[] = []) {
  return {
    data: { ...createSocketData(), uid },
    send(payload: string) {
      sent.push(JSON.parse(payload) as unknown);
    },
  } as unknown as ClientWebSocket;
}

describe('WsHub', () => {
  it('keeps the frontend confirmation window at 10 seconds', () => {
    expect(MESSAGE_CONFIRM_WINDOW_MS).toBe(10_000);
  });

  it('normalizes entities and whitespace for message matching', () => {
    expect(normalizeMessageForMatch(' hello&nbsp;\n\t&amp; world  ')).toBe('hello & world');
  });

  it('signals pending messages so the scraper can boost polling', () => {
    const pending: unknown[] = [];
    const hub = new WsHub({
      onPendingMessage: (message) => pending.push(message),
    });
    const ws = fakeSocket('42');

    hub.handleMessage(ws, JSON.stringify({
      type: 'pending_message',
      tempId: 'tmp-1',
      content: 'hello',
    }));

    expect(pending).toEqual([{ uid: '42', tempId: 'tmp-1', content: 'hello' }]);
  });

  it('attaches a matching pending tempId to newly broadcast messages', () => {
    const sent: unknown[] = [];
    const hub = new WsHub();
    const ws = fakeSocket('42', sent);
    hub.add(ws);

    hub.handleMessage(
      ws,
      JSON.stringify({
        type: 'pending_message',
        tempId: 'tmp-1',
        content: ' hello&nbsp;\n\t&amp; world ',
      }),
    );
    hub.broadcastNewMessages([
      {
        id: 1,
        db_id: 1,
        uid: 42,
        nickname: 'alice',
        avatar: '',
        message: 'hello & world',
        timestamp: Date.now(),
        reactions: [],
      },
    ]);

    expect(sent.at(-1)).toEqual({
      type: 'new_messages',
      payload: [
        {
          id: 1,
          db_id: 1,
          uid: 42,
          nickname: 'alice',
          avatar: '',
          message: 'hello & world',
          timestamp: expect.any(Number),
          reactions: [],
          tempId: 'tmp-1',
        },
      ],
    });

    sent.length = 0;
    hub.broadcastNewMessages([
      {
        id: 2,
        db_id: 2,
        uid: 42,
        nickname: 'alice',
        avatar: '',
        message: 'hello & world',
        timestamp: Date.now(),
        reactions: [],
      },
    ]);

    expect(sent.at(-1)).toEqual({
      type: 'new_messages',
      payload: [
        {
          id: 2,
          db_id: 2,
          uid: 42,
          nickname: 'alice',
          avatar: '',
          message: 'hello & world',
          timestamp: expect.any(Number),
          reactions: [],
        },
      ],
    });
  });

  it('includes synthetic users in presence results and online count', () => {
    const sent: unknown[] = [];
    const hub = new WsHub();
    const ws = fakeSocket(null, sent);
    hub.add(ws);

    const result = hub.setSyntheticPresence({ uid: 560875, active: true, name: 'Bot', ttlMs: 5000 });
    hub.sendPresenceResult(ws, ['560875', '1']);

    expect(result).toEqual({ active: true, onlineCount: 2 });
    expect(sent).toContainEqual({
      type: 'presence_result',
      users: [
        { id: '560875', active: true, name: 'Bot' },
        { id: '1', active: false },
      ],
    });

    hub.setSyntheticPresence({ uid: 560875, active: false });
  });

  it('counts identified-only sockets while keeping them hidden from presence', () => {
    const hiddenSent: unknown[] = [];
    const observerSent: unknown[] = [];
    const hub = new WsHub();
    const hidden = fakeSocket(null, hiddenSent);
    const observer = fakeSocket(null, observerSent);
    hub.add(hidden);
    hub.add(observer);

    hub.handleMessage(observer, JSON.stringify({ type: 'identify', uid: '7' }));
    observerSent.length = 0;
    hub.handleMessage(hidden, JSON.stringify({ type: 'identify', uid: '42' }));

    expect(observerSent).toContainEqual({ type: 'online_count_update', count: 2 });
    expect(hub.sendToUser('42', { type: 'notification', payload: { ok: true } })).toBe(1);
    expect(hiddenSent.at(-1)).toEqual({ type: 'notification', payload: { ok: true } });

    hub.sendPresenceResult(observer, ['42']);
    expect(observerSent.at(-1)).toEqual({
      type: 'presence_result',
      users: [{ id: '42', active: false }],
    });
  });

  it('deduplicates multiple sockets for the same identified user in online count', () => {
    const sent: unknown[] = [];
    const hub = new WsHub();
    const first = fakeSocket(null, sent);
    const second = fakeSocket(null, sent);
    const other = fakeSocket(null, sent);
    hub.add(first);
    hub.add(second);
    hub.add(other);

    hub.handleMessage(first, JSON.stringify({ type: 'identify', uid: '42' }));
    hub.handleMessage(second, JSON.stringify({ type: 'identify', uid: '42' }));
    hub.handleMessage(other, JSON.stringify({ type: 'identify', uid: '7' }));

    expect(sent.at(-1)).toEqual({ type: 'online_count_update', count: 2 });
  });

  it('marks a user visible only after join shares presence', () => {
    const observerSent: unknown[] = [];
    const hub = new WsHub();
    const user = fakeSocket(null);
    const observer = fakeSocket(null, observerSent);
    hub.add(user);
    hub.add(observer);

    hub.handleMessage(user, JSON.stringify({ type: 'identify', uid: '42' }));
    hub.handleMessage(user, JSON.stringify({ type: 'join', user: { id: '42', name: 'Alice' } }));

    hub.sendPresenceResult(observer, ['42']);
    expect(observerSent.at(-1)).toEqual({
      type: 'presence_result',
      users: [{ id: '42', active: true }],
    });
  });

  it('broadcasts typing events with name and nickname for legacy clients', () => {
    const sent: unknown[] = [];
    const hub = new WsHub();
    const sender = fakeSocket(null);
    const receiver = fakeSocket(null, sent);
    hub.add(sender);
    hub.add(receiver);

    hub.handleMessage(
      sender,
      JSON.stringify({
        type: 'join',
        user: { id: '42', nickname: 'Alice', avatar: 'https://avatar/alice.jpg' },
      }),
    );
    hub.handleMessage(sender, JSON.stringify({ type: 'typing_start' }));

    expect(sent.at(-1)).toEqual({
      type: 'typing_start',
      user: {
        id: '42',
        name: 'Alice',
        nickname: 'Alice',
        avatar: 'https://avatar/alice.jpg',
      },
    });
  });

  it('does not broadcast typing events for identified-only clients', () => {
    const sent: unknown[] = [];
    const hub = new WsHub();
    const sender = fakeSocket('42');
    const receiver = fakeSocket(null, sent);
    hub.add(sender);
    hub.add(receiver);

    hub.handleMessage(sender, JSON.stringify({ type: 'typing_start' }));

    expect(sent).toEqual([]);
  });

  it('falls back to uid for typing events when shared presence has no profile', () => {
    const sent: unknown[] = [];
    const hub = new WsHub();
    const sender = fakeSocket(null);
    const receiver = fakeSocket(null, sent);
    hub.add(sender);
    hub.add(receiver);

    hub.handleMessage(sender, JSON.stringify({ type: 'join', user: { id: '42' } }));
    hub.handleMessage(sender, JSON.stringify({ type: 'typing_start' }));

    expect(sent.at(-1)).toEqual({
      type: 'typing_start',
      user: { id: '42', name: '42', nickname: '42' },
    });
  });

  it('emits synthetic typing to clients and internal event subscribers', () => {
    const sent: unknown[] = [];
    const events: unknown[] = [];
    const hub = new WsHub();
    const ws = fakeSocket(null, sent);
    hub.add(ws);
    const unsubscribe = hub.subscribeEvents((event) => events.push(event));

    const result = hub.emitSyntheticTyping({ uid: 560875, typing: true, name: 'Bot' });

    expect(result).toEqual({ sent: 1 });
    expect(sent).toEqual([
      { type: 'typing_start', user: { id: '560875', name: 'Bot', nickname: 'Bot' } },
    ]);
    expect(events).toEqual([
      { type: 'typing_start', user: { id: '560875', name: 'Bot', nickname: 'Bot' } },
    ]);
    unsubscribe();
  });
});
