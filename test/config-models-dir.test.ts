import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe('local model directory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('resolves the default model directory under the current home directory', async () => {
    vi.stubEnv('NEWMAN_MCP_MODELS_DIR', undefined);

    const { getConfig } = await import('../src/config.js');
    expect(getConfig().modelsDir).toBe(resolve(homedir(), '.newman-ai-mcp', 'models'));
  });

  it('keeps an explicit absolute model directory unchanged', async () => {
    const customDir = resolve(tmpdir(), 'newman-models');
    vi.stubEnv('NEWMAN_MCP_MODELS_DIR', customDir);

    const { getConfig } = await import('../src/config.js');
    expect(getConfig().modelsDir).toBe(customDir);
  });

  it('expands a custom home-relative model directory without escaping the home directory', async () => {
    vi.stubEnv('NEWMAN_MCP_MODELS_DIR', '~/.cache/newman-models');

    const { getConfig } = await import('../src/config.js');
    expect(getConfig().modelsDir).toBe(resolve(homedir(), '.cache', 'newman-models'));
  });
});
