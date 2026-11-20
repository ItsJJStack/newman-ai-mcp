/**
 * @fileoverview Tool 1: generate_tests_from_story
 * Generates API test cases from a user story or natural-language idea
 * for a Postman collection from any source.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult, safePath } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { buildEndpointCatalog, extractAcceptanceCriteria } from '../postman/storyAnalyzer.js';
import { getProvider } from '../llm/provider.js';
import { getTestPlanSchema, getTestCaseDraftSchema } from '../llm/schemas.js';
import { plannerSystemPrompt, caseWriterSystemPrompt } from '../llm/promptBuilder.js';
import { redactSecrets } from '../llm/redact.js';
import { validateCollectionStatic } from '../postman/parser.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const inputSchema = {
  collectionSource: z.string().describe('Collection (path, https URL, or Postman UID)'),
  userStory: z.string().min(20).max(4000).describe('User story, acceptance criteria, or natural-language idea'),
  acceptanceCriteria: z.array(z.string().max(300)).min(1).max(8).optional().describe('Acceptance criteria already separated'),
  additionalContext: z.string().max(2000).optional().describe('User answers to questions from a previous call'),
  maxTestCases: z.number().int().min(1).max(8).default(5).describe('Maximum number of scenarios'),
  includePreRequestScripts: z.boolean().default(false).describe('Allow prerequest scripts in generated cases'),
  outputPath: z.string().optional().describe('Output path (required for a remote collection source)'),
  overwrite: z.boolean().default(false).describe('Allow replacing outputPath'),
};

const outputSchema = z.object({
  status: z.enum(['ready', 'needs_info', 'out_of_scope']),
  missingInfo: z.array(z.object({
    topic: z.enum(['endpoint', 'expected_result', 'business_rule', 'preconditions', 'scope']),
    question: z.string(),
  })),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.object({
    id: z.string(),
    text: z.string(),
    source: z.enum(['input', 'gherkin', 'list', 'none']),
    coveredBy: z.array(z.string()),
  })),
  outputPath: z.string().nullable(),
  folderName: z.string().nullable(),
  testCases: z.array(z.object({
    id: z.string(),
    name: z.string(),
    criterionId: z.string(),
    kind: z.enum(['positive', 'negative', 'edge', 'security']),
    endpoint: z.string(),
    expectedStatus: z.number(),
  })),
  skipped: z.array(z.object({
    scenario: z.string(),
    reason: z.string(),
  })),
  requiredVariables: z.array(z.string()),
  validation: z.object({
    errors: z.number(),
    warnings: z.number(),
  }),
  warnings: z.array(z.string()),
  retries: z.number(),
  llm: z.object({
    provider: z.enum(['local', 'openai-compatible']),
    model: z.string(),
  }),
});

/**
 * Returns why a generated test script is unusable, or null when it is valid.
 * Reuses the static collection validator so the rules stay in one place.
 */
export function testScriptProblem(lines: string[]): string | null {
  if (lines.length === 0) return 'empty test script';
  const probe = {
    info: { name: 'probe' },
    item: [{ name: 'case', event: [{ listen: 'test', script: { exec: lines } }] }],
  };
  const issue = validateCollectionStatic(probe).issues.find(i => i.severity === 'error');
  if (issue) return issue.message;
  if (lines.some(l => /\{\{[^}]+\}\}/.test(l))) return 'uses {{variable}} inside JavaScript';
  return null;
}

export function registerGenerateTestsTool(server: McpServer): void {
  server.registerTool(
    'generate_tests_from_story',
    {
      title: 'Generate tests from story',
      description: 'Generates API test cases from a user story or natural-language idea for a Postman collection (path, URL, or UID).',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const loaded = await loadCollection(args.collectionSource);
        const collection = loaded.collection;

        if (!collection.item || !Array.isArray(collection.item) || collection.item.length === 0) {
          return toolError('The collection contains no requests or folders.');
        }

        const { catalog, folders, catalogNote } = buildEndpointCatalog(collection);
        if (catalog.length === 0) {
          return toolError('The collection has no usable endpoints for test generation.');
        }

        const criteriaExtracted = extractAcceptanceCriteria(args.userStory, args.acceptanceCriteria);
        const criteriaList = criteriaExtracted.criteria;

        if (criteriaList.length > 8) {
          return toolError('Too many acceptance criteria (maximum 8). Split the story into smaller parts.');
        }

        const maxScenarios = Math.min(8, Math.max(args.maxTestCases, criteriaList.length));
        const endpointEnums = catalog.map(c => c.id);
        const criterionEnums = criteriaList.length > 0 ? criteriaList.map(c => c.id) : ['extra'];

        const planSchema = getTestPlanSchema(maxScenarios, endpointEnums, criterionEnums);
        const provider = await getProvider();

        // Preparar prompt del planificador
        const userPromptObj = {
          USER_STORY: args.userStory,
          ACCEPTANCE_CRITERIA: criteriaList.length > 0 ? criteriaList : 'none',
          ADDITIONAL_CONTEXT: args.additionalContext || 'none',
          MAX_SCENARIOS: maxScenarios,
          AVAILABLE_FOLDERS: folders,
          ...(catalogNote ? { CATALOG_NOTE: catalogNote } : {}),
          ENDPOINT_CATALOG: redactSecrets(catalog),
        };

        let retries = 0;
        let planResult: any = null;
        let lastError: any = null;

        while (retries < 2) {
          try {
            planResult = await provider.generateJson({
              system: plannerSystemPrompt,
              user: JSON.stringify(userPromptObj, null, 2),
              schema: planSchema,
              maxTokens: 900,
            });
            break;
          } catch (err) {
            retries++;
            lastError = err;
          }
        }

        if (!planResult) {
          throw new Error(`Test plan generation failed after retries: ${lastError?.message || 'unknown error'}`);
        }

        // If status is not ready
        if (planResult.status !== 'ready') {
          const criteriaMapped = criteriaList.map(c => ({
            id: c.id,
            text: c.text,
            source: c.source,
            coveredBy: [] as string[],
          }));

          return toolResult({
            status: planResult.status,
            missingInfo: planResult.missingInfo || [],
            assumptions: planResult.assumptions || [],
            acceptanceCriteria: criteriaMapped,
            outputPath: null,
            folderName: null,
            testCases: [],
            skipped: [],
            requiredVariables: [],
            validation: { errors: 0, warnings: 0 },
            warnings: [],
            retries,
            llm: { provider: provider.id, model: provider.model },
          }, `The plan needs more information (${planResult.status}).`);
        }

        // Notify progress if token exists
        const progressToken = (extra as any)?._meta?.progressToken;
        const sendNotification = (extra as any)?.sendNotification;
        const totalSteps = (planResult.scenarios?.length || 0) + 1;

        if (sendNotification && progressToken) {
          try {
            await sendNotification({
              method: 'notifications/progress',
                params: { progressToken, progress: 1, total: totalSteps, message: 'Plan generated successfully' },
            });
          } catch {
            // Ignore progress notification failures.
          }
        }

        // Redactar cada escenario
        const testCasesDrafts: any[] = [];
        const skipped: { scenario: string; reason: string }[] = [];
        const generatedTestCases: any[] = [];
        const requiredVarsSet = new Set<string>();

        const scenarios = planResult.scenarios || [];
        for (let i = 0; i < scenarios.length; i++) {
          const sc = scenarios[i];
          const endpoint = catalog.find(c => c.id === sc.endpointId) || catalog[0];
          if (!endpoint) {
            skipped.push({ scenario: sc.title || `Scenario ${i + 1}`, reason: 'Endpoint was not found in the catalog.' });
            continue;
          }

          const caseSchema = getTestCaseDraftSchema(args.includePreRequestScripts);
          const caseUserObj = {
            STORY_TITLE: planResult.title || 'Tests',
            SCENARIO: sc,
            INCLUDE_PREREQUEST: args.includePreRequestScripts,
            ENDPOINT: redactSecrets(endpoint),
            DOCUMENTED_RESPONSE: endpoint?.responseKeys[String(sc.expectedStatus)] || [],
            AVAILABLE_VARIABLES: collection.variable ? collection.variable.map((v: any) => v.key) : [],
          };

          let caseDraft: any = null;
          let caseRetries = 0;
          let caseOk = false;
          let failReason = 'Failed to generate a case draft after retries.';

          while (caseRetries < 2 && !caseOk) {
            try {
              caseDraft = await provider.generateJson({
                system: caseWriterSystemPrompt,
                user: JSON.stringify(caseUserObj, null, 2),
                schema: caseSchema,
                maxTokens: 700,
              });
              caseDraft.testScript = (caseDraft.testScript || []).filter((l: unknown) => typeof l === 'string' && l.trim());
              const problem = testScriptProblem(caseDraft.testScript);
              if (problem) {
                failReason = `Invalid test script after retries: ${problem}`;
                throw new Error(problem);
              }
              caseOk = true;
            } catch {
              caseRetries++;
              retries++;
            }
          }

          if (!caseOk || !caseDraft) {
            skipped.push({ scenario: sc.title || `Scenario ${i + 1}`, reason: failReason });
            continue;
          }

          const caseId = `TC${i + 1}`;
          generatedTestCases.push({
            id: caseId,
            name: caseDraft.name || sc.title,
            criterionId: sc.criterionId || 'extra',
            kind: sc.kind || 'positive',
            endpoint: `${endpoint.method} ${endpoint.path}`,
            expectedStatus: sc.expectedStatus,
          });

          testCasesDrafts.push({
            caseId,
            draft: caseDraft,
            endpoint,
            criterionId: sc.criterionId,
          });

          if (sendNotification && progressToken) {
            try {
              await sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: i + 2, total: totalSteps, message: `Case ${i + 1} of ${scenarios.length}: ${sc.title}` },
              });
            } catch {
              // Ignorar
            }
          }
        }

        if (generatedTestCases.length === 0) {
          return toolError('No valid test cases could be generated from the scenarios.');
        }

        // Assemble the collection.
        const newCollection = JSON.parse(JSON.stringify(collection));
        if (!Array.isArray(newCollection.item)) {
          newCollection.item = [];
        }

        let folderName = `Tests - ${planResult.title || 'Story'}`;
        // Ensure the folder name is unique.
        let existingFolder = newCollection.item.find((it: any) => it.name === folderName);
        let folderSuffix = 2;
        while (existingFolder) {
          folderName = `Tests - ${planResult.title || 'Story'} (${folderSuffix++})`;
          existingFolder = newCollection.item.find((it: any) => it.name === folderName);
        }

        const newFolderItem: any = {
          name: folderName,
          description: `User story:\n${args.userStory}\n\nAssumptions:\n${(planResult.assumptions || []).join('\n')}`,
          item: [],
        };

        for (const itemData of testCasesDrafts) {
          const { caseId, draft, endpoint, criterionId } = itemData;
          const criterion = criteriaList.find(c => c.id === criterionId);

          const reqItem: any = {
            name: `[${caseId}] ${draft.name}`,
            request: {
              method: draft.method || endpoint.method,
              header: draft.headers || [],
              // The model often rewrites the host; the catalog owns base and path.
              url: `${endpoint.base}${endpoint.path}`,
              description: `${draft.description || ''}\n${criterion ? `Criterion ${criterion.id}: ${criterion.text}` : ''}`,
            },
            event: [
              {
                listen: 'test',
                script: {
                  type: 'text/javascript',
                  exec: draft.testScript || [],
                },
              },
            ],
          };

          if (draft.auth === 'none') {
            reqItem.request.auth = { type: 'noauth' };
          } else if (endpoint.auth && endpoint.auth !== 'none') {
            reqItem.request.auth = { type: endpoint.auth };
          }

          if (draft.body && draft.body.trim().length > 0) {
            reqItem.request.body = {
              mode: 'raw',
              raw: draft.body,
              options: { raw: { language: 'json' } },
            };
          }

          if (Array.isArray(draft.prerequestScript) && draft.prerequestScript.length > 0) {
            reqItem.event.push({
              listen: 'prerequest',
              script: {
                type: 'text/javascript',
                exec: draft.prerequestScript,
              },
            });
          }

          // Detect {{var}} references in the generated item.
          const serialized = JSON.stringify(reqItem);
          const varMatches = serialized.matchAll(/\{\{([^\}]+)\}\}/g);
          for (const vm of varMatches) {
            const vName = vm[1]?.trim();
            if (vName && !vName.startsWith('$')) {
              requiredVarsSet.add(vName);
            }
          }

          newFolderItem.item.push(reqItem);
        }

        newCollection.item.push(newFolderItem);

        // Declare required collection variables when missing.
        if (!Array.isArray(newCollection.variable)) {
          newCollection.variable = [];
        }
        const existingVars = new Set(newCollection.variable.map((v: any) => v.key));
        const requiredVariables: string[] = [];

        for (const rv of requiredVarsSet) {
          if (!existingVars.has(rv)) {
            newCollection.variable.push({ key: rv, value: '' });
            requiredVariables.push(rv);
          }
        }

        // Statically validate the resulting collection.
        const valResult = validateCollectionStatic(newCollection);

        // Determine the output path.
        let outputPath = args.outputPath;
        if (!outputPath) {
          const parsedSource = path.parse(args.collectionSource);
          outputPath = path.join(parsedSource.dir || '.', `${parsedSource.name}.tests.postman_collection.json`);
        }

        const resolvedOutputPath = safePath(outputPath);
        if (!args.overwrite) {
          // Comprobar si existe
          try {
            await writeFile(resolvedOutputPath, JSON.stringify(newCollection, null, 2), { flag: 'wx' });
          } catch {
            return toolError(`Output file ${outputPath} already exists. Set overwrite: true to replace it.`);
          }
        } else {
          await writeFile(resolvedOutputPath, JSON.stringify(newCollection, null, 2), 'utf8');
        }

        // Map criterion coverage.
        const acceptanceCriteriaMapped = criteriaList.map(c => {
          const coveredBy: string[] = [];
          for (const dt of testCasesDrafts) {
            if (dt.criterionId === c.id) {
              const found = generatedTestCases.find(gt => gt.name === dt.draft.name);
              if (found) coveredBy.push(found.id);
            }
          }
          return {
            id: c.id,
            text: c.text,
            source: c.source,
            coveredBy,
          };
        });

        const warnings: string[] = [];
        for (const ac of acceptanceCriteriaMapped) {
          if (ac.coveredBy.length === 0) {
            warnings.push(`Criterion ${ac.id} ("${ac.text}") was not covered by any scenario.`);
          }
        }

        return toolResult({
          status: 'ready',
          missingInfo: [],
          assumptions: planResult.assumptions || [],
          acceptanceCriteria: acceptanceCriteriaMapped,
          outputPath,
          folderName,
          testCases: generatedTestCases,
          skipped,
          requiredVariables,
          validation: valResult.summary,
          warnings,
          retries,
          llm: { provider: provider.id, model: provider.model },
        }, `Generated ${generatedTestCases.length} test cases in folder "${folderName}" and wrote them to ${outputPath}.`);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
