/**
 * @fileoverview Phase 2 tests: deterministic Postman behavior (collectionLoader, parser, openapiImporter, tools 6, 7, and 9).
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { loadCollection } from '../src/postman/collectionLoader.js';
import { validateCollectionStatic } from '../src/postman/parser.js';
import { importOpenApiSpec } from '../src/postman/openapiImporter.js';
import { readFile } from 'node:fs/promises';
import { safePath } from '../src/errors.js';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

describe('Phase 2: deterministic Postman tools', () => {
  const tempOutputDir = 'test/.tmp/phase2';
  const outputPath = `${tempOutputDir}/generated-collection.json`;

  beforeAll(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(safePath(tempOutputDir), { recursive: true });
  });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(safePath(tempOutputDir), { recursive: true, force: true });
  });

  it('loads collection.json', async () => {
    const res = await loadCollection('test/fixtures/collection.json');
    expect(res.collection).toBeDefined();
    expect(res.collection.info.name).toBeDefined();
    expect(res.sourceType).toBe('file');
  });

  it('statically validates collection-invalid.json (tool 7)', async () => {
    const raw = await readFile(safePath('test/fixtures/collection-invalid.json'), 'utf8');
    const collection = JSON.parse(raw);

    const validation = validateCollectionStatic(collection);
    expect(validation.valid).toBe(false);
    expect(validation.summary.errors).toBeGreaterThan(0);

    // Check for expected specific rules from test/fixtures/README.md.
    const rules = validation.issues.map(i => i.rule);
    expect(rules).toContain('syntax');
    expect(rules).toContain('forbidden_api');
  });

  it('imports openapi.yaml into a Postman collection (tool 9)', async () => {
    const result = await importOpenApiSpec({
      specSource: 'test/fixtures/openapi.yaml',
      outputPath,
      mode: 'create',
      folderStrategy: 'Tags',
      generateBasicTests: true,
      overwrite: true,
    });

    expect(result).toBeDefined();
    expect(result.totalItems).toBeGreaterThan(0);
    expect(result.variables).toContain('baseUrl');
    expect(result.variables).toContain('bearerToken');

    // Check that the generated collection passes tool 7 without syntax errors.
    const generatedRaw = await readFile(safePath(outputPath), 'utf8');
    const generatedCollection = JSON.parse(generatedRaw);
    const valResult = validateCollectionStatic(generatedCollection);
    expect(valResult.summary.errors).toBe(0);
    for (const item of generatedCollection.item.flatMap((entry: any) => entry.item ?? [])) {
      for (const event of item.event ?? []) if (event.listen === 'test') new vm.Script(event.script.exec.join('\n'));
    }
  });

  it('rejects a symlink that escapes the configured root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'newman-outside-'));
    const link = 'test/.outside-link';
    try {
      await symlink(outside, join(process.cwd(), link), 'junction');
      expect(() => safePath(`${link}/secret.json`)).toThrow(/outside NEWMAN_MCP_ROOT/);
    } finally {
      await rm(join(process.cwd(), link), { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects the root itself and paths outside the root', () => {
    expect(() => safePath('.')).toThrow(/outside NEWMAN_MCP_ROOT/);
    expect(() => safePath('../outside.json')).toThrow(/outside NEWMAN_MCP_ROOT/);
  });
});
