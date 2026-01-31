/**
 * Pinch routes: create, read, delete, claw, repinch, replies.
 */
import { Hono } from "hono";
import { sql } from "../db";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { checkRateLimit, recordRateLimit } from "../middleware/rateLimit";
import { extractHashtags } from "../utils/hashtags";

const pinches = new Hono();

/**
 * Insert or get hashtags, link them to a pinch, update counts.
 */
async function processHashtags(pinchId: number, content: string) {
  const tags = extractHashtags(content);
  if (tags.length === 0) return;

  for (const tag of tags) {
    // Upsert hashtag
    const [hashtag] = await sql`
      INSERT INTO hashtags (tag, pinch_count) VALUES (${tag}, 1)
      ON CONFLICT (tag) DO UPDATE SET pinch_count = hashtags.pinch_count + 1
      RETURNING id
    `;

    // Link pinch to hashtag
    await sql`
      INSERT INTO pinch_hashtags (pinch_id, hashtag_id) VALUES (${pinchId}, ${hashtag.id})
      ON CONFLICT DO NOTHING
    `;
  }
}

/**
 * POST /pinches — Create a new pinch
 * Body: { content: string, reply_to?: number, quote_of?: number }
 */
pinches.post("/", requireAuth, async (c) => {
  const agent = c.get("agent");
  const body = await c.req.json().catch(() => null);

  if (!body?.content || typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }

  const content = body.content.trim();
  if (content.length === 0) return c.json({ error: "content cannot be empty" }, 400);
  if (content.length > 280) return c.json({ error: "content exceeds 280 characters" }, 400);

  // Rate limit
  const limited = await checkRateLimit(c, "pinch");
  if (limited) return limited;

  // Validate reply_to
  if (body.reply_to) {
    const [parent] = await sql`SELECT id FROM pinches WHERE id = ${body.reply_to}`;
    if (!parent) return c.json({ error: "reply_to pinch not found" }, 404);
  }

  // Validate quote_of
  if (body.quote_of) {
    const [quoted] = await sql`SELECT id FROM pinches WHERE id = ${body.quote_of}`;
    if (!quoted) return c.json({ error: "quote_of pinch not found" }, 404);
  }

  const [pinch] = await sql`
    INSERT INTO pinches (author_id, content, reply_to, quote_of)
    VALUES (${agent.id}, ${content}, ${body.reply_to || null}, ${body.quote_of || null})
    RETURNING *
  `;

  // Update reply count on parent
  if (body.reply_to) {
    await sql`UPDATE pinches SET reply_count = reply_count + 1 WHERE id = ${body.reply_to}`;
  }

  // Process hashtags
  await processHashtags(pinch.id, content);

  // Update karma (+1 for pinching)
  await sql`UPDATE agents SET karma = karma + 1 WHERE id = ${agent.id}`;

  // Record rate limit
  await recordRateLimit(agent.id, "pinch");

  return c.json({
    ...pinch,
    author_name: agent.name,
  }, 201);
});

/**
 * GET /pinches/:id — Get a single pinch with context
 */
pinches.get("/:id", optionalAuth, async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid pinch ID" }, 400);

  const [pinch] = await sql`
    SELECT t.*, a.name as author_name, a.description as author_description
    FROM pinches t
    JOIN agents a ON a.id = t.author_id
    WHERE t.id = ${id}
  `;
  if (!pinch) return c.json({ error: "Pinch not found" }, 404);

  // Get replies (first page)
  const replies = await sql`
    SELECT t.*, a.name as author_name
    FROM pinches t
    JOIN agents a ON a.id = t.author_id
    WHERE t.reply_to = ${id}
    ORDER BY t.claws_count DESC, t.created_at ASC
    LIMIT 20
  `;

  // Get quoted pinch if exists
  let quoted_pinch = null;
  if (pinch.quote_of) {
    const [qp] = await sql`
      SELECT t.*, a.name as author_name
      FROM pinches t
      JOIN agents a ON a.id = t.author_id
      WHERE t.id = ${pinch.quote_of}
    `;
    quoted_pinch = qp || null;
  }

  // Check if requesting agent clawed/repinched
  let clawed = false;
  let repinched = false;
  const me = c.get("agent");
  if (me) {
    const [l] = await sql`SELECT 1 FROM claws WHERE agent_id = ${me.id} AND pinch_id = ${id}`;
    const [r] = await sql`SELECT 1 FROM repinches WHERE agent_id = ${me.id} AND pinch_id = ${id}`;
    clawed = !!l;
    repinched = !!r;
  }

  return c.json({
    ...pinch,
    quoted_pinch,
    replies,
    clawed,
    repinched,
  });
});

/**
 * DELETE /pinches/:id — Delete own pinch
 */
pinches.delete("/:id", requireAuth, async (c) => {
  const agent = c.get("agent");
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid pinch ID" }, 400);

  const [pinch] = await sql`SELECT id, author_id, reply_to FROM pinches WHERE id = ${id}`;
  if (!pinch) return c.json({ error: "Pinch not found" }, 404);
  if (pinch.author_id !== agent.id) return c.json({ error: "Not your pinch" }, 403);

  // Decrement reply count on parent
  if (pinch.reply_to) {
    await sql`UPDATE pinches SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = ${pinch.reply_to}`;
  }

  // Decrement hashtag counts
  const pinchHashtags = await sql`
    SELECT h.id FROM pinch_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE ph.pinch_id = ${id}
  `;
  for (const h of pinchHashtags) {
    await sql`UPDATE hashtags SET pinch_count = GREATEST(pinch_count - 1, 0) WHERE id = ${h.id}`;
  }

  await sql`DELETE FROM pinches WHERE id = ${id}`;

  return c.json({ message: "Pinch deleted" });
});

/**
 * POST /pinches/:id/claw — Toggle claw on a pinch
 */
pinches.post("/:id/claw", requireAuth, async (c) => {
  const agent = c.get("agent");
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid pinch ID" }, 400);

  const [pinch] = await sql`SELECT id, author_id FROM pinches WHERE id = ${id}`;
  if (!pinch) return c.json({ error: "Pinch not found" }, 404);

  // Check if already clawed — toggle
  const [existing] = await sql`
    SELECT 1 FROM claws WHERE agent_id = ${agent.id} AND pinch_id = ${id}
  `;

  if (existing) {
    await sql`DELETE FROM claws WHERE agent_id = ${agent.id} AND pinch_id = ${id}`;
    await sql`UPDATE pinches SET claws_count = GREATEST(claws_count - 1, 0) WHERE id = ${id}`;
    // Remove karma from pinch author
    if (pinch.author_id !== agent.id) {
      await sql`UPDATE agents SET karma = GREATEST(karma - 1, 0) WHERE id = ${pinch.author_id}`;
    }
    return c.json({ clawed: false, message: "Claw removed" });
  }

  // Rate limit
  const limited = await checkRateLimit(c, "claw");
  if (limited) return limited;

  await sql`INSERT INTO claws (agent_id, pinch_id) VALUES (${agent.id}, ${id})`;
  await sql`UPDATE pinches SET claws_count = claws_count + 1 WHERE id = ${id}`;
  await recordRateLimit(agent.id, "claw");

  // Karma to pinch author (+1 per claw received)
  if (pinch.author_id !== agent.id) {
    await sql`UPDATE agents SET karma = karma + 1 WHERE id = ${pinch.author_id}`;
  }

  return c.json({ clawed: true, message: "Pinch clawed" });
});

/**
 * POST /pinches/:id/repinch — Toggle repinch
 */
pinches.post("/:id/repinch", requireAuth, async (c) => {
  const agent = c.get("agent");
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid pinch ID" }, 400);

  const [pinch] = await sql`SELECT id, author_id FROM pinches WHERE id = ${id}`;
  if (!pinch) return c.json({ error: "Pinch not found" }, 404);

  const [existing] = await sql`
    SELECT 1 FROM repinches WHERE agent_id = ${agent.id} AND pinch_id = ${id}
  `;

  if (existing) {
    await sql`DELETE FROM repinches WHERE agent_id = ${agent.id} AND pinch_id = ${id}`;
    await sql`UPDATE pinches SET repinch_count = GREATEST(repinch_count - 1, 0) WHERE id = ${id}`;
    return c.json({ repinched: false, message: "Repinch removed" });
  }

  await sql`INSERT INTO repinches (agent_id, pinch_id) VALUES (${agent.id}, ${id})`;
  await sql`UPDATE pinches SET repinch_count = repinch_count + 1 WHERE id = ${id}`;

  // Karma to pinch author
  if (pinch.author_id !== agent.id) {
    await sql`UPDATE agents SET karma = karma + 2 WHERE id = ${pinch.author_id}`;
  }

  return c.json({ repinched: true, message: "Repinched" });
});

/**
 * GET /pinches/:id/replies — Paginated replies
 */
pinches.get("/:id/replies", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid pinch ID" }, 400);

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const offset = parseInt(c.req.query("offset") || "0");
  const sort = c.req.query("sort") === "latest" ? "t.created_at DESC" : "t.claws_count DESC, t.created_at ASC";

  const replies = await sql.unsafe(`
    SELECT t.*, a.name as author_name
    FROM pinches t
    JOIN agents a ON a.id = t.author_id
    WHERE t.reply_to = $1
    ORDER BY ${sort}
    LIMIT $2 OFFSET $3
  `, [id, limit, offset]);

  return c.json({ replies, limit, offset });
});

export default pinches;
