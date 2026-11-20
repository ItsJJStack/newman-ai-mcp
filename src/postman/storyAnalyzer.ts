/**
@fileoverview User-story analyzer and endpoint-catalog builder (storyAnalyzer.ts).
Extracts acceptance criteria (Gherkin, lists, or explicit fields) and builds the collection endpoint catalog.
*/

import { extractItems, normalizeUrl } from './parser.js';

export type EndpointCatalogItem = {
  id: string;
  folder: string;
  name: string;
  method: string;
  base: string;
  path: string;
  auth: string;
  bodyKeys: string[];
  pathParams: string[];
  documentedStatus: number[];
  responseKeys: Record<string, string[]>;
};

export type AcceptanceCriterion = {
  id: string;
  text: string;
  source: 'input' | 'gherkin' | 'list' | 'none';
};

/**
 * Builds an endpoint catalog from collection items.
 */
export function buildEndpointCatalog(collection: any): { catalog: EndpointCatalogItem[]; folders: string[]; catalogNote?: string } {
  const parsedItems = extractItems(collection.item || []);
  const catalog: EndpointCatalogItem[] = [];
  const foldersSet = new Set<string>();

  let index = 1;
  for (const item of parsedItems) {
    const folder = item.path.join('/') || 'Root';
    foldersSet.add(folder);

    // Extract a clean path without baseUrl or query parameters.
    let rawUrl = item.url;
    // Split off a base-variable prefix or protocol/host.
    const base = rawUrl.match(/^\{\{[^\}]+\}\}/)?.[0] ?? rawUrl.match(/^https?:\/\/[^\/]+/)?.[0] ?? '';
    rawUrl = rawUrl.slice(base.length);
    const queryIdx = rawUrl.indexOf('?');
    if (queryIdx !== -1) {
      rawUrl = rawUrl.slice(0, queryIdx);
    }
    if (!rawUrl.startsWith('/')) {
      rawUrl = '/' + rawUrl;
    }

    // Auth
    const authType = item.rawItem?.request?.auth?.type || 'none';

    // Body keys
    const bodyKeys: string[] = [];
    const body = item.rawItem?.request?.body;
    if (body?.mode === 'raw' && typeof body.raw === 'string') {
      try {
        const parsedBody = JSON.parse(body.raw);
        if (parsedBody && typeof parsedBody === 'object') {
          bodyKeys.push(...Object.keys(parsedBody));
        }
      } catch {
        // Not valid JSON.
      }
    }

    // Path params (ej. :id o {{id}})
    const pathParams: string[] = [];
    const paramMatches = rawUrl.matchAll(/:([a-zA-Z0-9_]+)|\{\{([^\}]+)\}\}/g);
    for (const pm of paramMatches) {
      if (pm[1]) pathParams.push(pm[1]);
      if (pm[2] && !pm[2].startsWith('$')) pathParams.push(pm[2]);
    }

    // Documented status y responseKeys de los ejemplos en response[]
    const documentedStatus: number[] = [];
    const responseKeys: Record<string, string[]> = {};
    if (Array.isArray(item.rawItem?.response)) {
      for (const res of item.rawItem.response) {
        if (res.code && typeof res.code === 'number') {
          if (!documentedStatus.includes(res.code)) {
            documentedStatus.push(res.code);
          }
          if (res.body && typeof res.body === 'string') {
            try {
              const resJson = JSON.parse(res.body);
              if (resJson && typeof resJson === 'object') {
                responseKeys[String(res.code)] = Object.keys(resJson);
              }
            } catch {
              // Ignorar
            }
          }
        }
      }
    }

    catalog.push({
      id: `E${index++}`,
      folder,
      name: item.name,
      method: item.method,
      base,
      path: rawUrl,
      auth: authType,
      bodyKeys,
      pathParams,
      documentedStatus,
      responseKeys,
    });
  }

  let catalogNote: string | undefined = undefined;
  let finalCatalog = catalog;
  if (catalog.length > 15) {
    finalCatalog = catalog.slice(0, 15);
    catalogNote = `CATALOG_NOTE: showing 15 of ${catalog.length} endpoints`;
  }

  return {
    catalog: finalCatalog,
    folders: Array.from(foldersSet),
    catalogNote,
  };
}

/**
 * Extracts acceptance criteria from the user story or uses the provided criteria.
 */
export function extractAcceptanceCriteria(userStory: string, providedCriteria?: string[]): { criteria: AcceptanceCriterion[]; source: 'input' | 'gherkin' | 'list' | 'none' } {
  if (Array.isArray(providedCriteria) && providedCriteria.length > 0) {
    const criteria: AcceptanceCriterion[] = providedCriteria
      .map((text, i) => ({ id: `C${i + 1}`, text: text.trim(), source: 'input' as const }))
      .filter(c => c.text.length > 0);
    if (criteria.length > 0) {
      return { criteria, source: 'input' };
    }
  }

  const lines = userStory.split(/\r?\n/).map(l => l.trim());
  const criteria: AcceptanceCriterion[] = [];

  // 1. Gherkin check: Escenario:, Scenario:, Caso:
  for (const line of lines) {
    const match = line.match(/^(?:escenario|scenario|caso):\s*(.+)$/i);
    if (match && match[1]) {
      criteria.push({
        id: `C${criteria.length + 1}`,
        text: match[1].trim(),
        source: 'gherkin',
      });
    }
  }

  if (criteria.length > 0) {
    return { criteria: criteria.slice(0, 8), source: 'gherkin' };
  }

  // Gherkin check sin palabra escenario (contando Dado / Given)
  for (const line of lines) {
    if (/^(given|dado)\b/i.test(line)) {
      criteria.push({
        id: `C${criteria.length + 1}`,
        text: line,
        source: 'gherkin',
      });
    }
  }

  if (criteria.length > 0) {
    return { criteria: criteria.slice(0, 8), source: 'gherkin' };
  }

  // 2. List check (Spanish or English acceptance-criteria heading followed by bullets).
  let inListSection = false;
  const listCriteria: string[] = [];

  for (const line of lines) {
    if (/criterios de aceptaci[oó]n|acceptance criteria/i.test(line)) {
      inListSection = true;
      continue;
    }
    if (inListSection) {
      if (line === '') {
        // A blank line ends the list section.
        break;
      }
      const bulletMatch = line.match(/^[-*•1-9][.)]\s*(.+)$/);
      if (bulletMatch && bulletMatch[1]) {
        listCriteria.push(bulletMatch[1].trim());
      } else if (line.startsWith('-') || line.startsWith('*') || line.startsWith('•')) {
        const text = line.replace(/^[-*•]\s*/, '').trim();
        if (text) listCriteria.push(text);
      } else if (listCriteria.length > 0) {
        // Join a multiline continuation to the previous criterion.
        listCriteria[listCriteria.length - 1] += ' ' + line;
      }
    }
  }

  if (listCriteria.length > 0) {
    const mapped = listCriteria.slice(0, 8).map((text, i) => ({
      id: `C${i + 1}`,
      text,
      source: 'list' as const,
    }));
    return { criteria: mapped, source: 'list' };
  }

  return { criteria: [], source: 'none' };
}
