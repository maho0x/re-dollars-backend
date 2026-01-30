import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    SESSION_SECRET: z.string().min(10, 'Session secret must be at least 10 characters long'),

    // Database Configuration
    DB_HOST: z.string().default('localhost'),
    DB_USER: z.string().default('bgmchat'),
    DB_PASS: z.string().optional(),
    DB_PASSWORD: z.string().optional(), // Legacy
    DB_NAME: z.string().optional(),
    DB_DATABASE: z.string().optional(), // Legacy
    DB_PORT: z.coerce.number().default(5432),

    // Search Database (Optional, defaulting to main DB if not set)
    SEARCH_DB_HOST: z.string().optional(),
    SEARCH_DB_USER: z.string().optional(),
    SEARCH_DB_PASS: z.string().optional(),
    SEARCH_DB_NAME: z.string().optional(),
    SEARCH_DB_PORT: z.coerce.number().optional(),

    // Remote Search Database (for Sync)
    REMOTE_SEARCH_DB_HOST: z.string().optional(),
    REMOTE_SEARCH_DB_USER: z.string().optional(),
    REMOTE_SEARCH_DB_PASS: z.string().optional(),
    REMOTE_SEARCH_DB_NAME: z.string().optional(),
    REMOTE_SEARCH_DB_PORT: z.coerce.number().optional(),

    // LSKY Database
    LSKY_DB_HOST: z.string().optional(),
    LSKY_DB_USER: z.string().optional(),
    LSKY_DB_PASS: z.string().optional(),
    LSKY_DB_NAME: z.string().optional(),
    LSKY_DB_PORT: z.coerce.number().optional(),

    // API Keys & External Services
    OPENAI_API_KEY: z.string().optional(),
    BANGUMI_ACCESS_TOKEN: z.string().optional(),
    BANGUMI_API_TOKEN: z.string().optional(), // Legacy

    // Bangumi API
    BGM_API_BASE: z.string().default('https://api.bgm.tv/v0'),
    BGM_ORIGIN: z.string().default('https://chii.in'),
    BGM_DOLLARS_PATH: z.string().default('/dollars'), // Default to the known Dollars topic
    BGM_COOKIE_JSON: z.string().default('[]'),
    BGM_USER_AGENT: z.string().default('DollarsScraper/2.1'),
    BGM_APP_ID: z.string().optional(),
    BGM_APP_SECRET: z.string().optional(),
    BGM_CALLBACK_URL: z.string().optional(),

    // Scraper
    SCRAPER_INTERVAL: z.coerce.number().optional(),
    SCRAPE_INTERVAL_MS: z.coerce.number().optional(), // Legacy

    // Image Services
    LSKY_API_URL: z.string().default(''),
    LSKY_TOKEN: z.string().default(''),
    LSKY_GIF_TOKEN: z.string().optional(),
    REMOTE_PROCESSOR_URL: z.string().optional(),

    // Storage Paths
    BACKUP_DIR: z.string().default('./backups'),
    VIDEOS_PATH: z.string().default('./videos'),

    // Video Processing
    VIDEO_PROCESSING_ENABLED: z.coerce.boolean().default(true),
    VIDEO_PROCESSING_QUALITY: z.enum(['low', 'medium', 'high']).default('medium'),
    VIDEO_PROCESSING_CODEC: z.enum(['h264', 'hevc', 'av1', 'vp9', 'auto']).default('auto'),
    VIDEO_MAX_CONCURRENT: z.coerce.number().default(1),
    VIDEO_COMPRESSION_THRESHOLD: z.coerce.number().default(10), // 压缩率阈值（百分比），超过此值删除原文件

    // GitHub Backup (Optional)
    GITHUB_BACKUP_REPO: z.string().optional(),
    GITHUB_BACKUP_TOKEN: z.string().optional(),
    GITHUB_BACKUP_TAG: z.string().default('db-backup'),
    ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
    console.error('❌ Invalid environment variables:', parsedEnv.error.format());
    process.exit(1);
}

export const env = parsedEnv.data;
export const config = {
    port: env.PORT,
    sessionSecret: env.SESSION_SECRET,

    // Database
    db: {
        host: env.DB_HOST,
        user: env.DB_USER,
        password: env.DB_PASS || env.DB_PASSWORD || 'password',
        database: env.DB_NAME || env.DB_DATABASE || 'bgmchat',
        port: env.DB_PORT,
    },
    searchDb: {
        host: env.SEARCH_DB_HOST,
        user: env.SEARCH_DB_USER,
        password: env.SEARCH_DB_PASS,
        database: env.SEARCH_DB_NAME,
        port: env.SEARCH_DB_PORT,
    },
    remoteSearchDb: {
        host: env.REMOTE_SEARCH_DB_HOST,
        user: env.REMOTE_SEARCH_DB_USER,
        password: env.REMOTE_SEARCH_DB_PASS,
        database: env.REMOTE_SEARCH_DB_NAME,
        port: env.REMOTE_SEARCH_DB_PORT,
    },
    lskyDb: {
        host: env.LSKY_DB_HOST,
        user: env.LSKY_DB_USER,
        password: env.LSKY_DB_PASS,
        database: env.LSKY_DB_NAME,
        port: env.LSKY_DB_PORT,
    },

    // Services
    bgm: {
        apiBase: env.BGM_API_BASE,
        origin: env.BGM_ORIGIN,
        dollarsPath: env.BGM_DOLLARS_PATH,
        cookieJson: env.BGM_COOKIE_JSON,
        userAgent: env.BGM_USER_AGENT,
        accessToken: env.BANGUMI_ACCESS_TOKEN || env.BANGUMI_API_TOKEN || '',
        appId: env.BGM_APP_ID,
        appSecret: env.BGM_APP_SECRET,
        callbackUrl: env.BGM_CALLBACK_URL,
        nextApiBase: 'https://next.bgm.tv/p1',
    },
    scraper: {
        intervalMs: env.SCRAPER_INTERVAL || env.SCRAPE_INTERVAL_MS || 5000,
    },
    lsky: {
        apiUrl: env.LSKY_API_URL,
        token: env.LSKY_TOKEN,
        gifToken: env.LSKY_GIF_TOKEN,
    },
    remoteProcessorUrl: env.REMOTE_PROCESSOR_URL,
    storage: {
        backupDir: env.BACKUP_DIR,
        videosPath: env.VIDEOS_PATH,
    },
    githubBackup: {
        repo: env.GITHUB_BACKUP_REPO,
        token: env.GITHUB_BACKUP_TOKEN,
        tag: env.GITHUB_BACKUP_TAG
    },
    adminPassword: env.ADMIN_PASSWORD,
};
