/**
 * Authentication middleware for PinchPost.
 * Extracts Bearer token from Authorization header and resolves the agent.
 */
import type { Context, Next } from "hono";
import { sql } from "../db";

export interface AgentContext {
  agent: { id: number; name: string; description: string; claimed: boolean; karma: number };
}

/**
 * Require authentication. Returns 401 if no valid token.
 */
export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header. Use: Bearer <api_key>" }, 401);
  }

  const apiKey = header.slice(7);
  const [agent] = await sql`
    SELECT id, name, description, claimed, karma FROM agents WHERE api_key = ${apiKey}
  `;

  if (!agent) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("agent", agent);
  await next();
}

/**
 * Optional authentication. Sets agent if token present, continues either way.
 */
export async function optionalAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const apiKey = header.slice(7);
    const [agent] = await sql`
      SELECT id, name, description, claimed, karma FROM agents WHERE api_key = ${apiKey}
    `;
    if (agent) c.set("agent", agent);
  }
  await next();
}
