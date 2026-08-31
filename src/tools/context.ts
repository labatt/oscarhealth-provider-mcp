import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { OscarClient } from '../oscar/client.js';
import { ResponseCache } from '../oscar/cache.js';
import { loadPlans, type PlanBook } from '../plans.js';

export interface ToolContext {
  client: OscarClient;
  plans: PlanBook;
  config: Config;
}

/** `<project root>/data/cache.db`, whether running from `src/` or `dist/`. */
const CACHE_PATH = fileURLToPath(new URL('../../data/cache.db', import.meta.url));

/**
 * Built once per process. The /mcp handler constructs a fresh McpServer per
 * request (stateless Streamable HTTP), so building the client and cache here
 * instead of in buildMcpServer is what keeps the cache and the throttle's
 * lastRequestAt shared across requests rather than reset on each one. This is
 * the same hazard documented at length in a sibling MCP server's mcp.ts.
 */
export function buildToolContext(config: Config): ToolContext {
  const cache = new ResponseCache(CACHE_PATH);
  return {
    client: new OscarClient(config.oscarBaseUrl, cache),
    plans: loadPlans(),
    config
  };
}
