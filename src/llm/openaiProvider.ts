/**
 * @fileoverview OpenAI-compatible LLM provider using native fetch (openaiProvider.ts).
 */
import type { LlmProvider } from './provider.js';
import type { Config } from '../config.js';
import type { JsonSchema } from './schemas.js';
import { toRemoteSchema } from './schemas.js';

export class OpenAiLlmProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;
  readonly model: string;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    if (!config.NEWMAN_MCP_LLM_MODEL) {
      throw new Error('NEWMAN_MCP_LLM_MODEL is required for the openai-compatible provider.');
    }
    this.model = config.NEWMAN_MCP_LLM_MODEL;
  }

  async generateJson<T>(req: {
    system: string;
    user: string;
    schema: JsonSchema;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<T> {
    if (!this.config.normalizedBaseUrl) {
      throw new Error('NEWMAN_MCP_LLM_BASE_URL is not configured.');
    }

    const remoteSchema = toRemoteSchema(req.schema);
    const jsonMode = this.config.NEWMAN_MCP_LLM_JSON_MODE;

    let responseFormat: any = undefined;
    if (jsonMode === 'json_schema') {
      responseFormat = {
        type: 'json_schema',
        json_schema: {
          name: 'response_schema',
          strict: true,
          schema: remoteSchema,
        },
      };
    } else if (jsonMode === 'json_object') {
      responseFormat = { type: 'json_object' };
    }

    const messages = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];

    const bodyObj: any = {
      model: this.model,
      messages,
      temperature: 0.1,
      max_tokens: req.maxTokens,
    };

    if (responseFormat) {
      bodyObj.response_format = responseFormat;
    }

    let attempts = 0;
    const maxAttempts = 3;
    let lastError: any = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const controller = new AbortController();
        const timeoutMs = this.config.NEWMAN_MCP_LLM_TIMEOUT_MS;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        if (req.signal) {
          req.signal.addEventListener('abort', () => controller.abort());
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...this.config.extraHeaders,
        };
        if (this.config.NEWMAN_MCP_LLM_API_KEY) {
          headers['Authorization'] = `Bearer ${this.config.NEWMAN_MCP_LLM_API_KEY}`;
        }

        const res = await fetch(this.config.normalizedBaseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyObj),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 401 || res.status === 403) {
            throw new Error(`API key is invalid or lacks permission for model ${this.model} (${res.status}).`);
          }
          if (res.status === 404) {
            throw new Error(`Model or endpoint not found; check NEWMAN_MCP_LLM_BASE_URL and NEWMAN_MCP_LLM_MODEL (${res.status}).`);
          }
          if (res.status === 400 && errText.includes('response_format') && jsonMode === 'json_schema' && attempts === 1) {
            console.error('[newman-ai-mcp] Server rejected json_schema; retrying with json_object');
            bodyObj.response_format = { type: 'json_object' };
            continue;
          }
          if ((res.status === 429 || res.status >= 500) && attempts < maxAttempts) {
            const retryAfter = res.headers.get('retry-after');
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : attempts * 2000;
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`HTTP ${res.status} error from LLM provider: ${errText.slice(0, 300)}`);
        }

        const data = await res.json() as any;
        const content = data.choices?.[0]?.message?.content;
        if (!content || typeof content !== 'string') {
          throw new Error('LLM provider returned an empty response or no choices[0].message.content.');
        }

        let cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }

        return JSON.parse(cleaned) as T;
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') {
          throw new Error(`LLM call timed out after ${this.config.NEWMAN_MCP_LLM_TIMEOUT_MS}ms.`);
        }
        if (attempts >= maxAttempts) {
          throw lastError;
        }
        await new Promise((r) => setTimeout(r, attempts * 1000));
      }
    }

    throw lastError || new Error('Unknown error from OpenAI-compatible provider.');
  }

  async dispose(): Promise<void> {
    // Nothing to dispose
  }
}
