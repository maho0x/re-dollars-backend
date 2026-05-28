import { describe, expect, it } from 'bun:test';
import { normalizeServedVideoUrl, videoMetadataLookupKeys } from './mediaUrlService.js';

describe('media URL migration helpers', () => {
  it('rewrites configured legacy video hosts to the new video base URL', () => {
    expect(normalizeServedVideoUrl('https://bgmchat.ry.mk/videos/foo.mp4')).toBe(
      'https://rd.ry.mk/videos/foo.mp4',
    );
    expect(normalizeServedVideoUrl('/videos/2026/05/foo.mp4')).toBe(
      'https://rd.ry.mk/videos/2026/05/foo.mp4',
    );
  });

  it('does not rewrite arbitrary external hosts with a /videos path', () => {
    expect(normalizeServedVideoUrl('https://cdn.example/videos/foo.mp4')).toBeUndefined();
  });

  it('builds metadata lookup keys for old, relative, and new video URLs', () => {
    expect(videoMetadataLookupKeys('https://bgmchat.ry.mk/videos/foo.mp4')).toEqual([
      'https://bgmchat.ry.mk/videos/foo.mp4',
      'https://rd.ry.mk/videos/foo.mp4',
      '/videos/foo.mp4',
    ]);
  });
});
