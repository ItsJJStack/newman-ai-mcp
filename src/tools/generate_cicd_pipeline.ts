/**
 * @fileoverview Tool 8: generate_cicd_pipeline
 * Generates configuration for running Newman in CI/CD or Docker.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult, writeSafeFile } from '../errors.js';
import { generateCicdPipelineConfig } from '../postman/cicdTemplates.js';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { safePath } from '../errors.js';

const inputSchema = {
  platform: z.enum(['github-actions', 'gitlab-ci', 'azure-devops', 'jenkins', 'dockerfile']).describe('Target platform'),
  collectionSource: z.string().describe('Collection (repo-relative path, https URL, or Postman UID)'),
  environmentPath: z.string().optional().describe('Environment file path'),
  iterationDataPath: z.string().optional().describe('Iteration data path'),
  useHtmlExtra: z.boolean().default(false).describe('Add newman-reporter-htmlextra alongside JUnit'),
  nodeVersion: z.string().default('20').describe('Node version for the image or runner'),
  outputPath: z.string().optional().describe('Write the file when provided; otherwise return content only'),
  overwrite: z.boolean().default(false).describe('Allow replacing outputPath'),
};

const outputSchema = z.object({
  platform: z.string(),
  suggestedPath: z.string(),
  writtenTo: z.string().nullable(),
  content: z.string(),
  requiredSecrets: z.array(z.string()),
});

export function registerGenerateCicdTool(server: McpServer): void {
  server.registerTool(
    'generate_cicd_pipeline',
    {
      title: 'Generate CI/CD pipeline',
      description: 'Generates configuration to run Newman in CI/CD or Docker (GitHub Actions, GitLab CI, Azure DevOps, Jenkins, Dockerfile).',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const configResult = generateCicdPipelineConfig({
          platform: args.platform,
          collectionSource: args.collectionSource,
          environmentPath: args.environmentPath,
          iterationDataPath: args.iterationDataPath,
          useHtmlExtra: args.useHtmlExtra,
          nodeVersion: args.nodeVersion,
        });

        let writtenTo: string | null = null;
        if (args.outputPath) {
          const output = safePath(args.outputPath);
          await mkdir(dirname(output), { recursive: true });
          await writeSafeFile(args.outputPath, configResult.content, { overwrite: args.overwrite });
          writtenTo = output;
        }

        const summaryText = `CI/CD pipeline generated for ${args.platform}${writtenTo ? ` and saved to ${writtenTo}` : ''}`;

        return toolResult({
          platform: args.platform,
          suggestedPath: configResult.suggestedPath,
          writtenTo,
          content: configResult.content,
          requiredSecrets: configResult.requiredSecrets,
        }, summaryText);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
