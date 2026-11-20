import { readFile, rm, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importOpenApiSpec } from '../src/postman/openapiImporter.js';
import { safePath } from '../src/errors.js';
import { resetConfig } from '../src/config.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validateCollectionStatic } from '../src/postman/parser.js';

const tempDir = 'test/.tmp/openapi-sync';
const specPath = `${tempDir}/sync-spec.json`;
const collectionPath = `${tempDir}/sync-collection.json`;
const outputPath = `${tempDir}/sync-output.json`;

describe('OpenAPI sync', () => {
  beforeAll(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(safePath(tempDir), { recursive: true });
  });

  afterAll(async () => rm(safePath(tempDir), { recursive: true, force: true }));

  it('requires collectionSource and applies exact method/path identity and orphan policy', async () => {
    await rm(safePath(tempDir), { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(safePath(tempDir), { recursive: true });
    await writeFile(safePath(specPath), JSON.stringify({
      openapi: '3.0.0', info: { title: 'Sync test', version: '1.0.0' },
      servers: [{ url: 'http://127.0.0.1:3000' }],
      paths: { '/matched': { get: { summary: 'Updated summary', responses: { '200': { description: 'OK' } } } } },
    }));
    const orphan = { name: 'Orphan', request: { method: 'GET', url: { raw: '{{baseUrl}}/orphan', path: ['orphan'] } }, event: [{ listen: 'test', script: { exec: ['keep orphan test'] } }] };
    const existing = {
      info: { name: 'Existing' }, item: [{ name: 'Old summary', request: { method: 'GET', url: { raw: '{{baseUrl}}/matched', path: ['matched'] } },
        event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("keep", () => {});'] } }, { listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.variables.set("x", "y");'] } }] }],
    };
    existing.item.push(orphan);
    await writeFile(safePath(collectionPath), JSON.stringify(existing));
    await expect(importOpenApiSpec({ specSource: specPath, outputPath, mode: 'sync' })).rejects.toThrow(/collectionSource/);
    const sourceBefore = await readFile(safePath(collectionPath));
    const result = await importOpenApiSpec({ specSource: specPath, outputPath, mode: 'sync', collectionSource: collectionPath });
    const sourceAfter = await readFile(safePath(collectionPath));
    const output = JSON.parse(await readFile(safePath(outputPath), 'utf8'));
    expect(result.sync).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(output.item[0].name).toBe('Updated summary');
    expect(output.item[0].event).toEqual(existing.item[0].event);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(result.sync).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(output.item).toHaveLength(2);

    const acSpecPath = `${tempDir}/ac-spec.json`;
    const acSourcePath = `${tempDir}/ac-source.json`;
    const acOutputPath = `${tempDir}/ac-output.json`;
    await writeFile(safePath(acSpecPath), JSON.stringify({
      openapi: '3.0.0', info: { title: 'Fixture sync', version: '1.0.0' },
      servers: [{ url: 'http://127.0.0.1:3000' }],
      paths: {
        '/login': { post: { summary: 'Updated Login', responses: { '200': { description: 'OK' } } } },
        '/users/{userId}': { get: { summary: 'Updated user summary', responses: { '200': { description: 'OK' } } } },
        '/health': { get: { summary: 'Health', responses: { '200': { description: 'OK' } } } },
      },
    }));
    const fixture = JSON.parse(await readFile(safePath('test/fixtures/collection.json'), 'utf8'));
    const login = fixture.item[0].item.find((item: any) => item.name === 'Login');
    login.event = [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("preserved", () => {});'] } }];
    await writeFile(safePath(acSourcePath), JSON.stringify(fixture));
    const acResult = await importOpenApiSpec({ specSource: acSpecPath, outputPath: acOutputPath, mode: 'sync', collectionSource: acSourcePath });
    const acOutput = JSON.parse(await readFile(safePath(acOutputPath), 'utf8'));
    expect(acResult.sync).toEqual({ added: 3, updated: 0, removed: 0 });
    expect(acOutput.item).toHaveLength(5);

    const deleteOutput = `${tempDir}/sync-delete.json`;
    const deleted = await importOpenApiSpec({ specSource: specPath, outputPath: deleteOutput, mode: 'sync', collectionSource: collectionPath, deleteOrphanedRequests: true });
    const deletedCollection = JSON.parse(await readFile(safePath(deleteOutput), 'utf8'));
    expect(deleted.sync).toEqual({ added: 0, updated: 1, removed: 1 });
    expect(deleted.warnings).toEqual(['Removed request with scripts: Orphan']);
    expect(deletedCollection.item).toHaveLength(1);

    const exactSpec = `${tempDir}/exact-spec.json`;
    const exactCollection = `${tempDir}/exact-collection.json`;
    const exactOutput = `${tempDir}/exact-output.json`;
    await writeFile(safePath(exactSpec), JSON.stringify({
      openapi: '3.0.0', info: { title: 'Exact match', version: '1.0.0' },
      paths: { '/exact': { get: { summary: 'Renamed exact', responses: { '200': { description: 'OK' } } } } },
    }));
    const exactExisting = { info: { name: 'Existing exact' }, item: [{ name: 'Old exact name', request: { method: 'GET', url: '/exact' }, event: [{ listen: 'test', script: { exec: ['pm.test("retain", () => {});'] } }, { listen: 'prerequest', script: { exec: ['pm.variables.set("ready", true);'] } }] }] };
    await writeFile(safePath(exactCollection), JSON.stringify(exactExisting));
    const exactResult = await importOpenApiSpec({ specSource: exactSpec, outputPath: exactOutput, mode: 'sync', collectionSource: exactCollection });
    const exactUpdated = JSON.parse(await readFile(safePath(exactOutput), 'utf8'));
    expect(exactResult.sync).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(exactUpdated.item[0].name).toBe('Renamed exact');
    expect(exactUpdated.item[0].event).toEqual(exactExisting.item[0].event);
  });

  it('returns validation summary from tool 7 and fails without writing on converter errors', async () => {
    await rm(safePath(tempDir), { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(safePath(tempDir), { recursive: true });
    const invalidSpecPath = `${tempDir}/invalid-spec.json`;
    const output = `${tempDir}/invalid-output.json`;
    await writeFile(safePath(invalidSpecPath), JSON.stringify({ openapi: '3.0.0', info: { title: 'Invalid', version: '1' }, paths: {} }));
    const result = await importOpenApiSpec({ specSource: invalidSpecPath, outputPath: output });
    const collection = JSON.parse(await readFile(safePath(output), 'utf8'));
    expect(result.validation).toEqual(validateCollectionStatic(collection).summary);

    const converter = await import('openapi-to-postmanv2');
    const originalConvert = converter.default.convert;
    converter.default.convert = (_input: any, _options: any, callback: (error: Error | null, result?: any) => void) => callback(null, { result: false, reason: 'controlled conversion failure' });
    const failedOutput = `${tempDir}/failed-output.json`;
    try {
      await expect(importOpenApiSpec({ specSource: invalidSpecPath, outputPath: failedOutput })).rejects.toThrow('controlled conversion failure');
      await expect(readFile(safePath(failedOutput))).rejects.toThrow();
    } finally {
      converter.default.convert = originalConvert;
    }
  });

  it('imports OpenAPI 3 and Swagger 2 fixtures with expected collection variables and requests', async () => {
    await rm(safePath(tempDir), { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(safePath(tempDir), { recursive: true });
    for (const specSource of ['test/fixtures/openapi.yaml', 'test/fixtures/swagger2.json']) {
      const outputPath = `${tempDir}/${specSource.endsWith('.yaml') ? 'openapi' : 'swagger2'}-output.json`;
      const result = await importOpenApiSpec({ specSource, outputPath });
      const collection = JSON.parse(await readFile(safePath(outputPath), 'utf8'));
      const requests = collection.item.flatMap((item: any) => item.item ?? []);
      for (const item of requests) {
        for (const event of item.event ?? []) {
          if (event.listen === 'test') {
            expect(Array.isArray(event.script?.exec)).toBe(true);
            new vm.Script(event.script.exec.join('\n'));
          }
        }
      }
      expect(result.totalItems).toBeGreaterThan(0);
      expect(result.variables).toContain('baseUrl');
      expect(JSON.stringify(collection).includes('http://127.0.0.1:3000')).toBe(true);
    }
  });

  it('blocks HTTP and outside-root local refs before writing output', async () => {
    await rm(safePath(tempDir), { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(safePath(tempDir), { recursive: true });
    const specPath = `${tempDir}/ref-spec.json`;
    const outputPath = `${tempDir}/ref-output.json`;
    const server = await import('node:http');
    let requests = 0;
    const listener = server.createServer((_request, response) => { requests++; response.end('{}'); });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Loopback test server did not bind');
    try {
      const httpSpec = { openapi: '3.0.0', info: { title: 'Ref test', version: '1' }, paths: {}, components: { schemas: { X: { $ref: `http://127.0.0.1:${address.port}/schema.json` } } } };
      await writeFile(safePath(specPath), JSON.stringify(httpSpec));
      await expect(importOpenApiSpec({ specSource: specPath, outputPath })).rejects.toThrow();
      expect(requests).toBe(0);
      await expect(readFile(safePath(outputPath))).rejects.toThrow();

      const outsideRef = { ...httpSpec, components: { schemas: { X: { $ref: '../../outside-schema.json' } } } };
      await writeFile(safePath(specPath), JSON.stringify(outsideRef));
      await expect(importOpenApiSpec({ specSource: specPath, outputPath })).rejects.toThrow();
      await expect(readFile(safePath(outputPath))).rejects.toThrow();

      const internalSchemaPath = `${tempDir}/internal-schema.json`;
      await writeFile(safePath(internalSchemaPath), JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } }));
      const localRefSpec = { ...httpSpec, components: { schemas: { X: { $ref: pathToFileURL(safePath(internalSchemaPath)).href } } } };
      await writeFile(safePath(specPath), JSON.stringify(localRefSpec));
      await expect(importOpenApiSpec({ specSource: specPath, outputPath })).resolves.toBeDefined();
      expect(requests).toBe(0);
      await rm(safePath(outputPath), { force: true });

    } finally {
      await new Promise<void>((resolve, reject) => listener.close(err => err ? reject(err) : resolve()));
    }
  });

  it('blocks HTTPS refs before network resolution and rejects symlink escape', async () => {
    await rm(safePath(tempDir), { recursive: true, force: true });
    const { mkdir, symlink } = await import('node:fs/promises');
    const parent = safePath(tempDir);
    const restrictedRoot = `${tempDir}/root`;
    await mkdir(safePath(restrictedRoot), { recursive: true });
    const restrictedRootAbs = safePath(restrictedRoot);
    const priorRoot = process.env.NEWMAN_MCP_ROOT;
    process.env.NEWMAN_MCP_ROOT = restrictedRootAbs;
    resetConfig();
    try {
      const specPath = 'spec.json';
      const outputPath = 'out.json';
      const base = { openapi: '3.0.0', info: { title: 'Ref security', version: '1' }, paths: {} };
      const httpsSpec = { ...base, components: { schemas: { X: { $ref: 'https://example.invalid/schema.json' } } } };
      await writeFile(safePath(specPath), JSON.stringify(httpsSpec));
      await expect(importOpenApiSpec({ specSource: specPath, outputPath })).rejects.toThrow(/https:\/\/example\.invalid\/schema\.json/);
      await expect(readFile(safePath(outputPath))).rejects.toThrow();

      const outside = `${parent}/outside-schema.json`;
      await writeFile(outside, JSON.stringify({ type: 'string' }));
      await symlink(outside, resolve(restrictedRootAbs, 'linked-schema.json'), 'file');
      const linkedSpec = { ...base, components: { schemas: { X: { $ref: './linked-schema.json' } } } };
      await writeFile(safePath(specPath), JSON.stringify(linkedSpec));
      await expect(importOpenApiSpec({ specSource: specPath, outputPath })).rejects.toThrow();
      await expect(readFile(safePath(outputPath))).rejects.toThrow();
    } finally {
      if (priorRoot === undefined) delete process.env.NEWMAN_MCP_ROOT;
      else process.env.NEWMAN_MCP_ROOT = priorRoot;
      resetConfig();
    }
  });
});
