import { stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env.js';
import { ApiError, corsHeaders } from '../utils/http.js';

const MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.avi': 'video/x-msvideo',
  '.css': 'text/css; charset=utf-8',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function resolveStaticPath(root: string, prefix: string, pathname: string) {
  const relative = decodeURIComponent(pathname.replace(prefix, '')).replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) throw new ApiError(404, 'Not found');

  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, relative);
  if (!filePath.startsWith(`${rootPath}${path.sep}`) && filePath !== rootPath) {
    throw new ApiError(403, 'Forbidden');
  }
  return filePath;
}

function parseRange(rangeHeader: string | null, size: number) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  let start = rawStart ? Number(rawStart) : 0;
  let end = rawEnd ? Number(rawEnd) : size - 1;

  if (!rawStart && rawEnd) {
    const suffixLength = Number(rawEnd);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return 'invalid';
  }

  return { start, end: Math.min(end, size - 1) };
}

async function serveStaticFile(request: Request, root: string, prefix: string, pathname: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(404, 'Not found');

  const filePath = resolveStaticPath(root, prefix, pathname);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) throw new ApiError(404, 'Not found');

  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const baseHeaders = {
    ...corsHeaders(request),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=2592000, immutable',
    'content-type': contentType,
  };
  const file = Bun.file(filePath);
  const range = parseRange(request.headers.get('range'), fileStat.size);

  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'content-range': `bytes */${fileStat.size}` },
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    return new Response(request.method === 'HEAD' ? null : file.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
      },
    });
  }

  return new Response(request.method === 'HEAD' ? null : file, {
    headers: { ...baseHeaders, 'content-length': String(fileStat.size) },
  });
}

export function serveVideoAsset(request: Request, pathname: string) {
  return serveStaticFile(request, config.media.videosPath, '/videos/', pathname);
}

export function servePublicAsset(request: Request, pathname: string) {
  return serveStaticFile(request, config.media.publicDir, '/public/', pathname);
}
