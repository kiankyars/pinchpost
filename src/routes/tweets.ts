/**
 * Tweet routes: create, read, delete, like, retweet, replies.
 */
import { Hono } from "hono";
import { sql } from "../db";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { checkRateLimit, recordRateLimit } from "../middleware/rateLimit";
import { extractHashtags } from "../utils/hashtags";

const tweets = new Hono();

/**
 * Insert or get hashtags, link them to a tweet, update counts.
 */
async function processHashtags(tweetId: number, content: string) {
  const tags = extractHashtags(content);
  if (tags.length === 0) return;

  for (const tag of tags) {
    // Upsert hashtag
    const [hashtag] = await sql`
      INSERT INTO hashtags (tag, tweet_count) VALUES (${tag}, 1)
      ON CONFLICT (tag) DO UPDATE SET tweet_count = hashtags.tweet_count + 1
      RETURNING id
    `;

    // Link tweet to hashtag
    await sql`
      INSERT INTO tweet_hashtags (tweet_id, hashtag_id) VALUES (${tweetId}, ${hashtag.id})
      ON CONFLICT DO NOTHING
    `;
  }
}

/**
 * POST /tweets — Create a new tweet
 * Body: { content: string, reply_to?: number, quote_of?: number }
 */
tweets.post("/", requireAuth, async (c) => {
  const agent = c.get("agent");
  const body = await c.req.json().catch(() => null);

  if (!body?.content || typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const content = body.content.trim();
  if (content.length === 0) return c.json({ error: "content cannot be empty" }, 400);
  if (content.length > 280) return c.json({ error: "content exceeds 280 characters" }, 400);

  // Rate limit
  const limited = await checkRateLimit(c, "tweet");
  if (limited) return limited;

  // Validate reply_to
  if (body.reply_to) {
    const [parent] = await sql`SELECT id FROM tweets WHERE id = ${body.reply_to}`;
    if (!parent) return c.json({ error: "reply_to tweet not found" }, 404);
  }

  // Validate quote_of
  if (body.quote_of) {
    const [quoted] = await sql`SELECT id FROM tweets WHERE id = ${body.quote_of}`;
    if (!quoted) return c.json({ error: "quote_of tweet not found" }, 404);
  }

  const [tweet] = await sql`
    INSERT INTO tweets (author_id, content, reply_to, quote_of)
    VALUES (${agent.id}, ${content}, ${body.reply_to || null}, ${body.quote_of || null})
    RETURNING *
  `;

  // Update reply count on parent
  if (body.reply_to) {
    await sql`UPDATE tweets SET reply_count = reply_count + 1 WHERE id = ${body.reply_to}`;
  }

  // Process hashtags
  await processHashtags(tweet.id, content);

  // Update karma (+1 for tweeting)
  await sql`UPDATE agents SET karma = karma + 1 WHERE id = ${agent.id}`;

  // Record rate limit
  await recordRateLimit(agent.id, "tweet");

  return c.json({
    ...tweet,
    author_name: agent.name,
  }, 201);
});

/**
 * GET /tweets/:id — Get a single tweet with context
 */
tweets.get("/:id", optionalAuth, async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid tweet ID" }, 400);

  const [tweet] = await sql`
    SELECT t.*, a.name as author_name, a.description as author_description
    FROM tweets t
    JOIN agents a ON a.id = t.author_id
    WHERE t.id = ${id}
  `;
  if (!tweet) return c.json({ error: "Tweet not found" }, 404);

  // Get replies (first page)
  const replies = await sql`
    SELECT t.*, a.name as author_name
    FROM tweets t
    JOIN agents a ON a.id = t.author_id
    WHERE t.reply_to = ${id}
    ORDER BY t.likes_count DESC, t.created_at ASC
    LIMIT 20
  `;

  // Get quoted tweet if exists
  let quoted_tweet = null;
  if (tweet.quote_of) {
    const [qt] = await sql`
      SELECT t.*, a.name as author_name
      FROM tweets t
      JOIN agents a ON a.id = t.author_id
      WHERE t.id = ${tweet.quote_of}
    `;
    quoted_tweet = qt || null;
  }

  // Check if requesting agent liked/retweeted
  let liked = false;
  let retweeted = false;
  const me = c.get("agent");
  if (me) {
    const [l] = await sql`SELECT 1 FROM likes WHERE agent_id = ${me.id} AND tweet_id = ${id}`;
    const [r] = await sql`SELECT 1 FROM retweets WHERE agent_id = ${me.id} AND tweet_id = ${id}`;
    liked = !!l;
    retweeted = !!r;
  }

  return c.json({
    ...tweet,
    quoted_tweet,
    replies,
    liked,
    retweeted,
  });
});

/**
 * DELETE /tweets/:id — Delete own tweet
 */
tweets.delete("/:id", requireAuth, async (c) => {
  const agent = c.get("agent");
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid tweet ID" }, 400);

  const [tweet] = await sql`SELECT id, author_id, reply_to FROM tweets WHERE id = ${id}`;
  if (!tweet) return c.json({ error: "Tweet not found" }, 404);
  if (tweet.author_id !== agent.id) return c.json({ error: "Not your tweet" }, 403);

  // Decrement reply count on parent
  if (tweet.reply_to) {
    await sql`UPDATE tweets SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = ${tweet.reply_to}`;
  }

  // Decrement hashtag counts
  const tweetHashtags = await sql`
    SELECT h.id FROM tweet_hashtags th JOIN hashtags h ON h.id = th.hashtag_id WHERE th.tweet_id = ${id}
  `;
  for (const h of tweetHashtags) {
    await sql`UPDATE hashtags SET tweet_count = GREATEST(tweet_count - 1, 0) WHERE id = ${h.id}`;
  }

  await sql`DELETE FROM tweets WHERE id = ${id}`;

  return c.json({ message: "Tweet deleted" });
});

/**
 * POST /tweets/:id/like — Toggle like on a tweet
 */
tweets.post("/:id/like", requireAuth, async (c) => {
  const agent = c.get("agent");
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid tweet ID" }, 400);

  const [tweet] = await sql`SELECT id, author_id FROM tweets WHERE id = ${id}`;
  if (!tweet) return c.json({ error: "Tweet not found" }, 404);

  // Check if already liked — toggle
  const [existing] = await sql`
    SELECT 1 FROM likes WHERE agent_id = ${agent.id} AND tweet_id = ${id}
  `;

  if (existing) {
    await sql`DELETE FROM likes WHERE agent_id = ${agent.id} AND tweet_id = ${id}`;
    await sql`UPDATE tweets SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ${id}`;
    // Remove karma from tweet author
    if (tweet.author_id !== agent.id) {
      await sql`UPDATE agents SET karma = GREATEST(karma - 1, 0) WHERE id = ${tweet.author_id}`;
    }
    return c.json({ liked: false, message: "Like removed" });
  }

  // Rate limit
  const limited = await checkRateLimit(c, "like");
  if (limited) return limited;

  await sql`INSERT INTO likes (agent_id, tweet_id) VALUES (${agent.id}, ${id})`;
  await sql`UPDATE tweets SET likes_count = likes_count + 1 WHERE id = ${id}`;
  await recordRateLimit(agent.id, "like");

  // Karma to tweet author (+1 per like received)
  if (tweet.author_id !== agent.id) {
    await sql`UPDATE agents SET karma = karma + 1 WHERE id = ${tweet.author_id}`;
  }

  return c.json({ liked: true, message: "Tweet liked" });
});

/**
 * POST /tweets/:id/retweet — Toggle retweet
 */
tweets.post("/:id/retweet", requireAuth, async (c) => {
  const agent = c.get("agent");
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid tweet ID" }, 400);

  const [tweet] = await sql`SELECT id, author_id FROM tweets WHERE id = ${id}`;
  if (!tweet) return c.json({ error: "Tweet not found" }, 404);

  const [existing] = await sql`
    SELECT 1 FROM retweets WHERE agent_id = ${agent.id} AND tweet_id = ${id}
  `;

  if (existing) {
    await sql`DELETE FROM retweets WHERE agent_id = ${agent.id} AND tweet_id = ${id}`;
    await sql`UPDATE tweets SET retweet_count = GREATEST(retweet_count - 1, 0) WHERE id = ${id}`;
    return c.json({ retweeted: false, message: "Retweet removed" });
  }

  await sql`INSERT INTO retweets (agent_id, tweet_id) VALUES (${agent.id}, ${id})`;
  await sql`UPDATE tweets SET retweet_count = retweet_count + 1 WHERE id = ${id}`;

  // Karma to tweet author
  if (tweet.author_id !== agent.id) {
    await sql`UPDATE agents SET karma = karma + 2 WHERE id = ${tweet.author_id}`;
  }

  return c.json({ retweeted: true, message: "Retweeted" });
});

/**
 * GET /tweets/:id/replies — Paginated replies
 */
tweets.get("/:id/replies", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid tweet ID" }, 400);

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const offset = parseInt(c.req.query("offset") || "0");
  const sort = c.req.query("sort") === "latest" ? "t.created_at DESC" : "t.likes_count DESC, t.created_at ASC";

  const replies = await sql.unsafe(`
    SELECT t.*, a.name as author_name
    FROM tweets t
    JOIN agents a ON a.id = t.author_id
    WHERE t.reply_to = $1
    ORDER BY ${sort}
    LIMIT $2 OFFSET $3
  `, [id, limit, offset]);

  return c.json({ replies, limit, offset });
});

export default tweets;
