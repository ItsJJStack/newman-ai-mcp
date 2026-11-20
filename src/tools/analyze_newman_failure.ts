/**
 * @fileoverview Tool 3: analyze_newman_failure
 * Diagnoses a failure and suggests a corrected script or request.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { getProvider } from '../llm/provider.js';
import { failureDiagnosisSchema } from '../llm/schemas.js';
import { diagnosisSystemPrompt } from '../llm/promptBuilder.js';
import { redactSecrets } from '../llm/redact.js';
import vm from 'node:vm';

const inputSchema = {
  collectionSource: z.string().describe('Executed collection (path, https URL, or Postman UID)'),
  failure: z.object({
    itemName: z.string().describe('Postman item name'),
    itemPath: z.array(z.string()).describe('Folders from the root, e.g. ["Auth", "Login"]'),
    iteration: z.number().describe('Zero-based iteration index'),
    type: z.enum(['assertion', 'exception', 'request']).describe('Failure type'),
    errorMessage: z.string().describe('Error message, e.g. "expected 401 to equal 200"'),
    responseCode: z.number().optional().describe('HTTP response code'),
    responseSnippet: z.string().optional().describe('Response snippet (max. 1500 characters)'),
  }).describe('A NewmanFailure item as returned by tool 4 or 5'),
};

const outputSchema = z.object({
  category: z.enum(['assertion', 'network', 'ssl', 'timeout', 'auth', 'data', 'script_error', 'other']),
  rootCause: z.string().max(400),
  suggestedFix: z.string().max(400),
  fixTarget: z.enum(['test_script', 'prerequest_script', 'request', 'environment', 'server']),
  fixedExec: z.array(z.string().max(200)).nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  validationError: z.string().optional(),
  llm: z.object({
    provider: z.enum(['local', 'openai-compatible']),
    model: z.string(),
  }),
});

/**
 * Recursively finds a collection item by path and name.
 */
function findItemInCollection(items: any[], targetPath: string[], targetName: string): any {
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    if (!item) continue;
    if (Array.isArray(item.item)) {
      const found = findItemInCollection(item.item, targetPath, targetName);
      if (found) return found;
    } else if (item.request) {
      if (item.name === targetName) {
        return item;
      }
    }
  }

  // Fallback: search the entire collection by name only.
  for (const item of items) {
    if (!item) continue;
    if (Array.isArray(item.item)) {
      const foundByName = findItemByNameOnly(item.item, targetName);
      if (foundByName) return foundByName;
    } else if (item.request && item.name === targetName) {
      return item;
    }
  }

  return null;
}

function findItemByNameOnly(items: any[], targetName: string): any {
  for (const item of items) {
    if (!item) continue;
    if (Array.isArray(item.item)) {
      const found = findItemByNameOnly(item.item, targetName);
      if (found) return found;
    } else if (item.request && item.name === targetName) {
      return item;
    }
  }
  return null;
}

export function registerAnalyzeFailureTool(server: McpServer): void {
  server.registerTool(
    'analyze_newman_failure',
    {
      title: 'Analyze Newman failure',
      description: 'Diagnoses a failure and suggests a corrected script or request.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const loaded = await loadCollection(args.collectionSource);
        const item = findItemInCollection(loaded.collection.item || [], args.failure.itemPath, args.failure.itemName);

        if (!item) {
          return toolError(`Could not find item "${args.failure.itemName}" in the collection.`);
        }

        // Deterministic analysis for common network and SSL errors.
        let deterministicCategory: any = null;
        let deterministicCause = '';
        let deterministicFix = '';

        const errMsg = args.failure.errorMessage.toLowerCase();
        if (errMsg.includes('econnrefused')) {
          deterministicCategory = 'network';
          deterministicCause = 'The server is not running or the URL/port is incorrect (ECONNREFUSED).';
          deterministicFix = 'Start the local server or check the baseUrl variable.';
        } else if (errMsg.includes('enotfound')) {
          deterministicCategory = 'network';
          deterministicCause = 'The hostname could not be resolved (ENOTFOUND).';
          deterministicFix = 'Check the URL or network connectivity.';
        } else if (errMsg.includes('etimedout') || errMsg.includes('timeout')) {
          deterministicCategory = 'timeout';
          deterministicCause = 'The request exceeded the timeout.';
          deterministicFix = 'Increase the timeout or check whether the service is slow.';
        } else if (errMsg.includes('self signed certificate') || errMsg.includes('unable to verify')) {
          deterministicCategory = 'ssl';
          deterministicCause = 'The SSL certificate is self-signed or untrusted.';
          deterministicFix = 'Use the insecure option (true) or configure client certificates.';
        }

        const provider = await getProvider();
        const redactedItem = redactSecrets(item);

        const userPromptObj = {
          failure: args.failure,
          item: redactedItem,
          ...(deterministicCategory ? { deterministicHint: { category: deterministicCategory, cause: deterministicCause, fix: deterministicFix } } : {}),
        };

        let diagnosis: any = null;
        let retries = 0;
        let lastError: any = null;

        while (retries < 2) {
          try {
            diagnosis = await provider.generateJson({
              system: diagnosisSystemPrompt,
              user: JSON.stringify(userPromptObj, null, 2),
              schema: failureDiagnosisSchema,
              maxTokens: 800,
            });
            break;
          } catch (err) {
            retries++;
            lastError = err;
          }
        }

        if (!diagnosis) {
          throw new Error(`Failure analysis failed after retries: ${lastError?.message || 'unknown error'}`);
        }

        let fixedExec: string[] | null = Array.isArray(diagnosis.fixedExec) && diagnosis.fixedExec.length > 0 ? diagnosis.fixedExec : null;
        let validationError: string | undefined = undefined;

        if (fixedExec && fixedExec.length > 0) {
          const codeSnippet = fixedExec.join('\n');
          try {
            new vm.Script(codeSnippet, { filename: 'fixed_script' });
          } catch (err: any) {
            validationError = err.message || 'Syntax error in the proposed corrected script.';
            fixedExec = null;
          }
        }

        return toolResult({
          category: diagnosis.category || deterministicCategory || 'assertion',
          rootCause: diagnosis.rootCause || deterministicCause || args.failure.errorMessage,
           suggestedFix: diagnosis.suggestedFix || deterministicFix || 'Check the assertion or submitted data.',
          fixTarget: diagnosis.fixTarget || 'test_script',
          fixedExec,
          confidence: diagnosis.confidence || 'medium',
          ...(validationError ? { validationError } : {}),
          llm: { provider: provider.id, model: provider.model },
        }, `Failure diagnosis for "${args.failure.itemName}": category ${diagnosis.category}, root cause: ${diagnosis.rootCause}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
