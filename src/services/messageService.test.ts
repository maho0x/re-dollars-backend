import { describe, expect, it } from 'bun:test';
import { enrichMessages, type QueryablePool } from './messageService.js';
import type { DbMessage } from '../types.js';

interface CannedRow {
  image_url: string;
  width: number;
  height: number;
  placeholder?: string | null;
}

class RecordingClient implements QueryablePool {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly imageRows: CannedRow[]) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<Row = any>(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    this.queries.push({ sql, params });
    if (sql.includes('FROM image_metadata')) {
      return { rows: this.imageRows as unknown as Row[] };
    }
    // Every other main-DB read this enrichment performs (reactions, link_previews,
    // replies, global_blocklist) is empty in this scenario.
    return { rows: [] };
  }
}

describe('enrichMessages with queryClient', () => {
  it('routes main-DB reads through the supplied client so uncommitted image_metadata is visible', async () => {
    const dbMessage: DbMessage = {
      id: 501,
      uid: 7,
      nickname: 'Alice',
      avatar: '',
      message: '看这个 [img]https://lsky.example/i/2026/05/a.webp[/img]',
      timestamp: 1_700_000_000,
    };
    const client = new RecordingClient([
      { image_url: 'https://lsky.example/i/2026/05/a.webp', width: 640, height: 480, placeholder: null },
    ]);

    const [enriched] = await enrichMessages([dbMessage], {
      fetchMissingPreviews: false,
      queryClient: client,
    });

    // Sanity: the read for image_metadata went through our client, not the
    // module-level pool. If enrichMessages were still calling pool.query
    // directly (the pre-fix behavior), the canned row would be ignored and
    // image_meta would be missing.
    const imageQuery = client.queries.find((q) => q.sql.includes('FROM image_metadata'));
    expect(imageQuery).toBeDefined();
    expect(imageQuery?.params).toEqual([['https://lsky.example/i/2026/05/a.webp']]);

    expect(enriched?.image_meta).toEqual({
      'https://lsky.example/i/2026/05/a.webp': { width: 640, height: 480 },
    });
  });

  it('preserves the placeholder column when populated', async () => {
    const dbMessage: DbMessage = {
      id: 502,
      uid: 7,
      nickname: 'Alice',
      avatar: '',
      message: '[img]https://cdn.example/p.webp[/img]',
      timestamp: 1_700_000_000,
    };
    const client = new RecordingClient([
      { image_url: 'https://cdn.example/p.webp', width: 100, height: 200, placeholder: 'LEHV6n' },
    ]);

    const [enriched] = await enrichMessages([dbMessage], {
      fetchMissingPreviews: false,
      queryClient: client,
    });

    expect(enriched?.image_meta).toEqual({
      'https://cdn.example/p.webp': { width: 100, height: 200, placeholder: 'LEHV6n' },
    });
  });

  it('skips image_metadata SELECT entirely when no [img] BBCode is present', async () => {
    const dbMessage: DbMessage = {
      id: 503,
      uid: 7,
      nickname: 'Alice',
      avatar: '',
      message: 'plain text',
      timestamp: 1_700_000_000,
    };
    const client = new RecordingClient([]);

    const [enriched] = await enrichMessages([dbMessage], {
      fetchMissingPreviews: false,
      queryClient: client,
    });

    expect(client.queries.some((q) => q.sql.includes('FROM image_metadata'))).toBe(false);
    expect(enriched?.image_meta).toBeUndefined();
  });
});
