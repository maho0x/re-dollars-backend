import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { ApiError } from '../utils/http.js';
import type { AuthUser } from '../types.js';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let serviceAccount: ServiceAccount | null | undefined;

function getServiceAccount(): ServiceAccount | null {
  if (serviceAccount !== undefined) return serviceAccount;
  serviceAccount = null;
  try {
    const raw = config.push.serviceAccountJson
      ?? (config.push.serviceAccountFile ? readFileSync(config.push.serviceAccountFile, 'utf8') : null);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        serviceAccount = { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key };
      } else {
        console.warn('[push] service account JSON is missing project_id/client_email/private_key');
      }
    }
  } catch (err) {
    console.warn('[push] failed to load FCM service account:', err instanceof Error ? err.message : err);
  }
  return serviceAccount;
}

export function pushEnabled() {
  return getServiceAccount() !== null;
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let accessTokenRequest: Promise<string | null> | null = null;

async function fetchAccessToken(account: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(account.private_key).toString('base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    console.warn('[push] OAuth token exchange failed:', response.status, await response.text().catch(() => ''));
    return null;
  }
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };
  return data.access_token;
}

async function getAccessToken(account: ServiceAccount): Promise<string | null> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) return cachedAccessToken.token;
  if (accessTokenRequest) return accessTokenRequest;
  accessTokenRequest = fetchAccessToken(account).finally(() => {
    accessTokenRequest = null;
  });
  return accessTokenRequest;
}

export async function registerPushToken(user: AuthUser, body: unknown) {
  const token = String((body as { token?: string }).token ?? '').trim();
  if (!token || token.length > 4096) throw new ApiError(400, 'token is required');
  const platform = String((body as { platform?: string }).platform ?? 'android').slice(0, 20);
  await pool.query(
    `INSERT INTO push_tokens (token, user_id, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = NOW()`,
    [token, user.id, platform],
  );
  return { status: true };
}

export async function unregisterPushToken(body: unknown) {
  const token = String((body as { token?: string }).token ?? '').trim();
  if (!token) throw new ApiError(400, 'token is required');
  await pool.query('DELETE FROM push_tokens WHERE token = $1', [token]);
  return { status: true };
}

async function deleteToken(token: string) {
  await pool.query('DELETE FROM push_tokens WHERE token = $1', [token]).catch(() => {});
}

interface PushPayload {
  id: number;
  message_id: number;
  uid: string | number;
  nickname: string;
  avatar: string;
  content: string;
  timestamp: number;
  type: string;
}

async function sendToToken(account: ServiceAccount, accessToken: string, token: string, payload: PushPayload) {
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          data: {
            notification_id: String(payload.id),
            message_id: String(payload.message_id),
            uid: String(payload.uid),
            nickname: payload.nickname ?? '',
            avatar: payload.avatar ?? '',
            content: (payload.content ?? '').slice(0, 2048),
            timestamp: String(payload.timestamp),
            type: payload.type ?? 'mention',
          },
          android: { priority: 'HIGH' },
        },
      }),
    },
  );
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  if (response.status === 404 || text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) {
    await deleteToken(token);
  } else {
    console.warn('[push] FCM send failed:', response.status, text.slice(0, 300));
  }
}

export async function sendPushToUser(uid: string | number, payload: PushPayload) {
  const account = getServiceAccount();
  if (!account) return;
  try {
    const { rows } = await pool.query<{ token: string }>(
      'SELECT token FROM push_tokens WHERE user_id = $1',
      [Number(uid)],
    );
    if (rows.length === 0) return;
    const accessToken = await getAccessToken(account);
    if (!accessToken) return;
    await Promise.all(rows.map((row) => sendToToken(account, accessToken, row.token, payload)));
  } catch (err) {
    console.warn('[push] sendPushToUser failed:', err instanceof Error ? err.message : err);
  }
}
