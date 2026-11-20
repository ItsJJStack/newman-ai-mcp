#!/usr/bin/env node
/**
 * @fileoverview Entry point for the newman-ai-mcp MCP server.
 * Handles CLI commands (--download, --check-llm, --help), connects the stdio transport,
 * and registers the 9 tools in src/server.ts.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { getConfig, resetConfig } from './config.js';
import { toolError } from './errors.js';

/** Parses command-line arguments. */
function parseArgs(): { command: 'download' | 'check-llm' | 'help' | 'serve'; args: string[] } {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', args };
  if (args.includes('--download')) return { command: 'download', args };
  if (args.includes('--check-llm')) return { command: 'check-llm', args };
  return { command: 'serve', args };
}

/** Prints help and exits. */
function showHelp(): void {
  console.error(`
newman-ai-mcp — MCP server for automated Postman/Newman QA

Usage:
  npx newman-ai-mcp              Start the MCP server (stdio)
  npx newman-ai-mcp --download   Download the local model (Qwen3.5-2B)
  npx newman-ai-mcp --check-llm  Check LLM provider configuration
  npx newman-ai-mcp --help       Show this help

Main environment variables:
  NEWMAN_MCP_LLM_PROVIDER         "local" | "openai-compatible" (inferred if unset)
  NEWMAN_MCP_LLM_BASE_URL         Base URL for OpenAI-compatible provider
  NEWMAN_MCP_LLM_API_KEY          API key (Bearer) for OpenAI-compatible provider
  NEWMAN_MCP_LLM_MODEL            Model for OpenAI-compatible provider
  NEWMAN_MCP_MODEL_URI            Local model (default: hf:unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf)
  NEWMAN_MCP_MODELS_DIR           Model directory (default: ~/.newman-mcp/models)
  NEWMAN_MCP_ROOT                 Allowed file root (default: cwd)
  POSTMAN_API_KEY                 For remote collections by Postman UID

Exposed tools (9):
  1. generate_tests_from_story     (AI) Generate test cases from a user story
  2. generate_test_dataset         (AI) Generate an iteration dataset (JSON/CSV)
  3. analyze_newman_failure        (AI) Diagnose a Newman failure
  4. run_newman_collection         Run a collection with Newman
  5. generate_newman_report        Run a collection and generate reports (JUnit, JSON, HTML Extra)
  6. inspect_postman_collection    Inspect a collection without running it
  7. validate_postman_collection   Statically validate a collection
  8. generate_cicd_pipeline        Generate CI/CD config (GitHub Actions, GitLab, etc.)
  9. import_openapi_spec           Convert OpenAPI/Swagger to a Postman collection
`);
}

/** --download command: downloads the local model. */
async function cmdDownload(): Promise<void> {
  resetConfig(); // Forzar relectura de config
  const config = getConfig();

  if (config.effectiveProvider !== 'local') {
    console.error('The configured provider is not "local". Set NEWMAN_MCP_LLM_PROVIDER=local to download.');
    process.exit(1);
  }

  try {
    const { resolveModelFile, getLlama } = await import('node-llama-cpp');

    console.error(`Downloading model: ${config.NEWMAN_MCP_MODEL_URI}`);
    console.error(`Directory: ${config.modelsDir}`);

    const modelPath = await resolveModelFile(config.NEWMAN_MCP_MODEL_URI, {
      directory: config.modelsDir,
      download: 'auto',
      cli: false,
      onProgress: ({ totalSize, downloadedSize }) => {
        const pct = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
        console.error(`  Progreso: ${pct}% (${downloadedSize}/${totalSize} bytes)`);
      },
    });

    // Verify that the model can be loaded.
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    model.dispose();
    llama.dispose();

    console.error('✓ Model downloaded and verified successfully');
    process.exit(0);
  } catch (err) {
    console.error('✗ Error downloading model:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** --check-llm command: verifies the configured provider. */
async function cmdCheckLlm(): Promise<void> {
  resetConfig();
  const config = getConfig();

  console.error(`Provider: ${config.effectiveProvider}`);
  console.error(`Model: ${config.effectiveProvider === 'local' ? config.NEWMAN_MCP_MODEL_URI : config.NEWMAN_MCP_LLM_MODEL}`);
  console.error(`Base URL: ${config.normalizedBaseUrl || 'N/A'}`);
  console.error(`JSON mode: ${config.NEWMAN_MCP_LLM_JSON_MODE}`);
  console.error(`Timeout: ${config.NEWMAN_MCP_LLM_TIMEOUT_MS}ms`);

  if (config.effectiveProvider === 'local') {
    try {
      const { resolveModelFile, getLlama } = await import('node-llama-cpp');
      const modelPath = await resolveModelFile(config.NEWMAN_MCP_MODEL_URI, { directory: config.modelsDir, download: false });
      console.error('✓ Local model found');
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath });
      const context = await model.createContext({ contextSize: 8192, sequences: 1 });
      console.error('✓ Local model context created successfully');
      context.dispose();
      model.dispose();
      llama.dispose();
    } catch (err) {
      console.error('✗ Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    // OpenAI-compatible provider: minimal request.
    try {
      const start = Date.now();
      const res = await fetch(config.normalizedBaseUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.NEWMAN_MCP_LLM_API_KEY ? { Authorization: `Bearer ${config.NEWMAN_MCP_LLM_API_KEY}` } : {}),
          ...config.extraHeaders,
        },
        body: JSON.stringify({
          model: config.NEWMAN_MCP_LLM_MODEL,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(config.NEWMAN_MCP_LLM_TIMEOUT_MS),
      });
  console.error(`✓ HTTP response: ${res.status} (${Date.now() - start}ms)`);
      if (!res.ok) {
        const text = await res.text();
        console.error(`  Detalle: ${text.slice(0, 200)}`);
        process.exit(1);
      }
    } catch (err) {
      console.error('✗ Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  process.exit(0);
}

/** Main function. */
async function main(): Promise<void> {
  const { command } = parseArgs();

  switch (command) {
    case 'help':
      showHelp();
      process.exit(0);
    case 'download':
      await cmdDownload();
      break;
    case 'check-llm':
      await cmdCheckLlm();
      break;
    case 'serve':
      // Start the MCP server.
      try {
        const server = createServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error('[newman-ai-mcp] MCP server started on stdio');
      } catch (err) {
        console.error('[newman-ai-mcp] Error starting server:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
  }
}

main().catch((err) => {
  console.error('[newman-ai-mcp] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
