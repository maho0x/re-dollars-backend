import { pool } from '../db/pool.js';

const globalBlocklist = new Set<string>();

export const loadGlobalBlocklist = async () => {
    try {
        const { rows } = await pool.query('SELECT user_id FROM global_blocklist');
        globalBlocklist.clear();
        rows.forEach(row => globalBlocklist.add(String(row.user_id)));
        console.log(`✅ Loaded ${globalBlocklist.size} users into the global blocklist cache.`);
    } catch (err) {
        console.error('❌ Error loading global blocklist:', err);
    }
};

export const isBlocked = (uid: string | number): boolean => {
    return globalBlocklist.has(String(uid));
};

export const addToBlocklist = async (uid: string | number) => {
    const userId = parseInt(String(uid), 10);
    if (isNaN(userId)) {
        throw new Error('Invalid user ID format.');
    }
    if (isBlocked(userId)) {
        return { success: true, message: 'User is already in the global blocklist.' };
    }

    await pool.query('INSERT INTO global_blocklist (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    globalBlocklist.add(String(userId));
    console.log(`[Admin] User ${userId} added to the global blocklist.`);
    return { success: true, message: `User ${userId} has been added to the global blocklist.` };
};

export const removeFromBlocklist = async (uid: string | number) => {
    const userId = parseInt(String(uid), 10);
    if (isNaN(userId)) {
        throw new Error('Invalid user ID format.');
    }
    if (!isBlocked(userId)) {
        return { success: false, message: 'User is not in the global blocklist.' };
    }

    await pool.query('DELETE FROM global_blocklist WHERE user_id = $1', [userId]);
    globalBlocklist.delete(String(userId));
    console.log(`[Admin] User ${userId} removed from the global blocklist.`);
    return { success: true, message: `User ${userId} has been removed from the global blocklist.` };
};

export const getBlocklist = () => {
    return Array.from(globalBlocklist);
};
