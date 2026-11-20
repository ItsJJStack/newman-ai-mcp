/**
 * @fileoverview Tool 2: generate_test_dataset
 * Generates a --iteration-data file (.json or .csv) with positive, negative, and boundary-value cases.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult, safePath } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { extractItems, extractVariableReferences } from '../postman/parser.js';
import { getProvider } from '../llm/provider.js';
import { getDatasetDraftSchema } from '../llm/schemas.js';
import { datasetSystemPrompt } from '../llm/promptBuilder.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const inputSchema = {
  collectionSource: z.string().describe('Collection (path, https URL, or Postman UID)'),
  targetItemName: z.string().optional().describe('Item to parameterize (if omitted, use all variables, max. 15)'),
  scenarioCount: z.number().int().min(1).max(12).default(5).describe('Number of rows'),
  outputPath: z.string().describe('Output path (must end in .json or .csv)'),
  overwrite: z.boolean().default(false).describe('Allow replacing an existing file'),
};

const outputSchema = z.object({
  outputPath: z.string(),
  format: z.enum(['json', 'csv']),
  rows: z.number(),
  columns: z.array(z.string()),
});

export function registerGenerateDatasetTool(server: McpServer): void {
  server.registerTool(
    'generate_test_dataset',
    {
      title: 'Generate test dataset',
      description: 'Generates a --iteration-data file (.json or .csv) with positive, negative, and boundary-value cases.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const ext = path.extname(args.outputPath).toLowerCase();
        if (ext !== '.json' && ext !== '.csv') {
          return toolError('outputPath must end in .json or .csv.');
        }

        const loaded = await loadCollection(args.collectionSource);
        const parsedItems = extractItems(loaded.collection.item || []);

        let targetItems = parsedItems;
        if (args.targetItemName) {
          targetItems = parsedItems.filter(it => it.name.toLowerCase() === args.targetItemName!.toLowerCase());
          if (targetItems.length === 0) {
            return toolError(`No item named "${args.targetItemName}" was found.`);
          }
        }

        const variablesSet = new Set<string>();
        for (const item of targetItems) {
          const serialized = JSON.stringify(item.rawItem);
          const refs = extractVariableReferences(serialized);
          for (const r of refs) {
            if (!r.startsWith('$')) {
              variablesSet.add(r);
            }
          }
        }

        const variables = Array.from(variablesSet).slice(0, 15);
        if (variables.length === 0) {
          return toolError('No {{variable}} references were found in the collection (or selected item) to parameterize.');
        }

        const datasetSchema = getDatasetDraftSchema(args.scenarioCount, variables);
        const provider = await getProvider();

        const userPromptObj = {
          variables,
          scenarioCount: args.scenarioCount,
          instructions: `Generate exactly ${args.scenarioCount} test rows (positive, negative, and boundary-value) for variables [${variables.join(', ')}]. Include _scenario and _expectedStatus (integer from 100 to 599) in each row.`,
        };

        let datasetResult: any = null;
        let retries = 0;
        let lastError: any = null;

        while (retries < 2) {
          try {
            datasetResult = await provider.generateJson({
              system: datasetSystemPrompt,
              user: JSON.stringify(userPromptObj, null, 2),
              schema: datasetSchema,
              maxTokens: 1500,
            });
            break;
          } catch (err) {
            retries++;
            lastError = err;
          }
        }

        if (!datasetResult || !Array.isArray(datasetResult.rows)) {
          throw new Error(`Dataset generation failed after retries: ${lastError?.message || 'invalid response'}`);
        }

        const rows = datasetResult.rows;
        // Validate _expectedStatus.
        for (const row of rows) {
          if (typeof row._expectedStatus !== 'number' || row._expectedStatus < 100 || row._expectedStatus > 599) {
            row._expectedStatus = 200; // Default correction.
          }
        }

        const format = ext === '.csv' ? 'csv' : 'json';
        const columns = ['_scenario', '_expectedStatus', ...variables];

        let fileContent = '';
        if (format === 'json') {
          fileContent = JSON.stringify(rows, null, 2);
        } else {
          // RFC 4180 CSV.
          const escapeCsv = (val: any) => {
            if (val === undefined || val === null) return '';
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          };

          const lines = [columns.join(',')];
          for (const row of rows) {
            const lineValues = columns.map(col => escapeCsv(row[col] ?? ''));
            lines.push(lineValues.join(','));
          }
          fileContent = lines.join('\n');
        }

        const resolvedPath = safePath(args.outputPath);
        if (!args.overwrite) {
          try {
            await writeFile(resolvedPath, fileContent, { flag: 'wx' });
          } catch {
            return toolError(`File ${args.outputPath} already exists. Set overwrite: true to replace it.`);
          }
        } else {
          await writeFile(resolvedPath, fileContent, 'utf8');
        }

        return toolResult({
          outputPath: args.outputPath,
          format,
          rows: rows.length,
          columns,
        }, `Dataset generated at ${args.outputPath} (${rows.length} rows, ${format} format).`);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
