import { describe, expect, it } from 'bun:test';
import {
  collectImageUrls,
  type LskyQueryPool,
  lookupLskyDimensions,
  lskyFilenameFromUrl,
  persistLskyImageMetadataForMessages,
} from './lskyImageMetadataService.js';

class FakeLskyPool implements LskyQueryPool {
  public calls: unknown[][] = [];

  constructor(
    private readonly rowsByFilename: Record<string, Array<{ width: number | string | null; height: number | string | null }>>,
  ) {}

  async query<Row = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    expect(sql).toBe('SELECT width, height FROM images WHERE name = $1 ORDER BY id DESC LIMIT 1');
    this.calls.push(params);
    const filename = String(params[0] ?? '');
    return { rows: (this.rowsByFilename[filename] ?? []) as Row[] };
  }
}

class FakePgClient {
  public inserts: unknown[][] = [];
  public selects: unknown[][] = [];

  constructor(private readonly existingUrls: string[] = []) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<T = any>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.includes('SELECT image_url FROM image_metadata')) {
      this.selects.push(params);
      return { rows: this.existingUrls.map((image_url) => ({ image_url })) as T[] };
    }
    if (sql.includes('INSERT INTO image_metadata')) {
      this.inserts.push(params);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

describe('LSKY image metadata helpers', () => {
  it('collects unique clean image URLs from BBCode messages', () => {
    expect(collectImageUrls([
      { message: '[img]https://lsky.ry.mk/i/2026/05/a.webp?x=1[/img]' },
      { message: '[img]https://lsky.ry.mk/i/2026/05/a.webp[/img] [img]https://cdn.example/nope.jpg[/img]' },
      { message: '[url]https://lsky.ry.mk/i/not-an-img.webp[/url]' },
      { message: null },
    ])).toEqual([
      'https://lsky.ry.mk/i/2026/05/a.webp',
      'https://cdn.example/nope.jpg',
    ]);
  });

  it('extracts LSKY filenames only from /i/ paths', () => {
    expect(lskyFilenameFromUrl('https://lsky.ry.mk/i/2026/05/a%20b.webp?token=1')).toBe('a b.webp');
    expect(lskyFilenameFromUrl('https://lsky.ry.mk/uploads/a.webp')).toBeNull();
    expect(lskyFilenameFromUrl('not a url')).toBeNull();
  });

  it('looks up dimensions by image filename via pg', async () => {
    const pool = new FakeLskyPool({
      'a.webp': [{ width: '640', height: 480 }],
      'bad.webp': [{ width: 0, height: 480 }],
    });

    await expect(lookupLskyDimensions('https://lsky.ry.mk/i/2026/05/a.webp', pool)).resolves.toEqual({
      width: 640,
      height: 480,
    });
    await expect(lookupLskyDimensions('https://lsky.ry.mk/i/2026/05/bad.webp', pool)).resolves.toBeNull();
    await expect(lookupLskyDimensions('https://lsky.ry.mk/uploads/a.webp', pool)).resolves.toBeNull();
    expect(pool.calls).toEqual([['a.webp'], ['bad.webp']]);
  });

  it('persists metadata for new LSKY images and skips cached URLs', async () => {
    const pg = new FakePgClient(['https://lsky.ry.mk/i/2026/05/existing.webp']);
    const lsky = new FakeLskyPool({
      'new.webp': [{ width: 320, height: 240 }],
      'external.jpg': [{ width: 100, height: 100 }],
    });

    const result = await persistLskyImageMetadataForMessages(pg as never, [
      { message: '[img]https://lsky.ry.mk/i/2026/05/existing.webp[/img]' },
      { message: '[img]https://lsky.ry.mk/i/2026/05/new.webp[/img]' },
      { message: '[img]https://cdn.example/external.jpg[/img]' },
    ], lsky);

    expect(result.size).toBe(1);
    expect(result.get('https://lsky.ry.mk/i/2026/05/new.webp')).toEqual({ width: 320, height: 240 });
    expect(pg.selects).toEqual([[
      [
        'https://lsky.ry.mk/i/2026/05/existing.webp',
        'https://lsky.ry.mk/i/2026/05/new.webp',
        'https://cdn.example/external.jpg',
      ],
    ]]);
    expect(lsky.calls).toEqual([['new.webp']]);
    expect(pg.inserts).toEqual([['https://lsky.ry.mk/i/2026/05/new.webp', 320, 240]]);
  });
});
