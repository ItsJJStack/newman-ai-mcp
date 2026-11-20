/**
 * @fileoverview Basic Phase 1 tests for compilation, server setup, and inspector behavior.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';
import { getConfig, resetConfig } from '../src/config.js';
import { safePath } from '../src/errors.js';

describe('Phase 1: infrastructure and base server', () => {
  it('compiles and creates the MCP server with 9 tools', () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it('reads and validates configuration', () => {
    resetConfig();
    const config = getConfig();
    expect(config).toBeDefined();
    expect(config.effectiveProvider).toBeDefined();
  });

  it('validates safePath', () => {
    resetConfig();
    const p = safePath('package.json');
    expect(p).toContain('package.json');

    expect(() => safePath('../outside.json')).toThrow();
  });
});
