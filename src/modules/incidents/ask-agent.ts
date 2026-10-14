/**
 * Ask-agent chat: LLM analyzes the incident, then emits clickable chips.
 * Apply still maps to allowlisted agent actions after the operator confirms.
 */

import {
  MEMORY_PRESETS,
  isValidImageRef,
  isValidMemoryQuantity,
  resolveApplyPrefill,
  resolveDeploymentTarget,
  resolveContainerTarget,
  type ApplyPrefill,
  type AutoFixIncident,
} from './auto-fix';

export { isDockerContainerIncident, resolveContainerTarget } from './auto-fix';

export const ASK_OPEN_PROMPT =
  'Analyze this incident. Explain what is failing and why. Then recommend safe remediations I can apply after I confirm.';

export const ASK_LLM_ACTIONS = [
  'set_image',
  'set_memory',
  'restart',
  'scale',
] as const;

export type AskLlmAction = (typeof ASK_LLM_ACTIONS)[number];

export type AskOption = {
  id: string;
  action: AskLlmAction;
  label: string;
  detail: string;
  params: Record<string, string>;
  needsInput?: 'image' | 'memory' | 'replicas';
};

export type AskAgentSession = {
  incidentId?: string;
  agentId?: string;
  /** kubernetes (default) or docker-host container incidents. */
  platform?: 'kubernetes' | 'docker';
  type: string;
  namespace: string;
  deployment: string;
  problem: string;
  opener: string;
  options: AskOption[];
  prefill: ApplyPrefill;
  facts: string;
  evidence: string;
};

function metaField(metadata: unknown, key: string): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }
  const v = (metadata as Record<string, unknown>)[key];
  return v != null && String(v).trim() ? String(v).trim() : '';
}

export function buildAskAgentSession(
  incident: AutoFixIncident,
  prefill: ApplyPrefill,
): AskAgentSession {
  const type = (incident.type || '').trim();
  const containerTarget = resolveContainerTarget(incident);
  if (containerTarget) {
    const exitCode = metaField(incident.metadata, 'exitCode');
    const image = prefill.currentImage || metaField(incident.metadata, 'image');
    const kubeMessage = (incident.message || '').trim();
    const evidence =
      kubeMessage ||
      metaField(incident.metadata, 'status') ||
      (incident.reason || '').trim();
    const problem = [
      `${type || 'Incident'} on Docker host ${containerTarget.host}, container ${containerTarget.container}.`,
      image ? `Image: ${image}.` : '',
      exitCode ? `Exit code: ${exitCode}.` : '',
      evidence ? `Detail: ${evidence}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const facts = [
      'platform=docker',
      `host=${containerTarget.host}`,
      `container=${containerTarget.container}`,
      `service=${containerTarget.service}`,
      type ? `type=${type}` : '',
      image ? `image=${image}` : '',
      exitCode ? `exitCode=${exitCode}` : '',
      kubeMessage ? `message=${kubeMessage.slice(0, 400)}` : '',
      incident.suggestedFix
        ? `storedSuggestion=${String(incident.suggestedFix).slice(0, 400)}`
        : '',
      incident.reason ? `reason=${String(incident.reason).slice(0, 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      type,
      platform: 'docker',
      namespace: containerTarget.host,
      deployment: containerTarget.container,
      problem,
      opener: '',
      options: [],
      prefill,
      facts,
      evidence,
    };
  }

  const target = resolveDeploymentTarget(incident);
  const ns = target.namespace;
  const deploy = target.deployment || '—';
  const container = prefill.container || target.container || 'app';
  const waitingMessage = metaField(incident.metadata, 'waitingMessage');
  const kubeMessage = (incident.message || '').trim();
  const evidence = waitingMessage || kubeMessage || (incident.reason || '').trim();
  const problem = [
    `${type || 'Incident'} on ${ns}/${deploy} container ${container}.`,
    prefill.currentImage ? `Current image: ${prefill.currentImage}.` : '',
    prefill.memoryLimit ? `Memory limit: ${prefill.memoryLimit}.` : '',
    prefill.desiredReplicas
      ? `Desired replicas: ${prefill.desiredReplicas}.`
      : '',
    evidence ? `Kubernetes: ${evidence}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const facts = [
    `type=${type || 'unknown'}`,
    `namespace=${ns}`,
    `deployment=${deploy}`,
    `container=${container}`,
    prefill.currentImage ? `image=${prefill.currentImage}` : '',
    prefill.memoryLimit ? `memoryLimit=${prefill.memoryLimit}` : '',
    prefill.memoryRequest ? `memoryRequest=${prefill.memoryRequest}` : '',
    prefill.desiredReplicas ? `desiredReplicas=${prefill.desiredReplicas}` : '',
    waitingMessage ? `waitingMessage=${waitingMessage.slice(0, 400)}` : '',
    kubeMessage ? `kubeMessage=${kubeMessage.slice(0, 400)}` : '',
    incident.suggestedFix
      ? `storedSuggestion=${String(incident.suggestedFix).slice(0, 400)}`
      : '',
    incident.reason ? `reason=${String(incident.reason).slice(0, 300)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    type,
    platform: 'kubernetes',
    namespace: ns,
    deployment: deploy,
    problem,
    opener: '',
    options: [],
    prefill,
    facts,
    evidence,
  };
}

export function sanitizeLlmOptions(
  raw: unknown,
  prefill: ApplyPrefill,
): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const container = prefill.container || 'app';
  const out: AskOption[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const nested =
      rec.params && typeof rec.params === 'object' && !Array.isArray(rec.params)
        ? (rec.params as Record<string, unknown>)
        : {};
    const action = String(rec.action || '').trim() as AskLlmAction;
    if (!ASK_LLM_ACTIONS.includes(action)) continue;
    const label = String(rec.label || '').trim().slice(0, 80);
    if (!label) continue;
    const detail = String(rec.detail || label).trim().slice(0, 240);
    const id = `${action}_${out.length}`;
    const wantsInput = rec.needsInput === true || rec.needsInput === 'true';

    if (action === 'set_image') {
      const image = String(rec.image || rec.value || nested.image || '').trim();
      if (image && isValidImageRef(image)) {
        out.push({
          id,
          action,
          label,
          detail,
          params: { container, image },
        });
      } else if (!image || wantsInput) {
        out.push({
          id,
          action,
          label: label || 'Set a custom image…',
          detail: detail || 'Type registry/app:tag, then confirm apply.',
          params: { container },
          needsInput: 'image',
        });
      }
      continue;
    }

    if (action === 'set_memory') {
      const memory = String(
        rec.memoryLimit || rec.value || nested.memoryLimit || '',
      ).trim();
      if (memory && isValidMemoryQuantity(memory)) {
        out.push({
          id,
          action,
          label,
          detail,
          params: {
            container,
            memoryLimit: memory,
            memoryRequest: memory,
          },
        });
      } else if (!memory || wantsInput) {
        out.push({
          id,
          action,
          label: label || 'Choose a memory size…',
          detail:
            detail ||
            `Pick from ${MEMORY_PRESETS.join(', ')} or type a value like 768Mi.`,
          params: { container },
          needsInput: 'memory',
        });
      }
      continue;
    }

    if (action === 'restart') {
      out.push({
        id,
        action,
        label,
        detail: detail || 'Rollout restart — recreate pods after you confirm.',
        params: { deployAction: 'restart' },
      });
      continue;
    }

    if (action === 'scale') {
      const replicas = String(
        rec.replicas || rec.value || nested.replicas || '',
      ).trim();
      if (replicas && /^\d+$/.test(replicas)) {
        out.push({
          id,
          action,
          label,
          detail,
          params: { deployAction: 'scale', replicas },
        });
      } else {
        out.push({
          id,
          action,
          label: label || 'Scale replicas…',
          detail: detail || 'Set desired replica count (0–50), then confirm.',
          params: { deployAction: 'scale' },
          needsInput: 'replicas',
        });
      }
    }
  }
  return out;
}

export function resolveAskOptionParams(
  opt: AskOption,
  userInput?: string,
): Record<string, string> {
  const params = { ...opt.params };
  const raw = (userInput || '').trim();

  if (opt.needsInput === 'image') {
    if (!raw) throw new Error('Image is required');
    if (!isValidImageRef(raw)) throw new Error('Invalid image reference');
    params.image = raw;
  }
  if (opt.needsInput === 'memory') {
    if (!raw) throw new Error('Memory size is required');
    if (!isValidMemoryQuantity(raw)) {
      throw new Error('Invalid memory size (use e.g. 512Mi or 1Gi)');
    }
    params.memoryLimit = raw;
    params.memoryRequest = raw;
  }
  if (opt.needsInput === 'replicas') {
    if (!raw) throw new Error('Replica count is required');
    params.replicas = raw;
    params.deployAction = 'scale';
  }

  params.acknowledge = '1';
  return params;
}

export function parseAskOptionPayload(
  body: {
    option?: Record<string, unknown>;
    optionId?: string;
    userInput?: string;
  },
  sessionOptions: AskOption[],
  prefill: ApplyPrefill,
): AskOption {
  if (body.option && body.option.action) {
    const sanitized = sanitizeLlmOptions([body.option], prefill);
    if (!sanitized[0]) throw new Error('Unsupported or invalid option');
    return sanitized[0];
  }
  const found = sessionOptions.find((o) => o.id === body.optionId);
  if (!found) throw new Error('Unknown option');
  return found;
}

export function buildAskSessionFromIncident(
  incident: AutoFixIncident,
): AskAgentSession {
  return buildAskAgentSession(incident, resolveApplyPrefill(incident));
}

export type AskChatMessage = { role: 'user' | 'assistant'; content: string };

export type AskChatPropose = {
  optionId: string;
  userInput?: string;
};

export type AskChatSource = 'cursor-mcp' | 'openai' | 'evidence';

export type AskChatResult = {
  reply: string;
  propose: AskChatPropose | null;
  options: AskOption[];
  source?: AskChatSource;
};

/** Live events while Cursor + MCP runs (SSE to the dashboard). */
export type AskStreamEvent =
  | { type: 'status'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      name: string;
      status: 'running' | 'completed' | 'error';
      callId?: string;
    }
  | { type: 'done'; result: AskChatResult }
  | { type: 'error'; message: string };

export function parseAskChatLlmJson(
  raw: string,
  prefill: ApplyPrefill,
): AskChatResult | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      reply?: unknown;
      options?: unknown;
      propose?: { optionId?: unknown; userInput?: unknown } | null;
    };
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    if (!reply) return null;
    const options = sanitizeLlmOptions(parsed.options, prefill);
    let propose: AskChatPropose | null = null;
    const optId =
      parsed.propose && typeof parsed.propose.optionId === 'string'
        ? parsed.propose.optionId
        : '';
    if (optId && options.some((o) => o.id === optId)) {
      propose = {
        optionId: optId,
        userInput:
          parsed.propose && typeof parsed.propose.userInput === 'string'
            ? parsed.propose.userInput
            : undefined,
      };
    }
    return { reply, propose, options };
  } catch {
    return null;
  }
}

/** Local replies when the LLM is unavailable — still explains and offers chips. */
export function fallbackOptionsFromFacts(session: AskAgentSession): AskOption[] {
  if (session.platform === 'docker') {
    const image = (session.prefill.currentImage || '').trim();
    const raw: unknown[] = [
      {
        action: 'restart',
        label: `Restart ${session.deployment}`,
        detail: 'Start or restart the container on this Docker host.',
      },
    ];
    if (image) {
      raw.push({
        action: 'set_image',
        label: `Recreate with ${image}`,
        detail: `Recreate container ${session.deployment} using image ${image}.`,
        image,
      });
    }
    raw.push({
      action: 'set_image',
      label: 'Set a custom image…',
      needsInput: true,
    });
    return sanitizeLlmOptions(raw, session.prefill);
  }

  const type = (session.type || '').toLowerCase();
  const prefill = session.prefill;
  const bump = prefill.suggestedMemoryLimit || '256Mi';
  const image = (prefill.currentImage || '').trim();
  const raw: unknown[] = [];

  if (type.includes('oom')) {
    raw.push({
      action: 'set_memory',
      label: `Raise memory to ${bump}`,
      detail: `The container is hitting its memory limit (${prefill.memoryLimit || 'unknown'}). Raise limit/request to ${bump}.`,
      memoryLimit: bump,
    });
    raw.push({
      action: 'set_memory',
      label: 'Choose another memory size…',
      needsInput: true,
    });
  } else if (type.includes('imagepull') || type.includes('errimage')) {
    const good =
      !image || /invalid|does-not-exist|404|notfound/i.test(image)
        ? 'nginx:1.27-alpine'
        : image;
    raw.push({
      action: 'set_image',
      label: `Set image to ${good}`,
      detail: `Current image ${image || 'unknown'} cannot be pulled.`,
      image: good,
    });
    raw.push({
      action: 'set_image',
      label: 'Set a custom image…',
      needsInput: true,
    });
  } else {
    raw.push({
      action: 'restart',
      label: 'Restart deployment',
      detail: 'Rollout restart to recreate pods after you confirm.',
    });
    raw.push({
      action: 'scale',
      label: 'Scale replicas…',
      needsInput: true,
    });
  }

  return sanitizeLlmOptions(raw, prefill);
}

function quotedObjectNames(blob: string, kind: 'secret' | 'configmap'): string[] {
  const re = new RegExp(`${kind}\\s+"([^"]+)"`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob || ''))) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function fallbackCauseReply(session: AskAgentSession): string {
  const type = (session.type || '').toLowerCase();
  if (session.platform === 'docker') {
    if (type.includes('oom')) {
      return `${session.problem}\n\nThe container was OOM-killed by the Docker host. Check memory limits (\`docker update --memory\`) and recent logs for spikes.`;
    }
    if (type.includes('unhealthy')) {
      return `${session.problem}\n\nThe container health check is failing. Inspect logs and the Dockerfile HEALTHCHECK — restart alone may not fix a bad probe or dependency.`;
    }
    if (type.includes('restart')) {
      return `${session.problem}\n\nThe container is in a restart loop. Check logs for the crash reason before restarting again.`;
    }
    if (type.includes('exited')) {
      return `${session.problem}\n\nThe container process exited. Review logs for the exit code, fix the underlying command or dependency, then start the container again.`;
    }
    return `${session.problem}\n\nThis Docker container is not healthy. Review logs and the image configuration on host ${session.namespace}.`;
  }
  if (type.includes('oom')) {
    return `${session.problem}\n\nThe kernel killed the container (exit 137) because it used more RAM than the limit. Evidence: memory limit ${session.prefill.memoryLimit || '16Mi'} on ${session.namespace}/${session.deployment}. Raising memory is the allowlisted fix.`;
  }
  if (type.includes('imagepull') || type.includes('errimage')) {
    return `${session.problem}\n\nKubernetes cannot pull the image, so the pod never starts. Evidence: image ${session.prefill.currentImage || 'unknown'}. Point the container at a real tag to recover.`;
  }
  if (type.includes('createcontainer') || type.includes('invalidimage')) {
    const ev = session.evidence || session.type;
    return `${session.problem}\n\nThe container never started because kubelet rejected the config. Kubernetes said: ${ev}. Restart will not create a missing Secret or ConfigMap — fix or create that object, then the pod can start.`;
  }
  if (type.includes('crash')) {
    return `${session.problem}\n\nThe process is exiting and Kubernetes is restarting it. Evidence: CrashLoop on ${session.namespace}/${session.deployment}. A restart/scale will not fix a bad command; it can unstick the rollout.`;
  }
  return `${session.problem}\n\nThe deployment is not healthy. Evidence is in the incident type, image, and memory fields above.`;
}

function withLive(session: AskAgentSession, liveInspect: string, closer: string): string {
  const live = liveInspect.trim()
    ? `\n\nLive cluster inspect:\n${liveInspect.trim().slice(0, 900)}`
    : '';
  return `${fallbackCauseReply(session)}${live}\n\n${closer}`;
}

export function fallbackAskChatReply(
  session: AskAgentSession,
  userMessage: string,
  liveInspect = '',
): AskChatResult {
  const q = (userMessage || '').trim().toLowerCase();
  const options = fallbackOptionsFromFacts(session);
  const ownBlob = `${session.facts}\n${session.evidence}\n${session.problem}`;
  const allBlob = `${ownBlob}\n${liveInspect}`;
  const analyzing =
    /analyze this incident/.test(q) || q === ASK_OPEN_PROMPT.toLowerCase();

  if (/\b(secret|configmap)s?\b/.test(q)) {
    const ownSecrets = quotedObjectNames(ownBlob, 'secret');
    const inspectSecrets = quotedObjectNames(allBlob, 'secret');
    if (ownSecrets.length) {
      return {
        reply: `Yes. Kubernetes cannot start this container because Secret "${ownSecrets[0]}" is missing. Restart will not create it — create or attach that Secret, then the pod can start.`,
        propose: null,
        options,
      };
    }
    if (inspectSecrets.length) {
      return {
        reply: `Secret "${inspectSecrets[0]}" is not this incident. This chat is ${session.type} on ${session.namespace}/${session.deployment}. That Secret error is another pod in the namespace. This workload failed because: ${session.evidence || session.type}.`,
        propose: null,
        options,
      };
    }
    return {
      reply: `There is no missing Secret on ${session.namespace}/${session.deployment}. This incident is ${session.type}: ${session.evidence || 'the container exceeded its memory limit (OOMKilled, exit 137)'}.`,
      propose: null,
      options,
    };
  }

  if (
    analyzing ||
    !q ||
    /^(hi|hello|hey)\b/.test(q) ||
    /\b(issue|problem|wrong|happen|why|what'?s|whats|explain|mean|cause|evidence)\b/.test(
      q,
    )
  ) {
    const closer =
      session.platform === 'docker'
        ? 'Click a chip below, then confirm. The docker-host agent will run the fix on this machine.'
        : 'Click a chip below, then confirm. I will not change the cluster until you confirm.';
    return {
      reply: withLive(session, liveInspect, closer),
      propose: null,
      options,
    };
  }

  return {
    reply: `${session.type} on ${session.namespace}/${session.deployment}: ${session.evidence || session.problem} Ask about this workload, or use a chip to apply an allowlisted fix.`,
    propose: null,
    options,
  };
}
