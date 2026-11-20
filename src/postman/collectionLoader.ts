/**
 * @fileoverview Postman collection loader (collectionLoader).
 * Supports local paths (validated with safePath), https URLs (5 MB maximum, 30-second timeout),
 * and Postman UIDs (using POSTMAN_API_KEY).
 * Single source of truth for collectionSource validation and loading.
 */
import { safePath, sanitizeUrl } from '../errors.js';
import { getConfig } from '../config.js';
import { readFile } from 'node:fs/promises';

/** Result of loading a collection. */
export type LoadedCollection = {
  collection: any;
  sourceType: 'file' | 'url' | 'postman';
  source: string;
};

const MAX_REMOTE_BYTES = 5 * 1024 * 1024;

export async function fetchBoundedText(fetchFn: typeof fetch, url: string, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && url.includes('api.getpostman.com')) {
        throw new Error('POSTMAN_API_KEY is invalid or does not have access to this collection.');
      }
      throw new Error(`HTTP ${response.status} while downloading remote content.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_REMOTE_BYTES) throw new Error('Remote content exceeds the 5 MB limit.');
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_BYTES) {
        await reader.cancel();
        throw new Error('Remote content exceeds the 5 MB limit.');
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Remote download timed out after 30 seconds.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Loads a Postman collection from a local path, https URL, or UID.
 * @param collectionSource Collection source
 * @param options Optional settings (for example, fetchImpl for test mocks)
 * @returns Collection object and source metadata
 */
export async function loadCollection(
  collectionSource: string,
  options?: { fetchImpl?: typeof fetch }
): Promise<LoadedCollection> {
  if (!collectionSource || typeof collectionSource !== 'string') {
    throw new Error('collectionSource is required and must be a string.');
  }

  // 1. Reject http:// URLs.
  if (collectionSource.startsWith('http://')) {
    throw new Error('http:// URLs are not allowed. Use https:// or a local path.');
  }

  // 2. Reject API keys in URLs.
  if (collectionSource.includes('apikey=')) {
    throw new Error('Do not include an API key in the URL. Set POSTMAN_API_KEY in the environment.');
  }

  const fetchFn = options?.fetchImpl || fetch;

  // 3. Handle https:// URLs.
  if (collectionSource.startsWith('https://')) {
    const sanitized = sanitizeUrl(collectionSource);
    try {
      const text = await fetchBoundedText(fetchFn, collectionSource, {
        headers: collectionSource.includes('api.getpostman.com')
          ? {
              ...(getConfig().POSTMAN_API_KEY ? { 'X-Api-Key': getConfig().POSTMAN_API_KEY! } : {}),
            }
          : {},
      });
      const data = JSON.parse(text);
      // If it comes from api.getpostman.com, it often comes wrapped in { collection: { ... } }
      const collection = data.collection ? data.collection : data;

      if (!collection || !collection.info || !Array.isArray(collection.item)) {
        throw new Error('Downloaded JSON is not a valid Postman v2.1 collection (missing info or item).');
      }

      return { collection, sourceType: 'url', source: sanitized };
    } catch (err: any) {
      throw err;
    }
  }

  // 4. Detect Postman UID: ^\d+-[0-9a-fA-F-]{36}$
  const uidRegex = /^\d+-[0-9a-fA-F-]{36}$/;
  if (uidRegex.test(collectionSource)) {
    const config = getConfig();
    if (!config.POSTMAN_API_KEY) {
      throw new Error(
        'POSTMAN_API_KEY is not set. Set it in the environment to download collections by UID.'
      );
    }

    try {
      const text = await fetchBoundedText(fetchFn, `https://api.getpostman.com/collections/${collectionSource}`, {
        headers: {
          'X-Api-Key': config.POSTMAN_API_KEY,
        },
      });
      const data = JSON.parse(text) as any;
      const collection = data.collection;
      if (!collection || !collection.info || !Array.isArray(collection.item)) {
        throw new Error('Postman API returned an invalid structure (missing .collection).');
      }

      return { collection, sourceType: 'postman', source: collectionSource };
    } catch (err: any) {
      throw err;
    }
  }

  // 5. Handle a local path.
  const absPath = safePath(collectionSource);
  try {
    const fileContent = await readFile(absPath, 'utf8');
    const collection = JSON.parse(fileContent);

    if (!collection || !collection.info || !Array.isArray(collection.item)) {
      throw new Error('JSON file is not a valid Postman v2.1 collection (missing info or item).');
    }

    return { collection, sourceType: 'file', source: absPath };
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in local collection ${collectionSource}: ${err.message}`);
    }
    throw err;
  }
}
