import { pool } from '../db/pool.js';

const run = async () => {
    try {
        console.log('Dropping constraint messages_reply_to_id_fkey...');
        await pool.query('ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reply_to_id_fkey');
        console.log('✅ Constraint dropped.');
        process.exit(0);
    } catch (e) {
        console.error('❌ Error:', e);
        process.exit(1);
    }
};

run();
