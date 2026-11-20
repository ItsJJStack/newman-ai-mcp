/**
 * @fileoverview Tool 7: validate_postman_collection
 * Performs instant static validation without a model or HTTP requests.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { validateCollectionStatic } from '../postman/parser.js';
import { readFile } from 'node:fs/promises';
import { safePath } from '../errors.js';

const inputSchema = {
  collectionSource: z.string().describe('Collection (path, https URL, or Postman UID)'),
  environmentPath: z.string().optional().describe('Environment path'),
  globalsPath: z.string().optional().describe('Globals path'),
  iterationDataPath: z.string().optional().describe('Iteration data path'),
};

const outputSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({
    severity: z.enum(['error', 'warning']),
    rule: z.enum(['json', 'schema', 'syntax', 'forbidden_api', 'template_in_js', 'undefined_variable', 'runtime_variable']),
    location: z.string(),
    message: z.string(),
  })),
  summary: z.object({
    errors: z.number(),
    warnings: z.number(),
  }),
});

export function registerValidateTool(server: McpServer): void {
  server.registerTool(
    'validate_postman_collection',
    {
      title: 'Validate Postman collection',
      description: 'Instant static validation (no model or HTTP requests). Checks JSON, schema, script syntax, forbidden APIs, and undefined variables.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const { collection } = await loadCollection(args.collectionSource);

        let envData: any = undefined;
        if (args.environmentPath) {
          const envAbs = safePath(args.environmentPath);
          envData = JSON.parse(await readFile(envAbs, 'utf8'));
        }

        let globalsData: any = undefined;
        if (args.globalsPath) {
          const globAbs = safePath(args.globalsPath);
          globalsData = JSON.parse(await readFile(globAbs, 'utf8'));
        }

        let iterationData: any[] | undefined = undefined;
        if (args.iterationDataPath) {
          const iterAbs = safePath(args.iterationDataPath);
          const iterContent = await readFile(iterAbs, 'utf8');
          if (args.iterationDataPath.endsWith('.json')) {
            iterationData = JSON.parse(iterContent);
          } else if (args.iterationDataPath.endsWith('.csv')) {
            // Parse CSV using the supported simple format.
            const lines = iterContent.split(/\r?\n/).filter(Boolean);
            if (lines.length > 0) {
              const headers = lines[0]?.split(',').map(h => h.trim().replace(/^["']|["']$/g, '')) || [];
              iterationData = [];
              for (let i = 1; i < lines.length; i++) {
                const vals = lines[i]?.split(',') || [];
                const row: Record<string, string> = {};
                for (let j = 0; j < headers.length; j++) {
                  const hKey = headers[j];
                  if (hKey) {
                    row[hKey] = vals[j]?.trim().replace(/^["']|["']$/g, '') || '';
                  }
                }
                iterationData.push(row);
              }
            }
          }
        }

        const result = validateCollectionStatic(collection, envData, globalsData, iterationData);

        return toolResult(
          result,
          `Static validation complete: ${result.summary.errors} errors, ${result.summary.warnings} warnings (${result.valid ? 'Valid' : 'Invalid'})`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
