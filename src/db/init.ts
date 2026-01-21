import { pool } from './pool.js';

export const initDb = async () => {
    // 1. Create Tables
    const tableQueries = [
        `CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            bangumi_id BIGINT NOT NULL UNIQUE,
            "timestamp" BIGINT NOT NULL,
            uid INT NOT NULL,
            nickname VARCHAR(255) NOT NULL,
            avatar VARCHAR(255),
            message TEXT,
            color VARCHAR(20),
            is_html BOOLEAN DEFAULT FALSE,
            type VARCHAR(20) DEFAULT 'text' NOT NULL,
            reply_to_id BIGINT DEFAULT NULL,
            is_deleted BOOLEAN DEFAULT FALSE,
            edited_at TIMESTAMPTZ DEFAULT NULL,
            original_content TEXT DEFAULT NULL
        );`,
        `CREATE TABLE IF NOT EXISTS user_mention_status (
            user_id INT PRIMARY KEY,
            last_read_mention_id INT DEFAULT 0 NOT NULL
        );`,
        `CREATE TABLE IF NOT EXISTS global_blocklist (
            user_id INT PRIMARY KEY
        );`,
        `CREATE TABLE IF NOT EXISTS message_reactions (
            id SERIAL PRIMARY KEY,
            message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_id INT NOT NULL,
            nickname VARCHAR(255) NOT NULL,
            avatar VARCHAR(255),
            emoji VARCHAR(50) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (message_id, user_id, emoji)
        );`,
        `CREATE TABLE IF NOT EXISTS user_favorites (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL,
            image_url TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (user_id, image_url)
        );`,
        `CREATE TABLE IF NOT EXISTS image_metadata (
            image_url TEXT PRIMARY KEY,
            width INT NOT NULL,
            height INT NOT NULL,
            placeholder TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        `CREATE TABLE IF NOT EXISTS link_previews (
            url TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            image_url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        `CREATE TABLE IF NOT EXISTS user_lookup_cache (
            user_id INT PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            nickname VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        `CREATE TABLE IF NOT EXISTS user_memories (
            user_id INT PRIMARY KEY,
            memory_text TEXT,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        `CREATE TABLE IF NOT EXISTS auth_tokens (
            token VARCHAR(255) PRIMARY KEY,
            user_id INT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        `CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL,
            sender_id INT NOT NULL,
            message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            type VARCHAR(20) NOT NULL DEFAULT 'mention',
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (user_id, message_id, type)
        );`,
        `CREATE TABLE IF NOT EXISTS video_processing_queue (
            id VARCHAR(255) PRIMARY KEY,
            original_path TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'pending' NOT NULL,
            options JSONB DEFAULT '{}',
            result JSONB,
            error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            processed_at TIMESTAMPTZ
        );`
    ];

    // 1.5 Add user_read_state table
    tableQueries.push(`CREATE TABLE IF NOT EXISTS user_read_state (
            user_id INT NOT NULL,
            channel_id VARCHAR(50) DEFAULT 'global' NOT NULL,
            last_read_id INT DEFAULT 0 NOT NULL,
            last_updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (user_id, channel_id)
        );`);

    // 2. Define Indexes (Name and Definition)
    const indexDefinitions = [
        { name: 'idx_messages_timestamp', query: `CREATE INDEX idx_messages_timestamp ON messages("timestamp");` },
        { name: 'idx_messages_reply_to_id', query: `CREATE INDEX idx_messages_reply_to_id ON messages(reply_to_id);` },
        { name: 'idx_messages_uid', query: `CREATE INDEX idx_messages_uid ON messages(uid);` },
        { name: 'idx_reactions_message_id', query: `CREATE INDEX idx_reactions_message_id ON message_reactions(message_id);` },
        { name: 'idx_favorites_user_id', query: `CREATE INDEX idx_favorites_user_id ON user_favorites(user_id);` },
        { name: 'idx_memories_user_id', query: `CREATE INDEX idx_memories_user_id ON user_memories(user_id);` },
        { name: 'idx_auth_tokens_user_id', query: `CREATE INDEX idx_auth_tokens_user_id ON auth_tokens(user_id);` },
        { name: 'idx_notifications_user_read', query: `CREATE INDEX idx_notifications_user_read ON notifications(user_id);` },
        { name: 'idx_notifications_message', query: `CREATE INDEX idx_notifications_message ON notifications(message_id);` }
    ];

    try {
        // Run Table Creations
        for (const query of tableQueries) {
            await pool.query(query);
        }

        // Check and Create Indexes
        const existingIndexesRes = await pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()');
        const existingIndexes = new Set(existingIndexesRes.rows.map((row: any) => row.indexname));

        for (const idx of indexDefinitions) {
            if (!existingIndexes.has(idx.name)) {
                console.log(`Creating missing index: ${idx.name}`);
                await pool.query(idx.query);
            }
        }

        console.log('✅ Database initialized successfully.');
    } catch (err) {
        console.error('❌ Error initializing database:', err);
        process.exit(1);
    }
};
