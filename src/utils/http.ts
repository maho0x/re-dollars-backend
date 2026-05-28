import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import type { AuthUser, RequestContext } from '../types.js';
import { getUserForToken } from '../services/authService.js';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}, request?: Request) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
      ...init.headers,
    },
  });
}

export function noContent(request?: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function corsHeaders(request?: Request): HeadersInit {
  const origin = request?.headers.get('origin') ?? '';
  const allowOrigin = config.corsOrigins.includes(origin) ? origin : config.corsOrigins[0] ?? '*';

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization',
    vary: 'Origin',
  };
}

export function optionsResponse(request: Request) {
  return noContent(request);
}

export async function parseJson<T = unknown>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, 'Invalid JSON body');
  }
}

export function parseIntParam(value: string | null | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function getBearerToken(request: Request) {
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)dollars_auth=([^;]+)/);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

export async function createContext(request: Request): Promise<RequestContext> {
  const token = getBearerToken(request);
  let user: AuthUser | null = null;
  if (token) {
    user = await getUserForToken(token);
  }
  return { user, requestId: randomUUID() };
}

export function requireAuth(ctx: RequestContext): AuthUser {
  if (!ctx.user) {
    throw new ApiError(401, 'Unauthorized');
  }
  return ctx.user;
}

export function errorResponse(error: unknown, request: Request) {
  if (error instanceof ApiError) {
    return json({ status: false, message: error.message, details: error.details }, { status: error.statusCode }, request);
  }

  console.error('[http] unhandled error', error);
  return json({ status: false, message: 'Internal server error' }, { status: 500 }, request);
}
