/**
 * OpsPilot MCP: Cursor AI ↔ this process ↔ opspilot-api ↔ in-cluster agent.
 *
 * Tools call the backend HTTP API. The agent heartbeats inventory and claims
 * fix commands from that API. Live cluster state comes from the agent.
 */
const API = (process.env.OPSPILOT_API_URL || 'http://localhost:3000').replace(
  /\/$/,
  '',
);

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

function send(msg: object) {
  const body = JSON.stringify(msg);
  const payload = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  process.stdout.write(payload);
}

function ok(id: number | string | null | undefined, result: unknown) {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function err(id: number | string | null | undefined, message: string) {
  send({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32000, message },
  });
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API ${path} did not return JSON`);
  }
}

function stripAgent(a: Record<string, unknown>) {
  const {
    accessToken: _t,
    installToken: _i,
    installTokenId: _id,
    ...rest
  } = a;
  return rest;
}

function compactIncident(i: Record<string, unknown>) {
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
    agent:
      i.agent && typeof i.agent === 'object'
        ? {
            id: (i.agent as Record<string, unknown>).id,
            hostname: (i.agent as Record<string, unknown>).hostname,
            clusterName: (i.agent as Record<string, unknown>).clusterName,
            status: (i.agent as Record<string, unknown>).status,
          }
        : undefined,
  };
}

const TOOLS = [
  {
    name: 'opspilot_health',
    description: 'Check OpsPilot backend API health (agent reports into this API).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description:
      'List in-cluster OpsPilot agents registered with the backend (heartbeat status, cluster, host).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_agent_live',
    description:
      'Live pod inventory from the last agent heartbeat (what the in-cluster agent currently sees).',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
    },
  },
  {
    name: 'list_incidents',
    description: 'List recent incidents the agent reported to the backend.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'get_incident',
    description: 'Get one incident by id, including metadata the agent attached.',
    inputSchema: {
      type: 'object',
      properties: { incidentId: { type: 'string' } },
      required: ['incidentId'],
    },
  },
  {
    name: 'get_apply_status',
    description:
      'Status of allowlisted fix commands queued for the in-cluster agent on an incident.',
    inputSchema: {
      type: 'object',
      properties: { incidentId: { type: 'string' } },
      required: ['incidentId'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'opspilot_health') {
    return JSON.stringify(await apiGet('/v1/health'));
  }
  if (name === 'list_agents') {
    const rows = (await apiGet('/v1/agents')) as Record<string, unknown>[];
    return JSON.stringify(
      (Array.isArray(rows) ? rows : []).map((a) => stripAgent(a)),
      null,
      2,
    );
  }
  if (name === 'get_agent_live') {
    const id = String(args.agentId || '');
    if (!id) throw new Error('agentId is required');
    return JSON.stringify(await apiGet(`/dashboard/agents/${encodeURIComponent(id)}/live`));
  }
  if (name === 'list_incidents') {
    const limit = Number(args.limit || 30);
    const rows = (await apiGet(
      `/v1/incidents?limit=${Number.isFinite(limit) ? limit : 30}`,
    )) as Record<string, unknown>[];
    return JSON.stringify(
      (Array.isArray(rows) ? rows : []).map((i) => compactIncident(i)),
      null,
      2,
    );
  }
  if (name === 'get_incident') {
    const id = String(args.incidentId || '');
    if (!id) throw new Error('incidentId is required');
    const row = (await apiGet(`/v1/incidents/${encodeURIComponent(id)}`)) as Record<
      string,
      unknown
    >;
    return JSON.stringify(compactIncident(row), null, 2);
  }
  if (name === 'get_apply_status') {
    const id = String(args.incidentId || '');
    if (!id) throw new Error('incidentId is required');
    return JSON.stringify(
      await apiGet(`/dashboard/incidents/${encodeURIComponent(id)}/apply-status`),
    );
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(msg: JsonRpc) {
  const method = msg.method || '';
  if (method === 'initialize') {
    ok(msg.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'opspilot', version: '0.1.0' },
      capabilities: { tools: {} },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    ok(msg.id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = String(msg.params?.name || '');
    const args =
      msg.params?.arguments && typeof msg.params.arguments === 'object'
        ? (msg.params.arguments as Record<string, unknown>)
        : {};
    try {
      const text = await callTool(name, args);
      ok(msg.id, { content: [{ type: 'text', text }] });
    } catch (e) {
      err(msg.id, e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (method === 'ping') {
    ok(msg.id, {});
  }
}

function feed(chunk: string, state: { buf: string }) {
  state.buf += chunk;
  while (true) {
    if (state.buf.startsWith('{')) {
      const nl = state.buf.indexOf('\n');
      if (nl < 0) return;
      const line = state.buf.slice(0, nl).trim();
      state.buf = state.buf.slice(nl + 1);
      if (line) void handle(JSON.parse(line) as JsonRpc);
      continue;
    }
    const headerEnd = state.buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = state.buf.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      state.buf = state.buf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(match[1]);
    const start = headerEnd + 4;
    if (state.buf.length < start + len) return;
    const json = state.buf.slice(start, start + len);
    state.buf = state.buf.slice(start + len);
    void handle(JSON.parse(json) as JsonRpc);
  }
}

const state = { buf: '' };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => feed(String(c), state));
