import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { config } from '../config/env.js';
import { isAllowedOrigin, corsHeaders } from './http.js';
import { isBangumiHost } from '../services/previewService.js';

describe('CORS Wildcard and Mirror Site Compatibility', () => {
  let originalCorsOrigins: string[];
  let originalBgmOrigin: string;

  beforeAll(() => {
    originalCorsOrigins = [...config.corsOrigins];
    originalBgmOrigin = config.bgm.origin;
  });

  afterAll(() => {
    config.corsOrigins = originalCorsOrigins;
    config.bgm.origin = originalBgmOrigin;
  });

  it('isAllowedOrigin matches exact domains', () => {
    config.corsOrigins = ['https://bangumi.tv', 'https://bgm.tv'];
    expect(isAllowedOrigin('https://bangumi.tv')).toBe(true);
    expect(isAllowedOrigin('https://bgm.tv')).toBe(true);
    expect(isAllowedOrigin('https://chii.in')).toBe(false);
  });

  it('isAllowedOrigin matches wildcards', () => {
    config.corsOrigins = ['https://*.bangumi.tv', 'https://*.anibt.net'];
    expect(isAllowedOrigin('https://mirror.bangumi.tv')).toBe(true);
    expect(isAllowedOrigin('https://bgmmi.anibt.net')).toBe(true);
    expect(isAllowedOrigin('https://bangumi.tv')).toBe(false); // needs subdomain if using *.
    expect(isAllowedOrigin('https://anibt.net')).toBe(false);
  });

  it('isAllowedOrigin matches global wildcard *', () => {
    config.corsOrigins = ['*'];
    expect(isAllowedOrigin('https://any-domain.com')).toBe(true);
    expect(isAllowedOrigin('https://mirror.la')).toBe(true);
  });

  it('corsHeaders returns correct header for matched origin', () => {
    config.corsOrigins = ['https://*.bangumi.tv'];
    const req = new Request('https://api.test/messages', {
      headers: { origin: 'https://mirror.bangumi.tv' },
    });
    const headers = corsHeaders(req);
    expect((headers as Record<string, string>)['access-control-allow-origin']).toBe('https://mirror.bangumi.tv');
  });

  it('corsHeaders falls back to default origin when no match', () => {
    config.corsOrigins = ['https://bangumi.tv', 'https://bgm.tv'];
    const req = new Request('https://api.test/messages', {
      headers: { origin: 'https://malicious.com' },
    });
    const headers = corsHeaders(req);
    expect((headers as Record<string, string>)['access-control-allow-origin']).toBe('https://bangumi.tv');
  });

  it('isBangumiHost recognizes default hosts', () => {
    config.corsOrigins = [];
    config.bgm.origin = 'https://bangumi.tv';
    expect(isBangumiHost('bangumi.tv')).toBe(true);
    expect(isBangumiHost('bgm.tv')).toBe(true);
    expect(isBangumiHost('chii.in')).toBe(true);
    expect(isBangumiHost('www.bangumi.tv')).toBe(true);
  });

  it('isBangumiHost recognizes configured BGM_ORIGIN', () => {
    config.corsOrigins = [];
    config.bgm.origin = 'https://custom-mirror.com';
    expect(isBangumiHost('custom-mirror.com')).toBe(true);
    expect(isBangumiHost('www.custom-mirror.com')).toBe(true);
    expect(isBangumiHost('another.com')).toBe(false);
  });

  it('isBangumiHost recognizes CORS origins', () => {
    config.corsOrigins = ['https://*.anibt.net', 'https://bangumi.one'];
    config.bgm.origin = 'https://bangumi.tv';
    expect(isBangumiHost('bgmmi.anibt.net')).toBe(true);
    expect(isBangumiHost('bangumi.one')).toBe(true);
    expect(isBangumiHost('unallowed-mirror.com')).toBe(false);
  });
});
