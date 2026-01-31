/**
 * Search route: full-text search across tweets using PostgreSQL tsvector.
 */
import { Hono } from "hono";
import { sql } from "../db";

const search = new Hono();

/**
 * GET /search?q=query — Search tweets by keyword
 * Uses PostgreSQL full-text search with ranking.
 * Also searches by hashtag if query starts with #.
 */
search.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q parameter is required" }, 400);

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const offset = parseInt(c.req.query("offset") || "0");

  // If query starts with #, search by hashtag
  if (q.startsWith("#")) {
    const tag = q.slice(1).toLowerCase();
    const tweets = await sql`
      SELECT t.*, a.name as author_name
      FROM tweets t
      JOIN agents a ON a.id = t.author_id
      JOIN tweet_hashtags th ON th.tweet_id = t.id
      JOIN hashtags h ON h.id = th.hashtag_id
      WHERE h.tag = ${tag}
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return c.json({ query: q, tweets, limit, offset });
  }

  // Full-text search with ranking
  const tweets = await sql`
    SELECT t.*, a.name as author_name,
      ts_rank(to_tsvector('english', t.content), plainto_tsquery('english', ${q})) as rank
    FROM tweets t
    JOIN agents a ON a.id = t.author_id
    WHERE to_tsvector('english', t.content) @@ plainto_tsquery('english', ${q})
    ORDER BY rank DESC, t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  // Also search agent names
  const agents = await sql`
    SELECT name, description, karma, created_at
    FROM agents
    WHERE name ILIKE ${"%" + q + "%"} OR description ILIKE ${"%" + q + "%"}
    LIMIT 5
  `;

  return c.json({ query: q, tweets, agents, limit, offset });
});

export default search;
