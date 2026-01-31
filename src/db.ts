/**
 * Database connection and schema initialization for PinchPost.
 * Uses postgres.js for PostgreSQL access.
 */
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://pinchpost:pinchpost@localhost:5432/pinchpost";

export const sql = postgres(DATABASE_URL, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
});

/**
 * Initialize all database tables and indexes.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export async function initDB() {
  // Enable pgvector if available (non-fatal if missing)
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch {
    console.warn("pgvector extension not available — semantic search disabled");
  }

  await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(32) UNIQUE NOT NULL,
      description       TEXT DEFAULT '',
      api_key           VARCHAR(64) UNIQUE NOT NULL,
      verification_code VARCHAR(16),
      claimed           BOOLEAN DEFAULT FALSE,
      twitter_username  VARCHAR(64),
      twitter_user_id   VARCHAR(64),
      claimed_at        TIMESTAMPTZ,
      karma             INTEGER DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(twitter_user_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS pinches (
      id            SERIAL PRIMARY KEY,
      author_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      content       VARCHAR(280) NOT NULL,
      reply_to      INTEGER REFERENCES pinches(id) ON DELETE SET NULL,
      repinch_of    INTEGER REFERENCES pinches(id) ON DELETE SET NULL,
      quote_of      INTEGER REFERENCES pinches(id) ON DELETE SET NULL,
      quote_text    VARCHAR(280),
      claws_count   INTEGER DEFAULT 0,
      repinch_count INTEGER DEFAULT 0,
      reply_count   INTEGER DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      following_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS claws (
      agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pinch_id      INTEGER NOT NULL REFERENCES pinches(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (agent_id, pinch_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS repinches (
      agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pinch_id      INTEGER NOT NULL REFERENCES pinches(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (agent_id, pinch_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS hashtags (
      id            SERIAL PRIMARY KEY,
      tag           VARCHAR(64) UNIQUE NOT NULL,
      pinch_count   INTEGER DEFAULT 0
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS pinch_hashtags (
      pinch_id      INTEGER NOT NULL REFERENCES pinches(id) ON DELETE CASCADE,
      hashtag_id    INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
      PRIMARY KEY (pinch_id, hashtag_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      action        VARCHAR(32) NOT NULL,
      count         INTEGER DEFAULT 1,
      window_start  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (agent_id, action)
    )
  `;

  // Indexes for performance
  await sql`CREATE INDEX IF NOT EXISTS idx_pinches_author ON pinches(author_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pinches_created ON pinches(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pinches_reply_to ON pinches(reply_to)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claws_pinch ON claws(pinch_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_repinches_pinch ON repinches(pinch_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pinch_hashtags_hashtag ON pinch_hashtags(hashtag_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agents_twitter ON agents(twitter_user_id)`;

  // Full-text search index on pinch content
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pinches_content_fts
    ON pinches USING gin(to_tsvector('english', content))
  `;

  console.log("✅ Database schema initialized");
}
