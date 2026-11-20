/**
 * @fileoverview Error, result, and path-security utilities.
 * - toolError(): normalizes errors to an MCP response { isError: true, content: [...] }
 * - toolResult(): builds a successful response with structuredContent and readable content
 * - safePath(): resolves a path and ensures it stays inside NEWMAN_MCP_ROOT
 */
import { getConfig } from './config.js';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

/**
 * Error raised by LLM providers with an actionable code.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly code: 'PROVIDER_NOT_CONFIGURED' | 'MODEL_NOT_FOUND' | 'GENERATION_FAILED' | 'VALIDATION_FAILED' | 'NETWORK_ERROR' | 'AUTH_FAILED' | 'MODEL_NOT_FOUND_REMOTE' | 'TIMEOUT',
    public readonly fixHint?: string
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Normalizes any error to the MCP isError format.
 * @param err Caught error (Error, string, or unknown)
 * @returns MCP response object with isError: true
 */
export function toolError(err: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  let message: string;
  let fixHint: string | undefined;

  if (err instanceof LlmError) {
    message = err.message;
    fixHint = err.fixHint;
  } else if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === 'string') {
    message = err;
  } else {
    message = 'Unknown error';
  }

  const text = fixHint ? `${message} — ${fixHint}` : message;
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * Builds a successful MCP response with structuredContent and a readable summary.
 * @param structuredContent Object matching the tool output schema
 * @param summary Readable 1–5 line summary for the client
 * @returns MCP response object
 */
export function toolResult<T extends Record<string, unknown>>(
  structuredContent: T,
  summary: string
): { structuredContent: T; content: { type: 'text'; text: string }[] } {
  return {
    structuredContent,
    content: [{ type: 'text', text: summary }],
  };
}

/**
 * Resolves a path and validates that it is inside NEWMAN_MCP_ROOT.
 * @param inputPath Input path (relative or absolute)
 * @returns Resolved absolute path
 * @throws Error if the path is outside NEWMAN_MCP_ROOT or invalid
 */
export function safePath(inputPath: string): string {
  const config = getConfig();
  const root = config.rootDir;

  // Resolve an absolute path.
  const resolved = resolve(root, inputPath);

  // Ensure it is lexically inside the root.
  const relative = relativePath(root, resolved);
  if (relative.startsWith('..') || relative === '') {
    throw new Error(`Path is outside NEWMAN_MCP_ROOT: ${inputPath}`);
  }

  const realRoot = realpathSync.native(root);
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..');
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync.native(existing);
  const realTarget = resolve(realExisting, resolved.slice(existing.length).replace(/^[/\\]+/, ''));
  const realRelative = relativePath(realRoot, realTarget);
  if (realRelative.startsWith('..') || realRelative === '') {
    throw new Error(`Path is outside NEWMAN_MCP_ROOT: ${inputPath}`);
  }

  return resolved;
}

export async function writeSafeFile(
  outputPath: string,
  content: string,
  options: { overwrite?: boolean; inputPath?: string } = {}
): Promise<void> {
  if (options.inputPath) {
    const input = safePath(options.inputPath);
    const output = safePath(outputPath);
    let inputReal: string | undefined;
    let outputReal: string | undefined;
    try {
      inputReal = realpathSync.native(input).toLowerCase();
    } catch {}
    try {
      outputReal = realpathSync.native(output).toLowerCase();
    } catch {}
    if (inputReal && outputReal && inputReal === outputReal) {
      throw new Error('Output path must not be the same file as its input.');
    }
  }
  const target = safePath(outputPath);
  try {
    await writeFile(target, content, options.overwrite ? 'utf8' : { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`File already exists: ${outputPath}. Set overwrite: true to replace it.`);
    }
    throw err;
  }
}

/**
 * Calculates the relative path from `from` to `to` (both absolute paths).
 * @internal
 */
function relativePath(from: string, to: string): string {
  const fromParts = from.split(/[\\/]/).filter(Boolean);
  const toParts = to.split(/[\\/]/).filter(Boolean);

  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i]?.toLowerCase() === toParts[i]?.toLowerCase()) {
    i++;
  }

  const up = fromParts.length - i;
  const down = toParts.slice(i);

  return [...Array(up).fill('..'), ...down].join('/');
}

/**
 * Sanitizes a URL for logs/responses: removes query string.
 * @param url URL to sanitize
 * @returns URL without query string
 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}
