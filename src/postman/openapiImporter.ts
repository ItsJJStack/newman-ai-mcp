/**
 * @fileoverview Imports and syncs OpenAPI/Swagger specs into Postman collections (openapiImporter.ts).
 * Uses @apidevtools/swagger-parser and openapi-to-postmanv2.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import { safePath, sanitizeUrl, writeSafeFile } from '../errors.js';
import { getConfig } from '../config.js';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { fetchBoundedText } from './collectionLoader.js';
import { validateCollectionStatic } from './parser.js';

/** OpenAPI import options. */
export type ImportOpenApiOptions = {
  specSource: string;
  outputPath: string;
  mode?: 'create' | 'sync';
  collectionSource?: string;
  deleteOrphanedRequests?: boolean;
  folderStrategy?: 'Tags' | 'Paths';
  parametersResolution?: 'Example' | 'Schema';
  includeDeprecated?: boolean;
  generateBasicTests?: boolean;
  baseUrlVariable?: string;
  overwrite?: boolean;
  fetchImpl?: typeof fetch;
};

/** OpenAPI import result. */
export type ImportOpenApiResult = {
  outputPath: string;
  mode: 'create' | 'sync';
  spec: { version: string; title: string; apiVersion: string };
  totalItems: number;
  folders: string[];
  variables: string[];
  testsGenerated: number;
  sync?: { added: number; updated: number; removed: number };
  warnings: string[];
  validation: { errors: number; warnings: number };
};

/**
 * Imports or syncs an OpenAPI/Swagger spec into a Postman collection.
 */
export async function importOpenApiSpec(options: ImportOpenApiOptions): Promise<ImportOpenApiResult> {
  const fetchFn = options.fetchImpl || fetch;
  const specSource = options.specSource;

  // 1. Load the spec (local or https://).
  let specContent: string;
  if (specSource.startsWith('https://')) {
    specContent = await fetchBoundedText(fetchFn, specSource);
  } else {
    const absPath = safePath(specSource);
    specContent = await readFile(absPath, 'utf8');
  }

  // Parse JSON or YAML.
  let parsedSpec: any;
  try {
    if (specSource.endsWith('.yaml') || specSource.endsWith('.yml') || specContent.trim().startsWith('{') === false) {
      parsedSpec = yaml.parse(specContent);
    } else {
      parsedSpec = JSON.parse(specContent);
    }
  } catch (err: any) {
    throw new Error(`Invalid OpenAPI spec (could not parse JSON/YAML): ${err.message}`);
  }

  // 2. Validate references without allowing network or out-of-root file reads.
  let dereferencedSpec: any;
  try {
    const { realpathSync } = await import('node:fs');
    const root = realpathSync.native(getConfig().rootDir);
    dereferencedSpec = await SwaggerParser.validate(parsedSpec, {
      resolve: {
        http: false,
        file: {
          order: 100,
          canRead: (file: { url: string }) => {
            try {
              const filePath = file.url.startsWith('file:') ? fileURLToPath(file.url) : file.url;
              const candidate = realpathSync.native(filePath);
              const relativePath = relative(root, candidate);
              return !relativePath.startsWith('..') && relativePath !== '';
            } catch {
              return false;
            }
          },
          read: async (file: { url: string }) => readFile(safePath(file.url.startsWith('file:') ? fileURLToPath(file.url) : file.url)),
        },
      },
    } as any);
  } catch (err: any) {
      throw new Error(`Invalid OpenAPI spec according to SwaggerParser: ${err.message}`);
  }

  const apiVersion = dereferencedSpec.info?.version || '1.0.0';
  const apiTitle = dereferencedSpec.info?.title || 'API';
  const openApiVersion = dereferencedSpec.openapi || dereferencedSpec.swagger || '3.0.0';

  const warnings: string[] = [];
  if (dereferencedSpec.servers && dereferencedSpec.servers.length > 1) {
    warnings.push(`Multiple servers were found in the spec; the first was used (${dereferencedSpec.servers[0].url})`);
  }

  // 3. Convert with openapi-to-postmanv2.
  const conversionOptions = {
    folderStrategy: options.folderStrategy || 'Tags',
    parametersResolution: options.parametersResolution || 'Example',
    includeDeprecated: options.includeDeprecated || false,
    requestNameSource: 'Fallback' as const,
    alwaysInheritAuthentication: false,
  };
  const { default: OpenApiToPostman } = await import('openapi-to-postmanv2');

  let collectionData = await new Promise<any>((resolve, reject) => {
    OpenApiToPostman.convert(
      { type: 'json', data: parsedSpec },
      conversionOptions,
      (err: any, conversionResult: any) => {
        if (err) {
          reject(new Error(`OpenAPI conversion error: ${err.message || err}`));
          return;
        }
        if (!conversionResult.result) {
          reject(new Error(`OpenAPI conversion failed: ${conversionResult.reason || 'unknown reason'}`));
          return;
        }
        resolve(conversionResult.output[0]?.data);
      }
    );
  });

  if (!collectionData) {
    throw new Error('OpenAPI conversion did not produce a collection.');
  }

  let sync: ImportOpenApiResult['sync'];
  if (options.mode === 'sync') {
    if (!options.collectionSource) throw new Error('collectionSource is required when mode is sync.');
    const loaded = await (await import('./collectionLoader.js')).loadCollection(options.collectionSource, { fetchImpl: options.fetchImpl });
    const current = loaded.collection;
    const generated = collectionData;
    const sourceItems = collectRequests(current.item);
    const generatedItems = collectRequests(generated.item);
    const sourceByKey = uniqueRequestMap(sourceItems);
    const generatedByKey = uniqueRequestMap(generatedItems);
    const ambiguousSource = duplicateRequestKeys(sourceItems);
    const ambiguousGenerated = duplicateRequestKeys(generatedItems);
    if (ambiguousSource.size || ambiguousGenerated.size) {
      throw new Error('Sync cannot safely match duplicate method and path keys.');
    }
    const added = [...generatedByKey.keys()].filter(key => !sourceByKey.has(key)).length;
    const updated = [...generatedByKey.keys()].filter(key => sourceByKey.has(key) && sourceByKey.get(key)!.name !== generatedByKey.get(key)!.name).length;
    const removedKeys = [...sourceByKey.keys()].filter(key => !generatedByKey.has(key));
    const removed = options.deleteOrphanedRequests ? removedKeys.length : 0;
    const removedEvents = options.deleteOrphanedRequests
      ? removedKeys.map(key => sourceByKey.get(key)!).filter(item => Array.isArray(item.event) && item.event.length > 0)
      : [];
    for (const key of generatedByKey.keys()) {
      const next = generatedByKey.get(key)!;
      const old = sourceByKey.get(key);
      if (old) {
        next.name = old.name === next.name ? old.name : next.name;
        if (Array.isArray(old.event)) next.event = old.event;
      }
    }
    current.item = mergeItems(current.item, generated.item, generatedByKey, sourceByKey, options.deleteOrphanedRequests === true);
    collectionData = current;
    sync = { added, updated, removed };
    for (const item of removedEvents) warnings.push(`Removed request with scripts: ${item.name}`);
  }

  // Rename the base URL variable.
  const baseUrlVarName = options.baseUrlVariable || 'baseUrl';
  if (collectionData.variable) {
    for (const v of collectionData.variable) {
      if (v.key === 'baseUrl' || v.key === 'base_url') {
        v.key = baseUrlVarName;
      }
    }
  } else {
    collectionData.variable = [];
  }

  // Detect and declare security variables (for example, bearerToken).
  const variablesList: string[] = [baseUrlVarName];
  if (collectionData.variable) {
    for (const v of collectionData.variable) {
      if (v.key && !variablesList.includes(v.key)) {
        variablesList.push(v.key);
      }
    }
  }

  // Add bearerToken when bearer auth is present.
  if (JSON.stringify(collectionData).includes('bearerAuth') || JSON.stringify(collectionData).includes('bearer')) {
    if (!variablesList.includes('bearerToken')) {
      collectionData.variable.push({ key: 'bearerToken', value: '', type: 'string' });
      variablesList.push('bearerToken');
    }
  }

  // 4. Generate contract tests when enabled.
  let testsGenerated = 0;
  if (options.generateBasicTests !== false) {
    // Traverse items and add a basic test when missing.
    function addContractTests(items: any[]) {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (Array.isArray(item.item)) {
          addContractTests(item.item);
        } else if (item.request) {
          if (!item.event) item.event = [];
          const hasTest = item.event.some((e: any) => e.listen === 'test');
          if (!hasTest) {
            item.event.push({
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  "pm.test('[contract] status documentado', function () {",
                  "    pm.expect(pm.response.code).to.be.oneOf([200, 201, 204, 400, 401, 403, 404]);",
                  "});",
                ],
              },
            });
            testsGenerated++;
          }
        }
      }
    }
    if (collectionData.item) {
      addContractTests(collectionData.item);
    }
  }

  // 5. Write output through safePath.
  const outAbsPath = safePath(options.outputPath);
  if (options.mode === 'sync' && !options.collectionSource) {
    throw new Error('collectionSource is required when mode is sync.');
  }
  await writeSafeFile(options.outputPath, JSON.stringify(collectionData, null, 2), {
    overwrite: options.overwrite,
    inputPath: options.mode === 'sync' ? options.collectionSource : undefined,
  });

  // Collect folders and total items
  const folders: string[] = [];
  let totalItems = 0;
  function countItems(items: any[], parent = '') {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (Array.isArray(item.item)) {
        const folderName = parent ? `${parent}/${item.name}` : item.name;
        folders.push(folderName);
        countItems(item.item, folderName);
      } else if (item.request) {
        totalItems++;
      }
    }
  }
  if (collectionData.item) {
    countItems(collectionData.item);
  }

  return {
    outputPath: outAbsPath,
    mode: options.mode || 'create',
    spec: {
      version: String(openApiVersion),
      title: apiTitle,
      apiVersion,
    },
    totalItems,
    folders,
    variables: variablesList,
    testsGenerated,
    ...(sync ? { sync } : {}),
    warnings,
    validation: validateCollectionStatic(collectionData).summary,
  };
}

function requestKey(item: any): string | undefined {
  const method = item.request?.method;
  const url = item.request?.url;
  if (typeof method !== 'string' || !url) return undefined;
  const path = Array.isArray(url.path) ? `/${url.path.join('/')}` : typeof url === 'string' ? url : url.raw;
  if (typeof path !== 'string' || !path) return undefined;
  return path ? `${method.toUpperCase()} ${path}` : undefined;
}

function collectRequests(items: any[] = []): any[] {
  return items.flatMap(item => Array.isArray(item.item) ? collectRequests(item.item) : item.request ? [item] : []);
}

function duplicateRequestKeys(items: any[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = requestKey(item);
    if (!key) throw new Error('Sync cannot safely match a request with an unresolved method or path.');
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

function uniqueRequestMap(items: any[]): Map<string, any> {
  return new Map(items.map(item => [requestKey(item)!, item]));
}

function mergeItems(existing: any[], generated: any[], generatedByKey: Map<string, any>, existingByKey: Map<string, any>, deleteOrphans: boolean): any[] {
  const generatedKeys = new Set(generatedByKey.keys());
  const next = existing.flatMap(item => {
    if (Array.isArray(item.item)) {
      const generatedFolder = generated.find(candidate => Array.isArray(candidate.item) && candidate.name === item.name);
      const children = mergeItems(item.item, generatedFolder?.item ?? [], generatedByKey, existingByKey, deleteOrphans);
      return children.length ? [{ ...item, item: children }] : deleteOrphans ? [] : [item];
    }
    if (!item.request) return [item];
    const key = requestKey(item)!;
    const match = generatedByKey.get(key);
    if (match) return [match];
    return deleteOrphans ? [] : [item];
  });
  const existingKeys = new Set(existingByKey.keys());
  const additions = generated.filter(item => Array.isArray(item.item)
    ? false
    : item.request && !existingKeys.has(requestKey(item)!));
  const existingFolders = new Set(existing.filter(item => Array.isArray(item.item)).map(item => item.name));
  const newFolders = generated.filter(item => Array.isArray(item.item) && !existingFolders.has(item.name))
    .map(folder => ({ ...folder, item: mergeItems([], folder.item, generatedByKey, existingByKey, deleteOrphans) }));
  const output = [...next, ...additions, ...newFolders.filter(f => f.item.length)];
  if (!deleteOrphans && generatedKeys.size === 0) return [...existing];
  return output;
}
