import { z } from 'zod';
import { resolve } from 'node:path';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalNumber = z.preprocess((value) => {
  if (value == null || value === '') return undefined;
  return Number(value);
}, z.number().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(13032),
  PUBLIC_BASE_URL: z.string().url().default('https://rd.ry.mk'),

  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(5432),
  DB_USER: z.string().default('bgmchat'),
  DB_PASSWORD: z.string().default('password'),
  DB_DATABASE: z.string().default('bgmchat'),

  SEARCH_DATABASE_URL: z.string().optional(),
  SEARCH_DB_HOST: z.string().optional(),
  SEARCH_DB_PORT: optionalNumber,
  SEARCH_DB_USER: z.string().optional(),
  SEARCH_DB_PASSWORD: z.string().optional(),
  SEARCH_DB_DATABASE: z.string().optional(),
  SEARCH_DB_PASS: z.string().optional(),
  SEARCH_DB_NAME: z.string().optional(),
  REMOTE_SEARCH_DATABASE_URL: z.string().optional(),
  REMOTE_SEARCH_DB_HOST: z.string().optional(),
  REMOTE_SEARCH_DB_PORT: optionalNumber,
  REMOTE_SEARCH_DB_USER: z.string().optional(),
  REMOTE_SEARCH_DB_PASSWORD: z.string().optional(),
  REMOTE_SEARCH_DB_DATABASE: z.string().optional(),
  REMOTE_SEARCH_DB_PASS: z.string().optional(),
  REMOTE_SEARCH_DB_NAME: z.string().optional(),
  SEARCH_SYNC_ENABLED: booleanFromEnv.default(true),
  SEARCH_SYNC_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  SEARCH_SYNC_INITIAL_DELAY_MS: z.coerce.number().default(5000),
  SEARCH_SYNC_BATCH_SIZE: z.coerce.number().default(1000),
  SEARCH_SYNC_RECENT_LIMIT: z.coerce.number().default(200),
  SEARCH_SYNC_QUERY_TIMEOUT_MS: z.coerce.number().default(10000),
  DB_PASS: z.string().optional(),
  DB_NAME: z.string().optional(),

  BACKUP_ENABLED: booleanFromEnv.default(false),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_KEEP_DAYS: z.coerce.number().default(7),
  BACKUP_HOUR: z.coerce.number().default(4),
  BACKUP_RUN_ON_START: booleanFromEnv.default(false),
  BACKUP_PG_DUMP_BIN: z.string().default('pg_dump'),
  BACKUP_EXCLUDE_TABLE_DATA: z.string().default('auth_tokens'),
  R2_BACKUP_REMOTE: z.string().optional(),
  R2_BACKUP_RCLONE_BIN: z.string().default('rclone'),
  CHAT_LOG_BACKUP_ENABLED: booleanFromEnv.default(false),
  CHAT_LOG_BACKUP_DIR: z.string().default('./chat-log-backups'),
  CHAT_LOG_BACKUP_KEEP_DAYS: z.coerce.number().default(30),
  CHAT_LOG_BACKUP_HOUR: z.coerce.number().default(4),
  CHAT_LOG_BACKUP_RUN_ON_START: booleanFromEnv.default(false),
  CHAT_LOG_BACKUP_WINDOW_DAYS: z.coerce.number().default(1),

  IMGHOST_DATABASE_URL: z.string().optional(),
  IMGHOST_DB_HOST: z.string().optional(),
  IMGHOST_DB_PORT: optionalNumber,
  IMGHOST_DB_USER: z.string().optional(),
  IMGHOST_DB_PASSWORD: z.string().optional(),
  IMGHOST_DB_DATABASE: z.string().optional(),
  IMGHOST_DB_PASS: z.string().optional(),
  IMGHOST_DB_NAME: z.string().optional(),
  IMGHOST_DB_MAX: z.coerce.number().default(2),
  // Legacy LSKY MySQL aliases — accepted only so existing .env files keep
  // parsing. The lookup itself targets imghost PostgreSQL now.
  LSKY_DB_HOST: z.string().optional(),
  LSKY_DB_PORT: optionalNumber,
  LSKY_DB_USER: z.string().optional(),
  LSKY_DB_PASSWORD: z.string().optional(),
  LSKY_DB_DATABASE: z.string().optional(),
  LSKY_DB_PASS: z.string().optional(),
  LSKY_DB_NAME: z.string().optional(),
  LSKY_DB_CONNECTION_LIMIT: z.coerce.number().default(2),
  LSKY_API_URL: z.string().optional(),

  BANGUMI_ACCESS_TOKEN: z.string().optional(),
  BANGUMI_API_TOKEN: z.string().optional(),
  BGM_APP_ID: z.string().optional(),
  BGM_APP_SECRET: z.string().optional(),
  BGM_CALLBACK_URL: z.string().optional(),
  BGM_API_BASE: z.string().url().default('https://api.bgm.tv/v0'),
  BGM_ORIGIN: z.string().url().default('https://chii.in'),
  BGM_DOLLARS_PATH: z.string().default('/dollars'),
  BGM_COOKIE_JSON: z.string().default('[]'),
  BGM_USER_AGENT: z.string().default('ReDollarsNext/0.1'),
  BOT_USER_ID: optionalNumber,
  BOT_NICKNAME: z.string().default('布莱克·樱·Bangumi娘'),
  BOT_MEMORY_FILE: z.string().default('./MEMORY.md'),

  CORS_ORIGINS: z.string().default('https://bangumi.tv,https://bgm.tv,https://chii.in'),
  ADMIN_PASSWORD: z.string().optional(),
  COMMUNITY_EMOJI_DIR: z.string().optional(),
  EMOTE_CONFIG_PATH: z.string().optional(),
  VIDEOS_PATH: z.string().default('./videos'),
  PUBLIC_DIR: z.string().default('./public'),
  VIDEO_PUBLIC_BASE_URL: z.string().optional(),
  LOCAL_VIDEO_PUBLIC_URL: z.string().optional(),
  LEGACY_VIDEO_BASE_URLS: z.string().default('https://bgmchat.ry.mk/videos'),

  UPLOAD_IMAGE_ENDPOINT: z.string().optional(),
  UPLOAD_IMAGE_FIELD: z.string().optional(),
  UPLOAD_IMAGE_BATCH_ENDPOINT: z.string().optional(),
  UPLOAD_IMAGE_BATCH_FIELD: z.string().optional(),
  UPLOAD_FILE_ENDPOINT: z.string().optional(),
  UPLOAD_FILE_FIELD: z.string().optional(),
  UPLOAD_AUTH_HEADER: z.string().default('Authorization'),
  UPLOAD_AUTH_TOKEN: z.string().optional(),
  REMOTE_PROCESSOR_URL: z.string().optional(),
  REMOTE_PROCESSOR_API_KEY: z.string().optional(),
  PROCESSOR_API_KEY: z.string().optional(),

  WS_PATH: z.string().default('/ws'),
  DB_TAIL_ENABLED: booleanFromEnv.default(true),
  DB_TAIL_INTERVAL_MS: z.coerce.number().default(1500),
  DB_TAIL_BATCH_SIZE: z.coerce.number().default(100),

  SCRAPER_ENABLED: booleanFromEnv.default(false),
  SCRAPER_INTERVAL_MS: optionalNumber,
  SCRAPE_INTERVAL_MS: optionalNumber,
  SCRAPER_SAFETY_SWEEP_WINDOW_SEC: z.coerce.number().default(120),
  SCRAPER_SAFETY_SWEEP_EVERY_TICKS: z.coerce.number().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables', parsed.error.format());
  process.exit(1);
}

const env = parsed.data;

function remoteProcessorBase(url: string) {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/(?:\/process(?:-batch|-video)?|\/api\/upload(?:\/batch|\/video)?)$/i, '');
}

function lskyUploadEndpoint(url: string | undefined) {
  const trimmed = url?.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  if (/\/api\/v\d+\/upload(?:\/batch)?$/i.test(trimmed)) {
    return trimmed.replace(/\/api\/v\d+\/upload(?:\/batch)?$/i, '/api/upload');
  }
  if (/\/api\/upload\/batch$/i.test(trimmed)) return trimmed.replace(/\/batch$/i, '');
  if (/\/api\/upload$/i.test(trimmed)) return trimmed;
  if (/\/api\/v\d+$/i.test(trimmed)) return trimmed.replace(/\/api\/v\d+$/i, '/api/upload');
  if (/\/api$/i.test(trimmed)) return `${trimmed}/upload`;
  return `${trimmed}/api/upload`;
}

function normalizePublicBaseUrl(value: string | undefined, publicBaseUrl: string) {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${publicBaseUrl}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`.replace(/\/+$/, '');
}

function commaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

const publicBaseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, '');
const videoPublicBaseUrl = normalizePublicBaseUrl(
  env.VIDEO_PUBLIC_BASE_URL ?? env.LOCAL_VIDEO_PUBLIC_URL ?? '/videos',
  publicBaseUrl,
) ?? `${publicBaseUrl}/videos`;
const legacyLskyImageEndpoint = lskyUploadEndpoint(env.LSKY_API_URL);
const remoteProcessorUrl = env.REMOTE_PROCESSOR_URL ? remoteProcessorBase(env.REMOTE_PROCESSOR_URL) : undefined;
const remoteProcessorApiKey = env.REMOTE_PROCESSOR_API_KEY ?? env.PROCESSOR_API_KEY;
const imageEndpointSource = env.UPLOAD_IMAGE_ENDPOINT ? 'explicit' : legacyLskyImageEndpoint ? 'lsky' : remoteProcessorUrl ? 'remote' : undefined;
const fileEndpointSource = env.UPLOAD_FILE_ENDPOINT ? 'explicit' : remoteProcessorUrl ? 'remote' : undefined;
const imageEndpoint = env.UPLOAD_IMAGE_ENDPOINT
  ?? legacyLskyImageEndpoint
  ?? (remoteProcessorUrl ? `${remoteProcessorUrl}/process` : undefined);
const imageBatchEndpoint = env.UPLOAD_IMAGE_BATCH_ENDPOINT
  ?? (legacyLskyImageEndpoint ? `${legacyLskyImageEndpoint}/batch` : undefined)
  ?? (remoteProcessorUrl ? `${remoteProcessorUrl}/process-batch` : undefined);
const fileEndpoint = env.UPLOAD_FILE_ENDPOINT
  ?? (remoteProcessorUrl ? `${remoteProcessorUrl}/process-video` : undefined);
const imageUsesRemoteProcessor = Boolean(
  imageEndpointSource !== 'lsky' && imageEndpoint && remoteProcessorUrl && imageEndpoint.startsWith(remoteProcessorUrl),
);
const fileUsesRemoteProcessor = Boolean(
  fileEndpoint && remoteProcessorUrl && fileEndpoint.startsWith(remoteProcessorUrl),
);

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  publicBaseUrl,
  db: env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASS ?? env.DB_PASSWORD,
        database: env.DB_NAME ?? env.DB_DATABASE,
      },
  searchDb: env.SEARCH_DATABASE_URL
    ? { connectionString: env.SEARCH_DATABASE_URL }
    : env.SEARCH_DB_HOST
      ? {
          host: env.SEARCH_DB_HOST,
          port: env.SEARCH_DB_PORT ?? env.DB_PORT,
          user: env.SEARCH_DB_USER ?? env.DB_USER,
          password: env.SEARCH_DB_PASSWORD ?? env.SEARCH_DB_PASS ?? env.DB_PASSWORD,
          database: env.SEARCH_DB_DATABASE ?? env.SEARCH_DB_NAME ?? env.DB_DATABASE,
        }
      : null,
  remoteSearchDb: env.REMOTE_SEARCH_DATABASE_URL
    ? { connectionString: env.REMOTE_SEARCH_DATABASE_URL }
    : env.REMOTE_SEARCH_DB_HOST
      ? {
          host: env.REMOTE_SEARCH_DB_HOST,
          port: env.REMOTE_SEARCH_DB_PORT ?? env.DB_PORT,
          user: env.REMOTE_SEARCH_DB_USER,
          password: env.REMOTE_SEARCH_DB_PASSWORD ?? env.REMOTE_SEARCH_DB_PASS,
          database: env.REMOTE_SEARCH_DB_DATABASE ?? env.REMOTE_SEARCH_DB_NAME,
        }
      : null,
  searchSync: {
    enabled: env.SEARCH_SYNC_ENABLED,
    intervalMs: env.SEARCH_SYNC_INTERVAL_MS,
    initialDelayMs: env.SEARCH_SYNC_INITIAL_DELAY_MS,
    batchSize: env.SEARCH_SYNC_BATCH_SIZE,
    recentLimit: env.SEARCH_SYNC_RECENT_LIMIT,
    queryTimeoutMs: env.SEARCH_SYNC_QUERY_TIMEOUT_MS,
  },
  backup: {
    enabled: env.BACKUP_ENABLED,
    dir: resolve(env.BACKUP_DIR),
    keepDays: env.BACKUP_KEEP_DAYS,
    hour: env.BACKUP_HOUR,
    runOnStart: env.BACKUP_RUN_ON_START,
    pgDumpBin: env.BACKUP_PG_DUMP_BIN,
    excludeTableData: env.BACKUP_EXCLUDE_TABLE_DATA.split(',').map((table) => table.trim()).filter(Boolean),
  },
  chatLogBackup: {
    enabled: env.CHAT_LOG_BACKUP_ENABLED,
    dir: resolve(env.CHAT_LOG_BACKUP_DIR),
    keepDays: env.CHAT_LOG_BACKUP_KEEP_DAYS,
    hour: env.CHAT_LOG_BACKUP_HOUR,
    runOnStart: env.CHAT_LOG_BACKUP_RUN_ON_START,
    windowDays: env.CHAT_LOG_BACKUP_WINDOW_DAYS,
  },
  r2Backup: {
    remote: env.R2_BACKUP_REMOTE,
    rcloneBin: env.R2_BACKUP_RCLONE_BIN,
  },
  imghostDb: env.IMGHOST_DATABASE_URL
    ? { connectionString: env.IMGHOST_DATABASE_URL, max: env.IMGHOST_DB_MAX }
    : env.IMGHOST_DB_HOST
      ? {
          host: env.IMGHOST_DB_HOST,
          port: env.IMGHOST_DB_PORT ?? 5432,
          user: env.IMGHOST_DB_USER ?? 'imghost',
          password: env.IMGHOST_DB_PASSWORD ?? env.IMGHOST_DB_PASS ?? '',
          database: env.IMGHOST_DB_DATABASE ?? env.IMGHOST_DB_NAME ?? 'imghost',
          max: env.IMGHOST_DB_MAX,
        }
      : null,
  bgm: {
    appId: env.BGM_APP_ID,
    appSecret: env.BGM_APP_SECRET,
    callbackUrl: env.BGM_CALLBACK_URL ?? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/v1/auth/callback`,
    apiBase: env.BGM_API_BASE.replace(/\/$/, ''),
    origin: env.BGM_ORIGIN.replace(/\/$/, ''),
    dollarsPath: env.BGM_DOLLARS_PATH.startsWith('/') ? env.BGM_DOLLARS_PATH : `/${env.BGM_DOLLARS_PATH}`,
    cookieJson: env.BGM_COOKIE_JSON,
    userAgent: env.BGM_USER_AGENT,
    accessToken: env.BANGUMI_ACCESS_TOKEN ?? env.BANGUMI_API_TOKEN,
  },
  bot: {
    userId: env.BOT_USER_ID,
    nickname: env.BOT_NICKNAME,
    memoryFile: resolve(env.BOT_MEMORY_FILE),
  },
  corsOrigins: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  adminPassword: env.ADMIN_PASSWORD,
  communityEmojiDir: env.COMMUNITY_EMOJI_DIR,
  emoteConfigPath: env.EMOTE_CONFIG_PATH,
  media: {
    videosPath: resolve(env.VIDEOS_PATH),
    publicDir: resolve(env.PUBLIC_DIR),
    videoPublicBaseUrl,
    legacyVideoBaseUrls: commaList(env.LEGACY_VIDEO_BASE_URLS)
      .map((baseUrl) => normalizePublicBaseUrl(baseUrl, publicBaseUrl))
      .filter((baseUrl): baseUrl is string => Boolean(baseUrl)),
  },
  upload: {
    imageEndpoint,
    imageField: env.UPLOAD_IMAGE_FIELD ?? 'image',
    imageBatchEndpoint,
    imageBatchField: env.UPLOAD_IMAGE_BATCH_FIELD ?? 'images',
    fileEndpoint,
    fileField: env.UPLOAD_FILE_FIELD ?? (fileEndpointSource === 'remote' ? 'video' : 'file'),
    imageAuthHeader: env.UPLOAD_AUTH_TOKEN ? env.UPLOAD_AUTH_HEADER : imageUsesRemoteProcessor ? 'x-api-key' : undefined,
    imageAuthToken: env.UPLOAD_AUTH_TOKEN ?? (imageUsesRemoteProcessor ? remoteProcessorApiKey : undefined),
    fileAuthHeader: env.UPLOAD_AUTH_TOKEN ? env.UPLOAD_AUTH_HEADER : fileUsesRemoteProcessor ? 'x-api-key' : undefined,
    fileAuthToken: env.UPLOAD_AUTH_TOKEN ?? (fileUsesRemoteProcessor ? remoteProcessorApiKey : undefined),
  },
  ws: {
    path: env.WS_PATH,
  },
  tailer: {
    enabled: env.DB_TAIL_ENABLED,
    intervalMs: env.DB_TAIL_INTERVAL_MS,
    batchSize: env.DB_TAIL_BATCH_SIZE,
  },
  scraper: {
    enabled: env.SCRAPER_ENABLED,
    intervalMs: env.SCRAPER_INTERVAL_MS ?? env.SCRAPE_INTERVAL_MS ?? 5000,
    safetySweepWindowSec: env.SCRAPER_SAFETY_SWEEP_WINDOW_SEC,
    safetySweepEveryTicks: env.SCRAPER_SAFETY_SWEEP_EVERY_TICKS,
  },
};

export type AppConfig = typeof config;
