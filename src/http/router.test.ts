import { describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { openApiDocument } from './openapi.js';
import { createRouter, normalizeApiPath } from './router.js';
import { WsHub } from '../ws/hub.js';

describe('normalizeApiPath', () => {
  it('keeps versioned and compatibility API paths equivalent', () => {
    expect(normalizeApiPath('/api/v1/messages')).toBe('/messages');
    expect(normalizeApiPath('/api/messages')).toBe('/messages');
    expect(normalizeApiPath('/api/v1/users/123')).toBe('/users/123');
    expect(normalizeApiPath('/api/users/123')).toBe('/users/123');
    expect(normalizeApiPath('/api/v1/auth/callback')).toBe('/auth/callback');
    expect(normalizeApiPath('/api/auth/callback')).toBe('/auth/callback');
  });

  it('exposes OpenAPI through versioned and compatibility aliases', async () => {
    const route = createRouter(new WsHub());
    const versioned = await route(new Request('https://example.test/api/v1/openapi.json'));
    const compatibility = await route(new Request('https://example.test/api/openapi.json'));

    expect(versioned.status).toBe(200);
    expect(compatibility.status).toBe(200);
    expect((await versioned.json()).openapi).toBe('3.1.0');
    expect((await compatibility.json()).servers[0].url).toBe('/api/v1');
  });

  it('documents userscript-facing migration endpoints in OpenAPI', () => {
    const documentedPaths = Object.keys(openApiDocument.paths);
    const publicMigrationPaths = [
      '/auth/me',
      '/auth/token-login',
      '/auth/logout',
      '/auth/callback',
      '/messages',
      '/messages/confirm',
      '/messages/unread-count',
      '/messages/by-date',
      '/messages/sync',
      '/messages/status',
      '/messages/{id}',
      '/messages/{id}/reactions',
      '/messages/context/{id}',
      '/messages/read',
      '/search',
      '/gallery',
      '/upload',
      '/upload/batch',
      '/upload/file',
      '/upload/video',
      '/users/search',
      '/users/{identifier}',
      '/users/lookup-by-name',
      '/users/map-uid-to-username/{uid}',
      '/notifications',
      '/notifications/{id}/read',
      '/notifications/read-all',
      '/favorites',
      '/favorites/add',
      '/favorites/remove',
      '/preview/{type}/{id}',
      '/preview/generic-url',
      '/emojis/community',
      '/emojis/meanings',
      '/admin/blocklist',
      '/admin/blocklist/add',
      '/admin/blocklist/remove',
      '/admin/bot-blocklist',
      '/admin/bot-blocklist/add',
      '/admin/bot-blocklist/remove',
      '/debug/test-notification',
    ];

    for (const path of publicMigrationPaths) {
      expect(documentedPaths).toContain(path);
    }
  });

  it('keeps legacy emoji metadata endpoints available under the versioned API', async () => {
    const route = createRouter(new WsHub());
    const community = await route(new Request('https://example.test/api/v1/emojis/community'));
    const meanings = await route(new Request('https://example.test/api/v1/emojis/meanings'));

    expect(community.status).toBe(200);
    expect(meanings.status).toBe(200);
    expect(await community.json()).toEqual({ status: true, data: [] });
    expect(await meanings.json()).toEqual({
      status: true,
      data: { enabled: false, description: '', mapping: {} },
    });
  });

  it('exposes DB-backed readiness on root and versioned API paths', async () => {
    const route = createRouter(new WsHub(), {
      readiness: async () => ({
        status: true,
        ready: true,
        name: 're-dollars-backend-next',
        checks: {
          db: { ok: true },
          tables: { ok: true, required: ['messages'], missing: [], inaccessible: [] },
          searchDb: { ok: true, configured: false, skipped: true, required: ['users'], missing: [], inaccessible: [] },
        },
      }),
    });

    const root = await route(new Request('https://example.test/ready'));
    const versioned = await route(new Request('https://example.test/api/v1/ready'));

    expect(root.status).toBe(200);
    expect(versioned.status).toBe(200);
    expect(await root.json()).toMatchObject({ status: true, ready: true });
    expect(await versioned.json()).toMatchObject({ checks: { db: { ok: true } } });
  });

  it('returns 503 when readiness checks fail', async () => {
    const route = createRouter(new WsHub(), {
      readiness: async () => ({
        status: false,
        ready: false,
        name: 're-dollars-backend-next',
        checks: {
          db: { ok: true },
          tables: {
            ok: false,
            required: ['messages', 'notifications'],
            missing: ['notifications'],
            inaccessible: [],
          },
          searchDb: { ok: true, configured: false, skipped: true, required: ['users'], missing: [], inaccessible: [] },
        },
      }),
    });

    const response = await route(new Request('https://example.test/api/v1/ready'));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: false,
      ready: false,
      checks: {
        tables: {
          missing: ['notifications'],
        },
      },
    });
  });

  it('allows scraper backfill only from local requests', async () => {
    let calledWith: unknown;
    const route = createRouter(new WsHub(), {
      scraper: {
        scrapeOnce: async (options: unknown) => {
          calledWith = options;
          return { inserted: 3, advanced: false };
        },
      } as never,
    });

    const local = await route(new Request('https://127.0.0.1/internal/scraper/backfill?sinceTs=100'));
    const remote = await route(new Request('https://127.0.0.1/internal/scraper/backfill?sinceTs=100', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }));

    expect(local.status).toBe(404);
    expect(remote.status).toBe(403);

    const postLocal = await route(new Request('https://127.0.0.1/internal/scraper/backfill?sinceTs=100', {
      method: 'POST',
    }));
    expect(postLocal.status).toBe(200);
    expect(await postLocal.json()).toEqual({ success: true, inserted: 3 });
    expect(calledWith).toEqual({ sinceTs: 100, immobileCursor: true });
  });

  it('exposes internal bot health only to local requests', async () => {
    const route = createRouter(new WsHub());
    const local = await route(new Request('https://127.0.0.1/internal/bot/health'));
    const versioned = await route(new Request('https://127.0.0.1/api/v1/internal/bot/health'));
    const remote = await route(new Request('https://127.0.0.1/internal/bot/health', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }));

    expect(local.status).toBe(200);
    expect(versioned.status).toBe(200);
    expect((await local.json()).ok).toBe(true);
    expect(remote.status).toBe(403);
  });

  it('serves legacy video files with range support', async () => {
    await mkdir('videos/test-fixtures', { recursive: true });
    await writeFile('videos/test-fixtures/range.mp4', 'abcdef');
    const route = createRouter(new WsHub());

    try {
      const response = await route(new Request('https://example.test/videos/test-fixtures/range.mp4', {
        headers: { range: 'bytes=1-3' },
      }));

      expect(response.status).toBe(206);
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(response.headers.get('content-range')).toBe('bytes 1-3/6');
      expect(await response.text()).toBe('bcd');
    } finally {
      await rm('videos/test-fixtures', { recursive: true, force: true });
    }
  });
});
