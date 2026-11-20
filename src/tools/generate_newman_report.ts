/**
 * @fileoverview Tool 5: generate_newman_report
 * Runs a collection and generates a report for auditing or CI/CD.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult, safePath } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { runCollection } from '../postman/newmanRunner.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const inputSchema = {
  collectionSource: z.string().describe('Collection (path, https URL, or Postman UID)'),
  environmentPath: z.string().optional().describe('Environment path'),
  iterationDataPath: z.string().optional().describe('Iteration data path'),
  reportFormats: z.array(z.enum(['json', 'junit', 'htmlextra'])).min(1).max(3).describe('Report formats'),
  outputDir: z.string().describe('Output directory'),
  insecure: z.boolean().default(false).describe('Ignore certificate errors'),
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
  reports: z.array(z.object({
    format: z.string(),
    path: z.string(),
  })),
});

export function registerGenerateReportTool(server: McpServer): void {
  server.registerTool(
    'generate_newman_report',
    {
      title: 'Generate Newman report',
      description: 'Runs a collection and generates a report for auditing or CI/CD (JSON, JUnit, HTML Extra).',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.reportFormats.includes('htmlextra')) {
          try {
            await import('newman-reporter-htmlextra');
          } catch {
            return toolError('The "htmlextra" format requires an installed package. Run: npm i newman-reporter-htmlextra');
          }
        }

        const absOutDir = safePath(args.outputDir);
        await mkdir(absOutDir, { recursive: true });

        const loaded = await loadCollection(args.collectionSource);

        const reporters = args.reportFormats;
        const reporterConfig: Record<string, any> = {};
        const reports: { format: string; path: string }[] = [];

        for (const fmt of args.reportFormats) {
          let fileName = 'newman-report.json';
          if (fmt === 'junit') fileName = 'newman-report.xml';
          else if (fmt === 'htmlextra') fileName = 'newman-report.html';

          const reportPath = resolve(absOutDir, fileName);
          reporterConfig[fmt] = { export: reportPath };
          reports.push({ format: fmt, path: reportPath });
        }

        const result = await runCollection({
          collection: loaded.collection,
          environmentPath: args.environmentPath,
          iterationDataPath: args.iterationDataPath,
          executionControl: { insecure: args.insecure },
          reporters,
          reporter: reporterConfig,
        });

        const summaryText = `Newman report generated in ${absOutDir} (${args.reportFormats.join(', ')}): ${result.success ? 'SUCCESS' : 'FAILED'}`;

        return toolResult({ ...result, reports }, summaryText);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
