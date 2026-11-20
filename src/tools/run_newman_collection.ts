/**
 * @fileoverview Tool 4: run_newman_collection
 * Runs a local or remote collection with full control over variables, timeouts, SSL, iterations, and state export.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { runCollection } from '../postman/newmanRunner.js';

const inputSchema = {
  collectionSource: z.string().describe('Collection (path, https URL, or Postman UID)'),
  environmentPath: z.string().optional().describe('Environment path (-e)'),
  globalsPath: z.string().optional().describe('Globals path (-g)'),
  envVars: z.record(z.string(), z.string()).optional().describe('Inline environment variables (--env-var)'),
  globalVars: z.record(z.string(), z.string()).optional().describe('Inline global variables (--global-var)'),
  iterationDataPath: z.string().optional().describe('Iteration data path (-d)'),
  iterationCount: z.number().int().min(1).optional().describe('Number of iterations (-n)'),
  folder: z.union([z.string(), z.array(z.string())] as const).optional().describe('Folder(s) to run (--folder)'),
  executionControl: z.object({
    delayRequest: z.number().int().min(0).optional().describe('Delay between requests (ms)'),
    timeout: z.number().int().min(1).default(300000).describe('Total timeout (ms)'),
    timeoutRequest: z.number().int().min(1).optional().describe('Timeout per request (ms)'),
    timeoutScript: z.number().int().min(1).optional().describe('Timeout per script (ms)'),
    bail: z.boolean().optional().describe('Stop on first failure'),
    ignoreRedirects: z.boolean().optional().describe('Ignore redirects'),
    insecure: z.boolean().optional().describe('Ignore SSL certificate errors (-k)'),
  }).optional().describe('Execution controls'),
  sslOptions: z.object({
    clientCertPath: z.string().optional().describe('SSL client certificate'),
    clientKeyPath: z.string().optional().describe('SSL client key'),
    passphrase: z.string().optional().describe('Certificate passphrase'),
  }).optional().describe('SSL options'),
  exports: z.object({
    environmentPath: z.string().optional().describe('Export environment'),
    globalsPath: z.string().optional().describe('Export globals'),
    collectionPath: z.string().optional().describe('Export collection'),
  }).optional().describe('Export files'),
};

const outputSchema = z.object({
  success: z.boolean(),
  aborted: z.boolean(),
  stats: z.object({
    iterations: z.object({ total: z.number(), failed: z.number() }),
    requests: z.object({ total: z.number(), failed: z.number() }),
    assertions: z.object({ total: z.number(), failed: z.number() }),
    testScripts: z.object({ total: z.number(), failed: z.number() }),
    prerequestScripts: z.object({ total: z.number(), failed: z.number() }),
  }),
  timings: z.object({
    totalMs: z.number(),
    avgResponseMs: z.number(),
  }),
  failures: z.array(z.object({
    itemName: z.string(),
    itemPath: z.array(z.string()),
    iteration: z.number(),
    type: z.enum(['assertion', 'exception', 'request']),
    errorMessage: z.string(),
    responseCode: z.number().optional(),
    responseSnippet: z.string().optional(),
  })).max(20),
  truncated: z.boolean(),
  consoleLogs: z.array(z.string()).max(50),
  exportedFiles: z.array(z.string()),
});

export function registerRunNewmanTool(server: McpServer): void {
  server.registerTool(
    'run_newman_collection',
    {
      title: 'Run Newman collection',
      description: 'Runs a local or remote collection with full control over variables, timeouts, SSL, iterations, and state export.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const loaded = await loadCollection(args.collectionSource);
        const result = await runCollection({
          collection: loaded.collection,
          environmentPath: args.environmentPath,
          globalsPath: args.globalsPath,
          envVars: args.envVars,
          globalVars: args.globalVars,
          iterationDataPath: args.iterationDataPath,
          iterationCount: args.iterationCount,
          folder: args.folder,
          executionControl: args.executionControl,
          sslOptions: args.sslOptions,
          exports: args.exports,
        });

        const summaryText = `Collection run ${args.collectionSource}: ${result.success ? 'SUCCESS' : 'FAILED'} (Assertions: ${result.stats.assertions.total - result.stats.assertions.failed}/${result.stats.assertions.total}, Failures: ${result.failures.length})`;

        return toolResult(result, summaryText);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
