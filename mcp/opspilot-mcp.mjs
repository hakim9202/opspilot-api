#!/usr/bin/env node
/**
 * Cursor AI --stdio MCP--> this process --HTTP--> opspilot-api --heartbeat--> in-cluster agent
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.OPSPILOT_API_URL || 'http://localhost:3000').replace(
  /\/$/,
  '',
);

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function compactAgent(a) {
  return {
    id: a.id,
    hostname: a.hostname,
    environment: a.environment,
    clusterName: a.clusterName,
    status: a.status,
    lastHeartbeatAt: a.lastHeartbeatAt,
  };
}

function compactIncident(i) {
  return {
    id: i.id,
    type: i.type,
    severity: i.severity,
    reason: i.reason,
    namespace: i.namespace,
    resource: i.resource,
    message: i.message,
    suggestedFix: i.suggestedFix,
    occurredAt: i.occurredAt,
    metadata: i.metadata,
    agent: i.agent
      ? {
          id: i.agent.id,
          hostname: i.agent.hostname,
          clusterName: i.agent.clusterName,
          status: i.agent.status,
        }
      : undefined,
  };
}

const server = new McpServer({ name: 'opspilot', version: '0.1.0' });

server.registerTool(
  'opspilot_health',
  { description: 'Check OpsPilot backend API health.' },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await apiGet('/v1/health')) }],
  }),
);

server.registerTool(
  'list_agents',
  {
    description:
      'List in-cluster OpsPilot agents registered with the backend (status, cluster, host).',
  },
  async () => {
    const rows = await apiGet('/v1/agents');
    const compact = (Array.isArray(rows) ? rows : []).map(compactAgent);
    return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
  },
);

server.registerTool(
  'get_agent_live',
  {
    description:
      'Live pod inventory from the last in-cluster agent heartbeat.',
    inputSchema: { agentId: z.string() },
  },
  async ({ agentId }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          await apiGet(`/dashboard/agents/${encodeURIComponent(agentId)}/live`),
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  'list_incidents',
  {
    description: 'List recent incidents the agent reported to the backend.',
    inputSchema: { limit: z.number().optional() },
  },
  async ({ limit }) => {
    const n = Number(limit || 30);
    const rows = await apiGet(`/v1/incidents?limit=${Number.isFinite(n) ? n : 30}`);
    const compact = (Array.isArray(rows) ? rows : []).map(compactIncident);
    return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
  },
);

server.registerTool(
  'get_incident',
  {
    description: 'Get one incident by id.',
    inputSchema: { incidentId: z.string() },
  },
  async ({ incidentId }) => {
    const row = await apiGet(`/v1/incidents/${encodeURIComponent(incidentId)}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(compactIncident(row), null, 2) }],
    };
  },
);

server.registerTool(
  'get_apply_status',
  {
    description: 'Fix-command status the in-cluster agent claimed or completed.',
    inputSchema: { incidentId: z.string() },
  },
  async ({ incidentId }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          await apiGet(
            `/dashboard/incidents/${encodeURIComponent(incidentId)}/apply-status`,
          ),
          null,
          2,
        ),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
