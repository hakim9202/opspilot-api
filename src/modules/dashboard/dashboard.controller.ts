import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { IncidentsService } from '../incidents/incidents.service';
import { LicensingService } from '../licensing/licensing.service';
import { ClusterPrefillService } from '../incidents/cluster-prefill.service';
import { groupIncidents } from '../incidents/incident-groups';
import { inferDeploymentFromPodName } from '../incidents/pod-history';
import { filterLiveFailureIncidents } from '../incidents/live-failures';
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
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page() {
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

    const liveIncidents = filterLiveFailureIncidents(incidents, agents);
    const groups = groupIncidents(liveIncidents);
    const incidentRows = groups
      .map((g) => {
        const i = g.latest;
        const cause = formatCause(i.metadata, i.reason);
        const fix = this.incidentsService.displaySuggestedFix(
          i.suggestedFix,
          i.severity,
        );
        const hasSnap = i.snapshot != null;
        const action = this.incidentsService.suggestionAction(i);
        let actionCell = '<span class="muted">—</span>';
        if (action === 'apply') {
          actionCell = `<a class="btn primary autofix-btn" href="/dashboard/incidents/${esc(i.id)}/apply-fix">Apply suggested fix</a>`;
        } else if (action === 'view') {
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
        <td>${esc(g.namespace)}</td>
        <td>${esc(g.clusterName)}</td>
        <td><a href="/dashboard/incidents/${esc(i.id)}">${hasSnap ? 'Snapshot' : 'Detail'}</a></td>
      </tr>`;
      })
      .join('');

    return layout(
      'OpsPilot Dashboard',
      'Connected agents and live failures · auto-refresh 15s',
      true,
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
      <p class="muted">Only failures on pods that still exist in the latest agent inventory. Healthy / deleted pods and rollouts are hidden — open an agent → pod for full history.</p>
      ${
        groups.length
          ? `<table>
        <thead><tr>
          <th>Fix</th><th>Last seen</th><th>Count</th><th>Severity</th><th>Type</th><th>Cause / Why</th><th>Suggested fix</th><th>Resource</th><th>Namespace</th><th>Cluster</th><th>Evidence</th>
        </tr></thead>
        <tbody>${incidentRows}</tbody>
      </table>`
          : `<p class="empty">No live failures. All inventoried pods look healthy (or break a demo pod to generate one).</p>`
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
      return { url: `/dashboard/incidents/${id}/apply-fix`, statusCode: 302 };
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
        `${i.type} · advice view — use Apply suggested fix for dry-run / confirm`,
        false,
        `
    <section>
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a></p>
      <h2>Suggested fix</h2>
      <p class="fix">${esc(fix)}</p>
      <p><a class="btn primary" href="/dashboard/incidents/${esc(i.id)}/apply-fix">Apply suggested fix</a></p>
      <p class="muted">This incident has a concrete remediating kubectl plan. Apply opens a dry-run preview and requires confirmation before unlock.</p>
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

  @Get('incidents/:id/apply-fix')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async incidentApplyFix(
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
      <p><a href="/dashboard">← Back to dashboard</a> · <a href="/dashboard/incidents/${esc(i.id)}">Incident detail</a> · <a href="/dashboard/incidents/${esc(i.id)}/suggestion">View suggestion</a></p>
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
          I reviewed the options. Apply this change in-cluster via the OpsPilot agent on the next heartbeat.
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
        url: `/dashboard/incidents/${id}/apply-fix?queued=1#apply-status`,
        statusCode: 303,
      };
    } catch (err: any) {
      const msg = Array.isArray(err?.response?.message)
        ? err.response.message.join(', ')
        : err?.response?.message || err?.message || 'Failed to queue fix command';
      return {
        url: `/dashboard/incidents/${id}/apply-fix?error=${encodeURIComponent(String(msg))}#apply-status`,
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
    const action = this.incidentsService.suggestionAction(i);
    let actionLink = '';
    if ((i.severity || '').toLowerCase() !== 'info') {
      if (action === 'apply') {
        actionLink = ` · <a class="btn primary" href="/dashboard/incidents/${esc(i.id)}/apply-fix">Apply suggested fix</a>`;
      } else if (action === 'view') {
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
    return {
      id: agent.id,
      status: agent.status,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      podInventoryAt: agent.podInventoryAt,
      pods,
    };
  }

  @Get('agents/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async agentDetail(@Param('id') id: string) {
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

    const statusClass =
      agent.status === 'online' ? 'ok' : agent.status === 'revoked' ? 'crit' : 'off';

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

    const liveScript = liveMonitorScript({
      mode: 'agent',
      agentId: agent.id,
      pollMs: 3000,
    });

    return layout(
      `Agent ${agent.hostname}`,
      `${agent.clusterName} · ${agent.environment} · live pod monitor`,
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
        <tr><th>Status</th><td><span id="live-agent-status" class="badge ${statusClass}">${esc(agent.status)}</span></td></tr>
        <tr><th>Version</th><td>${esc(agent.version)}</td></tr>
        <tr><th>Last heartbeat</th><td id="live-heartbeat">${agent.lastHeartbeatAt ? esc(new Date(agent.lastHeartbeatAt).toISOString()) : '—'}</td></tr>
        <tr><th>Inventory updated</th><td id="live-inventory-at">${agent.podInventoryAt ? esc(new Date(agent.podInventoryAt).toISOString()) : '— (waiting for agent heartbeat)'}</td></tr>
      </table>
      <p class="muted" id="live-poll-hint">Live refresh every 3s from agent heartbeats (~10s).</p>
    </section>
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
    </section>`,
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
  const refreshTag =
    typeof autoRefresh === 'string' && autoRefresh
      ? `<meta http-equiv="refresh" content="15;url=${esc(autoRefresh)}" />`
      : autoRefresh
        ? '<meta http-equiv="refresh" content="15" />'
        : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${refreshTag}
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
  ${script}
</body>
</html>`;
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
  mode: 'agent' | 'pod';
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
    if (s === 'Running' || s === 'Succeeded' || s === 'Completed') return 'ok';
    if (/CrashLoop|ImagePull|ErrImage|OOM|Error|Failed|Evicted|BackOff/i.test(s)) return 'crit';
    if (s === 'Pending' || s === 'ContainerCreating' || s === 'Terminating') return 'warn';
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
      if (data.podInventoryAt) setText('live-inventory-at', new Date(data.podInventoryAt).toISOString());
      if (data.lastHeartbeatAt) setText('live-heartbeat', new Date(data.lastHeartbeatAt).toISOString());
      if (data.status) setHtml('live-agent-status', badge(data.status));
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
