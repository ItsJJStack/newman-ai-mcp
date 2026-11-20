/**
 * @fileoverview Tool 6: inspect_postman_collection
 * Returns a lightweight map of the collection without running it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError, toolResult } from '../errors.js';
import { loadCollection } from '../postman/collectionLoader.js';
import { extractItems, extractVariableReferences } from '../postman/parser.js';

const inputSchema = {
  collectionSource: z.string().describe('Collection (path, https URL, or Postman UID)'),
  folder: z.string().optional().describe('Limit inspection to a folder'),
  maxItems: z.number().int().min(1).max(500).default(100).describe('Maximum number of listed items'),
};

const outputSchema = z.object({
  name: z.string(),
  schemaVersion: z.string(),
  folders: z.array(z.string()),
  items: z.array(z.object({
    path: z.array(z.string()),
    name: z.string(),
    method: z.string(),
    url: z.string(),
    hasTest: z.boolean(),
    hasPrerequest: z.boolean(),
  })),
  variables: z.object({
    defined: z.array(z.string()),
    referenced: z.array(z.string()),
  }),
  collectionScripts: z.object({
    test: z.boolean(),
    prerequest: z.boolean(),
  }),
  totalItems: z.number(),
  truncated: z.boolean(),
});

export function registerInspectTool(server: McpServer): void {
  server.registerTool(
    'inspect_postman_collection',
    {
      title: 'Inspect Postman collection',
      description: 'Returns a lightweight map of the collection without running it, so the agent can see what exists before calling other tools.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const { collection } = await loadCollection(args.collectionSource);
        const allItems = extractItems(collection.item || []);

        const foldersSet = new Set<string>();
        for (const item of allItems) {
          if (item.path.length > 0) {
            foldersSet.add(item.path.join('/'));
          }
        }

        // Filter by folder when provided.
        let filteredItems = allItems;
        if (args.folder) {
          filteredItems = allItems.filter(i => i.path.join('/') === args.folder || i.path.join('/').startsWith(args.folder + '/'));
        }

        const maxItems = args.maxItems ?? 100;
        const truncated = filteredItems.length > maxItems;
        const slicedItems = filteredItems.slice(0, maxItems).map(i => ({
          path: i.path,
          name: i.name,
          method: i.method,
          url: i.url,
          hasTest: i.hasTest,
          hasPrerequest: i.hasPrerequest,
        }));

        // Defined variables.
        const definedVars: string[] = [];
        if (Array.isArray(collection.variable)) {
          for (const v of collection.variable) {
            if (v && typeof v.key === 'string') definedVars.push(v.key);
          }
        }

        // Referenced variables.
        const referencedVarsSet = new Set<string>();
        for (const item of allItems) {
          const serialized = JSON.stringify(item.rawItem);
          for (const ref of extractVariableReferences(serialized)) {
            referencedVarsSet.add(ref);
          }
        }

        // Collection scripts.
        let colTest = false;
        let colPrereq = false;
        if (Array.isArray(collection.event)) {
          for (const ev of collection.event) {
            if (ev.listen === 'test' && ev.script?.exec) colTest = true;
            if (ev.listen === 'prerequest' && ev.script?.exec) colPrereq = true;
          }
        }

        return toolResult(
          {
            name: collection.info?.name || 'Unnamed collection',
            schemaVersion: collection.info?.schema || 'v2.1.0',
            folders: Array.from(foldersSet),
            items: slicedItems,
            variables: {
              defined: definedVars,
              referenced: Array.from(referencedVarsSet),
            },
            collectionScripts: {
              test: colTest,
              prerequest: colPrereq,
            },
            totalItems: allItems.length,
            truncated,
          },
          `Inspected collection: ${collection.info?.name || 'Collection'} (${allItems.length} items found)`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
