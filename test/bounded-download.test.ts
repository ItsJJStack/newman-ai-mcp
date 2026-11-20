import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCollection } from '../src/postman/collectionLoader.js';
import { readFile } from 'node:fs/promises';
import { safePath } from '../src/errors.js';

describe('bounded collection downloads', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects oversized declared content before reading the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } }));
    await expect(loadCollection('https://example.test/collection.json', { fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow();
  });

  it('rejects a streamed body beyond the limit without content-length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const fetchImpl = async () => new Response(body);
    await expect(loadCollection('https://example.test/collection.json', { fetchImpl })).rejects.toThrow();
  });

  it('keeps the timeout active after response headers arrive', async () => {
    vi.useFakeTimers();
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          signal?.addEventListener('abort', () => streamController.error(new DOMException('Aborted', 'AbortError')));
        },
      }));
    };
    const pending = loadCollection('https://example.test/collection.json', { fetchImpl: fetchImpl as typeof fetch }).then(() => 'resolved', () => 'rejected');
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    const outcome = await Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('pending'), 25))]);
    expect(outcome).toBe('rejected');
  });

  it('matches local and simulated remote fixture collections and rejects unsafe sources', async () => {
    const local = JSON.parse(await readFile(safePath('test/fixtures/collection.json'), 'utf8'));
    const fetchImpl = async () => new Response(JSON.stringify(local), { headers: { 'content-type': 'application/json' } });
    const remote = await loadCollection('https://example.test/collection.json', { fetchImpl });
    expect(remote.collection).toEqual(local);
    await expect(loadCollection('http://example.test/collection.json', { fetchImpl })).rejects.toThrow();
    await expect(loadCollection('https://example.test/collection.json?apikey=[REDACTED-SECRET]', { fetchImpl })).rejects.toThrow();
    await expect(loadCollection('../outside.json')).rejects.toThrow();
    await expect(loadCollection('https://example.test/empty.json', { fetchImpl: async () => new Response('{}') })).rejects.toThrow();
  });
});
