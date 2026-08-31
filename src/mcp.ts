import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tools/context.js';
import { registerLookupTools, registerDetailTools } from './tools/lookup.js';
import { registerPlanTools } from './tools/plan.js';
import { registerSearchTools, registerFacilityTools } from './tools/search.js';

export { buildToolContext } from './tools/context.js';
export type { ToolContext } from './tools/context.js';

/**
 * Builds the MCP surface. Called once per /mcp request (stateless transport),
 * so it must stay cheap — every expensive, long-lived object lives on the
 * ToolContext built once at startup.
 */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'oscarhealth-provider-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  registerLookupTools(server, ctx);
  registerPlanTools(server, ctx);
  registerSearchTools(server, ctx);
  registerFacilityTools(server, ctx);
  registerDetailTools(server, ctx);
  return server;
}
