import { describe, expect, it } from 'bun:test';
import { parseDollarsPayload } from './scraper.js';

describe('parseDollarsPayload', () => {
  it('normalizes Bangumi dollars rows and decodes HTML entities', () => {
    const [message] = parseDollarsPayload([
      {
        id: 'post_123',
        uid: '42',
        nickname: 'tester',
        avatar: '/avatar.jpg',
        timestamp: 1700000000,
        msg: 'A &amp; B &#65;',
      },
    ], 1700000001);

    expect(message).toMatchObject({
      bangumi_id: '123',
      uid: 42,
      nickname: 'tester',
      avatar: '/avatar.jpg',
      timestamp: 1700000000,
      message: 'A & B A',
      type: 'text',
    });
  });

  it('sorts same-second bot messages after user messages', () => {
    const messages = parseDollarsPayload([
      { id: 3, uid: 0, nickname: 'bot', avatar: '', timestamp: 1700000000, msg: 'bot' },
      { id: 2, uid: 10, nickname: 'u', avatar: '', timestamp: 1700000000, msg: 'user' },
      { id: 1, uid: 9, nickname: 'v', avatar: '', timestamp: 1699999999, msg: 'old' },
    ], 1700000001);

    expect(messages.map((message) => message.bangumi_id)).toEqual(['1', '2', '3']);
  });

  it('drops malformed or too-future rows', () => {
    const messages = parseDollarsPayload([
      { id: 'bad', uid: 1, timestamp: 1700000000, msg: 'bad id' },
      { id: 4, uid: 1, timestamp: 1700000100, msg: 'future' },
    ], 1700000000);

    expect(messages).toEqual([]);
  });
});
