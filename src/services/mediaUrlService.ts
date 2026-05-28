import { config } from '../config/env.js';

function trimBase(value: string) {
  return value.replace(/\/+$/, '');
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function relativeVideoPath(value: string, includeAbsolute = true) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/videos/')) return trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  if (!includeAbsolute) return null;

  try {
    const url = new URL(trimmed);
    return url.pathname.startsWith('/videos/') ? url.pathname : null;
  } catch {
    return null;
  }
}

function rewriteFromBase(value: string, baseUrl: string) {
  const base = trimBase(baseUrl);
  if (value === base) return base;
  if (!value.startsWith(`${base}/`)) return null;
  return `${trimBase(config.media.videoPublicBaseUrl)}${value.slice(base.length)}`;
}

export function normalizeServedVideoUrl(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const direct = rewriteFromBase(trimmed, config.media.videoPublicBaseUrl);
  if (direct) return direct;

  for (const legacyBase of config.media.legacyVideoBaseUrls) {
    const rewritten = rewriteFromBase(trimmed, legacyBase);
    if (rewritten) return rewritten;
  }

  const relative = relativeVideoPath(trimmed, false);
  if (relative) return `${trimBase(config.media.videoPublicBaseUrl)}${relative.slice('/videos'.length)}`;
  return undefined;
}

export function videoMetadataLookupKeys(value: string) {
  const relative = relativeVideoPath(value);
  return unique([
    value,
    normalizeServedVideoUrl(value),
    relative,
    relative ? `${trimBase(config.media.videoPublicBaseUrl)}${relative.slice('/videos'.length)}` : null,
    ...config.media.legacyVideoBaseUrls.map((baseUrl) => (
      relative ? `${trimBase(baseUrl)}${relative.slice('/videos'.length)}` : null
    )),
  ]);
}
