import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env.js';
import { ApiError } from '../utils/http.js';

type EmoteConfig = {
  enabled: boolean;
  description: string;
  mapping: Record<string, string>;
};

let cachedConfig: EmoteConfig | null | undefined;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

async function walkEmojiDir(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkEmojiDir(fullPath, relative));
    } else if (IMAGE_TYPES[path.extname(entry.name).toLowerCase()]) {
      files.push(relative);
    }
  }
  return files;
}

export async function listCommunityEmojis(requestUrl: URL) {
  if (!config.communityEmojiDir) return { status: true, data: [] };
  const files = await walkEmojiDir(config.communityEmojiDir);
  const base = `${requestUrl.protocol}//${requestUrl.host}`;
  return { status: true, data: files.map((file) => `${base}/emojis/${file}`) };
}

export async function getEmojiMeanings() {
  if (cachedConfig !== undefined) {
    return { status: true, data: cachedConfig ?? { enabled: false, description: '', mapping: {} } };
  }

  if (!config.emoteConfigPath) {
    cachedConfig = null;
    return { status: true, data: { enabled: false, description: '', mapping: {} } };
  }

  try {
    const raw = await readFile(config.emoteConfigPath, 'utf8');
    const data = JSON.parse(raw) as { emoteConfig?: EmoteConfig };
    cachedConfig = data.emoteConfig && typeof data.emoteConfig.mapping === 'object' ? data.emoteConfig : null;
  } catch {
    cachedConfig = null;
  }

  return { status: true, data: cachedConfig ?? { enabled: false, description: '', mapping: {} } };
}

export async function serveCommunityEmoji(pathname: string) {
  if (!config.communityEmojiDir) throw new ApiError(404, 'Not found');
  const relative = decodeURIComponent(pathname.replace(/^\/emojis\/?/, ''));
  if (!relative || relative.includes('\0')) throw new ApiError(404, 'Not found');

  const root = path.resolve(config.communityEmojiDir);
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) throw new ApiError(403, 'Forbidden');

  const ext = path.extname(filePath).toLowerCase();
  const contentType = IMAGE_TYPES[ext];
  if (!contentType) throw new ApiError(404, 'Not found');

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new ApiError(404, 'Not found');

  return new Response(Bun.file(filePath), {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
