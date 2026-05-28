import { pool, searchPool } from './pool.js';

async function tryQuery(sql: string) {
  try {
    await pool.query(sql);
  } catch (err) {
    if ((err as { code?: string }).code === '42501') return;
    console.warn('[schema] skipped optional migration:', err instanceof Error ? err.message : err);
  }
}

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
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
    );
  `);

  const tableSql = [
    `CREATE TABLE IF NOT EXISTS user_read_state (
      user_id INT NOT NULL,
      channel_id VARCHAR(50) DEFAULT 'global' NOT NULL,
      last_read_id INT DEFAULT 0 NOT NULL,
      last_updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, channel_id)
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
    `CREATE TABLE IF NOT EXISTS auth_tokens (
      token VARCHAR(255) PRIMARY KEY,
      user_id INT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS user_lookup_cache (
      user_id INT PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      nickname VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
    `CREATE TABLE IF NOT EXISTS user_profiles (
      uid INT PRIMARY KEY,
      username VARCHAR(255),
      nickname VARCHAR(255),
      avatar_url TEXT,
      sign TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS video_metadata (
      video_url TEXT PRIMARY KEY,
      thumbnail_url TEXT,
      width INT,
      height INT,
      duration NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
    );`,
    `CREATE TABLE IF NOT EXISTS scheduled_reminders (
      id SERIAL PRIMARY KEY,
      created_by_uid INT,
      message TEXT NOT NULL,
      description TEXT,
      next_run_at TIMESTAMPTZ NOT NULL,
      repeat_interval_minutes INT,
      is_active BOOLEAN DEFAULT TRUE,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS global_blocklist (user_id INT PRIMARY KEY);`,
    `CREATE TABLE IF NOT EXISTS bot_blocklist (user_id INT PRIMARY KEY);`,
    `CREATE TABLE IF NOT EXISTS user_memories (
      user_id INT PRIMARY KEY,
      memory_text TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS bot_replied_posts (
      post_id BIGINT PRIMARY KEY,
      topic_id BIGINT,
      replied_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS scraper_state (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
  ];

  for (const sql of tableSql) {
    await pool.query(sql);
  }

  const indexSql = [
    `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages("timestamp");`,
    `CREATE INDEX IF NOT EXISTS idx_messages_uid ON messages(uid);`,
    `CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages(reply_to_id);`,
    `CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON message_reactions(message_id);`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);`,
    `CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON user_favorites(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_memories_user_id ON user_memories(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_video_processing_queue_status ON video_processing_queue(status);`,
    `CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_due ON scheduled_reminders(is_active, next_run_at);`,
  ];

  for (const sql of indexSql) {
    await tryQuery(sql);
  }

  try {
    await searchPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        uid INT PRIMARY KEY,
        username VARCHAR(255),
        nickname VARCHAR(255),
        avatar_url TEXT,
        sign TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await searchPool.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);
  } catch (err) {
    console.warn('[schema] search profile table unavailable:', err instanceof Error ? err.message : err);
  }
}
