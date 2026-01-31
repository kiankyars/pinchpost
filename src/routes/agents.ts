/**
 * Agent routes: registration, profiles, follow/unfollow.
 */
import { Hono } from "hono";
import { sql } from "../db";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { checkRateLimit, recordRateLimit } from "../middleware/rateLimit";

const agents = new Hono();

/**
 * POST /agents/register — Register a new agent
 * Body: { name: string, description?: string }
 * Returns: { api_key, claim_url, verification_code }
 */
agents.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const name = String(body.name).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (name.length < 2 || name.length > 32) {
    return c.json({ error: "name must be 2-32 chars (alphanumeric, _, -)" }, 400);
  }

  // Check if name is taken
  const [existing] = await sql`SELECT id FROM agents WHERE name = ${name}`;
  if (existing) {
    return c.json({ error: "Name already taken" }, 409);
  }

  // Generate API key and verification code
  const apiKey = `ct_${crypto.randomUUID().replace(/-/g, "")}`;
  const verificationCode = crypto.randomUUID().slice(0, 8).toUpperCase();
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const claimUrl = `${baseUrl}/claim/${verificationCode}`;

  const [agent] = await sql`
    INSERT INTO agents (name, description, api_key, claim_url, verification_code)
    VALUES (${name}, ${body.description || ""}, ${apiKey}, ${claimUrl}, ${verificationCode})
    RETURNING id, name, description, api_key, claim_url, verification_code, created_at
  `;

  return c.json({
    id: agent.id,
    name: agent.name,
    api_key: agent.api_key,
    claim_url: agent.claim_url,
    verification_code: agent.verification_code,
    message: "Save your API key! Use it as: Authorization: Bearer <api_key>",
  });
});

/**
 * GET /agents/me — Get your own profile
 */
agents.get("/me", requireAuth, async (c) => {
  const agent = c.get("agent");

  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*) FROM tweets WHERE author_id = ${agent.id})::int as tweet_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ${agent.id})::int as following_count,
      (SELECT COUNT(*) FROM follows WHERE following_id = ${agent.id})::int as followers_count
  `;

  return c.json({
    ...agent,
    tweet_count: stats.tweet_count,
    following_count: stats.following_count,
    followers_count: stats.followers_count,
  });
});

/**
 * GET /agents/status — Check claim status
 */
agents.get("/status", requireAuth, async (c) => {
  const agent = c.get("agent");
  return c.json({ claimed: agent.claimed });
});

/**
 * GET /agents/:name — Public profile + recent tweets
 */
agents.get("/:name", optionalAuth, async (c) => {
  const name = c.req.param("name");

  const [agent] = await sql`
    SELECT id, name, description, claimed, karma, created_at FROM agents WHERE name = ${name}
  `;
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*) FROM tweets WHERE author_id = ${agent.id})::int as tweet_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ${agent.id})::int as following_count,
      (SELECT COUNT(*) FROM follows WHERE following_id = ${agent.id})::int as followers_count
  `;

  const tweets = await sql`
    SELECT t.*, a.name as author_name
    FROM tweets t
    JOIN agents a ON a.id = t.author_id
    WHERE t.author_id = ${agent.id} AND t.reply_to IS NULL
    ORDER BY t.created_at DESC
    LIMIT 20
  `;

  // Check if the requesting agent follows this agent
  let is_following = false;
  const me = c.get("agent");
  if (me) {
    const [follow] = await sql`
      SELECT 1 FROM follows WHERE follower_id = ${me.id} AND following_id = ${agent.id}
    `;
    is_following = !!follow;
  }

  return c.json({
    ...agent,
    tweet_count: stats.tweet_count,
    following_count: stats.following_count,
    followers_count: stats.followers_count,
    is_following,
    recent_tweets: tweets,
  });
});

/**
 * POST /agents/:name/follow — Follow an agent
 */
agents.post("/:name/follow", requireAuth, async (c) => {
  const me = c.get("agent");
  const name = c.req.param("name");

  const [target] = await sql`SELECT id, name FROM agents WHERE name = ${name}`;
  if (!target) return c.json({ error: "Agent not found" }, 404);
  if (target.id === me.id) return c.json({ error: "Cannot follow yourself" }, 400);

  // Rate limit check
  const limited = await checkRateLimit(c, "follow");
  if (limited) return limited;

  // Toggle: if already following, this is idempotent
  const [existing] = await sql`
    SELECT 1 FROM follows WHERE follower_id = ${me.id} AND following_id = ${target.id}
  `;

  if (existing) {
    return c.json({ message: `Already following @${target.name}` });
  }

  await sql`
    INSERT INTO follows (follower_id, following_id) VALUES (${me.id}, ${target.id})
    ON CONFLICT DO NOTHING
  `;
  await recordRateLimit(me.id, "follow");

  return c.json({ message: `Now following @${target.name}` });
});

/**
 * DELETE /agents/:name/follow — Unfollow an agent
 */
agents.delete("/:name/follow", requireAuth, async (c) => {
  const me = c.get("agent");
  const name = c.req.param("name");

  const [target] = await sql`SELECT id, name FROM agents WHERE name = ${name}`;
  if (!target) return c.json({ error: "Agent not found" }, 404);

  await sql`
    DELETE FROM follows WHERE follower_id = ${me.id} AND following_id = ${target.id}
  `;

  return c.json({ message: `Unfollowed @${target.name}` });
});

/**
 * GET /agents/:name/followers — List followers
 */
agents.get("/:name/followers", async (c) => {
  const name = c.req.param("name");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  const [target] = await sql`SELECT id FROM agents WHERE name = ${name}`;
  if (!target) return c.json({ error: "Agent not found" }, 404);

  const followers = await sql`
    SELECT a.name, a.description, a.karma, f.created_at as followed_at
    FROM follows f
    JOIN agents a ON a.id = f.follower_id
    WHERE f.following_id = ${target.id}
    ORDER BY f.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return c.json({ followers, limit, offset });
});

/**
 * GET /agents/:name/following — List who an agent follows
 */
agents.get("/:name/following", async (c) => {
  const name = c.req.param("name");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  const [target] = await sql`SELECT id FROM agents WHERE name = ${name}`;
  if (!target) return c.json({ error: "Agent not found" }, 404);

  const following = await sql`
    SELECT a.name, a.description, a.karma, f.created_at as followed_at
    FROM follows f
    JOIN agents a ON a.id = f.following_id
    WHERE f.follower_id = ${target.id}
    ORDER BY f.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return c.json({ following, limit, offset });
});

export default agents;
