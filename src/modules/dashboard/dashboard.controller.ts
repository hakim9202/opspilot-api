import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Redirect,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentsService } from '../agents/agents.service';
import { IncidentsService } from '../incidents/incidents.service';
import { LicensingService } from '../licensing/licensing.service';
import { ClusterPrefillService } from '../incidents/cluster-prefill.service';
import { AiSuggestionService } from '../incidents/ai-suggestion.service';
import { groupIncidents, type IncidentGroup } from '../incidents/incident-groups';
import { inferDeploymentFromPodName } from '../incidents/pod-history';
import { filterLiveFailureIncidents, filterLiveDockerFailureIncidents } from '../incidents/live-failures';
import {
  categoryTabLabel,
  filterIncidentsByCategory,
  inferIncidentCategory,
  normalizeDashboardCategoryTab,
  type DashboardCategoryTab,
} from '../incidents/incident-category';
import {
  ASK_OPEN_PROMPT,
  buildAskAgentSession,
  isDockerContainerIncident,
  parseAskOptionPayload,
  resolveAskOptionParams,
} from '../incidents/ask-agent';
import {
  splitCommands,
  MEMORY_PRESETS,
  resolveDeploymentTarget,
  resolveApplyPrefill,
  mergeClusterPrefill,
} from '../incidents/auto-fix';

const BUILTIN_REDACTION = [
  { label: 'Bearer tokens', example: 'Authorization: Bearer [REDACTED]' },
  { label: 'Passwords / API keys', example: 'password=[REDACTED]' },
  { label: 'JWTs', example: '[REDACTED_JWT]' },
  { label: 'DB connection strings', example: '[REDACTED_CONNECTION_STRING]' },
  { label: 'Long hex secrets', example: '[REDACTED_HEX]' },
];

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly incidentsService: IncidentsService,
    private readonly licensing: LicensingService,
    private readonly clusterPrefill: ClusterPrefillService,
    private readonly aiSuggestions: AiSuggestionService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(
    @Query('category') categoryParam?: string,
    @Query('source') sourceParam?: string,
  ) {
    const activeCategory = normalizeDashboardCategoryTab(
      categoryParam || sourceParam,
    );
    const [agents, incidents] = await Promise.all([
      this.agentsService.listAgents(),
      this.incidentsService.list(200),
    ]);

    const agentRows = agents
      .map((a) => {
        const statusClass =
          a.status === 'online' ? 'ok' : a.status === 'revoked' ? 'crit' : 'off';
        const actions =
          a.status === 'revoked'
            ? '<span class="muted">revoked</span>'
            : `<form method="post" action="/dashboard/agents/${esc(a.id)}/revoke" onsubmit="return confirm('Revoke this agent immediately? Heartbeats and events will be rejected.');">
                <button type="submit" class="btn danger">Revoke</button>
              </form>`;
        return `
      <tr>
        <td><a href="/dashboard/agents/${esc(a.id)}"><code>${esc(a.id)}</code></a></td>
        <td><a href="/dashboard/agents/${esc(a.id)}">${esc(a.hostname)}</a></td>
        <td>${esc(a.clusterName)}</td>
        <td>${esc(a.environment)}</td>
        <td><span class="badge ${statusClass}">${esc(a.status)}</span></td>
        <td>${a.lastHeartbeatAt ? esc(new Date(a.lastHeartbeatAt).toISOString()) : '—'}</td>
        <td>${esc(a.version)}</td>
        <td>${actions}</td>
      </tr>`;
      })
      .join('');

    const inventoryAgents = agents.map((a) => ({
      clusterName: a.clusterName,
      status: a.status,
      podInventory: (a as { podInventory?: unknown }).podInventory,
      containerInventory: (a as { containerInventory?: unknown }).containerInventory,
    }));

    const k8sLive = filterLiveFailureIncidents(incidents, inventoryAgents);
    const dockerLive = filterLiveDockerFailureIncidents(incidents, inventoryAgents);
    const allLive = [...k8sLive, ...dockerLive].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );

    const tabCounts: Record<DashboardCategoryTab, number> = {
      all: groupIncidents(allLive).length,
      pod: groupIncidents(filterIncidentsByCategory(allLive, 'pod')).length,
      deployment: groupIncidents(filterIncidentsByCategory(allLive, 'deployment'))
        .length,
      docker: groupIncidents(filterIncidentsByCategory(allLive, 'docker')).length,
      replicaset: groupIncidents(filterIncidentsByCategory(allLive, 'replicaset'))
        .length,
      other: groupIncidents(filterIncidentsByCategory(allLive, 'other')).length,
    };

    const liveIncidents = filterIncidentsByCategory(allLive, activeCategory);
    const groups = groupIncidents(liveIncidents);

    const locationHeader =
      activeCategory === 'docker'
        ? 'Host'
        : activeCategory === 'pod' ||
            activeCategory === 'deployment' ||
            activeCategory === 'replicaset'
          ? 'Namespace'
          : 'Namespace / Host';

    const incidentRows = renderDashboardIncidentRows(groups, this.incidentsService);

    const categoryTabs = renderCategoryTabs(activeCategory, tabCounts);
    const categoryHint = dashboardCategoryHint(activeCategory);
    const refreshUrl =
      activeCategory === 'all'
        ? '/dashboard'
        : `/dashboard?category=${activeCategory}`;

    return layout(
      'Pulse',
      'Connected agents and live failures · auto-refresh 15s',
      refreshUrl,
      `
    <section>
      <h2>Agents (${agents.length})</h2>
      ${
        agents.length
          ? `<table>
        <thead><tr><th>ID</th><th>Host</th><th>Cluster</th><th>Env</th><th>Status</th><th>Last heartbeat</th><th>Version</th><th>Actions</th></tr></thead>
        <tbody>${agentRows}</tbody>
      </table>`
          : `<p class="empty">No agents registered yet.</p>`
      }
    </section>
    <section>
      <h2>Incidents (${groups.length} live failures · ${liveIncidents.length} events)</h2>
      ${categoryTabs}
      <p class="muted">${esc(categoryHint)}</p>
      ${
        groups.length
          ? `<table>
        <thead><tr>
          <th>Fix</th><th>Last seen</th><th>Count</th><th>Severity</th><th>Type</th><th>Cause / Why</th><th>Suggested fix</th><th>Resource</th><th>${esc(locationHeader)}</th><th>Cluster</th><th>Evidence</th>
        </tr></thead>
        <tbody>${incidentRows}</tbody>
      </table>`
          : `<p class="empty">${esc(dashboardEmptyMessage(activeCategory))}</p>`
      }
    </section>`,
    );
  }

  @Get('incidents/:id/auto-fix')
  @Redirect()
  async incidentAutoFixLegacy(@Param('id') id: string) {
    const i = await this.incidentsService.getById(id);
    const action = this.incidentsService.suggestionAction(i);
    if (action === 'apply') {
      return { url: `/dashboard/incidents/${id}?ask=1`, statusCode: 302 };
    }
    return { url: `/dashboard/incidents/${id}/suggestion`, statusCode: 302 };
  }

  @Get('incidents/:id/suggestion')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async incidentSuggestion(@Param('id') id: string) {
    const i = await this.incidentsService.getById(id);
    if ((i.severity || '').toLowerCase() === 'info') {
      return layout(
        'Suggestion unavailable',
        `${i.type} · info event — no remediation suggestion`,
        false,
        `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a></p>
      <h2>No suggestion</h2>
      <p class="muted">Info events (e.g. rollouts) are audit-only and do not include a suggested fix.</p>
    </section>`,
      );
    }
    const fix = this.incidentsService.displaySuggestedFix(
      i.suggestedFix,
      i.severity,
    );
    const action = this.incidentsService.suggestionAction(i);

    if (!action) {
      return layout(
        'Suggestion unavailable',
        `${i.type} · ${i.namespace || '—'}/${i.resource || '—'}`,
        false,
        `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a></p>
      <h2>No suggestion yet</h2>
      <p class="muted">A suggestion appears here once enrichment finishes.</p>
      <p class="fix">${esc(fix)}</p>
    </section>`,
      );
    }

    if (action === 'apply') {
      return layout(
        'View suggestion',
        `${i.type} · advice view — use Ask Pulse to confirm and apply`,
        false,
        `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a></p>
      <h2>Suggested fix</h2>
      <p class="fix">${esc(fix)}</p>
      <p>${askAgentButton(i.id)}</p>
      <p class="muted">Chat through options, then confirm — the in-cluster agent applies the allowlisted fix.</p>
    </section>`,
      );
    }

    const commands = this.incidentsService.autoFixCommands(i);
    const { dryRun } = splitCommands(commands);
    const dryBlocks = renderCmdBlocks(dryRun, { copy: true });

    return layout(
      'View suggestion',
      `${i.type} · ${i.namespace || '—'}/${i.resource || '—'} · advice only (no cluster apply)`,
      false,
      `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a></p>
      <h2>Suggested fix</h2>
      <p class="fix">${esc(fix)}</p>
      <p class="muted">This looks like advisory guidance (root-cause investigation), not a safe one-click remediating change. OpsPilot will not offer Apply suggested fix for this incident.</p>
    </section>
    <section>
      <h2>Optional inspect commands (dry-run)</h2>
      ${dryBlocks || '<p class="empty">No inspect commands.</p>'}
    </section>
    ${copyScript()}`,
    );
  }

  @Get('incidents/:id/apply-status')
  async incidentApplyStatus(@Param('id') id: string) {
    const history = await this.incidentsService.listFixCommandsForIncident(id);
    return {
      incidentId: id,
      commands: history.map((h) => ({
        id: h.id,
        type: h.type,
        status: h.status,
        result: h.result,
        error: h.error,
        createdAt: h.createdAt,
        completedAt: h.completedAt,
      })),
      pending: history.some(
        (h) => h.status === 'pending' || h.status === 'claimed',
      ),
    };
  }

  @Get('incidents/:id/ask-agent')
  @Redirect()
  async incidentAskAgent(
    @Param('id') id: string,
    @Query('queued') queued?: string,
    @Query('error') error?: string,
  ) {
    const q = new URLSearchParams({ ask: '1' });
    if (queued) q.set('queued', queued);
    if (error) q.set('error', error);
    return {
      url: `/dashboard/incidents/${id}?${q.toString()}`,
      statusCode: 302,
    };
  }

  @Get('incidents/:id/ask-agent/session')
  async incidentAskAgentSession(@Param('id') id: string) {
    const i = await this.incidentsService.getById(id);
    const target = resolveDeploymentTarget(i);
    const docker = isDockerContainerIncident(i);
    if (!target.deployment && !docker) {
      return {
        ok: false,
        error: 'Pulse needs a Deployment or Docker container target for this incident.',
      };
    }
    let prefill = resolveApplyPrefill(i);
    if (target.deployment) {
      const live = await this.clusterPrefill.sniffDeploymentContainer(
        target.namespace,
        target.deployment,
        prefill.container || undefined,
      );
      if (live) {
        prefill = mergeClusterPrefill(prefill, live);
      }
    }
    const session = buildAskAgentSession(i, prefill);
    const history = await this.incidentsService.listFixCommandsForIncident(id);
    const subtitle = docker
      ? `${session.type} · docker ${session.namespace}/${session.deployment}`
      : `${session.type} · ${target.namespace}/${target.deployment || '—'}`;
    return {
      ok: true,
      incidentId: id,
      type: session.type,
      namespace: session.namespace,
      deployment: session.deployment,
      platform: session.platform || 'kubernetes',
      problem: session.problem,
      opener: session.opener,
      options: session.options,
      subtitle,
      poll: history.some(
        (h) => h.status === 'pending' || h.status === 'claimed',
      ),
    };
  }

  @Post('incidents/:id/ask-agent/chat')
  async incidentAskAgentChat(
    @Param('id') id: string,
    @Body()
    body: {
      message?: string;
      history?: Array<{ role?: string; content?: string }>;
    },
  ) {
    const prepared = await this.prepareAskChat(id, body);
    if ('error' in prepared) return prepared;
    const result = await this.aiSuggestions.chatAboutIncident(
      prepared.session,
      prepared.history,
      prepared.message,
    );
    return { ok: true, ...result };
  }

  /** SSE stream of Cursor thinking / MCP tools / final reply. */
  @Post('incidents/:id/ask-agent/chat-stream')
  async incidentAskAgentChatStream(
    @Param('id') id: string,
    @Body()
    body: {
      message?: string;
      history?: Array<{ role?: string; content?: string }>;
    },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let prepared: Awaited<ReturnType<DashboardController['prepareAskChat']>>;
    try {
      prepared = await this.prepareAskChat(id, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      write({ type: 'error', message: msg.slice(0, 300) });
      res.end();
      return;
    }
    if ('error' in prepared) {
      write({ type: 'error', message: prepared.error });
      res.end();
      return;
    }

    try {
      for await (const ev of this.aiSuggestions.streamChatAboutIncident(
        prepared.session,
        prepared.history,
        prepared.message,
      )) {
        write(ev);
        const flushable = res as unknown as { flush?: () => void };
        flushable.flush?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      write({ type: 'error', message: msg.slice(0, 300) });
    }
    res.end();
  }

  private async prepareAskChat(
    id: string,
    body: {
      message?: string;
      history?: Array<{ role?: string; content?: string }>;
    },
  ) {
    const i = await this.incidentsService.getById(id);
    let prefill = resolveApplyPrefill(i);
    const target = resolveDeploymentTarget(i);
    if (target.deployment) {
      const live = await this.clusterPrefill.sniffDeploymentContainer(
        target.namespace,
        target.deployment,
        prefill.container || undefined,
      );
      if (live) {
        prefill = mergeClusterPrefill(prefill, live);
      }
    }
    const session = buildAskAgentSession(i, prefill);
    session.incidentId = id;
    session.agentId = i.agent?.id;
    const message = (body.message || '').trim();
    if (!message) {
      return { ok: false as const, error: 'Message is required' };
    }
    const history = (body.history || [])
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim(),
      )
      .slice(-12)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: String(m.content).slice(0, 2000),
      }));
    return { session, history, message };
  }

  @Post('incidents/:id/ask-agent/apply')
  async incidentAskAgentApply(
    @Param('id') id: string,
    @Body()
    body: {
      optionId?: string;
      userInput?: string;
      option?: {
        action?: string;
        label?: string;
        detail?: string;
        image?: string;
        memoryLimit?: string;
        replicas?: string;
        needsInput?: boolean | string;
        params?: Record<string, string>;
      };
    },
  ) {
    const i = await this.incidentsService.getById(id);
    const target = resolveDeploymentTarget(i);
    const docker = isDockerContainerIncident(i);
    if (!target.deployment && !docker) {
      return { ok: false, error: 'Incident is not eligible for apply' };
    }
    let prefill = resolveApplyPrefill(i);
    if (target.deployment) {
      const live = await this.clusterPrefill.sniffDeploymentContainer(
        target.namespace,
        target.deployment,
        prefill.container || undefined,
      );
      if (live) {
        prefill = mergeClusterPrefill(prefill, live);
      }
    }
    try {
      const opt = parseAskOptionPayload(
        {
          option: body.option as Record<string, unknown> | undefined,
          optionId: body.optionId,
        },
        [],
        prefill,
      );
      const params = resolveAskOptionParams(opt, body.userInput);
      const cmd = await this.incidentsService.enqueueAgentFix(id, {
        acknowledge: params.acknowledge,
        container: params.container,
        memoryLimit: params.memoryLimit,
        memoryRequest: params.memoryRequest,
        image: params.image,
        deployAction: params.deployAction,
        replicas: params.replicas,
      });
      return {
        ok: true,
        commandId: cmd.id,
        type: cmd.type,
        status: cmd.status,
        summary: opt.detail || opt.label || 'Fix queued',
      };
    } catch (err: any) {
      const msg = Array.isArray(err?.response?.message)
        ? err.response.message.join(', ')
        : err?.response?.message || err?.message || 'Failed to queue fix';
      return { ok: false, error: String(msg) };
    }
  }

  @Get('incidents/:id/apply-fix')
  @Redirect()
  async incidentApplyFixRedirect(
    @Param('id') id: string,
    @Query('queued') queued?: string,
    @Query('error') error?: string,
    @Query('advanced') advanced?: string,
  ) {
    if (advanced === '1') {
      return {
        url: `/dashboard/incidents/${id}/apply-fix/advanced`,
        statusCode: 302,
      };
    }
    const q = new URLSearchParams();
    if (queued) q.set('queued', queued);
    if (error) q.set('error', error);
    const qs = q.toString();
    return {
      url: `/dashboard/incidents/${id}${qs ? `?ask=1&${qs}` : '?ask=1'}`,
      statusCode: 302,
    };
  }

  @Get('incidents/:id/apply-fix/advanced')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async incidentApplyFixAdvanced(
    @Param('id') id: string,
    @Query('queued') queued?: string,
    @Query('error') error?: string,
  ) {
    const i = await this.incidentsService.getById(id);
    const fix = this.incidentsService.displaySuggestedFix(
      i.suggestedFix,
      i.severity,
    );
    const action = this.incidentsService.suggestionAction(i);
    const history = await this.incidentsService.listFixCommandsForIncident(id);
    const target = resolveDeploymentTarget(i);

    if (action !== 'apply') {
      return layout(
        'Apply suggested fix unavailable',
        `${i.type} · ${i.namespace || '—'}/${i.resource || '—'}`,
        false,
        `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a>
        ${action === 'view' ? ` · <a href="/dashboard/incidents/${esc(i.id)}/suggestion">View suggestion</a>` : ''}
        · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a></p>
      <h2>Not applicable</h2>
      <p class="muted">Apply suggested fix is only for remediable types (OOMKilled, ImagePullBackOff, DeploymentUnhealthy). Advice-only incidents use View suggestion.</p>
      <p class="fix">${esc(fix)}</p>
    </section>`,
      );
    }

    const commands = this.incidentsService.autoFixCommands(i);
    const { dryRun } = splitCommands(commands);
    const dryBlocks = renderCmdBlocks(dryRun, { copy: true });

    let prefill = resolveApplyPrefill(i);
    if (target.deployment) {
      const live = await this.clusterPrefill.sniffDeploymentContainer(
        target.namespace,
        target.deployment,
        prefill.container || undefined,
      );
      if (live) {
        prefill = mergeClusterPrefill(prefill, live);
      }
    }

    const defaultContainer = prefill.container;
    const suggestedLimit = prefill.suggestedMemoryLimit || '512Mi';
    const memoryOptions = MEMORY_PRESETS.map((m) => {
      const selected = m === suggestedLimit ? 'selected' : '';
      return `<option value="${m}" ${selected}>${m}</option>`;
    }).join('');
    const useCustomMemory = !MEMORY_PRESETS.includes(
      suggestedLimit as (typeof MEMORY_PRESETS)[number],
    );

    const sourceNote =
      prefill.source === 'cluster'
        ? 'Prefill from live Kubernetes deployment'
        : prefill.source === 'snapshot'
          ? 'Prefill from agent evidence snapshot'
          : prefill.source === 'metadata'
            ? 'Prefill from incident metadata'
            : 'No prefill available — enter values manually';

    const paramFields =
      i.type === 'OOMKilled'
        ? `
      <p class="muted">${esc(sourceNote)}</p>
      <label>Container name
        <input name="container" required value="${esc(defaultContainer)}" />
      </label>
      <p class="muted">Current memory limit: <code>${esc(prefill.memoryLimit || '—')}</code> · request: <code>${esc(prefill.memoryRequest || '—')}</code></p>
      <label>New memory limit
        <select name="memoryLimit" required>
          ${memoryOptions}
          <option value="custom" ${useCustomMemory ? 'selected' : ''}>Custom…</option>
        </select>
      </label>
      <label>Custom memory (if Custom selected)
        <input name="memoryCustom" placeholder="e.g. 768Mi" value="${useCustomMemory ? esc(suggestedLimit) : ''}" />
      </label>
      <label>Memory request (optional, defaults to limit)
        <input name="memoryRequest" placeholder="e.g. 256Mi" value="${esc(prefill.memoryRequest)}" />
      </label>`
        : i.type === 'DeploymentUnhealthy'
          ? `
      <p class="muted">${esc(sourceNote)}</p>
      <p class="muted">Current desired replicas: <code>${esc(prefill.desiredReplicas || '—')}</code></p>
      <label>Action
        <select name="deployAction" id="deployAction" required>
          <option value="restart" selected>Restart deployment (rollout restart)</option>
          <option value="scale">Scale replicas</option>
        </select>
      </label>
      <label id="replicasField">Desired replicas
        <input name="replicas" type="number" min="0" max="50" step="1" value="${esc(prefill.desiredReplicas || '1')}" />
      </label>
      <p class="muted">Restart recreates pods. Scale changes replica count (0–50). Confirm is required before the agent mutates the cluster.</p>`
          : `
      <p class="muted">${esc(sourceNote)}</p>
      <label>Container name
        <input name="container" required value="${esc(defaultContainer)}" />
      </label>
      <p class="muted">Current image: <code>${esc(prefill.currentImage || '—')}</code></p>
      <label>New image
        <input name="image" required placeholder="registry/app:tag" value="" />
      </label>`;

    const historyRows = history.length
      ? `<table id="apply-status-table"><thead><tr><th>When</th><th>Type</th><th>Status</th><th>Result / Error</th></tr></thead><tbody id="apply-status-body">${history
          .map(
            (h) => `<tr data-cmd-id="${esc(h.id)}">
        <td>${esc(new Date(h.createdAt).toISOString())}</td>
        <td><code>${esc(h.type)}</code></td>
        <td data-f="status"><span class="badge ${fixStatusClass(h.status)}">${esc(h.status)}</span></td>
        <td class="msg" data-f="result">${esc(h.error || h.result || '—')}</td>
      </tr>`,
          )
          .join('')}</tbody></table>`
      : `<p class="empty" id="apply-status-empty">No apply attempts yet.</p>`;

    const banner = error
      ? `<p class="crit-note">${esc(error)}</p>`
      : queued === '1'
        ? `<p class="ok-note" id="apply-queue-banner">Queued for the in-cluster agent. Status polls every 3s (agent heartbeat ~10s).</p>`
        : history.some((h) => h.status === 'pending' || h.status === 'claimed')
          ? `<p class="ok-note" id="apply-queue-banner">Waiting for agent… status updates live below.</p>`
          : '';

    const shouldPoll =
      queued === '1' ||
      history.some((h) => h.status === 'pending' || h.status === 'claimed');

    const pollScript = shouldPoll
      ? applyStatusPollScript(id)
      : '';

    return layout(
      'Apply suggested fix',
      `${i.type} · ${target.namespace}/${target.deployment || '—'} · choose options → confirm → agent applies`,
      false,
      `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a> · ${askAgentButton(i.id)} · <a href="/dashboard/incidents/${esc(i.id)}/suggestion">View suggestion</a></p>
      ${banner}
      <h2>1. Suggested fix</h2>
      <p class="fix">${esc(fix)}</p>
      <p class="muted">Target: <code>${esc(target.namespace)}/${esc(target.deployment || '?')}</code> · Agent will patch the Deployment after you confirm (not silent).</p>
    </section>
    <section>
      <h2>2. Dry-run / preview (inspect)</h2>
      <p class="muted">Optional read-only checks before you apply.</p>
      ${dryBlocks || '<p class="empty">No dry-run commands.</p>'}
    </section>
    <section>
      <h2>3. Choose fix options &amp; confirm</h2>
      <form method="post" action="/dashboard/incidents/${esc(i.id)}/apply-fix" class="confirm-form apply-form">
        ${paramFields}
        <label class="confirm-label">
          <input type="checkbox" name="acknowledge" value="1" required />
          I reviewed the options. Apply this change in-cluster via Pulse on the next heartbeat.
        </label>
        <button type="submit" class="btn primary">Confirm &amp; apply via agent</button>
      </form>
    </section>
    <section id="apply-status">
      <h2>4. Apply status <span class="muted" id="apply-poll-hint">${shouldPoll ? '(live)' : ''}</span></h2>
      ${historyRows}
    </section>
    ${copyScript()}
    <script>
      (function () {
        const sel = document.querySelector('select[name="memoryLimit"]');
        const custom = document.querySelector('input[name="memoryCustom"]');
        if (sel && custom) {
          const sync = () => { custom.disabled = sel.value !== 'custom'; };
          sel.addEventListener('change', sync);
          sync();
        }
        const actionSel = document.getElementById('deployAction');
        const replicasField = document.getElementById('replicasField');
        if (actionSel && replicasField) {
          const syncAction = () => {
            replicasField.style.display = actionSel.value === 'scale' ? '' : 'none';
          };
          actionSel.addEventListener('change', syncAction);
          syncAction();
        }
        const params = new URLSearchParams(location.search);
        if (params.get('queued') === '1' || location.hash === '#apply-status') {
          const el = document.getElementById('apply-status');
          if (el) {
            requestAnimationFrame(() => {
              el.scrollIntoView({ behavior: 'smooth', block: 'end' });
            });
          }
        }
      })();
    </script>`,
      pollScript,
    );
  }

  @Post('incidents/:id/apply-fix')
  @Redirect()
  async confirmApplyFix(
    @Param('id') id: string,
    @Body()
    body: {
      acknowledge?: string;
      container?: string;
      memoryLimit?: string;
      memoryCustom?: string;
      memoryRequest?: string;
      image?: string;
      deployAction?: string;
      replicas?: string;
    },
  ) {
    try {
      const memoryLimit =
        body.memoryLimit === 'custom'
          ? body.memoryCustom
          : body.memoryLimit;
      await this.incidentsService.enqueueAgentFix(id, {
        acknowledge: body.acknowledge,
        container: body.container,
        memoryLimit,
        memoryRequest: body.memoryRequest,
        image: body.image,
        deployAction: body.deployAction,
        replicas: body.replicas,
      });
      return {
        url: `/dashboard/incidents/${id}?ask=1&queued=1`,
        statusCode: 303,
      };
    } catch (err: any) {
      const msg = Array.isArray(err?.response?.message)
        ? err.response.message.join(', ')
        : err?.response?.message || err?.message || 'Failed to queue fix command';
      return {
        url: `/dashboard/incidents/${id}?ask=1&error=${encodeURIComponent(String(msg))}`,
        statusCode: 303,
      };
    }
  }

  @Get('incidents/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async incidentDetail(@Param('id') id: string) {
    const i = await this.incidentsService.getById(id);
    const snap =
      i.snapshot && typeof i.snapshot === 'object'
        ? (i.snapshot as Record<string, unknown>)
        : this.incidentsService.composeSnapshotFromMetadata({
            type: i.type,
            reason: i.reason,
            namespace: i.namespace,
            resource: i.resource,
            occurredAt: i.occurredAt,
            metadata: i.metadata,
          });
    const evidence = Array.isArray(snap.evidence)
      ? (snap.evidence as unknown[]).map((e) => `<li><code>${esc(e)}</code></li>`).join('')
      : '';
    const logsObj =
      snap.logs && typeof snap.logs === 'object'
        ? (snap.logs as Record<string, unknown>)
        : {};
    const logSnippet = logsObj.snippet != null ? String(logsObj.snippet) : '';
    const fix = this.incidentsService.displaySuggestedFix(
      i.suggestedFix,
      i.severity,
    );
    const json = esc(JSON.stringify(snap, null, 2));
    const target = resolveDeploymentTarget(i);
    let actionLink = '';
    if ((i.severity || '').toLowerCase() !== 'info') {
      if (target.deployment || isDockerContainerIncident(i)) {
        actionLink = ` · ${askAgentButton(i.id)}`;
      } else if (this.incidentsService.suggestionAction(i) === 'view') {
        actionLink = ` · <a class="btn" href="/dashboard/incidents/${esc(i.id)}/suggestion">View suggestion</a>`;
      }
    }

    return layout(
      `Incident ${i.id.slice(0, 8)}…`,
      `${i.type} · ${i.namespace || '—'}/${i.resource || '—'}`,
      false,
      `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/v1/incidents/${esc(i.id)}">JSON API</a>${actionLink}</p>
      <h2>Summary</h2>
      <table>
        <tr><th>Occurred</th><td>${esc(new Date(i.occurredAt).toISOString())}</td></tr>
        <tr><th>Severity</th><td><span class="badge ${severityClass(i.severity)}">${esc(i.severity)}</span></td></tr>
        <tr><th>Type / Status</th><td>${esc(formatStatus(i.metadata, i.type))}</td></tr>
        <tr><th>Cause / Why</th><td class="cause"><code>${esc(formatCause(i.metadata, i.reason))}</code></td></tr>
        <tr><th>Suggested fix</th><td class="fix">${fix ? esc(fix) : '<span class="muted">—</span>'}</td></tr>
        <tr><th>Message</th><td class="msg">${esc(i.message)}</td></tr>
        <tr><th>Cluster</th><td>${esc(i.agent.clusterName)}</td></tr>
      </table>
    </section>
    <section>
      <h2>Evidence snapshot</h2>
      <p class="muted">Frozen, redacted pack captured at detection (or composed from metadata for older events).</p>
      ${evidence ? `<ul>${evidence}</ul>` : `<p class="empty">No evidence lines.</p>`}
      ${
        logSnippet
          ? `<h3>Logs</h3><pre class="logs">${esc(logSnippet)}</pre>`
          : ''
      }
      <h3>Snapshot JSON</h3>
      <pre>${json}</pre>
    </section>`,
    );
  }

  @Post('agents/:id/revoke')
  @Redirect('/dashboard', 303)
  async revokeAgent(@Param('id') id: string) {
    await this.agentsService.revoke(id);
  }

  @Get('agents/:id/live')
  async agentLive(@Param('id') id: string) {
    const agent = await this.agentsService.getAgent(id);
    const pods = Array.isArray(agent.podInventory) ? agent.podInventory : [];
    const containers = Array.isArray(agent.containerInventory)
      ? agent.containerInventory
      : [];
    return {
      id: agent.id,
      status: agent.status,
      agentType: agentMode(agent),
      lastHeartbeatAt: agent.lastHeartbeatAt,
      podInventoryAt: agent.podInventoryAt,
      containerInventoryAt: agent.containerInventoryAt,
      pods,
      containers,
    };
  }

  @Get('agents/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async agentDetail(@Param('id') id: string) {
    const agent = await this.agentsService.getAgent(id);
    const isDocker = agentMode(agent) === 'docker-host';
    const pods = !isDocker && Array.isArray(agent.podInventory)
      ? (agent.podInventory as Array<{
          namespace?: string;
          name?: string;
          status?: string;
          ready?: string;
          restarts?: number;
          age?: string;
          cpu?: string;
          memory?: string;
        }>)
      : [];
    const containers = isDocker && Array.isArray(agent.containerInventory)
      ? (agent.containerInventory as Array<{
          name?: string;
          status?: string;
          health?: string;
          restarts?: number;
          age?: string;
          image?: string;
          service?: string;
        }>)
      : [];

    const statusClass =
      agent.status === 'online' ? 'ok' : agent.status === 'revoked' ? 'crit' : 'off';

    const inventoryAt = isDocker
      ? agent.containerInventoryAt
      : agent.podInventoryAt;

    const podRows = pods
      .map((p) => {
        const ns = p.namespace || '';
        const name = p.name || '';
        const href =
          ns && name
            ? `/dashboard/agents/${esc(agent.id)}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`
            : '';
        const nameCell = href
          ? `<a href="${href}"><code>${esc(name)}</code></a>`
          : `<code>${esc(name || '—')}</code>`;
        const rowKey = `${ns}/${name}`;
        return `
      <tr data-pod-key="${esc(rowKey)}">
        <td>${esc(ns || '—')}</td>
        <td>${nameCell}</td>
        <td data-f="status"><span class="badge ${podStatusClass(p.status)}">${esc(p.status || '—')}</span></td>
        <td data-f="ready">${esc(p.ready || '—')}</td>
        <td data-f="restarts">${esc(p.restarts ?? 0)}</td>
        <td data-f="cpu">${esc(p.cpu || '—')}</td>
        <td data-f="memory">${esc(p.memory || '—')}</td>
        <td data-f="age">${esc(p.age || '—')}</td>
      </tr>`;
      })
      .join('');

    const containerRows = containers
      .map((c) => {
        const name = c.name || '';
        return `
      <tr data-container-key="${esc(name)}">
        <td><code>${esc(name || '—')}</code></td>
        <td data-f="service">${esc(c.service || '—')}</td>
        <td data-f="status"><span class="badge ${podStatusClass(c.status)}">${esc(c.status || '—')}</span></td>
        <td data-f="health">${esc(c.health || '—')}</td>
        <td data-f="restarts">${esc(c.restarts ?? 0)}</td>
        <td data-f="image"><code>${esc(c.image || '—')}</code></td>
        <td data-f="age">${esc(c.age || '—')}</td>
      </tr>`;
      })
      .join('');

    const liveScript = liveMonitorScript({
      mode: isDocker ? 'agent-containers' : 'agent',
      agentId: agent.id,
      pollMs: 3000,
    });

    const inventorySection = isDocker
      ? `
    <section>
      <h2>Monitored containers (<span id="live-container-count">${containers.length}</span>)</h2>
      <p class="muted">Docker containers matched by the agent watch filter on this host.</p>
      ${
        containers.length
          ? `<table id="live-container-table">
        <thead><tr><th>Name</th><th>Service</th><th>Status</th><th>Health</th><th>Restarts</th><th>Image</th><th>Age</th></tr></thead>
        <tbody>${containerRows}</tbody>
      </table>`
          : `<p class="empty" id="live-container-empty">No container inventory yet. Wait for the next agent heartbeat.</p>`
      }
    </section>`
      : `
    <section>
      <h2>Monitored pods (<span id="live-pod-count">${pods.length}</span>)</h2>
      <p class="muted">Click a pod for detail + history. CPU/memory require metrics-server in the cluster.</p>
      ${
        pods.length
          ? `<table id="live-pod-table">
        <thead><tr><th>Namespace</th><th>Name</th><th>Status</th><th>Ready</th><th>Restarts</th><th>CPU</th><th>Memory</th><th>Age</th></tr></thead>
        <tbody>${podRows}</tbody>
      </table>`
          : `<p class="empty" id="live-pod-empty">No pod inventory yet. Wait for the next agent heartbeat after upgrading the agent.</p>`
      }
    </section>`;

    return layout(
      `Agent ${agent.hostname}`,
      `${agent.clusterName} · ${agent.environment} · ${isDocker ? 'docker-host monitor' : 'live pod monitor'}`,
      false,
      `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/agents/${esc(agent.id)}/live">Live JSON</a></p>
      <h2>Agent</h2>
      <table>
        <tr><th>ID</th><td><code>${esc(agent.id)}</code></td></tr>
        <tr><th>Host</th><td>${esc(agent.hostname)}</td></tr>
        <tr><th>Cluster</th><td>${esc(agent.clusterName)}</td></tr>
        <tr><th>Env</th><td>${esc(agent.environment)}</td></tr>
        <tr><th>Mode</th><td>${esc(isDocker ? 'docker-host' : 'kubernetes')}</td></tr>
        <tr><th>Status</th><td><span id="live-agent-status" class="badge ${statusClass}">${esc(agent.status)}</span></td></tr>
        <tr><th>Version</th><td>${esc(agent.version)}</td></tr>
        <tr><th>Last heartbeat</th><td id="live-heartbeat">${agent.lastHeartbeatAt ? esc(new Date(agent.lastHeartbeatAt).toISOString()) : '—'}</td></tr>
        <tr><th>Inventory updated</th><td id="live-inventory-at">${inventoryAt ? esc(new Date(inventoryAt).toISOString()) : '— (waiting for agent heartbeat)'}</td></tr>
      </table>
      <p class="muted" id="live-poll-hint">Live refresh every 3s from agent heartbeats (~10s).</p>
    </section>
    ${inventorySection}`,
      liveScript,
    );
  }

  @Get('agents/:id/pods/:namespace/:name')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async agentPodDetail(
    @Param('id') id: string,
    @Param('namespace') namespaceParam: string,
    @Param('name') nameParam: string,
  ) {
    const namespace = decodeURIComponent(namespaceParam);
    const name = decodeURIComponent(nameParam);
    const agent = await this.agentsService.getAgent(id);
    const pods = Array.isArray(agent.podInventory)
      ? (agent.podInventory as Array<{
          namespace?: string;
          name?: string;
          status?: string;
          ready?: string;
          restarts?: number;
          age?: string;
          cpu?: string;
          memory?: string;
        }>)
      : [];
    const inventory = pods.find((p) => p.namespace === namespace && p.name === name);
    const deploy = inferDeploymentFromPodName(name);
    const history = await this.incidentsService.listForPod(id, namespace, name, 100);

    const historyRows = history
      .map((ev) => {
        const hasSnap = ev.snapshot != null;
        const cause = formatCause(ev.metadata, ev.reason);
        const fix = this.incidentsService.displaySuggestedFix(
          ev.suggestedFix,
          ev.severity,
        );
        return `
      <tr>
        <td>${esc(new Date(ev.occurredAt).toISOString())}</td>
        <td><span class="badge ${severityClass(ev.severity)}">${esc(ev.severity)}</span></td>
        <td>${esc(ev.type)}</td>
        <td class="cause"><code>${esc(cause)}</code></td>
        <td><code>${esc(ev.resource || '—')}</code></td>
        <td class="fix">${fix ? esc(fix) : '<span class="muted">—</span>'}</td>
        <td><a href="/dashboard/incidents/${esc(ev.id)}">${hasSnap ? 'Snapshot' : 'Detail'}</a></td>
      </tr>`;
      })
      .join('');

    const statusClass = inventory
      ? podStatusClass(inventory.status)
      : 'off';

    const liveScript = liveMonitorScript({
      mode: 'pod',
      agentId: agent.id,
      namespace,
      name,
      pollMs: 3000,
    });

    return layout(
      `Pod ${name}`,
      `${agent.clusterName} · ${namespace} · live status + history`,
      false,
      `
    <section>
      <p><a href="/dashboard">← Dashboard</a> · <a href="/dashboard/agents/${esc(agent.id)}">← Agent ${esc(agent.hostname)}</a> · <a href="/dashboard/agents/${esc(agent.id)}/live">Live JSON</a></p>
      <h2>Live status <span class="muted" id="live-poll-hint">(refresh 3s)</span></h2>
      <table>
        <tr><th>Namespace</th><td>${esc(namespace)}</td></tr>
        <tr><th>Name</th><td><code>${esc(name)}</code></td></tr>
        <tr><th>Status</th><td id="live-status">${
          inventory
            ? `<span class="badge ${statusClass}">${esc(inventory.status || '—')}</span>`
            : `<span class="badge off">not in latest inventory</span>`
        }</td></tr>
        <tr><th>Ready</th><td id="live-ready">${inventory ? esc(inventory.ready || '—') : '—'}</td></tr>
        <tr><th>Restarts</th><td id="live-restarts">${inventory ? esc(inventory.restarts ?? 0) : '—'}</td></tr>
        <tr><th>CPU</th><td id="live-cpu">${inventory ? esc(inventory.cpu || '—') : '—'}</td></tr>
        <tr><th>Memory</th><td id="live-memory">${inventory ? esc(inventory.memory || '—') : '—'}</td></tr>
        <tr><th>Age</th><td id="live-age">${inventory ? esc(inventory.age || '—') : '—'}</td></tr>
        <tr><th>Owner (inferred)</th><td>${
          deploy ? `<code>deployment/${esc(deploy)}</code>` : '—'
        }</td></tr>
        <tr><th>Inventory updated</th><td id="live-inventory-at">${
          agent.podInventoryAt
            ? esc(new Date(agent.podInventoryAt).toISOString())
            : '—'
        }</td></tr>
      </table>
    </section>
    <section>
      <h2>Event history (${history.length})</h2>
      <p class="muted">Incidents for this pod plus related deployment events (e.g. rollouts). Newest first.</p>
      ${
        history.length
          ? `<table>
        <thead><tr>
          <th>When</th><th>Severity</th><th>Type</th><th>Cause / Why</th><th>Resource</th><th>Suggestion</th><th>Evidence</th>
        </tr></thead>
        <tbody>${historyRows}</tbody>
      </table>`
          : `<p class="empty">No stored events for this pod yet.</p>`
      }
    </section>`,
      liveScript,
    );
  }

  @Get('security')
  @Header('Content-Type', 'text/html; charset=utf-8')
  securityPage() {
    return layout(
      'OpsPilot Security',
      'One-pager for security reviews and customer trust',
      false,
      `
    <section class="prose">
      <h2>Security one-pager</h2>
      <p>OpsPilot Agent runs inside the customer Kubernetes cluster as a <strong>read-only</strong> collector. It never mutates cluster state and never opens inbound ports.</p>

      <h3>What the agent can do</h3>
      <ul>
        <li>Watch pods, deployments, ReplicaSets, events (get/list/watch)</li>
        <li>Read a short slice of container logs for crash context</li>
        <li>Send structured incidents over HTTPS to the OpsPilot SaaS</li>
        <li>Redact secrets before upload (built-in + customer patterns)</li>
      </ul>

      <h3>What the agent cannot do</h3>
      <ul>
        <li>Execute shell commands or kubectl mutate operations</li>
        <li>Create, update, or delete Kubernetes resources</li>
        <li>Restart deployments automatically</li>
        <li>Read Kubernetes Secrets or dump full environment variables</li>
        <li>Ship unfiltered full log streams</li>
        <li>Accept inbound network connections</li>
      </ul>

      <h3>Data leaving the cluster</h3>
      <ul>
        <li>Structured events only (type, reason, exit code, short redacted log snippet)</li>
        <li>Not full pod YAML, not Secrets, not unrestricted env dumps</li>
        <li>TLS to the SaaS API; agent authenticates with a revocable bearer token</li>
      </ul>

      <h3>Customer controls</h3>
      <ul>
        <li><a href="/dashboard">Revoke agent</a> — invalidates the access token immediately; heartbeats and event uploads are rejected</li>
        <li><a href="/dashboard/redaction">Redaction patterns</a> — add custom regexes pushed to agents on the next heartbeat</li>
        <li>Install tokens can be deactivated server-side to block new registrations</li>
      </ul>

      <h3>RBAC (summary)</h3>
      <pre>verbs: get, list, watch
resources: pods, pods/log, events, namespaces, nodes, services,
           deployments, replicasets, statefulsets, daemonsets
no access to: secrets, configmaps (write), any mutating verbs</pre>

      <p class="muted">This page is intended for buyer security reviews. It mirrors the product posture of the MVP agent and SaaS.</p>
    </section>`,
    );
  }

  @Get('redaction')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async redactionPage() {
    const patterns = await this.agentsService.listRedactionPatterns();
    const builtinRows = BUILTIN_REDACTION.map(
      (b) => `
      <tr>
        <td>${esc(b.label)}</td>
        <td><code>${esc(b.example)}</code></td>
        <td><span class="badge ok">built-in</span></td>
      </tr>`,
    ).join('');

    const customRows = patterns
      .map(
        (p) => `
      <tr>
        <td>${esc(p.label || '—')}</td>
        <td><code>${esc(p.pattern)}</code></td>
        <td>
          <span class="badge ${p.enabled ? 'ok' : 'off'}">${p.enabled ? 'enabled' : 'disabled'}</span>
          <form method="post" action="/dashboard/redaction/${esc(p.id)}/toggle" style="display:inline">
            <input type="hidden" name="enabled" value="${p.enabled ? '0' : '1'}" />
            <button type="submit" class="btn">${p.enabled ? 'Disable' : 'Enable'}</button>
          </form>
          <form method="post" action="/dashboard/redaction/${esc(p.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this pattern?');">
            <button type="submit" class="btn danger">Delete</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    return layout(
      'OpsPilot Redaction',
      'Built-in scrubbing plus customer-defined patterns pushed to agents',
      false,
      `
    <section>
      <h2>Built-in redaction</h2>
      <p class="muted">Always applied by the agent before upload.</p>
      <table>
        <thead><tr><th>Rule</th><th>Example</th><th>Source</th></tr></thead>
        <tbody>${builtinRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Customer patterns (${patterns.length})</h2>
      <p class="muted">Regex patterns are delivered to agents on heartbeat / <code>GET /v1/agents/config</code>.</p>
      <form method="post" action="/dashboard/redaction" class="add-form">
        <label>Label <input name="label" placeholder="Employee ID" /></label>
        <label>Regex pattern <input name="pattern" required placeholder="employeeNumber=[A-Z][0-9]+" style="min-width:22rem" /></label>
        <button type="submit" class="btn primary">Add pattern</button>
      </form>
      ${
        patterns.length
          ? `<table>
        <thead><tr><th>Label</th><th>Pattern</th><th>Actions</th></tr></thead>
        <tbody>${customRows}</tbody>
      </table>`
          : `<p class="empty">No customer patterns yet. Add one above (example: <code>customerId=[0-9]+</code>).</p>`
      }
    </section>`,
    );
  }

  @Post('redaction')
  @Redirect('/dashboard/redaction', 303)
  async addRedaction(
    @Body() body: { pattern?: string; label?: string },
  ) {
    await this.agentsService.addRedactionPattern(
      body.pattern || '',
      body.label,
    );
  }

  @Post('redaction/:id/delete')
  @Redirect('/dashboard/redaction', 303)
  async deleteRedaction(@Param('id') id: string) {
    await this.agentsService.deleteRedactionPattern(id);
  }

  @Post('redaction/:id/toggle')
  @Redirect('/dashboard/redaction', 303)
  async toggleRedaction(
    @Param('id') id: string,
    @Body() body: { enabled?: string },
  ) {
    await this.agentsService.setRedactionPatternEnabled(
      id,
      body.enabled === '1' || body.enabled === 'true',
    );
  }

  @Get('license')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async licensePage() {
    const usage = await this.licensing.getLabUsage();
    const maxLabel = usage.unlimited ? '∞' : String(usage.organization.maxClusters);
    const clusterRows = usage.clusters.length
      ? usage.clusters
          .map((c) => `<tr><td><code>${esc(c)}</code></td></tr>`)
          .join('')
      : `<tr><td class="muted">No active clusters yet</td></tr>`;

    const planButtons = usage.catalog
      .map((p) => {
        const current = p.id === usage.organization.plan;
        return `
        <form method="post" action="/dashboard/license/plan" style="display:inline">
          <input type="hidden" name="plan" value="${esc(p.id)}" />
          <button type="submit" class="btn ${current ? 'primary' : ''}" ${current ? 'disabled' : ''}>
            ${esc(p.label)} (${p.maxClusters < 0 ? '∞' : p.maxClusters} clusters)${current ? ' — current' : ''}
          </button>
        </form>`;
      })
      .join(' ');

    return layout(
      'OpsPilot License (lab)',
      'Fake entitlements for testing — no real money / Stripe',
      false,
      `
    <section>
      <h2>Current plan</h2>
      <p>
        Org <strong>${esc(usage.organization.name)}</strong>
        (<code>${esc(usage.organization.slug)}</code>) ·
        plan <span class="badge ok">${esc(usage.plan.label)}</span> ·
        status <code>${esc(usage.organization.status)}</code>
      </p>
      <p class="sub" style="margin:0">
        Clusters used: <strong>${usage.clustersUsed}</strong> / <strong>${esc(maxLabel)}</strong>
        ${usage.canAddCluster ? '' : ' — <span class="badge crit">limit reached</span>'}
      </p>
      <p class="muted">${esc(usage.plan.description)}</p>
    </section>
    <section>
      <h2>Active clusters</h2>
      <table>
        <thead><tr><th>Cluster name</th></tr></thead>
        <tbody>${clusterRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Switch lab plan</h2>
      <p class="muted">Instantly change limits for testing register enforcement. No payment.</p>
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${planButtons}</div>
    </section>
    <section class="prose">
      <h2>How to test</h2>
      <ol>
        <li>Stay on <strong>Free</strong> (1 cluster). Your kind agent <code>opspilot-lab</code> counts as 1.</li>
        <li>Try registering a second cluster name → API returns <code>403 License limit reached</code>.</li>
        <li>Switch to <strong>Team</strong> or <strong>Enterprise</strong>, then register succeeds.</li>
        <li>Re-registering the <em>same</em> cluster name always allowed (agent replace / dedupe).</li>
      </ol>
    </section>`,
    );
  }

  @Post('license/plan')
  @Redirect('/dashboard/license', 303)
  async setLicensePlan(@Body() body: { plan?: string }) {
    await this.licensing.setLabPlan(body.plan || 'free');
  }
}

function layout(
  title: string,
  subtitle: string,
  autoRefresh: boolean | string,
  body: string,
  script = '',
): string {
  const refreshScript = autoRefresh
    ? `<script>
(function(){
  var url = ${JSON.stringify(typeof autoRefresh === 'string' ? autoRefresh : '')};
  setInterval(function(){
    var w = document.getElementById('ask-widget');
    if (w && !w.hidden) return;
    if (url) location.href = url;
    else location.reload();
  }, 15000);
})();
</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --text: #e7ecf3;
      --muted: #8b9bb4;
      --ok: #3dd68c;
      --warn: #f5a524;
      --crit: #f31260;
      --off: #889096;
      --line: #2a3548;
      --accent: #5b9fd4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1e3a5f 0%, transparent 50%),
                  radial-gradient(900px 500px at 100% 0%, #243447 0%, transparent 45%),
                  var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 2rem 2rem 1rem;
      border-bottom: 1px solid var(--line);
    }
    nav { margin-top: 0.85rem; display: flex; gap: 1rem; flex-wrap: wrap; }
    nav a { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    nav a:hover { text-decoration: underline; }
    h1 { margin: 0; font-size: 1.75rem; letter-spacing: -0.02em; }
    .sub { color: var(--muted); margin-top: 0.35rem; font-size: 0.95rem; }
    main { padding: 1.5rem 2rem 3rem; display: grid; gap: 1.5rem; }
    section {
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1.25rem;
      overflow-x: auto;
    }
    h2 { margin: 0 0 1rem; font-size: 1.1rem; }
    .source-tabs {
      display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0 0 0.85rem;
    }
    .source-tabs .tab {
      display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.35rem 0.75rem; border-radius: 999px;
      border: 1px solid var(--line); background: #121820;
      color: var(--muted); text-decoration: none; font-size: 0.85rem;
    }
    .source-tabs .tab:hover { border-color: var(--accent); color: var(--text); }
    .source-tabs .tab.active {
      background: rgba(91, 159, 212, 0.15); border-color: var(--accent); color: #dce9ff;
    }
    .source-tabs .tab-count {
      display: inline-block; min-width: 1.1rem; text-align: center;
      font-size: 0.75rem; font-weight: 700; color: inherit;
    }
    h3 { margin: 1.25rem 0 0.5rem; font-size: 1rem; color: #c5d4ea; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    code { font-size: 0.8rem; color: #9ec1ff; }
    pre {
      background: #0c1017;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 1rem;
      overflow-x: auto;
      font-size: 0.8rem;
      color: #b8c7a6;
    }
    .cause code { color: #f5c97a; font-weight: 600; white-space: nowrap; }
    .msg { max-width: 22rem; color: var(--text); line-height: 1.35; }
    .fix { max-width: 20rem; color: #9fd4c2; line-height: 1.4; font-size: 0.85rem; }
    .logs {
      max-width: 18rem; color: #b8c7a6;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.75rem; line-height: 1.35; white-space: pre-wrap; word-break: break-word;
    }
    .ctx { max-width: 14rem; color: var(--muted); font-size: 0.8rem; line-height: 1.35; white-space: pre-wrap; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
    .ok { background: rgba(61,214,140,.15); color: var(--ok); }
    .off { background: rgba(136,144,150,.15); color: var(--off); }
    .warn { background: rgba(245,165,36,.15); color: var(--warn); }
    .crit { background: rgba(243,18,96,.15); color: var(--crit); }
    .empty, .muted { color: var(--muted); }
    .prose ul { line-height: 1.55; color: var(--text); }
    .prose p { line-height: 1.55; max-width: 52rem; }
    .btn {
      background: #243447; color: var(--text); border: 1px solid var(--line);
      border-radius: 6px; padding: 0.3rem 0.65rem; font-size: 0.8rem; cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .btn.danger { color: #ff8fab; border-color: rgba(243,18,96,.35); }
    .btn.primary { background: #2a4a6a; border-color: var(--accent); color: #dce9ff; text-decoration: none; display: inline-block; }
    a.btn { text-decoration: none; }
    .autofix-col { min-width: 9.5rem; position: sticky; left: 0; background: var(--panel); z-index: 1; }
    .autofix-btn { font-weight: 700; white-space: nowrap; font-size: 0.75rem; }
    .ask-widget {
      position: fixed; right: 1.15rem; bottom: 1.15rem; z-index: 80;
      width: min(420px, calc(100vw - 1.5rem));
      height: min(640px, calc(100vh - 2.4rem));
      display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-end;
      gap: 0.7rem;
    }
    .ask-widget[hidden] { display: none !important; }
    .ask-widget .chatbox {
      width: 100%; height: 100%; min-height: 0; max-width: none; margin: 0;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    .ask-widget.minimized {
      width: auto; height: auto; right: 0; left: 0; bottom: 0.85rem;
      align-items: center; pointer-events: none;
    }
    .ask-widget.minimized .chatbox { display: none; }
    .ask-widget.maximized {
      inset: 0;
      right: 0; left: 0; top: 0; bottom: 0;
      width: 100vw; height: 100vh;
      max-width: none; max-height: none;
      padding: 0; gap: 0; z-index: 120;
      align-items: stretch; justify-content: stretch;
    }
    .ask-widget.maximized .chatbox {
      width: 100%; height: 100%;
      border-radius: 0; border-left: 0; border-right: 0;
      box-shadow: none;
    }
    .ask-dock {
      display: none; pointer-events: auto; position: relative;
      align-items: flex-end; justify-content: center;
      padding: 0.45rem 0.85rem 0.55rem;
      background: linear-gradient(180deg, rgba(36,48,64,.72), rgba(18,24,32,.88));
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 22px;
      box-shadow: 0 12px 32px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.12);
      backdrop-filter: blur(16px);
    }
    .ask-widget.minimized .ask-dock { display: flex; }
    .ask-dock-icon {
      width: 3.4rem; height: 3.4rem; border: 0; cursor: pointer; padding: 0;
      border-radius: 18px;
      background: linear-gradient(145deg, #5b9fd4, #3dd68c);
      color: #0c1017; font-weight: 800; font-size: 0.82rem;
      box-shadow: 0 8px 18px rgba(0,0,0,.35);
      transition: transform .16s ease;
    }
    .ask-dock-icon:hover { transform: scale(1.18) translateY(-6px); }
    .ask-dock-label {
      position: absolute; left: 50%; bottom: calc(100% + 0.4rem); transform: translateX(-50%);
      background: #1a2332; color: var(--text); font-size: 0.72rem; font-weight: 600;
      padding: 0.2rem 0.45rem; border-radius: 6px; border: 1px solid var(--line);
      opacity: 0; pointer-events: none; white-space: nowrap;
    }
    .ask-dock:hover .ask-dock-label { opacity: 1; }
    .chatbox-head-text { min-width: 0; overflow: hidden; }
    .chatbox-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }
    .chatbox-icon {
      width: 1.9rem; height: 1.9rem; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,.16); color: #fff; border: 1px solid rgba(255,255,255,.35);
      font-size: 1.05rem; line-height: 1; font-weight: 700; flex-shrink: 0;
    }
    .chatbox-icon:hover { background: rgba(255,255,255,.28); }
    .chatbox {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      min-width: 0;
      background: #121820;
      border: 1px solid var(--line);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 18px 50px rgba(0,0,0,.45);
    }
    .chatbox-head {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.6rem;
      min-width: 0;
      padding: 0.7rem 0.75rem;
      border-bottom: 1px solid var(--line);
      background: #0f6e6e;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .ask-widget.dragging .chatbox-head { cursor: grabbing; }
    .ask-widget.maximized .chatbox-head { cursor: default; }
    .chatbox-actions, .chatbox-actions * { cursor: pointer; }
    .chatbox-avatar {
      width: 2.35rem; height: 2.35rem; border-radius: 10px;
      display: grid; place-items: center;
      background: linear-gradient(145deg, #5b9fd4, #3dd68c);
      color: #0c1017; font-weight: 800; font-size: 0.78rem; letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .chatbox-title { font-weight: 700; font-size: 0.95rem; color: #f4fffe; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chatbox-sub { color: rgba(244,255,254,.78); font-size: 0.75rem; margin-top: 0.12rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-log {
      padding: 1.15rem 1.1rem 0.5rem;
      overflow-x: hidden;
      overflow-y: auto;
      min-height: 0;
      min-width: 0;
      display: flex; flex-direction: column; gap: 0.85rem;
      background:
        radial-gradient(900px 280px at 10% 0%, rgba(91,159,212,.08), transparent 55%),
        #10161e;
    }
    .chat-row { display: flex; gap: 0.65rem; align-items: flex-end; max-width: 100%; min-width: 0; }
    .chat-row.bot { align-self: stretch; }
    .chat-row.user { align-self: stretch; flex-direction: row-reverse; }
    .chat-row.sys { align-self: center; max-width: 100%; }
    .msg-avatar {
      width: 1.7rem; height: 1.7rem; border-radius: 8px;
      display: grid; place-items: center; font-size: 0.62rem; font-weight: 800;
      flex-shrink: 0;
    }
    .chat-row.bot .msg-avatar { background: #243447; color: #9ec1ff; }
    .chat-row.user .msg-avatar { background: #2a4a6a; color: #dce9ff; }
    .chat-bubble {
      padding: 0.75rem 0.9rem; border-radius: 14px; line-height: 1.5; font-size: 0.92rem;
      flex: 0 1 auto; min-width: 0; max-width: calc(100% - 2.4rem);
      overflow-wrap: anywhere; word-break: break-word;
    }
    .chat-bubble code { white-space: pre-wrap; word-break: break-word; }
    .chat-row.bot .chat-bubble {
      background: #1c2736; color: var(--text);
      border-top-left-radius: 5px;
    }
    .chat-row.user .chat-bubble {
      background: #2d5f8a; color: #f2f7ff;
      border-top-right-radius: 5px;
    }
    .chat-row.sys .chat-bubble {
      background: transparent; color: var(--muted); font-size: 0.8rem;
      padding: 0.2rem 0; text-align: center;
    }
    .chat-row.sys.chat-blink .chat-bubble {
      animation: ask-blink 1.1s ease-in-out infinite;
    }
    @keyframes ask-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.22; }
    }
    .ask-via {
      margin-top: 0.55rem; font-size: 0.72rem; color: var(--muted); letter-spacing: 0.02em;
    }
    .ask-caret {
      display: inline-block; width: 0.45em; margin-left: 1px;
      border-right: 2px solid #9ec1ff; animation: ask-caret-blink 0.8s step-end infinite;
      vertical-align: -0.05em;
    }
    @keyframes ask-caret-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .ask-think {
      align-self: stretch;
      margin: 0.15rem 0 0.35rem 2.35rem;
      padding: 0.85rem 0.9rem;
      border-left: 2px solid #3a4d66;
      background: rgba(20, 28, 40, 0.65);
      border-radius: 0 8px 8px 0;
      min-height: 7.5rem;
      max-height: 16rem;
      overflow: auto;
      font-size: 0.82rem;
      color: #8fa3bc;
      line-height: 1.5;
    }
    .ask-think-tools { display: grid; gap: 0.35rem; margin-bottom: 0.55rem; }
    .ask-think-tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; color: #9ec1ff; }
    .ask-think-tool.done { color: #7d93ab; }
    .ask-think-tool.err { color: #e8a0a0; }
    .ask-think-body { white-space: pre-wrap; word-break: break-word; opacity: 0.92; min-height: 3.5rem; }
    .chatbox-dock {
      padding: 0.7rem 1rem 1rem;
      border-top: 1px solid var(--line);
      background: #17202c;
      display: grid; gap: 0.55rem;
    }
    .chat-inline-chips {
      display: flex; flex-wrap: wrap; gap: 0.4rem;
      margin-top: 0.7rem;
    }
    .chat-inline-chip {
      border-radius: 999px; padding: 0.4rem 0.75rem; font-size: 0.8rem;
      background: #243447; color: var(--text); cursor: pointer;
      border: 1px solid var(--line); text-align: left;
    }
    .chat-inline-chip:hover { border-color: var(--accent); }
    .chat-confirm { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .chat-confirm[hidden] { display: none !important; }
    .chatbox-dock { flex-shrink: 0; min-width: 0; }
    .chat-composer {
      display: flex; align-items: flex-end; gap: 0.55rem;
      background: #0c1017; border: 1px solid var(--line);
      border-radius: 16px; padding: 0.45rem 0.5rem 0.45rem 0.85rem;
      min-width: 0;
    }
    .chat-composer:focus-within { border-color: var(--accent); }
    .chat-composer textarea {
      flex: 1 1 auto; min-width: 0; resize: none; border: 0; outline: none; background: transparent;
      color: var(--text); font: inherit; font-size: 0.95rem; line-height: 1.4;
      max-height: 7.5rem; min-height: 1.4rem;
    }
    .chat-send {
      flex: 0 0 auto; border: 0; cursor: pointer; border-radius: 12px;
      background: #5b9fd4; color: #0c1017; font-weight: 700;
      padding: 0.5rem 0.9rem; font-size: 0.85rem; white-space: nowrap;
    }
    .chat-send:hover { filter: brightness(1.08); }
    .cmd-block { margin-bottom: 1rem; }
    .cmd-block.preview pre { opacity: 0.55; user-select: none; filter: blur(0.4px); }
    .cmd-head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.35rem; }
    .confirm-form { display: grid; gap: 0.85rem; margin-top: 1rem; max-width: 40rem; }
    .confirm-label { display: flex; gap: 0.6rem; align-items: flex-start; line-height: 1.4; color: var(--text); font-size: 0.9rem; }
    .ok-note { color: var(--ok); font-weight: 600; }
    .crit-note { color: var(--crit); font-weight: 600; }
    .apply-form label { display: grid; gap: 0.25rem; font-size: 0.8rem; color: var(--muted); }
    .apply-form input, .apply-form select {
      background: #0c1017; border: 1px solid var(--line); color: var(--text);
      border-radius: 6px; padding: 0.45rem 0.6rem; font-size: 0.9rem;
    }
    .add-form { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin-bottom: 1rem; }
    .add-form label { display: grid; gap: 0.25rem; font-size: 0.8rem; color: var(--muted); }
    .add-form input {
      background: #0c1017; border: 1px solid var(--line); color: var(--text);
      border-radius: 6px; padding: 0.45rem 0.6rem; font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(subtitle)}</p>
    <nav>
      <a href="/dashboard">Dashboard</a>
      <a href="/dashboard/license">License</a>
      <a href="/dashboard/security">Security</a>
      <a href="/dashboard/redaction">Redaction</a>
      <a href="/v1/health">API health</a>
    </nav>
  </header>
  <main>${body}</main>
  ${askAgentWidgetMarkup()}
  ${askAgentWidgetScript()}
  ${refreshScript}
  ${script}
</body>
</html>`;
}

function askAgentButton(incidentId: string): string {
  return `<button type="button" class="btn primary autofix-btn js-ask-agent" data-incident-id="${esc(incidentId)}">Ask Pulse</button>`;
}

function askAgentWidgetMarkup(): string {
  return `
  <div class="ask-widget" id="ask-widget" hidden>
    <div class="ask-dock" id="ask-dock" title="Pulse">
      <span class="ask-dock-label">Pulse</span>
      <button type="button" class="ask-dock-icon" id="ask-dock-icon">PL</button>
    </div>
    <div class="chatbox" id="ask-chat">
      <header class="chatbox-head">
        <div class="chatbox-avatar" aria-hidden="true">PL</div>
        <div class="chatbox-head-text">
          <div class="chatbox-title">Pulse</div>
          <div class="chatbox-sub" id="ask-chat-sub"></div>
        </div>
        <div class="chatbox-actions">
          <button type="button" class="chatbox-icon" id="ask-max" title="Maximize">□</button>
          <button type="button" class="chatbox-icon" id="ask-min" title="Minimize to Dock">–</button>
          <button type="button" class="chatbox-icon" id="ask-close" title="Close">×</button>
        </div>
      </header>
      <div class="chat-log" id="ask-chat-log"></div>
      <div class="chatbox-dock">
        <div class="chat-chips" id="ask-chips"></div>
        <div class="chat-confirm" id="ask-confirm" hidden>
          <button type="button" class="btn primary" id="ask-yes">Yes, apply via Pulse</button>
          <button type="button" class="btn" id="ask-no">No, pick again</button>
        </div>
        <form class="chat-composer" id="ask-composer" autocomplete="off">
          <textarea id="ask-input" rows="1" placeholder="Ask what happened, why, or how to fix…"></textarea>
          <button type="submit" class="chat-send" id="ask-input-go" title="Send">Send</button>
        </form>
      </div>
    </div>
  </div>`;
}

function askAgentWidgetScript(): string {
  const openPrompt = JSON.stringify(ASK_OPEN_PROMPT);
  return `<script>
(function(){
  var openPrompt = ${openPrompt};
  var widget = document.getElementById('ask-widget');
  var log = document.getElementById('ask-chat-log');
  var chips = document.getElementById('ask-chips');
  var composer = document.getElementById('ask-composer');
  var inputEl = document.getElementById('ask-input');
  var confirmRow = document.getElementById('ask-confirm');
  var yesBtn = document.getElementById('ask-yes');
  var noBtn = document.getElementById('ask-no');
  var subEl = document.getElementById('ask-chat-sub');
  var minBtn = document.getElementById('ask-min');
  var maxBtn = document.getElementById('ask-max');
  var closeBtn = document.getElementById('ask-close');
  var dockIcon = document.getElementById('ask-dock-icon');
  var incidentId = null;
  var session = null;
  var pending = null;
  var pollTimer = null;
  var awaitingValue = false;
  var history = [];
  var busy = false;
  var STORE_KEY = 'pulse-ask-v1';
  var posLeft = null;
  var posTop = null;
  var dragState = null;
  var chatHead = document.querySelector('#ask-chat .chatbox-head');

  function clampPos(left, top){
    var w = widget.offsetWidth || 420;
    var h = widget.offsetHeight || 640;
    var maxL = Math.max(0, window.innerWidth - w);
    var maxT = Math.max(0, window.innerHeight - h);
    return {
      left: Math.min(maxL, Math.max(0, left)),
      top: Math.min(maxT, Math.max(0, top))
    };
  }
  function applyPos(left, top){
    var p = clampPos(left, top);
    posLeft = p.left;
    posTop = p.top;
    widget.style.left = p.left + 'px';
    widget.style.top = p.top + 'px';
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
    widget.classList.add('dragged');
  }
  function clearPosStyles(){
    widget.style.left = '';
    widget.style.top = '';
    widget.style.right = '';
    widget.style.bottom = '';
    widget.classList.remove('dragged');
  }
  function restorePos(){
    if (posLeft == null || posTop == null) {
      clearPosStyles();
      return;
    }
    if (widget.classList.contains('maximized') || widget.classList.contains('minimized')) {
      clearPosStyles();
      return;
    }
    applyPos(posLeft, posTop);
  }

  function persist(){
    try {
      if (widget.hidden || !incidentId) {
        sessionStorage.removeItem(STORE_KEY);
        return;
      }
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        minimized: widget.classList.contains('minimized'),
        maximized: widget.classList.contains('maximized'),
        incidentId: incidentId,
        subtitle: subEl ? subEl.textContent : '',
        history: history,
        options: (session && session.options) || [],
        sessionOk: !!session,
        pending: pending,
        awaitingValue: awaitingValue,
        confirmVisible: confirmRow && !confirmRow.hidden,
        poll: !!pollTimer,
        logHtml: log ? log.innerHTML : '',
        placeholder: inputEl ? inputEl.placeholder : '',
        posLeft: posLeft,
        posTop: posTop
      }));
    } catch (e) {}
  }
  function clearPersist(){
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
  }
  function rebindChips(){
    var opts = (session && session.options) || [];
    if (!opts.length || !log) return;
    log.querySelectorAll('.chat-inline-chip').forEach(function(btn){
      var label = btn.textContent;
      var opt = null;
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].label === label) { opt = opts[i]; break; }
      }
      if (!opt) return;
      btn.addEventListener('click', function(){ pickOption(opt); });
    });
  }
  function restorePersisted(){
    var raw = null;
    try { raw = sessionStorage.getItem(STORE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !data.incidentId || !data.sessionOk) return false;
    incidentId = data.incidentId;
    history = Array.isArray(data.history) ? data.history : [];
    session = { options: Array.isArray(data.options) ? data.options : [], subtitle: data.subtitle || '' };
    pending = data.pending || null;
    awaitingValue = !!data.awaitingValue;
    posLeft = typeof data.posLeft === 'number' ? data.posLeft : null;
    posTop = typeof data.posTop === 'number' ? data.posTop : null;
    widget.hidden = false;
    widget.classList.toggle('minimized', !!data.minimized);
    widget.classList.toggle('maximized', !!data.maximized && !data.minimized);
    syncMaxButton();
    restorePos();
    if (subEl) subEl.textContent = data.subtitle || '';
    if (log) log.innerHTML = data.logHtml || '';
    rebindChips();
    if (confirmRow) confirmRow.hidden = !data.confirmVisible;
    if (inputEl && data.placeholder) inputEl.placeholder = data.placeholder;
    if (data.poll) startPoll();
    return true;
  }

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function nl(s){
    return esc(s).replace(/\\n/g, '<br/>');
  }
  function typeReply(bubble, text){
    return new Promise(function(resolve){
      var full = String(text == null ? '' : text);
      if (!full) { resolve(); return; }
      var body = document.createElement('span');
      body.className = 'ask-type-body';
      var caret = document.createElement('span');
      caret.className = 'ask-caret';
      bubble.appendChild(body);
      bubble.appendChild(caret);
      var i = 0;
      var step = Math.max(1, Math.ceil(full.length / 100));
      function tick(){
        i = Math.min(full.length, i + step);
        body.innerHTML = nl(full.slice(0, i));
        log.scrollTop = log.scrollHeight;
        if (i >= full.length) {
          caret.remove();
          resolve();
          return;
        }
        setTimeout(tick, 16);
      }
      tick();
    });
  }
  function add(role, html){
    var row = document.createElement('div');
    row.className = 'chat-row ' + role;
    if (role !== 'sys') {
      var av = document.createElement('div');
      av.className = 'msg-avatar';
      av.textContent = role === 'user' ? 'You' : 'PL';
      row.appendChild(av);
    }
    var d = document.createElement('div');
    d.className = 'chat-bubble';
    d.innerHTML = html;
    row.appendChild(d);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function clearChips(){ if (chips) chips.innerHTML = ''; }
  function hideConfirm(){ confirmRow.hidden = true; }
  function stopPoll(){
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function attachChips(bubble, options){
    if (!bubble || !options || !options.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'chat-inline-chips';
    options.forEach(function(opt){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-inline-chip';
      b.textContent = opt.label;
      b.addEventListener('click', function(){ pickOption(opt); });
      wrap.appendChild(b);
    });
    bubble.appendChild(wrap);
  }
  function showOptions(){
    clearChips();
    if (session && session.options && session.options.length) {
      var bubble = add('bot', 'Suggested actions:');
      attachChips(bubble, session.options);
    }
  }
  function applyPropose(propose){
    if (!propose || !propose.optionId) return;
    var opt = (session.options || []).find(function(o){ return o.id === propose.optionId; });
    if (!opt) return;
    pending = {
      option: opt,
      optionId: opt.id,
      userInput: propose.userInput || '',
      label: opt.label,
      detail: opt.detail,
    };
    confirmRow.hidden = false;
  }
  function resetThread(){
    stopPoll();
    pending = null;
    awaitingValue = false;
    history = [];
    busy = false;
    hideConfirm();
    clearChips();
    log.innerHTML = '';
    inputEl.value = '';
    inputEl.placeholder = 'Ask what happened, why, or how to fix…';
    inputEl.style.height = 'auto';
  }
  function closeWidget(){
    stopPoll();
    widget.hidden = true;
    widget.classList.remove('minimized');
    widget.classList.remove('maximized');
    clearPosStyles();
    posLeft = null;
    posTop = null;
    syncMaxButton();
    clearPersist();
  }
  function minimizeWidget(){
    widget.classList.remove('maximized');
    widget.classList.add('minimized');
    clearPosStyles();
    syncMaxButton();
    persist();
  }
  function maximizeWidget(){
    widget.classList.remove('minimized');
    widget.classList.add('maximized');
    clearPosStyles();
    syncMaxButton();
    inputEl && inputEl.focus();
    persist();
  }
  function restoreWidget(){
    widget.classList.remove('minimized');
    restorePos();
    inputEl && inputEl.focus();
    persist();
  }
  function syncMaxButton(){
    if (!maxBtn) return;
    var on = widget.classList.contains('maximized');
    maxBtn.textContent = on ? '❐' : '□';
    maxBtn.title = on ? 'Restore' : 'Maximize';
  }
  function toggleMaximize(){
    if (widget.classList.contains('maximized')) {
      widget.classList.remove('maximized');
      restorePos();
      syncMaxButton();
      inputEl && inputEl.focus();
      persist();
      return;
    }
    maximizeWidget();
  }
  function onDragStart(ev){
    if (widget.hidden || widget.classList.contains('minimized') || widget.classList.contains('maximized')) return;
    if (ev.target && ev.target.closest && ev.target.closest('.chatbox-icon')) return;
    var point = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    var rect = widget.getBoundingClientRect();
    dragState = {
      dx: point.clientX - rect.left,
      dy: point.clientY - rect.top
    };
    applyPos(rect.left, rect.top);
    widget.classList.add('dragging');
    ev.preventDefault();
  }
  function onDragMove(ev){
    if (!dragState) return;
    var point = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    applyPos(point.clientX - dragState.dx, point.clientY - dragState.dy);
    ev.preventDefault();
  }
  function onDragEnd(){
    if (!dragState) return;
    dragState = null;
    widget.classList.remove('dragging');
    persist();
  }
  if (chatHead) {
    chatHead.addEventListener('mousedown', onDragStart);
    chatHead.addEventListener('touchstart', onDragStart, { passive: false });
  }
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('touchmove', onDragMove, { passive: false });
  window.addEventListener('mouseup', onDragEnd);
  window.addEventListener('touchend', onDragEnd);
  async function openAsk(id, opts){
    opts = opts || {};
    if (!id) return;
    widget.hidden = false;
    restoreWidget();
    if (incidentId === id && session) {
      if (opts.error) add('bot', esc(opts.error));
      if (opts.poll) startPoll();
      persist();
      inputEl.focus();
      return;
    }
    incidentId = id;
    resetThread();
    subEl.textContent = 'Loading…';
    add('sys', 'Connecting to Pulse…');
    try {
      var res = await fetch('/dashboard/incidents/' + encodeURIComponent(id) + '/ask-agent/session', {cache:'no-store'});
      var data = await res.json();
      log.innerHTML = '';
      if (!data.ok) {
        subEl.textContent = 'Unavailable';
        add('bot', esc(data.error || 'Pulse is not available for this incident.'));
        return;
      }
      session = data;
      session.options = [];
      subEl.textContent = data.subtitle || '';
      if (opts.error) add('bot', esc(opts.error));
      if (opts.poll || data.poll) startPoll();
      await talkToAgent(openPrompt, { hideUser: true });
      persist();
      inputEl.focus();
    } catch (e) {
      log.innerHTML = '';
      add('bot', 'Could not load Pulse. Stay on this page and try again.');
      persist();
    }
  }

  async function talkToAgent(text, flags){
    flags = flags || {};
    if (busy || !incidentId) return;
    busy = true;
    if (!flags.hideUser) {
      history.push({ role: 'user', content: text });
    }
    var typing = add('sys', 'PL is working…');
    if (typing.parentNode) typing.parentNode.classList.add('chat-blink');
    var thinkBox = document.createElement('div');
    thinkBox.className = 'ask-think';
    thinkBox.hidden = true;
    var thinkTools = document.createElement('div');
    thinkTools.className = 'ask-think-tools';
    var thinkBody = document.createElement('div');
    thinkBody.className = 'ask-think-body';
    thinkBox.appendChild(thinkTools);
    thinkBox.appendChild(thinkBody);
    log.appendChild(thinkBox);
    var thinkText = '';
    var toolRows = {};

    function showThink(){
      thinkBox.hidden = false;
      log.scrollTop = log.scrollHeight;
    }
    function onTool(name, status, callId){
      showThink();
      var key = String(callId || name || 'tool');
      var row = toolRows[key];
      if (!row) {
        row = document.createElement('div');
        row.className = 'ask-think-tool';
        thinkTools.appendChild(row);
        toolRows[key] = row;
      }
      var mark = status === 'completed' ? '✓' : status === 'error' ? '✕' : '→';
      row.className = 'ask-think-tool' + (status === 'completed' ? ' done' : status === 'error' ? ' err' : '');
      row.textContent = mark + ' ' + String(name || 'tool');
      log.scrollTop = log.scrollHeight;
    }
    function onThinking(chunk){
      showThink();
      var t = String(chunk || '');
      if (!t) return;
      if (thinkText && t.indexOf(thinkText) === 0) thinkText = t;
      else if (thinkText && thinkText.indexOf(t) === 0) { /* older cumulative */ }
      else thinkText = (thinkText ? thinkText + (/\s$/.test(thinkText) ? '' : ' ') : '') + t;
      if (thinkText.length > 1800) thinkText = thinkText.slice(-1800);
      thinkBody.textContent = thinkText;
      log.scrollTop = log.scrollHeight;
    }

    try {
      var res = await fetch('/dashboard/incidents/' + encodeURIComponent(incidentId) + '/ask-agent/chat-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message: text, history: history }),
      });
      if (!res.ok || !res.body) {
        typing.parentNode && typing.parentNode.remove();
        thinkBox.remove();
        add('bot', 'Could not start Cursor stream (' + res.status + ').');
        return;
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var donePayload = null;
      var errMsg = '';
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var parts = buf.split('\\n\\n');
        buf = parts.pop() || '';
        for (var pi = 0; pi < parts.length; pi++) {
          var block = parts[pi].trim();
          if (!block) continue;
          var lines = block.split('\\n');
          var dataLines = [];
          for (var li = 0; li < lines.length; li++) {
            if (lines[li].indexOf('data:') === 0) dataLines.push(lines[li].slice(5).trim());
          }
          if (!dataLines.length) continue;
          var ev;
          try { ev = JSON.parse(dataLines.join('\\n')); } catch (e) { continue; }
          if (ev.type === 'thinking') onThinking(ev.text);
          else if (ev.type === 'tool') onTool(ev.name, ev.status, ev.callId);
          else if (ev.type === 'status' && ev.text) {
            showThink();
            if (!thinkText) thinkBody.textContent = String(ev.text);
          }
          else if (ev.type === 'done') donePayload = ev.result || null;
          else if (ev.type === 'error') errMsg = ev.message || 'Stream error';
        }
      }
      typing.parentNode && typing.parentNode.remove();
      if (errMsg) {
        if (!thinkText && !Object.keys(toolRows).length) thinkBox.remove();
        add('bot', esc(errMsg));
        return;
      }
      if (!donePayload || !donePayload.reply) {
        if (!thinkText && !Object.keys(toolRows).length) thinkBox.remove();
        add('bot', 'Cursor + OpsPilot MCP did not return a reply.');
        return;
      }
      var reply = donePayload.reply || '';
      history.push({ role: 'assistant', content: reply });
      var bubble = add('bot', '');
      await typeReply(bubble, reply);
      if (donePayload.source === 'cursor-mcp' || donePayload.source === 'openai') {
        var via = document.createElement('div');
        via.className = 'ask-via';
        via.textContent =
          donePayload.source === 'cursor-mcp' ? 'Cursor · OpsPilot MCP' : 'OpenAI';
        bubble.appendChild(via);
      }
      if (donePayload.options && donePayload.options.length) {
        session.options = donePayload.options;
        attachChips(bubble, donePayload.options);
      }
      if (donePayload.propose && donePayload.propose.optionId) applyPropose(donePayload.propose);
    } catch (e) {
      typing.parentNode && typing.parentNode.remove();
      thinkBox.remove();
      add('bot', 'Network error talking to Cursor. Ask again, or try later.');
    } finally {
      busy = false;
      persist();
    }
  }

  function pickOption(opt){
    add('user', esc(opt.label));
    history.push({ role: 'user', content: opt.label });
    hideConfirm();
    if (opt.needsInput) {
    pending = { option: opt, optionId: opt.id, userInput: '', label: opt.label, needsInput: opt.needsInput, detail: opt.detail };
      awaitingValue = true;
      add('bot', esc(opt.detail) + '<br/>Type the value below and press Send.');
      if (opt.needsInput === 'image') inputEl.placeholder = 'registry/app:tag';
      if (opt.needsInput === 'memory') inputEl.placeholder = 'e.g. 512Mi';
      if (opt.needsInput === 'replicas') inputEl.placeholder = 'e.g. 2';
      inputEl.focus();
      persist();
      return;
    }
    pending = { option: opt, optionId: opt.id, userInput: '', label: opt.label, detail: opt.detail };
    add('bot', esc(opt.detail) + '<br/><strong>Apply this via Pulse?</strong>');
    confirmRow.hidden = false;
    persist();
  }

  function afterInput(){
    var v = (inputEl.value || '').trim();
    if (!v || busy) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    add('user', esc(v));
    history.push({ role: 'user', content: v });
    if (pending && awaitingValue) {
      pending.userInput = v;
      awaitingValue = false;
      inputEl.placeholder = 'Ask what happened, why, or how to fix…';
      add('bot', 'Plan: ' + esc(pending.detail) + ' → <code>' + esc(v) + '</code><br/><strong>Apply this via Pulse?</strong>');
      confirmRow.hidden = false;
      persist();
      return;
    }
    hideConfirm();
    talkToAgent(v, { hideUser: true });
  }

  async function applyNow(){
    if (!pending || !incidentId) return;
    hideConfirm();
    add('sys', 'Queueing fix for the in-cluster agent…');
    try {
      var res = await fetch('/dashboard/incidents/' + encodeURIComponent(incidentId) + '/ask-agent/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          optionId: pending.optionId,
          option: pending.option || undefined,
          userInput: pending.userInput || undefined
        }),
      });
      var data = await res.json();
      if (!data.ok) {
        add('bot', 'Could not queue fix: ' + esc(data.error || 'unknown error'));
        showOptions();
        return;
      }
      add('bot', 'Queued <code>' + esc(data.type) + '</code> — waiting for agent heartbeat…');
      pending = null;
      startPoll();
      persist();
    } catch (e) {
      add('bot', 'Network error queueing fix.');
      showOptions();
      persist();
    }
  }

  async function pollOnce(){
    if (!incidentId) return;
    try {
      var res = await fetch('/dashboard/incidents/' + encodeURIComponent(incidentId) + '/apply-status', {cache:'no-store'});
      if (!res.ok) return;
      var data = await res.json();
      var cmds = data.commands || [];
      if (!cmds.length) return;
      var latest = cmds[0];
      var el = document.getElementById('ask-status-line');
      var text = latest.status + (latest.result ? ' — ' + latest.result : '') + (latest.error ? ' — ' + latest.error : '');
      if (!el) {
        add('sys', '<span id="ask-status-line">Apply status: ' + esc(text) + '</span>');
      } else {
        el.textContent = 'Apply status: ' + text;
      }
      if (!data.pending) {
        stopPoll();
        if (latest.status === 'succeeded') add('bot', 'Done. Agent applied the fix successfully.');
        else if (latest.status === 'failed') {
          add('bot', 'Agent reported failure: ' + esc(latest.error || 'unknown'));
          showOptions();
        }
      }
    } catch (e) {}
  }
  function startPoll(){
    stopPoll();
    pollOnce();
    pollTimer = setInterval(pollOnce, 3000);
  }

  document.addEventListener('click', function(ev){
    var t = ev.target && ev.target.closest ? ev.target.closest('.js-ask-agent') : null;
    if (!t) return;
    ev.preventDefault();
    openAsk(t.getAttribute('data-incident-id'));
  });
  composer.addEventListener('submit', function(ev){
    ev.preventDefault();
    afterInput();
  });
  inputEl.addEventListener('keydown', function(ev){
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      afterInput();
    }
  });
  inputEl.addEventListener('input', function(){
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
  yesBtn.addEventListener('click', applyNow);
  noBtn.addEventListener('click', function(){
    hideConfirm();
    pending = null;
    add('sys', 'Okay — tell me more, or pick a suggested fix.');
    showOptions();
  });
  minBtn.addEventListener('click', minimizeWidget);
  maxBtn.addEventListener('click', toggleMaximize);
  dockIcon.addEventListener('click', restoreWidget);
  closeBtn.addEventListener('click', closeWidget);
  window.addEventListener('pagehide', persist);
  window.addEventListener('beforeunload', persist);

  var params = new URLSearchParams(location.search);
  var ask = params.get('ask');
  var pathId = (location.pathname.match(/\\/dashboard\\/incidents\\/([^/]+)/) || [])[1];
  var openId = ask && ask !== '1' ? ask : (ask === '1' ? pathId : null);
  if (openId) {
    openAsk(openId, { poll: params.get('queued') === '1', error: params.get('error') || '' });
  } else {
    restorePersisted();
  }
})();
</script>`;
}

function applyStatusPollScript(incidentId: string): string {
  const idJson = JSON.stringify(incidentId);
  return `<script>
(function(){
  var incidentId = ${idJson};
  var timer = null;
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function statusClass(st){
    var s = String(st || '').toLowerCase();
    if (s === 'succeeded') return 'ok';
    if (s === 'failed') return 'crit';
    if (s === 'claimed' || s === 'pending') return 'warn';
    return 'off';
  }
  function badge(st){
    return '<span class="badge ' + statusClass(st) + '">' + esc(st || '—') + '</span>';
  }
  function render(commands){
    var body = document.getElementById('apply-status-body');
    var empty = document.getElementById('apply-status-empty');
    var table = document.getElementById('apply-status-table');
    if (!commands || !commands.length) {
      if (body) body.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (!table) {
      var section = document.getElementById('apply-status');
      if (!section) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = '<table id="apply-status-table"><thead><tr><th>When</th><th>Type</th><th>Status</th><th>Result / Error</th></tr></thead><tbody id="apply-status-body"></tbody></table>';
      section.appendChild(wrap.firstChild);
      body = document.getElementById('apply-status-body');
    }
    if (!body) return;
    body.innerHTML = commands.map(function(h){
      return '<tr data-cmd-id="' + esc(h.id) + '">' +
        '<td>' + esc(h.createdAt ? new Date(h.createdAt).toISOString() : '—') + '</td>' +
        '<td><code>' + esc(h.type) + '</code></td>' +
        '<td data-f="status">' + badge(h.status) + '</td>' +
        '<td class="msg" data-f="result">' + esc(h.error || h.result || '—') + '</td>' +
        '</tr>';
    }).join('');
  }
  async function tick(){
    try {
      var res = await fetch('/dashboard/incidents/' + encodeURIComponent(incidentId) + '/apply-status', {cache:'no-store'});
      if (!res.ok) return;
      var data = await res.json();
      render(data.commands || []);
      var banner = document.getElementById('apply-queue-banner');
      var hint = document.getElementById('apply-poll-hint');
      if (!data.pending) {
        if (banner) banner.textContent = 'Apply finished — status updated.';
        if (hint) hint.textContent = '';
        if (timer) { clearInterval(timer); timer = null; }
      }
    } catch (e) {}
  }
  tick();
  timer = setInterval(tick, 3000);
})();
</script>`;
}

function liveMonitorScript(opts: {
  mode: 'agent' | 'agent-containers' | 'pod';
  agentId: string;
  pollMs: number;
  namespace?: string;
  name?: string;
}): string {
  const payload = JSON.stringify({
    mode: opts.mode,
    agentId: opts.agentId,
    pollMs: opts.pollMs,
    namespace: opts.namespace || '',
    name: opts.name || '',
  });
  return `<script>
(function(){
  var cfg = ${payload};
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function statusClass(st){
    var s = String(st || '');
    if (s === 'Running' || s === 'Succeeded' || s === 'Completed' || s === 'running') return 'ok';
    if (/CrashLoop|ImagePull|ErrImage|OOM|Error|Failed|Evicted|BackOff|exited|dead|unhealthy/i.test(s)) return 'crit';
    if (s === 'Pending' || s === 'ContainerCreating' || s === 'Terminating' || s === 'restarting') return 'warn';
    return 'off';
  }
  function setText(id, text){
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function setHtml(id, html){
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  function badge(st){
    return '<span class="badge ' + statusClass(st) + '">' + esc(st || '—') + '</span>';
  }
  async function tick(){
    try {
      var res = await fetch('/dashboard/agents/' + encodeURIComponent(cfg.agentId) + '/live', {cache:'no-store'});
      if (!res.ok) return;
      var data = await res.json();
      var inventoryAt = data.containerInventoryAt || data.podInventoryAt;
      if (inventoryAt) setText('live-inventory-at', new Date(inventoryAt).toISOString());
      if (data.lastHeartbeatAt) setText('live-heartbeat', new Date(data.lastHeartbeatAt).toISOString());
      if (data.status) setHtml('live-agent-status', badge(data.status));
      if (cfg.mode === 'agent-containers') {
        var containers = Array.isArray(data.containers) ? data.containers : [];
        setText('live-container-count', String(containers.length));
        var ctbody = document.querySelector('#live-container-table tbody');
        if (!ctbody) return;
        var cseen = {};
        containers.forEach(function(c){
          var key = c.name || '';
          if (!key) return;
          cseen[key] = true;
          var row = ctbody.querySelector('tr[data-container-key="' + key.replace(/"/g,'') + '"]');
          if (!row) {
            var tr = document.createElement('tr');
            tr.setAttribute('data-container-key', key);
            tr.innerHTML =
              '<td><code>' + esc(key) + '</code></td>' +
              '<td data-f="service">' + esc(c.service || '—') + '</td>' +
              '<td data-f="status">' + badge(c.status) + '</td>' +
              '<td data-f="health">' + esc(c.health || '—') + '</td>' +
              '<td data-f="restarts">' + esc(c.restarts == null ? 0 : c.restarts) + '</td>' +
              '<td data-f="image"><code>' + esc(c.image || '—') + '</code></td>' +
              '<td data-f="age">' + esc(c.age || '—') + '</td>';
            ctbody.appendChild(tr);
            return;
          }
          var st = row.querySelector('[data-f="status"]');
          if (st) st.innerHTML = badge(c.status);
          var svc = row.querySelector('[data-f="service"]'); if (svc) svc.textContent = c.service || '—';
          var h = row.querySelector('[data-f="health"]'); if (h) h.textContent = c.health || '—';
          var rs = row.querySelector('[data-f="restarts"]'); if (rs) rs.textContent = String(c.restarts == null ? 0 : c.restarts);
          var img = row.querySelector('[data-f="image"]'); if (img) img.innerHTML = '<code>' + esc(c.image || '—') + '</code>';
          var a = row.querySelector('[data-f="age"]'); if (a) a.textContent = c.age || '—';
        });
        Array.prototype.slice.call(ctbody.querySelectorAll('tr[data-container-key]')).forEach(function(row){
          var k = row.getAttribute('data-container-key');
          if (k && !cseen[k]) row.remove();
        });
        return;
      }
      var pods = Array.isArray(data.pods) ? data.pods : [];
      if (cfg.mode === 'agent') {
        setText('live-pod-count', String(pods.length));
        var tbody = document.querySelector('#live-pod-table tbody');
        if (!tbody) return;
        var seen = {};
        pods.forEach(function(p){
          var key = (p.namespace || '') + '/' + (p.name || '');
          seen[key] = true;
          var row = tbody.querySelector('tr[data-pod-key="' + key.replace(/"/g,'') + '"]');
          if (!row) {
            var tr = document.createElement('tr');
            tr.setAttribute('data-pod-key', key);
            var href = '/dashboard/agents/' + encodeURIComponent(cfg.agentId) + '/pods/' +
              encodeURIComponent(p.namespace || '') + '/' + encodeURIComponent(p.name || '');
            tr.innerHTML =
              '<td>' + esc(p.namespace || '—') + '</td>' +
              '<td><a href="' + href + '"><code>' + esc(p.name || '—') + '</code></a></td>' +
              '<td data-f="status">' + badge(p.status) + '</td>' +
              '<td data-f="ready">' + esc(p.ready || '—') + '</td>' +
              '<td data-f="restarts">' + esc(p.restarts == null ? 0 : p.restarts) + '</td>' +
              '<td data-f="cpu">' + esc(p.cpu || '—') + '</td>' +
              '<td data-f="memory">' + esc(p.memory || '—') + '</td>' +
              '<td data-f="age">' + esc(p.age || '—') + '</td>';
            tbody.appendChild(tr);
            return;
          }
          var st = row.querySelector('[data-f="status"]');
          if (st) st.innerHTML = badge(p.status);
          var r = row.querySelector('[data-f="ready"]'); if (r) r.textContent = p.ready || '—';
          var rs = row.querySelector('[data-f="restarts"]'); if (rs) rs.textContent = String(p.restarts == null ? 0 : p.restarts);
          var c = row.querySelector('[data-f="cpu"]'); if (c) c.textContent = p.cpu || '—';
          var m = row.querySelector('[data-f="memory"]'); if (m) m.textContent = p.memory || '—';
          var a = row.querySelector('[data-f="age"]'); if (a) a.textContent = p.age || '—';
        });
        Array.prototype.slice.call(tbody.querySelectorAll('tr[data-pod-key]')).forEach(function(row){
          var k = row.getAttribute('data-pod-key');
          if (k && !seen[k]) row.remove();
        });
      } else {
        var pod = pods.find(function(p){ return p.namespace === cfg.namespace && p.name === cfg.name; });
        if (!pod) {
          setHtml('live-status', '<span class="badge off">not in latest inventory</span>');
          setText('live-ready', '—');
          setText('live-restarts', '—');
          setText('live-cpu', '—');
          setText('live-memory', '—');
          setText('live-age', '—');
          return;
        }
        setHtml('live-status', badge(pod.status));
        setText('live-ready', pod.ready || '—');
        setText('live-restarts', String(pod.restarts == null ? 0 : pod.restarts));
        setText('live-cpu', pod.cpu || '—');
        setText('live-memory', pod.memory || '—');
        setText('live-age', pod.age || '—');
      }
    } catch (e) {}
  }
  tick();
  setInterval(tick, cfg.pollMs || 3000);
})();
</script>`;
}

function renderCategoryTabs(
  active: DashboardCategoryTab,
  counts: Record<DashboardCategoryTab, number>,
): string {
  const tabs: DashboardCategoryTab[] = [
    'all',
    'pod',
    'deployment',
    'docker',
  ];
  if (counts.replicaset > 0) tabs.push('replicaset');
  if (counts.other > 0) tabs.push('other');

  return `<div class="source-tabs">${tabs
    .map((id) => {
      const href = id === 'all' ? '/dashboard' : `/dashboard?category=${id}`;
      const cls = active === id ? 'tab active' : 'tab';
      return `<a class="${cls}" href="${href}">${esc(categoryTabLabel(id))} <span class="tab-count">${counts[id]}</span></a>`;
    })
    .join('')}</div>`;
}

function dashboardCategoryHint(category: DashboardCategoryTab): string {
  switch (category) {
    case 'pod':
      return 'Live pod failures (CrashLoopBackOff, OOM, image pull, etc.) on pods still in agent inventory.';
    case 'deployment':
      return 'Live deployment-level failures on deployments still failing in agent inventory.';
    case 'docker':
      return 'Live Docker container failures (exited, unhealthy, restart loop, OOM) still in container inventory.';
    case 'replicaset':
      return 'Live ReplicaSet failures still tied to failing workload inventory.';
    case 'other':
      return 'Live failures on other resource kinds.';
    default:
      return 'All live failures grouped by resource kind — pods, deployments, Docker containers, and more. Only resources still failing in the latest inventory are shown.';
  }
}

function dashboardEmptyMessage(category: DashboardCategoryTab): string {
  switch (category) {
    case 'pod':
      return 'No live pod failures in inventory.';
    case 'deployment':
      return 'No live deployment failures in inventory.';
    case 'docker':
      return 'No live Docker container failures in inventory.';
    case 'replicaset':
      return 'No live ReplicaSet failures in inventory.';
    case 'other':
      return 'No live failures on other resource kinds.';
    default:
      return 'No live failures across any resource kind.';
  }
}

function incidentLocationCell(g: IncidentGroup): string {
  if (inferIncidentCategory(g.latest) === 'docker') {
    const meta = (g.latest.metadata ?? {}) as Record<string, string>;
    return esc(meta.host || '—');
  }
  return esc(g.namespace);
}

function renderDashboardIncidentRows(
  groups: IncidentGroup[],
  incidentsService: IncidentsService,
): string {
  return groups
    .map((g) => {
      const i = g.latest;
      const cause = formatCause(i.metadata, i.reason);
      const fix = incidentsService.displaySuggestedFix(
        i.suggestedFix,
        i.severity,
      );
      const hasSnap = i.snapshot != null;
      const target = resolveDeploymentTarget(i);
      let actionCell = '<span class="muted">—</span>';
      if (target.deployment || isDockerContainerIncident(i)) {
        actionCell = askAgentButton(i.id);
      } else if (incidentsService.suggestionAction(i) === 'view') {
        actionCell = `<a class="btn autofix-btn" href="/dashboard/incidents/${esc(i.id)}/suggestion">View suggestion</a>`;
      }
      const countBadge =
        g.count > 1
          ? `<span class="badge off" title="Repeated detections of the same issue">×${g.count}</span>`
          : `<span class="muted">1</span>`;
      return `
      <tr>
        <td class="autofix-col">${actionCell}</td>
        <td>${esc(g.lastSeenAt.toISOString())}</td>
        <td>${countBadge}</td>
        <td><span class="badge ${severityClass(i.severity)}">${esc(i.severity)}</span></td>
        <td>${esc(g.type)}</td>
        <td class="cause"><code>${esc(cause)}</code></td>
        <td class="fix">${fix ? esc(fix) : '<span class="muted">—</span>'}</td>
        <td><code>${esc(g.resource)}</code></td>
        <td>${incidentLocationCell(g)}</td>
        <td>${esc(g.clusterName)}</td>
        <td><a href="/dashboard/incidents/${esc(i.id)}">${hasSnap ? 'Snapshot' : 'Detail'}</a></td>
      </tr>`;
    })
    .join('');
}

function agentMode(agent: { labels?: unknown }): 'docker-host' | 'kubernetes' {
  const labels = (agent.labels ?? {}) as Record<string, string>;
  return labels.agentType === 'docker-host' ? 'docker-host' : 'kubernetes';
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCmdBlocks(
  commands: Array<{ label: string; command: string }>,
  opts: { copy: boolean; previewOnly?: boolean },
): string {
  if (!commands.length) return '';
  return commands
    .map((c, idx) => {
      const id = `cmd-${opts.previewOnly ? 'preview' : 'ready'}-${idx}-${Math.abs(
        hashStr(c.command),
      )}`;
      const copyBtn = opts.copy
        ? `<button type="button" class="btn" data-copy="${id}">Copy</button>`
        : `<span class="muted">Locked until confirm</span>`;
      return `
      <div class="cmd-block${opts.previewOnly ? ' preview' : ''}">
        <div class="cmd-head">
          <strong>${esc(c.label)}</strong>
          ${copyBtn}
        </div>
        <pre id="${id}">${esc(c.command)}</pre>
      </div>`;
    })
    .join('');
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function copyScript(): string {
  return `<script>
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-copy');
      const el = document.getElementById(id);
      if (!el) return;
      try {
        await navigator.clipboard.writeText(el.textContent || '');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      } catch (_) {
        btn.textContent = 'Select & copy';
      }
    });
  });
</script>`;
}

function fixStatusClass(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'succeeded') return 'ok';
  if (s === 'failed') return 'crit';
  if (s === 'claimed' || s === 'pending') return 'warn';
  return 'off';
}

function severityClass(severity: string): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'error') return 'crit';
  if (s === 'warning') return 'warn';
  return 'ok';
}

function podStatusClass(status?: string): string {
  const s = (status || '').toLowerCase();
  if (
    s.includes('crash') ||
    s.includes('imagepull') ||
    s.includes('err') ||
    s === 'failed' ||
    s.includes('oom')
  ) {
    return 'crit';
  }
  if (s === 'pending' || s === 'terminating' || s.includes('backoff')) {
    return 'warn';
  }
  if (s === 'running' || s === 'succeeded') return 'ok';
  return 'off';
}

function asMeta(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return metadata as Record<string, unknown>;
}

function formatCause(metadata: unknown, reason?: string | null): string {
  const m = asMeta(metadata);
  const cause = m.cause;
  if (cause !== undefined && cause !== null && String(cause) !== '') {
    return String(cause);
  }
  const termReason = m.terminatedReason != null ? String(m.terminatedReason) : '';
  const exitCode = m.exitCode != null ? String(m.exitCode) : '';
  if (termReason && exitCode) {
    return `${termReason} (exit ${exitCode})`;
  }
  if (termReason) return termReason;
  if (exitCode) return `exit ${exitCode}`;
  if (reason) return reason;
  return '—';
}

function formatStatus(metadata: unknown, type?: string | null): string {
  const m = asMeta(metadata);
  for (const key of ['status', 'waitingReason'] as const) {
    const v = m[key];
    if (v !== undefined && v !== null && String(v) !== '') {
      return String(v);
    }
  }
  return type || '—';
}

function formatLogSnippet(metadata: unknown): string {
  const m = asMeta(metadata);
  const snippet = m.logSnippet;
  if (snippet === undefined || snippet === null) return '';
  const text = String(snippet).trim();
  if (!text) return '';
  const lines = text.split('\n').filter((l) => l.trim());
  const shown = lines.slice(-6).join('\n');
  return shown.length > 400 ? shown.slice(0, 397) + '...' : shown;
}

function formatContext(metadata: unknown): string {
  const m = asMeta(metadata);
  if (Object.keys(m).length === 0) {
    return '—';
  }
  const preferred = [
    'restartCount',
    'exitCode',
    'phase',
    'container',
    'terminatedReason',
    'finishedAt',
    'waitingReason',
    'desired',
    'available',
    'unavailable',
    'conditionReason',
    'count',
  ];
  const parts: string[] = [];
  for (const key of preferred) {
    const v = m[key];
    if (v !== undefined && v !== null && String(v) !== '') {
      parts.push(`${key}=${String(v)}`);
    }
  }
  return parts.length ? parts.join('\n') : '—';
}
