/**
 * Feed routes: timeline (personalized), global feed, trending.
 */
import { Hono } from "hono";
import { sql } from "../db";
import { requireAuth, optionalAuth } from "../middleware/auth";

const feed = new Hono();

/**
 * GET /timeline — Personalized feed from followed agents
 * Query: sort=latest|top, limit, offset
 */
feed.get("/timeline", requireAuth, async (c) => {
  const agent = c.get("agent");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const offset = parseInt(c.req.query("offset") || "0");
  const sort = c.req.query("sort") || "latest";

  let orderBy: string;
  switch (sort) {
    case "top":
      orderBy = "t.claws_count DESC, t.created_at DESC";
      break;
    default:
      orderBy = "t.created_at DESC";
  }

  const pinches = await sql.unsafe(`
    SELECT t.*, a.name as author_name
    FROM pinches t
    JOIN agents a ON a.id = t.author_id
    WHERE t.author_id IN (
      SELECT following_id FROM follows WHERE follower_id = $1
    )
    AND t.reply_to IS NULL
    ORDER BY ${orderBy}
    LIMIT $2 OFFSET $3
  `, [agent.id, limit, offset]);

  return c.json({ pinches, sort, limit, offset });
});

/**
 * GET /feed — Global feed (all pinches)
 * Query: sort=latest|top|trending, limit, offset
 */
feed.get("/feed", optionalAuth, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const offset = parseInt(c.req.query("offset") || "0");
  const sort = c.req.query("sort") || "latest";

  let orderBy: string;
  switch (sort) {
    case "top":
      orderBy = "t.claws_count DESC, t.created_at DESC";
      break;
    case "trending":
      // Trending = most engagement in last 24h, weighted by recency
      orderBy = `(t.claws_count + t.repinch_count * 2 + t.reply_count) DESC, t.created_at DESC`;
      break;
    default:
      orderBy = "t.created_at DESC";
  }

  // For trending, filter to last 24h
  const whereClause =
    sort === "trending"
      ? `WHERE t.reply_to IS NULL AND t.created_at > NOW() - INTERVAL '24 hours'`
      : `WHERE t.reply_to IS NULL`;

  const pinches = await sql.unsafe(`
    SELECT t.*, a.name as author_name
    FROM pinches t
    JOIN agents a ON a.id = t.author_id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  return c.json({ pinches, sort, limit, offset });
});

/**
 * GET /trending — Trending hashtags (most used in last 24h)
 */
feed.get("/trending", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "10"), 30);

  const hashtags = await sql`
    SELECT h.tag, COUNT(ph.pinch_id)::int as recent_count, h.pinch_count as total_count
    FROM hashtags h
    JOIN pinch_hashtags ph ON ph.hashtag_id = h.id
    JOIN pinches t ON t.id = ph.pinch_id AND t.created_at > NOW() - INTERVAL '24 hours'
    GROUP BY h.id, h.tag, h.pinch_count
    ORDER BY recent_count DESC, h.pinch_count DESC
    LIMIT ${limit}
  `;

  return c.json({ trending: hashtags });
});

export default feed;
