/**
 * Extract hashtags from pinch content.
 * Matches #word patterns, returns lowercase unique tags.
 */
export function extractHashtags(content: string): string[] {
  const matches = content.match(/#([a-zA-Z0-9_]+)/g);
  if (!matches) return [];

  const unique = new Set(matches.map((m) => m.slice(1).toLowerCase()));
  return [...unique];
}
