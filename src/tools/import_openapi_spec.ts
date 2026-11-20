/**
 * @fileoverview Tool 9: import_openapi_spec
 * Generates a Postman v2.1 collection from OpenAPI 3.0/3.1/Swagger 2.0, or syncs an existing collection.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult } from '../errors.js';
import { importOpenApiSpec } from '../postman/openapiImporter.js';

const inputSchema = {
  specSource: z.string().describe('Local path (.json/.yaml/.yml) or https URL to an OpenAPI/Swagger spec'),
  outputPath: z.string().describe('Path for the resulting collection'),
  mode: z.enum(['create', 'sync']).default('create').describe('create: new collection; sync: update an existing collection'),
  collectionSource: z.string().optional().describe('Collection to sync (required when mode=sync)'),
  deleteOrphanedRequests: z.boolean().default(false).describe('Sync only: remove requests absent from the spec'),
  folderStrategy: z.enum(['Tags', 'Paths']).default('Tags').describe('How to group items into folders'),
  parametersResolution: z.enum(['Example', 'Schema']).default('Example').describe('Use spec examples or generate values from schemas'),
  includeDeprecated: z.boolean().default(false).describe('Include deprecated operations'),
  generateBasicTests: z.boolean().default(true).describe('Add deterministic contract tests'),
  baseUrlVariable: z.string().default('baseUrl').describe('Collection variable name for the base URL'),
  overwrite: z.boolean().default(false).describe('Allow replacing outputPath'),
};

const outputSchema = z.object({
  outputPath: z.string(),
  mode: z.enum(['create', 'sync']),
  spec: z.object({
    version: z.string(),
    title: z.string(),
    apiVersion: z.string(),
  }),
  totalItems: z.number(),
  folders: z.array(z.string()),
  variables: z.array(z.string()),
  testsGenerated: z.number(),
  sync: z.object({
    added: z.number(),
    updated: z.number(),
    removed: z.number(),
  }).optional(),
  warnings: z.array(z.string()),
  validation: z.object({
    errors: z.number(),
    warnings: z.number(),
  }),
});

export function registerImportOpenApiTool(server: McpServer): void {
  server.registerTool(
    'import_openapi_spec',
    {
      title: 'Import OpenAPI specification',
      description: 'Generates a Postman v2.1 collection from OpenAPI 3.0/3.1/Swagger 2.0 (JSON/YAML), or syncs an existing collection with a new spec version. Deterministic: uses openapi-to-postmanv2 without a model.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await importOpenApiSpec({
          specSource: args.specSource,
          outputPath: args.outputPath,
          mode: args.mode,
          collectionSource: args.collectionSource,
          deleteOrphanedRequests: args.deleteOrphanedRequests,
          folderStrategy: args.folderStrategy,
          parametersResolution: args.parametersResolution,
          includeDeprecated: args.includeDeprecated,
          generateBasicTests: args.generateBasicTests,
          baseUrlVariable: args.baseUrlVariable,
          overwrite: args.overwrite,
        });

        return toolResult(
          result,
          `OpenAPI spec imported: ${result.spec.title} (${result.totalItems} requests, ${result.testsGenerated} tests generated)`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
