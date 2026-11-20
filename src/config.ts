/**
 * @fileoverview Centralized MCP server configuration.
 * Reads and validates environment variables with zod at startup.
 * Provides defaults and exposes typed configuration to the rest of the code.
 */
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Environment variable validation schema. */
const envSchema = z.object({
  /** Explicit LLM provider: "local" or "openai-compatible". */
  NEWMAN_MCP_LLM_PROVIDER: z.enum(['local', 'openai-compatible']).optional(),
  /** Base URL for an OpenAI-compatible provider (e.g. https://api.openai.com/v1). */
  NEWMAN_MCP_LLM_BASE_URL: z.string().url().optional(),
  /** API key for an OpenAI-compatible provider (Bearer token). */
  NEWMAN_MCP_LLM_API_KEY: z.string().optional(),
  /** Model to use with an OpenAI-compatible provider. */
  NEWMAN_MCP_LLM_MODEL: z.string().optional(),
  /** JSON output mode: "json_schema" | "json_object" | "none". */
  NEWMAN_MCP_LLM_JSON_MODE: z.enum(['json_schema', 'json_object', 'none']).default('json_schema'),
  /** Extra provider headers (JSON string). */
  NEWMAN_MCP_LLM_HEADERS: z.string().optional(),
  /** Timeout per LLM call in ms. */
  NEWMAN_MCP_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  /** Local model URI (Hugging Face or local path). */
  NEWMAN_MCP_MODEL_URI: z.string().default('hf:unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf'),
  /** Directory where local models are stored or downloaded. */
  NEWMAN_MCP_MODELS_DIR: z.string().default('~/.newman-ai-mcp/models'),
  /** Allowed root for file reads and writes (safePath). */
  NEWMAN_MCP_ROOT: z.string().optional(),
  /** Postman API key for remote collections by UID. */
  POSTMAN_API_KEY: z.string().optional(),
});

/** Parsed and validated configuration. */
export type Config = z.infer<typeof envSchema> & {
  /** Resolved model directory (absolute). */
  modelsDir: string;
  /** Resolved server root (absolute). */
  rootDir: string;
  /** Effective inferred provider. */
  effectiveProvider: 'local' | 'openai-compatible';
  /** Normalized base URL (no trailing slash, with /chat/completions). */
  normalizedBaseUrl: string | null;
  /** Parsed extra headers. */
  extraHeaders: Record<string, string>;
};

/** Parsed configuration cache. */
let configCache: Config | null = null;

/**
 * Gets the validated configuration (singleton).
 * @returns Full configuration with resolved values
 */
export function getConfig(): Config {
  if (configCache) return configCache;

  const raw = envSchema.parse(process.env);

  // Resolve a leading ~ against the current platform's home directory.
  const modelDir = raw.NEWMAN_MCP_MODELS_DIR;
  const modelsDir = modelDir === '~' || /^~[\\/]/.test(modelDir)
    ? resolve(homedir(), modelDir.slice(2))
    : modelDir.startsWith('~')
      ? resolve(homedir(), modelDir.slice(1))
      : isAbsolute(modelDir)
        ? resolve(modelDir)
        : resolve(process.cwd(), modelDir);

  // Resolve the server root.
  const rootDir = raw.NEWMAN_MCP_ROOT
    ? resolve(raw.NEWMAN_MCP_ROOT)
    : process.cwd();

  // Infer the effective provider.
  let effectiveProvider: 'local' | 'openai-compatible';
  if (raw.NEWMAN_MCP_LLM_PROVIDER) {
    effectiveProvider = raw.NEWMAN_MCP_LLM_PROVIDER;
  } else if (raw.NEWMAN_MCP_LLM_BASE_URL) {
    effectiveProvider = 'openai-compatible';
  } else {
    effectiveProvider = 'local';
  }

  // Normalize base URL
  let normalizedBaseUrl: string | null = null;
  if (raw.NEWMAN_MCP_LLM_BASE_URL) {
    const url = raw.NEWMAN_MCP_LLM_BASE_URL.replace(/\/+$/, '');
    normalizedBaseUrl = `${url}/chat/completions`;
  }

  // Parse extra headers
  let extraHeaders: Record<string, string> = {};
  if (raw.NEWMAN_MCP_LLM_HEADERS) {
    try {
      extraHeaders = JSON.parse(raw.NEWMAN_MCP_LLM_HEADERS);
    } catch {
      // Ignore invalid JSON; the provider will validate it.
    }
  }

  configCache = {
    ...raw,
    modelsDir,
    rootDir,
    effectiveProvider,
    normalizedBaseUrl,
    extraHeaders,
  };

  // Log the selected provider to stderr to keep MCP stdout clean.
  console.error(`[newman-ai-mcp] LLM provider: ${configCache.effectiveProvider}${configCache.effectiveProvider === 'openai-compatible' && raw.NEWMAN_MCP_LLM_BASE_URL ? ` (inferred from NEWMAN_MCP_LLM_BASE_URL)` : ''}`);

  return configCache;
}

/**
 * Resets the configuration cache (useful in tests).
 * @internal
 */
export function resetConfig(): void {
  configCache = null;
}
