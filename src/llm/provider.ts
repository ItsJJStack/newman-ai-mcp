/**
 * @fileoverview LlmProvider interface and lazy getProvider() factory (provider.ts).
 */
import { getConfig } from '../config.js';
import { LocalLlmProvider } from './localProvider.js';
import { OpenAiLlmProvider } from './openaiProvider.js';
import type { JsonSchema } from './schemas.js';

export interface LlmProvider {
  readonly id: 'local' | 'openai-compatible';
  readonly model: string;
  generateJson<T>(req: {
    system: string;
    user: string;
    schema: JsonSchema;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<T>;
  dispose(): Promise<void>;
}

let providerInstance: LlmProvider | null = null;
let initPromise: Promise<LlmProvider> | null = null;

/**
 * Gets the singleton LLM provider instance.
 */
export async function getProvider(): Promise<LlmProvider> {
  if (providerInstance) return providerInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const config = getConfig();
    if (config.effectiveProvider === 'local') {
      providerInstance = new LocalLlmProvider(config);
    } else {
      providerInstance = new OpenAiLlmProvider(config);
    }
    return providerInstance;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

/**
 * Releases resources held by the current provider.
 */
export async function disposeProvider(): Promise<void> {
  if (providerInstance) {
    await providerInstance.dispose();
    providerInstance = null;
    initPromise = null;
  }
}
