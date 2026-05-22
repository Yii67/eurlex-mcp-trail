// src/tools/deadlines.ts
// New tool: eurlex_deadlines
// Returns compliance deadlines for a given CELEX ID.
// Deadlines are stored as cdm:resource_legal_date_deadline in the Cellar.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CellarClient } from '../services/cellarClient.js';
import { toolError } from '../utils.js';

export const deadlinesSchema = z.object({
  celex_id: z.string().min(1).describe('CELEX identifier of the EU legal act'),
  language: z.enum(['ENG', 'DEU', 'FRA']).default('ENG'),
});

export async function handleEurlexDeadlines(input: {
  celex_id: string;
  language: string;
}): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  try {
    const parsed = deadlinesSchema.parse(input);
    const client = new CellarClient();
    const result = await client.deadlinesQuery(parsed.celex_id, parsed.language);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  } catch (error) {
    return toolError(error);
  }
}

export function registerDeadlinesTool(server: McpServer): void {
  server.tool(
    'eurlex_deadlines',
    'Returns compliance deadlines and key implementation dates for an EU legal act by CELEX ID. Includes entry into force, transposition deadline, and all article-specific application dates.',
    deadlinesSchema.shape,
    { readOnlyHint: true, destructiveHint: false },
    async (params) => handleEurlexDeadlines(params),
  );
}
