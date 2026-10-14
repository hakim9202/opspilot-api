import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { ClusterPrefillService } from './cluster-prefill.service';
import { ruleSuggestFix } from './suggested-fix';
import {
  parseAskChatLlmJson,
  type AskAgentSession,
  type AskChatMessage,
  type AskChatResult,
  type AskStreamEvent,
} from './ask-agent';

export type IncidentForSuggestion = {
  id?: string;
  type?: string | null;
  severity?: string | null;
  title?: string | null;
  message?: string | null;
  namespace?: string | null;
  resource?: string | null;
  reason?: string | null;
  metadata?: unknown;
};

const OPENAI_TIMEOUT_MS = 12_000;
const CURSOR_TIMEOUT_MS = 45_000;
/** Local Cursor+MCP chat is a full agent run; 45s was cutting off successful replies. */
const CHAT_CURSOR_TIMEOUT_MS = 120_000;
const BACKFILL_LIMIT = 40;
const ENRICH_CONCURRENCY = 1;

@Injectable()
export class AiSuggestionService implements OnModuleInit {
  private readonly logger = new Logger(AiSuggestionService.name);
  private backfilling = false;
  /** Skip OpenAI until this time after 429 / billing failures. */
  private openAiCooldownUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cluster: ClusterPrefillService,
  ) {}

  onModuleInit() {
    void this.backfillRecentMissing(BACKFILL_LIMIT);
  }

  /** True when an LLM path can run (OpenAI-compatible or Cursor SDK). */
  isConfigured(): boolean {
    return Boolean(this.openAiKey() || this.cursorKey());
  }

  displaySuggestion(stored: string | null | undefined): string {
    const text = (stored || '').trim();
    if (text) return text;
    return 'Generating suggestion…';
  }

  private openAiKey(): string | null {
    const key = process.env.OPENAI_API_KEY?.trim() || '';
    if (!key) return null;
    // Cursor keys are not valid for OpenAI chat completions.
    if (key.startsWith('crsr_')) return null;
    return key;
  }

  private cursorKey(): string | null {
    const fromCursor = process.env.CURSOR_API_KEY?.trim() || '';
    if (fromCursor) return fromCursor;
    const fromOpenAi = process.env.OPENAI_API_KEY?.trim() || '';
    if (fromOpenAi.startsWith('crsr_')) return fromOpenAi;
    return null;
  }

  async suggestFix(incident: IncidentForSuggestion): Promise<string | null> {
    if (this.openAiKey() && Date.now() >= this.openAiCooldownUntil) {
      const viaOpenAi = await this.suggestViaOpenAI(incident);
      if (viaOpenAi) return viaOpenAi;
    }
    if (this.cursorKey() && Date.now() >= this.openAiCooldownUntil) {
      // Skip slow Cursor retries while OpenAI is in billing cooldown.
      const viaCursor = await this.suggestViaCursor(incident);
      if (viaCursor) return viaCursor;
    }
    // Rule fallback when LLM is missing or failing (e.g. OpenAI 429) so the
    // dashboard is never stuck on "Generating…" without an Auto fix path.
    return ruleSuggestFix(incident);
  }

  private buildUserPayload(incident: IncidentForSuggestion) {
    const meta =
      incident.metadata &&
      typeof incident.metadata === 'object' &&
      !Array.isArray(incident.metadata)
        ? (incident.metadata as Record<string, unknown>)
        : {};

    const logSnippet = meta.logSnippet != null ? String(meta.logSnippet) : '';
    const compactMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === 'suggestedFix' || k === 'logSnippet') continue;
      if (v === undefined || v === null || String(v) === '') continue;
      compactMeta[k] = String(v).slice(0, 200);
    }

    return {
      type: incident.type,
      severity: incident.severity,
      title: incident.title,
      reason: incident.reason,
      message: incident.message,
      namespace: incident.namespace,
      resource: incident.resource,
      metadata: compactMeta,
      logSnippet: logSnippet.slice(0, 1200),
    };
  }

  private systemPrompt(): string {
    return 'You are an SRE assistant for Kubernetes incidents. Reply with 1–2 short practical sentences on how to fix the incident. No preamble, no markdown, no bullet lists. Focus on actionable checks (logs, config, image, memory, DB connectivity, probes, secrets).';
  }

  private async suggestViaOpenAI(
    incident: IncidentForSuggestion,
  ): Promise<string | null> {
    const apiKey = this.openAiKey()!;
    const baseUrl = (
      process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const userPayload = this.buildUserPayload(incident);

    const body = {
      model,
      temperature: 0.2,
      max_tokens: 160,
      messages: [
        { role: 'system', content: this.systemPrompt() },
        {
          role: 'user',
          content: `Suggest how to fix this incident:\n${JSON.stringify(userPayload)}`,
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.warn(
          `OpenAI request failed: ${res.status} ${errText.slice(0, 200)}`,
        );
        if (res.status === 429 || res.status === 402) {
          this.openAiCooldownUntil = Date.now() + 15 * 60_000;
          this.logger.warn(
            'OpenAI cooldown 15m — using rule suggestions until credits recover',
          );
        }
        return null;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json?.choices?.[0]?.message?.content?.trim() || '';
      if (!content) return null;
      return content.replace(/\s+/g, ' ').slice(0, 500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OpenAI suggestion error: ${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async suggestViaCursor(
    incident: IncidentForSuggestion,
  ): Promise<string | null> {
    const apiKey = this.cursorKey()!;
    const model = process.env.CURSOR_MODEL || process.env.OPENAI_MODEL || 'composer-2.5';
    const userPayload = this.buildUserPayload(incident);
    const prompt = `${this.systemPrompt()}\n\nSuggest how to fix this incident:\n${JSON.stringify(userPayload)}`;

    try {
      const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
      const storeRoot = `${process.cwd()}/.opspilot-cursor-agents`;
      const result = await Promise.race([
        Agent.prompt(prompt, {
          apiKey,
          model: { id: model },
          local: {
            cwd: process.cwd(),
            // Avoid requiring Node >= 22 built-in node:sqlite.
            store: new JsonlLocalAgentStore(storeRoot),
          },
        }),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), CURSOR_TIMEOUT_MS),
        ),
      ]);
      if (!result || typeof result !== 'object') {
        this.logger.warn('Cursor Agent.prompt timed out or returned empty');
        return null;
      }
      const content = String(
        (result as { result?: unknown }).result ?? '',
      ).trim();
      if (!content) {
        this.logger.warn(
          `Cursor Agent.prompt finished without text (status=${(result as { status?: string }).status})`,
        );
        return null;
      }
      return content.replace(/\s+/g, ' ').slice(0, 500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cursor suggestion error: ${msg}`);
      return null;
    }
  }

  async enrichIncident(incident: IncidentForSuggestion & { id: string }) {
    try {
      const suggestion = await this.suggestFix(incident);
      if (!suggestion) return;
      await this.prisma.incident.update({
        where: { id: incident.id },
        data: { suggestedFix: suggestion },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to enrich incident ${incident.id}: ${msg}`);
    }
  }

  async enrichMany(incidents: Array<IncidentForSuggestion & { id: string }>) {
    if (incidents.length === 0) return;
    for (let i = 0; i < incidents.length; i += ENRICH_CONCURRENCY) {
      const chunk = incidents.slice(i, i + ENRICH_CONCURRENCY);
      await Promise.all(chunk.map((inc) => this.enrichIncident(inc)));
    }
  }

  async backfillRecentMissing(limit = BACKFILL_LIMIT) {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const rows = await this.prisma.incident.findMany({
        where: { suggestedFix: null },
        orderBy: { occurredAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 50),
      });
      if (rows.length === 0) return;
      // Prioritize CrashLoop / demo-exit2 so the dashboard verifies AI wording first.
      rows.sort((a, b) => scorePriority(b) - scorePriority(a));
      this.logger.log(`Backfilling AI suggestions for ${rows.length} incidents`);
      await this.enrichMany(rows);
      this.logger.log('AI suggestion backfill complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI backfill failed: ${msg}`);
    } finally {
      this.backfilling = false;
    }
  }

  /** Force-regenerate suggestions for recent incidents (e.g. after key added). */
  async regenerateRecent(limit = 15) {
    if (!this.isConfigured()) return 0;
    const rows = await this.prisma.incident.findMany({
      orderBy: { occurredAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    rows.sort((a, b) => scorePriority(b) - scorePriority(a));
    await this.prisma.incident.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { suggestedFix: null },
    });
    await this.enrichMany(rows);
    return rows.length;
  }

  /**
   * Conversational reply for Ask agent. Cursor + OpsPilot MCP only —
   * never a canned template, never OpenAI.
   */
  async chatAboutIncident(
    session: AskAgentSession,
    history: AskChatMessage[],
    userMessage: string,
  ): Promise<AskChatResult> {
    let last: AskChatResult | null = null;
    for await (const ev of this.streamChatAboutIncident(
      session,
      history,
      userMessage,
    )) {
      if (ev.type === 'done') last = ev.result;
      if (ev.type === 'error') {
        return {
          reply: ev.message,
          propose: null,
          options: [],
        };
      }
    }
    return (
      last || {
        reply:
          'Cursor + OpsPilot MCP did not finish. I will not substitute a template — ask again.',
        propose: null,
        options: [],
      }
    );
  }

  /** Yields thinking / tool / final reply events for SSE. */
  async *streamChatAboutIncident(
    session: AskAgentSession,
    history: AskChatMessage[],
    userMessage: string,
  ): AsyncGenerator<AskStreamEvent> {
    if (!this.cursorKey()) {
      yield {
        type: 'error',
        message:
          'Ask agent is wired to Cursor + OpsPilot MCP. Set CURSOR_API_KEY and retry.',
      };
      return;
    }
    yield { type: 'status', text: 'Starting Cursor + OpsPilot MCP…' };
    yield* this.streamViaCursor(session, history, userMessage);
  }

  private chatSystemPrompt(session: AskAgentSession): string {
    const mcpHint = [
      'Use OpsPilot MCP tools only. Do not read or edit workspace files. Do not run shell.',
      session.incidentId
        ? `Call get_incident with incidentId="${session.incidentId}".`
        : 'Call list_incidents.',
      session.agentId
        ? `Call get_agent_live with agentId="${session.agentId}".`
        : 'Call list_agents, then get_agent_live for the online agent.',
      'Do not invent cluster state. Quote waitingMessage / Secret / image errors exactly.',
    ].join(' ');
    return `You are OpsPilot, a Kubernetes SRE copilot in a chat UI.
${mcpHint}

Incident facts:
${session.facts}

Allowlisted actions you MAY put on chips (nothing else):
- set_image: change container image. Include "image":"registry/app:tag" or "needsInput":true
- set_memory: change memory limit/request. Include "memoryLimit":"256Mi" (or 512Mi, 1Gi, 2Gi) or "needsInput":true
- restart: rollout restart the deployment
- scale: change replica count. Include "replicas":"2" or "needsInput":true

Rules:
- Write the entire reply yourself from MCP tool results. No canned templates.
- Do not show chips until you have explained the problem.
- Pick actions that match this incident. OOM → set_memory; bad image → set_image; missing Secret is not an allowlisted apply.
- Never claim you already changed the cluster.
- Reply as JSON only, no markdown fences:
{"reply":"your message","options":[{"action":"set_memory","label":"Raise memory to 256Mi","detail":"…","memoryLimit":"256Mi"}],"propose":null}
- Keep reply under 120 words.
- If they have not agreed to apply, propose must be null.`;
  }

  private async chatViaOpenAI(
    session: AskAgentSession,
    history: AskChatMessage[],
    userMessage: string,
  ): Promise<AskChatResult | null> {
    const apiKey = this.openAiKey()!;
    const baseUrl = (
      process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: this.chatSystemPrompt(session) },
    ];
    for (const m of history.slice(-12)) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content.slice(0, 2000) });
      }
    }
    messages.push({ role: 'user', content: userMessage.slice(0, 2000) });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 400,
          messages,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.warn(
          `OpenAI chat failed: ${res.status} ${errText.slice(0, 200)}`,
        );
        if (res.status === 429 || res.status === 402) {
          this.openAiCooldownUntil = Date.now() + 15 * 60_000;
        }
        return null;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json?.choices?.[0]?.message?.content?.trim() || '';
      return (
        parseAskChatLlmJson(content, session.prefill) ||
        (content
          ? { reply: content.slice(0, 2000), propose: null, options: [] }
          : null)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`OpenAI chat error: ${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async *streamViaCursor(
    session: AskAgentSession,
    history: AskChatMessage[],
    userMessage: string,
  ): AsyncGenerator<AskStreamEvent> {
    const apiKey = this.cursorKey()!;
    const model =
      process.env.CURSOR_MODEL || process.env.OPENAI_MODEL || 'composer-2.5';
    const transcript = history
      .slice(-8)
      .map((m) => `${m.role}: ${m.content.slice(0, 800)}`)
      .join('\n');
    const prompt = `${this.chatSystemPrompt(session)}\n\nPrior chat:\n${transcript || '(none)'}\n\nOperator: ${userMessage.slice(0, 2000)}`;

    const storeRoot = join(process.cwd(), '.opspilot-cursor-agents');
    const workspace = join(storeRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(workspace, 'README.md'),
      'Empty workspace. Use OpsPilot MCP tools only. Do not read other files.\n',
    );
    const mcpScript = join(process.cwd(), 'mcp/opspilot-mcp.mjs');
    const started = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let agent: any = null;

    try {
      const { Agent, JsonlLocalAgentStore } = await import('@cursor/sdk');
      agent = await Agent.create({
        apiKey,
        model: { id: model },
        mcpServers: {
          opspilot: {
            command: process.execPath,
            args: [mcpScript],
            env: {
              OPSPILOT_API_URL:
                process.env.OPSPILOT_API_URL || 'http://127.0.0.1:3000',
            },
          },
        },
        local: {
          cwd: workspace,
          store: new JsonlLocalAgentStore(storeRoot),
          settingSources: [],
          sandboxOptions: { enabled: false },
        },
      });

      const run = await agent.send(prompt);
      let assistantText = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void run.cancel().catch(() => undefined);
      }, CHAT_CURSOR_TIMEOUT_MS);

      try {
        for await (const event of run.stream()) {
          if (timedOut) break;
          if (event.type === 'thinking' && typeof event.text === 'string') {
            const chunk = event.text.trim();
            if (chunk) yield { type: 'thinking', text: chunk };
          } else if (event.type === 'tool_call') {
            const status =
              event.status === 'completed' || event.status === 'error'
                ? event.status
                : 'running';
            const args =
              event.args && typeof event.args === 'object'
                ? (event.args as Record<string, unknown>)
                : {};
            const toolName =
              typeof args.toolName === 'string' && args.toolName
                ? args.toolName
                : String(event.name || 'tool');
            yield {
              type: 'tool',
              name: toolName,
              status,
              callId:
                typeof event.call_id === 'string' ? event.call_id : undefined,
            };
          } else if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                assistantText += block.text;
              }
            }
          } else if (event.type === 'status' && event.status) {
            yield { type: 'status', text: String(event.status) };
          }
        }

        const result = timedOut ? null : await run.wait();
        const ms = Date.now() - started;
        if (timedOut) {
          this.logger.warn(`Cursor + MCP chat timed out after ${ms}ms`);
          yield {
            type: 'error',
            message:
              'Cursor + OpsPilot MCP timed out. Ask again — I will not substitute a template.',
          };
          return;
        }
        const content = String(
          result?.result ?? assistantText ?? '',
        ).trim();
        if (!content) {
          this.logger.warn(
            `Cursor + MCP finished without text after ${ms}ms status=${result?.status}`,
          );
          yield {
            type: 'error',
            message:
              'Cursor + OpsPilot MCP finished without a reply. Ask again.',
          };
          return;
        }
        this.logger.log(`Ask agent reply via Cursor + OpsPilot MCP in ${ms}ms`);
        const parsed =
          parseAskChatLlmJson(content, session.prefill) || {
            reply: content.slice(0, 2000),
            propose: null,
            options: [],
          };
        yield {
          type: 'done',
          result: { ...parsed, source: 'cursor-mcp' },
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cursor chat error: ${msg}`);
      yield {
        type: 'error',
        message: `Cursor + OpsPilot MCP error: ${msg.slice(0, 300)}`,
      };
    } finally {
      if (agent) {
        try {
          await agent[Symbol.asyncDispose]();
        } catch {
          try {
            agent.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}

function scorePriority(row: {
  type?: string | null;
  resource?: string | null;
  reason?: string | null;
}): number {
  const blob = `${row.type || ''} ${row.resource || ''} ${row.reason || ''}`.toLowerCase();
  let score = 0;
  if (blob.includes('demo-exit2')) score += 100;
  if (blob.includes('crashloop')) score += 50;
  if (blob.includes('exit 2') || blob.includes('exit2')) score += 20;
  return score;
}
