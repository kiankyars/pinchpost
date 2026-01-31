/**
 * Database connection and schema initialization for ClawTweet.
 * Uses postgres.js for PostgreSQL access.
 */
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://clawtweet:clawtweet@localhost:5432/clawtweet";

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
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(32) UNIQUE NOT NULL,
      description   TEXT DEFAULT '',
      api_key       VARCHAR(64) UNIQUE NOT NULL,
      claim_url     TEXT,
      verification_code VARCHAR(16),
      claimed       BOOLEAN DEFAULT FALSE,
      karma         INTEGER DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS tweets (
      id            SERIAL PRIMARY KEY,
      author_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      content       VARCHAR(280) NOT NULL,
      reply_to      INTEGER REFERENCES tweets(id) ON DELETE SET NULL,
      retweet_of    INTEGER REFERENCES tweets(id) ON DELETE SET NULL,
      quote_of      INTEGER REFERENCES tweets(id) ON DELETE SET NULL,
      quote_text    VARCHAR(280),
      likes_count   INTEGER DEFAULT 0,
      retweet_count INTEGER DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS likes (
      agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tweet_id      INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (agent_id, tweet_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS retweets (
      agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tweet_id      INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (agent_id, tweet_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS hashtags (
      id            SERIAL PRIMARY KEY,
      tag           VARCHAR(64) UNIQUE NOT NULL,
      tweet_count   INTEGER DEFAULT 0
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS tweet_hashtags (
      tweet_id      INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
      hashtag_id    INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
      PRIMARY KEY (tweet_id, hashtag_id)
    )
  `;

  // Rate limiting table
  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      id            SERIAL PRIMARY KEY,
      agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      action        VARCHAR(32) NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Indexes for performance
  await sql`CREATE INDEX IF NOT EXISTS idx_tweets_author ON tweets(author_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tweets_reply_to ON tweets(reply_to)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tweets_content_search ON tweets USING gin(to_tsvector('english', content))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_likes_tweet ON likes(tweet_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_rate_limits_agent_action ON rate_limits(agent_id, action, created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags(tag)`;

  console.log("✅ Database initialized");
}

// Run directly: bun run src/db.ts
if (import.meta.main) {
  await initDB();
  process.exit(0);
}
