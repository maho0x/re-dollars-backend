/**
 * 验证 emoji 是否为有效的 reaction 表情
 * BGM 表情: (bgm1) 到 (bgm529)
 * BMO 表情: (bmoC...) 或 (bmo_...)
 */
export function isValidReactionEmoji(emoji: string): boolean {
    if (!emoji || typeof emoji !== 'string') return false;

    // BGM 表情: (bgm1) 到 (bgm529)，有效范围：1-23, 24-125, 200-238, 500-529
    const bgmMatch = emoji.match(/^\(bgm(\d+)\)$/);
    if (bgmMatch) {
        const id = parseInt(bgmMatch[1], 10);
        // TV: 24-125, BGM: 1-23, VS: 200-238, 500: 500-529
        return (id >= 1 && id <= 125) || (id >= 200 && id <= 238) || (id >= 500 && id <= 529);
    }

    // BMO 表情: (bmoC...) 或 (bmo_...)
    if (/^\(bmo(C|_)[a-zA-Z0-9_-]+\)$/.test(emoji)) {
        return true;
    }

    return false;
}
