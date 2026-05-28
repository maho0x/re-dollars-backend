# Re:Dollars Backend Next

This is the new backend surface intended to run beside the current backend during migration.

It keeps compatibility aliases under `/api/*` for the existing userscript, and exposes the normalized versioned API under `/api/v1/*`. The WebSocket transport is native Bun at `/ws`.

## Development

```bash
bun install
bun dev
```

## Production Runtime

PM2, Docker, and direct Bun entrypoints are provided so the new backend can run beside the current backend without replacing it first.

```bash
bun install --frozen-lockfile
bun start
```

PM2:

```bash
pm2 start ecosystem.config.cjs
```

Docker Compose:

```bash
cp .env.example .env
docker compose up -d --build
```

Smoke check after the service is reachable:

```bash
bun run smoke http://127.0.0.1:13032
```

`/health` is a cheap liveness endpoint. Use `/ready` or `/api/v1/ready` for
reverse proxy and process-manager readiness checks; it verifies PostgreSQL
connectivity, required legacy tables, and the optional separate search/profile
database when configured.

### Environment Compatibility

`DATABASE_URL` is preferred when present. For direct PostgreSQL settings, the
new names are `DB_PASSWORD` and `DB_DATABASE`, but legacy `DB_PASS` and
`DB_NAME` from the current backend `.env` are also accepted.

`SEARCH_DATABASE_URL` or `SEARCH_DB_*` configures the local user search/profile
cache. The legacy remote profile sync is also ported: set
`REMOTE_SEARCH_DATABASE_URL` or the old `REMOTE_SEARCH_DB_*` variables to copy
remote `users` rows into the local `users` and `user_profiles` tables. The
scheduler is controlled by `SEARCH_SYNC_ENABLED`, `SEARCH_SYNC_INTERVAL_MS`,
`SEARCH_SYNC_BATCH_SIZE`, and `SEARCH_SYNC_RECENT_LIMIT`; when no remote search
database is configured it stays disabled.

Database backups are ported but opt-in. Set `BACKUP_ENABLED=true` to schedule a
daily `pg_dump` at `BACKUP_HOUR`; `BACKUP_RUN_ON_START=true` also runs one at
process startup. Backups are written to `BACKUP_DIR`, old `.sql` files are
pruned after `BACKUP_KEEP_DAYS`, and Docker Compose persists them via
`HOST_BACKUP_DIR`. `BACKUP_EXCLUDE_TABLE_DATA` defaults to `auth_tokens` so
session tokens are not dumped. If `GITHUB_BACKUP_REPO` and `GITHUB_BACKUP_TOKEN`
are set, each backup is uploaded to a daily GitHub release tagged
`GITHUB_BACKUP_TAG-YYYY-MM-DD`. The Docker image installs `postgresql-client`
for `pg_dump`; direct/PM2 deployments need `pg_dump` on `PATH` or a
`BACKUP_PG_DUMP_BIN` override.

Chat log archives are separate from database backups. Set
`CHAT_LOG_BACKUP_ENABLED=true` to export complete UTC days from `messages` as
gzipped JSONL files in `CHAT_LOG_BACKUP_DIR`; old `.jsonl.gz` archives are
pruned after `CHAT_LOG_BACKUP_KEEP_DAYS`. When the GitHub backup credentials are
set, chat logs upload to releases tagged `CHAT_LOG_BACKUP_TAG-YYYY-MM-DD`.

`LSKY_DB_*` is accepted for legacy image metadata compatibility. When
configured, the native scraper looks up width and height in the LSKY MySQL
`images` table for newly inserted `[img]...[/img]` URLs and writes those values
to `image_metadata` before broadcasting. This mirrors the useful legacy
dimension path without adding image downloads or placeholder generation to the
scraper loop.

Bangumi API requests use `BANGUMI_ACCESS_TOKEN` or `BANGUMI_API_TOKEN` as a
default bearer token when the caller does not provide an `Authorization` header.
OAuth still uses `BGM_APP_ID`, `BGM_APP_SECRET`, and `BGM_CALLBACK_URL`.

Uploads can be configured with explicit `UPLOAD_IMAGE_ENDPOINT`,
`UPLOAD_FILE_ENDPOINT`, `UPLOAD_AUTH_HEADER`, and `UPLOAD_AUTH_TOKEN` values.
During migration, `REMOTE_PROCESSOR_URL` is also supported as a shortcut for the
existing `remote_processor` service: image uploads are sent to `/process`,
file/video uploads are sent to `/process-video`, and
`REMOTE_PROCESSOR_API_KEY` or `PROCESSOR_API_KEY` is sent as `x-api-key`.

Static media compatibility is kept for legacy video links. For direct or PM2
runs, set `VIDEOS_PATH` to the current backend video directory so the new domain
can serve `/videos/*` with range requests and stable media MIME types. For
Docker Compose, set `HOST_VIDEOS_PATH` to the host directory and keep
`VIDEOS_PATH` as the in-container mount path. `VIDEO_PUBLIC_BASE_URL` controls
the URL returned for new video uploads, and `LEGACY_VIDEO_BASE_URLS` lists old
video hosts that should be rewritten to the new domain in upload and gallery
responses. `PUBLIC_DIR` optionally serves `/public/*`; `HOST_PUBLIC_DIR` is its
Docker Compose host-side mount.

Bot automation can be moved off the legacy localhost-only `/trpc` surface onto
the normalized `/internal/bot/*` REST/SSE bridge. Set `BOT_USER_ID` and
`BOT_NICKNAME` to enable backend-owned bot reactions, and set `BOT_MEMORY_FILE`
when global bot memory should live somewhere other than `./MEMORY.md`.

## Migration Shape

- Run this service on a new domain, for example `https://rd.ry.mk`.
- Point the Preact userscript to the new domain.
- During early gray rollout, keep the old backend/scraper running while this service tails the existing PostgreSQL `messages` and `notifications` tables and broadcasts new events to clients connected to the new WebSocket.
- For cutover, set `SCRAPER_ENABLED=true` so this service fetches Bangumi Dollars directly, writes `messages`/`notifications`, and broadcasts via the new WebSocket.
- Move write paths one by one. Implemented write paths include reactions, read state, favorites, auth token login, message edit/delete, upload proxying, static media serving, admin blocklists, debug notification insertion, localhost scraper backfill, and a localhost bot automation bridge.
- Browser message posting remains same-origin to Bangumi (`/dollars?ajax=1`) while the userscript runs on bangumi.tv because backend-next cannot receive the user's Bangumi session cookie on the new domain. After that post succeeds, the userscript polls `/api/v1/messages/confirm`; backend-next returns the canonical ingested message once the scraper or DB tail sees it.
- Remote profile synchronization from the legacy search database can run in this service before cutover, so avatar/user lookup cache freshness no longer depends on the old backend process.
- The legacy database backup scheduler is available as an opt-in backend-next service, including local retention and optional GitHub release uploads.
- LSKY MySQL image dimension lookup is available for the native scraper, so new-domain clients can keep receiving `image_meta` for newly scraped image posts after cutover.

Recommended cutover modes:

- Gray rollout: `DB_TAIL_ENABLED=true`, `SCRAPER_ENABLED=false`. The old backend remains the message ingester; this backend serves the new domain and mirrors DB changes to new WebSocket clients.
- New backend ingest: `DB_TAIL_ENABLED=true`, `SCRAPER_ENABLED=true`. This backend ingests Bangumi Dollars directly; DB tailing remains on for notifications/messages written by other legacy processes.
- Full backend ownership: keep `SCRAPER_ENABLED=true`, then retire legacy backend write paths only after OAuth, upload proxy, message ingest, notifications, and WebSocket behavior are verified on the new domain.

When this service connects with a PostgreSQL role that is not the owner of
legacy tables, optional performance indexes may be skipped. Core table checks,
reads, writes, and DB tailing still work as long as that role has normal DML
permissions on the existing tables.

Backend-next also creates and readiness-checks legacy auxiliary tables used by
external workers, including `video_processing_queue` and `scheduled_reminders`.
The current Bangumi userscript does not call the old draw-guess/game, reminder,
or local video queue APIs, so those UI/API surfaces are not exposed publicly on
the new domain.

## API Namespacing

- Preferred: `/api/v1/messages`, `/api/v1/users/:id`, `/api/v1/messages/read`
- Compatibility: `/api/messages`, `/api/users/:id`, `/api/messages/read`

Both route sets currently return the existing response shapes expected by `re-dollars-preact`.

The versioned API contract is available at `/api/v1/openapi.json`; `/api/openapi.json` is kept as a migration alias.

Legacy-parity endpoints kept during migration include:

- `/api/v1/preview/:type/:id` and `/api/v1/preview/generic-url`
- `/api/v1/emojis/community` and `/api/v1/emojis/meanings`
- `/api/v1/admin/blocklist`, `/api/v1/admin/bot-blocklist`, and their add/remove actions
- `/api/v1/debug/test-notification`
- `/internal/scraper/backfill` and `/api/v1/internal/scraper/backfill` for localhost-only backfills
- `/internal/bot/*` and `/api/v1/internal/bot/*` as localhost-only REST/SSE replacements for the old `/trpc` bot procedures
- `/videos/*` and `/public/*` static assets, including range support for video playback

Admin mutations and debug notification insertion require `ADMIN_PASSWORD`.
Community emoji URLs are served only when `COMMUNITY_EMOJI_DIR` is set. Emoji
meaning metadata is served only when `EMOTE_CONFIG_PATH` points at a compatible
`emotes.json` file.

The bot bridge covers health, message max-id/since/before/context/search,
quote-author checks, event streaming over SSE, backend-owned reactions, global
and per-user memory, user resolution/lookup, replied-post tracking, and
synthetic presence/typing broadcasts. It is guarded by localhost checks and is
not exposed as a public Bangumi userscript API.

For Bangumi OAuth, register the new-domain redirect URI as
`https://rd.ry.mk/api/v1/auth/callback` unless `BGM_CALLBACK_URL`
is explicitly overridden. The frontend uses the same versioned callback URL by
default.
