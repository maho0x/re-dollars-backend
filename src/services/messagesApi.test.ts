import { describe, expect, it } from 'bun:test';
import { confirmMessage } from './messagesApi.js';
import type { DbMessage, EnrichedMessage } from '../types.js';
import { ApiError } from '../utils/http.js';

class QueryPool {
  public queries: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly rows: DbMessage[]) {}

  query<Row>(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    return Promise.resolve({ rows: this.rows as Row[] });
  }
}

describe('confirmMessage', () => {
  it('returns an enriched canonical message when recent normalized content matches', async () => {
    const row: DbMessage = {
      id: 101,
      uid: 560875,
      nickname: 'Alice',
      avatar: 'https://avatar/560875.jpg',
      message: 'hello   world',
      timestamp: 1_700_000_000,
    };
    const pool = new QueryPool([row]);
    const enrichCalls: Array<{ messages: DbMessage[]; options: unknown }> = [];

    const result = await confirmMessage(
      { uid: '560875', message: 'hello world' },
      {
        queryPool: pool,
        now: () => 1_700_000_010_000,
        enrich: async (messages, options) => {
          enrichCalls.push({ messages, options });
          return messages.map((message) => ({
            ...message,
            db_id: Number(message.id),
            reactions: [],
            color: '#123456',
          })) as EnrichedMessage[];
        },
      },
    );

    expect(pool.queries[0]?.params).toEqual([560875, 1_699_999_990]);
    expect(enrichCalls).toEqual([{ messages: [row], options: { fetchMissingPreviews: false } }]);
    expect(result.status).toBe(true);
    expect(result.found).toBe(true);
    expect(result.message).toMatchObject({
      ...row,
      db_id: 101,
      reactions: [],
      color: '#123456',
    });
  });

  it('returns found false without enriching when no recent content matches', async () => {
    const pool = new QueryPool([
      {
        id: 102,
        uid: 560875,
        nickname: 'Alice',
        avatar: '',
        message: 'different',
        timestamp: 1_700_000_000,
      },
    ]);
    let enrichCalled = false;

    const result = await confirmMessage(
      { uid: 560875, message: 'hello world' },
      {
        queryPool: pool,
        now: () => 1_700_000_010_000,
        enrich: async () => {
          enrichCalled = true;
          return [];
        },
      },
    );

    expect(enrichCalled).toBe(false);
    expect(result).toEqual({ status: true, found: false, message: null });
  });

  it('rejects missing uid or message content', async () => {
    expect(confirmMessage({ uid: 560875, message: '' })).rejects.toThrow(ApiError);
    expect(confirmMessage({ message: 'hello' })).rejects.toThrow(ApiError);
  });
});
