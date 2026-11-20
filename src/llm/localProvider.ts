/**
 * @fileoverview Local LLM provider based on node-llama-cpp (localProvider.ts).
 */
import type { LlmProvider } from './provider.js';
import type { Config } from '../config.js';
import type { JsonSchema } from './schemas.js';
import { toGrammarSchema } from './schemas.js';

export class LocalLlmProvider implements LlmProvider {
  readonly id = 'local' as const;
  readonly model: string;
  private config: Config;
  private llamaInstance: any = null;
  private modelInstance: any = null;
  private contextInstance: any = null;
  private initLock: Promise<void> | null = null;

  constructor(config: Config) {
    this.config = config;
    this.model = config.NEWMAN_MCP_MODEL_URI;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.contextInstance) return;
    if (this.initLock) return this.initLock;

    this.initLock = (async () => {
      const { getLlama, resolveModelFile } = await import('node-llama-cpp');

      let modelPath: string;
      try {
        modelPath = await resolveModelFile(this.config.NEWMAN_MCP_MODEL_URI, {
          directory: this.config.modelsDir,
          download: false,
        });
      } catch {
        throw new Error(
          `Model is not downloaded (${this.config.NEWMAN_MCP_MODEL_URI}). Run 'npx newman-ai-mcp --download' or configure an OpenAI-compatible provider.`
        );
      }

      this.llamaInstance = await getLlama({ gpu: 'auto' });
      this.modelInstance = await this.llamaInstance.loadModel({ modelPath });
      this.contextInstance = await this.modelInstance.createContext({
        contextSize: 8192,
        sequences: 2,
      });
    })();

    try {
      await this.initLock;
    } finally {
      this.initLock = null;
    }
  }

  async generateJson<T>(req: {
    system: string;
    user: string;
    schema: JsonSchema;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<T> {
    await this.ensureInitialized();

    const { LlamaChatSession, QwenChatWrapper } = await import('node-llama-cpp');

    const grammarSchema = toGrammarSchema(req.schema);
    const grammar = await this.llamaInstance.createGrammarForJsonSchema(grammarSchema);

    const chatWrapper = new QwenChatWrapper({
      variation: '3.5',
      thoughts: 'discourage',
    });

    const sequence = this.contextInstance.getSequence();
    const session = new LlamaChatSession({
      contextSequence: sequence,
      chatWrapper,
      systemPrompt: req.system,
    });

    try {
      const promptResult = await session.prompt(req.user, {
        maxTokens: req.maxTokens,
        temperature: 0.1,
        grammar,
        budgets: { thoughtTokens: 0 },
        signal: req.signal,
      });

      const parsed = JSON.parse(promptResult);
      return parsed as T;
    } finally {
      sequence.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.contextInstance) {
      await this.contextInstance.dispose();
      this.contextInstance = null;
    }
    if (this.modelInstance) {
      await this.modelInstance.dispose();
      this.modelInstance = null;
    }
    this.llamaInstance = null;
  }
}
