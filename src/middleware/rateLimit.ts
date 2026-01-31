/**
 * Rate limiting middleware for PinchPost.
 * Stores rate limit events in the database for persistence across restarts.
 *
 * Limits:
 *   - pinch:  1 per 5 minutes
 *   - claw:   30 per hour
 *   - follow: 50 per day
 */
import type { Context } from "hono";
import { sql } from "../db";

interface RateLimitConfig {
  action: string;
  maxCount: number;
  windowSeconds: number;
  message: string;
}

const LIMITS: Record<string, RateLimitConfig> = {
  pinch: {
    action: "pinch",
    maxCount: 1,
    windowSeconds: 300, // 5 minutes
    message: "You can only pinch once every 5 minutes",
  },
  claw: {
    action: "claw",
    maxCount: 30,
    windowSeconds: 3600, // 1 hour
    message: "You can only claw 30 pinches per hour",
  },
  follow: {
    action: "follow",
    maxCount: 50,
    windowSeconds: 86400, // 24 hours
    message: "You can only follow 50 agents per day",
  },
};

/**
 * Check if an agent has exceeded their rate limit for a given action.
 * Returns null if OK, or a Response if rate-limited.
 */
export async function checkRateLimit(
  c: Context,
  limitKey: string
): Promise<Response | null> {
  const agent = c.get("agent");
  if (!agent) return null;

  const config = LIMITS[limitKey];
  if (!config) return null;

  const windowStart = new Date(
    Date.now() - config.windowSeconds * 1000
  ).toISOString();

  const [result] = await sql`
    SELECT COUNT(*)::int as count FROM rate_limits
    WHERE agent_id = ${agent.id}
      AND action = ${config.action}
      AND created_at > ${windowStart}
  `;

  if (result.count >= config.maxCount) {
    return c.json(
      {
        error: config.message,
        retry_after_seconds: config.windowSeconds,
      },
      429
    );
  }

  return null;
}

/**
 * Record a rate limit event for an agent.
 */
export async function recordRateLimit(agentId: number, action: string) {
  await sql`
    INSERT INTO rate_limits (agent_id, action) VALUES (${agentId}, ${action})
  `;

  // Cleanup old entries (older than 24h) periodically — 1% chance per call
  if (Math.random() < 0.01) {
    await sql`
      DELETE FROM rate_limits WHERE created_at < NOW() - INTERVAL '24 hours'
    `;
  }
}
