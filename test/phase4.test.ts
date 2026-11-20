/**
 * @fileoverview Phase 4 tests: AI, schemas, redaction, and story analysis.
 */
import { describe, it, expect } from 'vitest';
import { extractAcceptanceCriteria, buildEndpointCatalog } from '../src/postman/storyAnalyzer.js';
import { redactSecrets } from '../src/llm/redact.js';
import { getTestPlanSchema, getTestCaseDraftSchema, getDatasetDraftSchema, failureDiagnosisSchema, toRemoteSchema } from '../src/llm/schemas.js';
import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';
import { safePath } from '../src/errors.js';
import { validateCollectionStatic } from '../src/postman/parser.js';

describe('Phase 4: AI and LLM utilities', () => {
  it('matches fixture validator rules, runtime warnings, and line locations', async () => {
    const raw = await readFile(safePath('test/fixtures/collection-invalid.json'), 'utf8');
    const result = validateCollectionStatic(JSON.parse(raw));
    expect(result.issues.some(issue => issue.rule === 'runtime_variable' && issue.severity === 'warning')).toBe(true);
    expect(result.issues.some(issue => issue.rule === 'undefined_variable' && issue.message.includes('neverDefined'))).toBe(true);
    expect(result.issues.some(issue => issue.message.includes('$guid'))).toBe(false);
    expect(result.issues.filter(issue => issue.location.includes('line')).every(issue => /> (test|prerequest) > line \d+$/.test(issue.location))).toBe(true);
  });

  it('ignores forbidden API words in comments and literals and accepts await inside async functions', () => {
    const collection = { info: { name: 'Validator edge' }, item: [{ name: 'Safe script', request: { method: 'GET', url: '{{baseUrl}}/safe' }, event: [{ listen: 'test', script: { exec: ["// fetch window document", "const text = 'fetch window document';", 'async function run() { await Promise.resolve(); }'] } }] }] };
    const result = validateCollectionStatic(collection);
    expect(result.issues.some(issue => issue.rule === 'forbidden_api')).toBe(false);
    expect(result.issues.some(issue => issue.rule === 'syntax' && issue.message.toLowerCase().includes('await'))).toBe(false);
  });

  it('reports a later script-set variable as a runtime warning', () => {
    const collection = { info: { name: 'Runtime order' }, item: [
      { name: 'Reads first', request: { method: 'GET', url: '{{baseUrl}}/{{sessionId}}' } },
      { name: 'Sets later', request: { method: 'GET', url: '{{baseUrl}}/set' }, event: [{ listen: 'test', script: { exec: ["pm.collectionVariables.set('sessionId', 'value');"] } }] },
    ] };
    const result = validateCollectionStatic(collection);
    expect(result.issues.some(issue => issue.rule === 'runtime_variable' && issue.severity === 'warning' && issue.message.includes('sessionId'))).toBe(true);
    expect(result.issues.some(issue => issue.rule === 'undefined_variable' && issue.message.includes('sessionId'))).toBe(false);
  });

  it('reports fixture rules and line locations with exact severities', async () => {
    const raw = await readFile(safePath('test/fixtures/collection-invalid.json'), 'utf8');
    const result = validateCollectionStatic(JSON.parse(raw));
    const issues = result.issues;
    expect(issues.some(i => i.rule === 'syntax' && i.severity === 'error')).toBe(true);
    expect(issues.some(i => i.rule === 'template_in_js' && i.severity === 'error')).toBe(true);
    expect(issues.some(i => i.rule === 'forbidden_api' && i.severity === 'error')).toBe(true);
    expect(issues.some(i => i.rule === 'runtime_variable' && i.severity === 'warning' && i.message.includes('sessionId'))).toBe(true);
    expect(issues.some(i => i.rule === 'undefined_variable' && i.severity === 'error' && i.message.includes('neverDefined'))).toBe(true);
    expect(issues.some(i => i.rule === 'undefined_variable' && i.severity === 'error' && i.message.includes('baseUrl'))).toBe(true);
    expect(issues.some(i => i.message.includes('$guid'))).toBe(false);
    const scriptIssues = issues.filter(i => i.rule === 'syntax' || i.rule === 'forbidden_api' || i.rule === 'template_in_js');
    expect(scriptIssues.length).toBeGreaterThan(0);
    const badLocations = scriptIssues.filter(i => !/^.+ > (test|prerequest) > line \d+$/.test(i.location)).map(i => ({ rule: i.rule, locationParts: i.location.split(' > ').map(part => part.length), hasLineSegment: i.location.includes(' > line ') }));
    expect(badLocations).toEqual([]);
  });

  it('does not report top-level-await syntax when a prior issue exists', () => {
    const collection = { info: { name: 'Await location' }, item: [
      { name: 'Earlier', request: { method: 'GET', url: '{{undefinedOne}}' } },
      { name: 'Await', request: { method: 'GET', url: '{{undefinedTwo}}' }, event: [{ listen: 'test', script: { exec: ['const result = await pm.sendRequest("/path");'] } }] },
    ] };
    const result = validateCollectionStatic(collection);
    expect(result.issues.filter(i => i.rule === 'syntax' && i.message.toLowerCase().includes('await'))).toHaveLength(1);
  });

  it('extracts acceptance criteria from stories.json', async () => {
    const raw = await readFile(safePath('test/fixtures/stories.json'), 'utf8');
    const stories = JSON.parse(raw);

    for (const st of stories) {
      const res = extractAcceptanceCriteria(st.userStory);
      expect(res.source).toBe(st.expected.source);
      if (st.expected.count > 0) {
        expect(res.criteria.length).toBe(st.expected.count);
      }
    }
  });

  it('redacts secrets (redact.ts)', () => {
    const item = {
      name: 'Login',
      request: {
        auth: { type: 'bearer', bearer: [{ key: 'token', value: 'secret123' }] },
        header: [{ key: 'Authorization', value: 'Bearer secret123' }, { key: 'X-Api-Key', value: 'mykey' }],
        body: { raw: JSON.stringify({ password: 'mypassword', publicField: 'ok' }) },
      },
    };

    const redacted = redactSecrets(item);
    expect(redacted.request.header[0].value).toBe('<redacted>');
    expect(redacted.request.header[1].value).toBe('<redacted>');
  });

  it('generates and transforms schemas (schemas.ts)', () => {
    const planSchema = getTestPlanSchema(5, ['E1'], ['C1']);
    expect(planSchema).toBeDefined();

    const remote = toRemoteSchema(planSchema);
    expect(remote).toBeDefined();
    expect(remote.additionalProperties).toBe(false);

    const ajv = new Ajv();
    const validate = ajv.compile(remote);

    const validData = {
      status: 'ready',
      missingInfo: [],
      assumptions: ['assumption 1'],
      title: 'Test title',
      scenarios: [
        {
          title: 'Scenario 1',
          criterionId: 'C1',
          kind: 'positive',
          endpointId: 'E1',
          expectedStatus: 200,
          checks: ['status 200'],
          inputNotes: 'ninguna',
        },
      ],
    };

    const isValid = validate(validData);
    expect(isValid).toBe(true);
  });
});
