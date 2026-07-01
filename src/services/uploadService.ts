import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { ApiError, corsHeaders } from '../utils/http.js';
import { normalizeServedVideoUrl, videoMetadataLookupKeys } from './mediaUrlService.js';

type UploadKind = 'image' | 'file';

export interface NormalizedUploadResponse extends Record<string, unknown> {
  status: boolean;
  url: string;
  imageUrl?: string;
  fileUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  placeholder?: string;
  message?: string;
}

export interface NormalizedUploadBatchResponse extends Record<string, unknown> {
  status: boolean;
  total: number;
  succeeded: number;
  failed: number;
  items: NormalizedUploadResponse[];
  message?: string;
}

interface QueryablePool {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function absoluteUrl(value: string | undefined, fallbackBaseUrl: string) {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${fallbackBaseUrl.replace(/\/$/, '')}${value.startsWith('/') ? value : `/${value}`}`;
}

export function normalizeUploadResponse(data: unknown, fallbackBaseUrl: string, kind: UploadKind): NormalizedUploadResponse {
  const body = recordValue(data) ?? {};
  const nested = recordValue(body.data);
  const links = recordValue(nested?.links ?? body.links);
  const rawImageUrl = stringValue(
    body.imageUrl ??
      body.image_url ??
      nested?.imageUrl ??
      nested?.image_url ??
      nested?.url ??
      nested?.pathname ??
      nested?.path ??
      links?.imageUrl ??
      links?.image_url ??
      links?.url,
  );
  const rawVideoUrl = stringValue(
    body.videoUrl ??
      body.video_url ??
      nested?.videoUrl ??
      nested?.video_url ??
      body.fileUrl ??
      body.file_url ??
      nested?.fileUrl ??
      nested?.file_url,
  );
  const rawFileUrl = stringValue(
    body.fileUrl ?? body.file_url ?? nested?.fileUrl ?? nested?.file_url ?? rawVideoUrl,
  );
  const rawThumbnailUrl = stringValue(
    body.thumbnailUrl ??
      body.thumbnail_url ??
      nested?.thumbnailUrl ??
      nested?.thumbnail_url ??
      links?.thumbnailUrl ??
      links?.thumbnail_url,
  );
  const rawUrl = stringValue(
    body.url ??
      (kind === 'image' ? rawImageUrl : rawVideoUrl) ??
      rawFileUrl ??
      rawImageUrl ??
      nested?.path ??
      nested?.pathname ??
      links?.url,
  );

  const url = absoluteUrl(rawUrl, fallbackBaseUrl) ?? '';
  const imageUrl = absoluteUrl(rawImageUrl ?? (kind === 'image' ? rawUrl : rawThumbnailUrl), fallbackBaseUrl);
  const videoUrl = normalizeServedVideoUrl(absoluteUrl(rawVideoUrl ?? (kind === 'file' ? rawUrl : undefined), fallbackBaseUrl));
  const fileUrl = normalizeServedVideoUrl(absoluteUrl(rawFileUrl ?? (kind === 'file' ? rawUrl : undefined), fallbackBaseUrl));
  const thumbnailUrl = absoluteUrl(rawThumbnailUrl, fallbackBaseUrl);
  const primaryUrl = kind === 'file' ? (videoUrl ?? fileUrl ?? normalizeServedVideoUrl(url) ?? url) : url;
  const width = numberValue(body.width ?? nested?.width);
  const height = numberValue(body.height ?? nested?.height);
  const duration = numberValue(body.duration ?? nested?.duration);
  const placeholder = stringValue(body.placeholder ?? nested?.placeholder);
  const message = stringValue(body.message ?? body.error ?? nested?.message ?? nested?.error);

  const normalized: NormalizedUploadResponse = {
    ...body,
    status: body.status !== false && Boolean(primaryUrl),
    url: primaryUrl,
  };
  if (imageUrl) normalized.imageUrl = imageUrl;
  if (fileUrl) normalized.fileUrl = fileUrl;
  if (videoUrl) normalized.videoUrl = videoUrl;
  if (thumbnailUrl) normalized.thumbnailUrl = thumbnailUrl;
  if (width != null) normalized.width = width;
  if (height != null) normalized.height = height;
  if (duration != null) normalized.duration = duration;
  if (placeholder) normalized.placeholder = placeholder;
  if (message) normalized.message = message;
  return normalized;
}

export function normalizeUploadBatchResponse(data: unknown, fallbackBaseUrl: string): NormalizedUploadBatchResponse {
  const body = recordValue(data) ?? {};
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : [];
  const items = rawItems.map((item) => normalizeUploadResponse(item, fallbackBaseUrl, 'image'));
  const total = numberValue(body.total) ?? items.length;
  const succeeded = numberValue(body.succeeded) ?? items.filter((item) => item.status).length;
  const failed = numberValue(body.failed) ?? Math.max(total - succeeded, 0);
  const message = stringValue(body.message ?? body.error);

  const normalized: NormalizedUploadBatchResponse = {
    ...body,
    status: body.status !== false && succeeded > 0 && failed === 0,
    total,
    succeeded,
    failed,
    items,
  };
  if (message) normalized.message = message;
  return normalized;
}

function metadataItems(body: unknown) {
  const record = recordValue(body);
  const rawItems = Array.isArray(record?.items) ? record.items : [body];
  return rawItems
    .map((item) => {
      const row = recordValue(item);
      if (!row || row.status === false) return null;
      const imageUrl = stringValue(row.imageUrl ?? row.image_url ?? row.url);
      const width = numberValue(row.width);
      const height = numberValue(row.height);
      if (!imageUrl || !width || !height || width <= 0 || height <= 0) return null;
      return {
        imageUrl,
        width,
        height,
        placeholder: stringValue(row.placeholder) ?? null,
      };
    })
    .filter((item): item is { imageUrl: string; width: number; height: number; placeholder: string | null } => item !== null);
}

export async function upsertImageMetadataFromUpload(body: unknown, queryPool: QueryablePool = pool) {
  const items = metadataItems(body);
  for (const item of items) {
    await queryPool.query(
      `INSERT INTO image_metadata (image_url, width, height, placeholder)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (image_url) DO UPDATE SET width = $2, height = $3, placeholder = $4`,
      [item.imageUrl, item.width, item.height, item.placeholder],
    );
  }

  return { status: true, upserted: items.length };
}

async function persistUploadMetadata(kind: UploadKind, upload: NormalizedUploadResponse) {
  if (kind === 'image') {
    const imageUrl = upload.imageUrl ?? upload.url;
    if (imageUrl && upload.width != null && upload.height != null) {
      await pool.query(
        `INSERT INTO image_metadata (image_url, width, height, placeholder)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (image_url) DO UPDATE SET width = $2, height = $3, placeholder = $4`,
        [imageUrl, upload.width, upload.height, upload.placeholder ?? null],
      );
    }
    return;
  }

  const videoUrl = upload.videoUrl ?? upload.fileUrl ?? upload.url;
  if (videoUrl) {
    const thumbnailUrl = upload.thumbnailUrl ?? (upload.imageUrl && upload.imageUrl !== videoUrl ? upload.imageUrl : null);
    for (const metadataKey of videoMetadataLookupKeys(videoUrl)) {
      await pool.query(
        `INSERT INTO video_metadata (video_url, thumbnail_url, width, height, duration)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (video_url) DO UPDATE SET
           thumbnail_url = $2,
           width = $3,
           height = $4,
           duration = $5`,
        [
          metadataKey,
          thumbnailUrl,
          upload.width ?? null,
          upload.height ?? null,
          upload.duration ?? null,
        ],
      );
    }
  }
}

export async function proxyUpload(request: Request, kind: UploadKind) {
  const endpoint = kind === 'image'
    ? config.upload.imageEndpoint
    : (config.upload.fileEndpoint ?? config.upload.imageEndpoint);
  const field = kind === 'image' ? config.upload.imageField : config.upload.fileField;
  if (!endpoint) throw new ApiError(501, 'Upload proxy is not configured');

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    throw new ApiError(400, 'Invalid multipart form data');
  }
  const file = incoming.get(kind === 'image' ? 'image' : 'file') ?? incoming.get('image') ?? incoming.get('file');
  if (!(file instanceof File)) throw new ApiError(400, 'No file received');

  const outgoing = new FormData();
  outgoing.set(field, file, file.name);

  const headers = new Headers();
  const authHeader = kind === 'image' ? config.upload.imageAuthHeader : config.upload.fileAuthHeader;
  const authToken = kind === 'image' ? config.upload.imageAuthToken : config.upload.fileAuthToken;
  if (authHeader && authToken) headers.set(authHeader, authToken);

  const response = await fetch(endpoint, { method: 'POST', headers, body: outgoing });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : { status: response.ok, message: await response.text() };
  const normalized = normalizeUploadResponse(data, new URL(endpoint).origin, kind);

  if (!response.ok || !normalized.status) {
    return new Response(JSON.stringify(normalized), {
      status: response.ok ? 502 : response.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) },
    });
  }

  await persistUploadMetadata(kind, normalized).catch((err) => {
    console.warn('[upload] metadata persistence failed:', err instanceof Error ? err.message : err);
  });

  return new Response(JSON.stringify(normalized), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) },
  });
}

export async function proxyImageBatchUpload(request: Request) {
  const endpoint = config.upload.imageBatchEndpoint ?? config.upload.imageEndpoint;
  const field = config.upload.imageBatchField;
  if (!endpoint) throw new ApiError(501, 'Upload proxy is not configured');

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    throw new ApiError(400, 'Invalid multipart form data');
  }

  const files = [
    ...incoming.getAll('images'),
    ...incoming.getAll('image'),
    ...incoming.getAll('files'),
    ...incoming.getAll('file'),
  ].filter((item): item is File => item instanceof File);
  if (!files.length) throw new ApiError(400, 'No file received');

  const outgoing = new FormData();
  for (const file of files) {
    outgoing.append(field, file, file.name);
  }

  const headers = new Headers();
  if (config.upload.imageAuthHeader && config.upload.imageAuthToken) {
    headers.set(config.upload.imageAuthHeader, config.upload.imageAuthToken);
  }

  const response = await fetch(endpoint, { method: 'POST', headers, body: outgoing });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : { status: response.ok, message: await response.text() };
  const normalized = normalizeUploadBatchResponse(data, new URL(endpoint).origin);

  if (!response.ok || !normalized.status) {
    return new Response(JSON.stringify(normalized), {
      status: response.ok ? 502 : response.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) },
    });
  }

  await Promise.all(
    normalized.items.map((item) => persistUploadMetadata('image', item).catch((err) => {
      console.warn('[upload] metadata persistence failed:', err instanceof Error ? err.message : err);
    })),
  );

  return new Response(JSON.stringify(normalized), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) },
  });
}
