import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('optional package loading', () => {
  afterEach(() => vi.resetModules());

  it('does not load heavy packages while creating the server', async () => {
    const state = { converter: false, newman: false };
    vi.doMock('openapi-to-postmanv2', () => {
      state.converter = true;
      return { default: { convert: vi.fn() } };
    });
    vi.doMock('newman', () => {
      state.newman = true;
      return { default: {} };
    });

    const { createServer } = await import('../src/server.js');
    createServer();
    expect(state).toEqual({ converter: false, newman: false });

    const importerSource = await readFile(new URL('../src/postman/openapiImporter.ts', import.meta.url), 'utf8');
    expect(importerSource).toContain("await import('openapi-to-postmanv2')");
  });
});
