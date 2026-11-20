import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'newman-write-guard-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.resetModules();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('output overwrite guards', () => {
  it('protects existing CI/CD output unless overwrite is true', async () => {
    const root = await tempDir();
    const output = join(root, 'pipeline.yml');
    await writeFile(output, 'original');
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({ getConfig: () => ({ rootDir: root }) }));
    const { registerGenerateCicdTool } = await import('../src/tools/generate_cicd_pipeline.js');
    let handler: (args: any) => Promise<any>;
    const server = { registerTool: (_name: string, _options: any, callback: typeof handler) => { handler = callback; } } as any;
    registerGenerateCicdTool(server);
    const args = { platform: 'github-actions', collectionSource: 'collection.json', outputPath: 'pipeline.yml', useHtmlExtra: false, nodeVersion: '20' };
    const blocked = await handler(args);
    expect(blocked.isError).toBe(true);
    expect(await readFile(output, 'utf8')).toBe('original');
    const overwritten = await handler({ ...args, overwrite: true });
    if (overwritten.isError) throw new Error(overwritten.content?.[0]?.text ?? 'Unexpected overwrite error');
    expect(overwritten.isError).not.toBe(true);
    expect(await readFile(output, 'utf8')).not.toBe('original');
  });

  it('protects importer output and never overwrites the sync source', async () => {
    const root = await tempDir();
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({ getConfig: () => ({ rootDir: root }) }));
    const { importOpenApiSpec } = await import('../src/postman/openapiImporter.js');
    const { safePath } = await import('../src/errors.js');
    const spec = { openapi: '3.0.0', info: { title: 'Guard', version: '1' }, paths: {} };
    const specPath = 'spec.json';
    const outputPath = 'output.json';
    await writeFile(safePath(specPath), JSON.stringify(spec));
    await writeFile(safePath(outputPath), 'keep');
    await expect(importOpenApiSpec({ specSource: specPath, outputPath })).rejects.toThrow(/already exists/i);
    expect(await readFile(join(root, outputPath), 'utf8')).toBe('keep');
    await expect(importOpenApiSpec({ specSource: specPath, outputPath, overwrite: true })).resolves.toBeDefined();
    const beforeSource = await readFile(join(root, outputPath));
    await expect(importOpenApiSpec({ specSource: specPath, outputPath, mode: 'sync', collectionSource: outputPath, overwrite: true })).rejects.toThrow(/same file/i);
    expect(await readFile(join(root, outputPath))).toEqual(beforeSource);
  });

  it('rejects a not-yet-existing output alias to the sync source through a symlink', async () => {
    const root = await tempDir();
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({ getConfig: () => ({ rootDir: root }) }));
    const { importOpenApiSpec } = await import('../src/postman/openapiImporter.js');
    const { safePath } = await import('../src/errors.js');
    const source = 'source.json';
    const alias = 'alias.json';
    await writeFile(safePath(source), JSON.stringify({ info: { name: 'source' }, item: [] }));
    await symlink(join(root, source), join(root, alias), 'file');
    await writeFile(safePath('spec.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} }));
    await expect(importOpenApiSpec({ specSource: 'spec.json', outputPath: alias, mode: 'sync', collectionSource: source, overwrite: true })).rejects.toThrow(/same file/i);
  });
});
