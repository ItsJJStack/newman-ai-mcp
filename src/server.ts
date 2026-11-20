/**
 * @fileoverview Creates and configures the MCP server with 9 tools.
 * Registers each tool with its inputSchema, outputSchema, and handler.
 * Tool handlers live in src/tools/; this module only wires them together.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConfig } from './config.js';
import { toolError, toolResult, safePath } from './errors.js';

// Import tool handlers.
import { registerInspectTool } from './tools/inspect_postman_collection.js';
import { registerValidateTool } from './tools/validate_postman_collection.js';
import { registerImportOpenApiTool } from './tools/import_openapi_spec.js';
import { registerRunNewmanTool } from './tools/run_newman_collection.js';
import { registerGenerateReportTool } from './tools/generate_newman_report.js';
import { registerGenerateCicdTool } from './tools/generate_cicd_pipeline.js';
import { registerGenerateTestsTool } from './tools/generate_tests_from_story.js';
import { registerGenerateDatasetTool } from './tools/generate_test_dataset.js';
import { registerAnalyzeFailureTool } from './tools/analyze_newman_failure.js';

/**
 * Creates the MCP server and registers the 9 tools.
 * @returns Configured McpServer instance
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'newman-ai-mcp',
    version: '0.1.0',
  });

  // Tool 6: inspect_postman_collection.
  registerInspectTool(server);

  // Tool 7: validate_postman_collection.
  registerValidateTool(server);

  // Tool 9: import_openapi_spec.
  registerImportOpenApiTool(server);

  // Tool 4: run_newman_collection.
  registerRunNewmanTool(server);

  // Tool 5: generate_newman_report.
  registerGenerateReportTool(server);

  // Tool 8: generate_cicd_pipeline.
  registerGenerateCicdTool(server);

  // Tool 1: generate_tests_from_story (AI).
  registerGenerateTestsTool(server);

  // Tool 2: generate_test_dataset (AI).
  registerGenerateDatasetTool(server);

  // Tool 3: analyze_newman_failure (AI).
  registerAnalyzeFailureTool(server);

  return server;
}

/**
 * Shared Zod schema for collectionSource (used by all relevant tools).
 * Collection source validation is centralized in validateCollectionSource.
 */
export const collectionSourceSchema = z.string().describe(
  'Collection source: local path (./api.json), https URL, or Postman UID (12345678-0a1b2c3d-...)'
);

/**
 * Zod schema for outputPath with overwrite validation.
 */
export const outputPathSchema = z.object({
  outputPath: z.string().describe('Output path (validated through safePath)'),
  overwrite: z.boolean().default(false).describe('Allow replacing an existing file'),
});

/**
 * Validates collectionSource and throws an error when invalid.
 * Useful for early validation in handlers.
 */
export async function validateCollectionSource(source: string): Promise<void> {
  const config = getConfig();
  
  // Reject http:// URLs.
  if (source.startsWith('http://')) {
    throw new Error('http:// URLs are not allowed. Use https:// or a local path.');
  }
  
  // Reject API keys in URL queries.
  if (source.includes('apikey=')) {
    throw new Error('Do not include an API key in the URL. Set POSTMAN_API_KEY in the environment.');
  }
  
  // Validate local paths with safePath.
  if (!source.startsWith('https://') && !/^\d+-[0-9a-fA-F-]{36}$/.test(source)) {
    safePath(source); // Throws when outside NEWMAN_MCP_ROOT.
  }
}
