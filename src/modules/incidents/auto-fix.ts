/**
 * Suggestion actions + structured agent remediation plans.
 * Apply flow: user chooses params → confirm → agent patches Deployment in-cluster.
 */

export const APPLY_FIX_TYPES = new Set([
  'OOMKilled',
  'ImagePullBackOff',
  'DeploymentUnhealthy',
]);

export const MEMORY_PRESETS = ['256Mi', '512Mi', '1Gi', '2Gi'] as const;

const MEMORY_RE = /^\d+(Mi|Gi|M|G)$/;
const IMAGE_RE = /^[a-z0-9._\-\/:@+]+$/i;

export type AutoFixIncident = {
  type?: string | null;
  reason?: string | null;
  namespace?: string | null;
  resource?: string | null;
  suggestedFix?: string | null;
  metadata?: unknown;
  snapshot?: unknown;
};

export type ApplyPrefill = {
  container: string;
  currentImage: string;
  /** Suggested replacement image (empty unless we have a safe default). */
  newImage: string;
  memoryLimit: string;
  memoryRequest: string;
  /** Prefill for the memory limit select / custom field. */
  suggestedMemoryLimit: string;
  /** Current desired replicas (DeploymentUnhealthy scale). */
  desiredReplicas: string;
  source: 'snapshot' | 'metadata' | 'cluster' | 'none';
};

export type AutoFixCommand = {
  label: string;
  command: string;
  /** dry-run = inspect only; apply = mutates cluster if the operator runs it. */
  kind: 'dry-run' | 'apply';
};

/** Row button kind: apply (confirm+preview) | view (advice) | none. */
export type SuggestionAction = 'apply' | 'view' | null;

const PLACEHOLDER_FIXES = new Set([
  '',
  'generating…',
  'generating...',
  'generating suggestion…',
  'generating suggestion...',
  'ai not configured — set openai_api_key',
]);

function asMeta(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return metadata as Record<string, unknown>;
}

export function hasUsableSuggestion(suggestedFix: string | null | undefined): boolean {
  const text = (suggestedFix || '').trim();
  if (!text) return false;
  return !PLACEHOLDER_FIXES.has(text.toLowerCase());
}

function podName(resource?: string | null, metadata?: unknown): string {
  const m = asMeta(metadata);
  if (m.pod != null && String(m.pod)) return String(m.pod);
  const r = (resource || '').trim();
  if (r.startsWith('pod/')) return r.slice(4);
  if (r && !r.includes('/')) return r;
  return '';
}

function deploymentName(resource?: string | null, metadata?: unknown): string {
  const m = asMeta(metadata);
  if (m.deployment != null && String(m.deployment)) return String(m.deployment);
  const r = (resource || '').trim();
  if (r.startsWith('deployment/')) return r.slice('deployment/'.length);
  const pod = podName(resource, metadata);
  const m2 = pod.match(/^(.+)-[a-z0-9]{8,10}-[a-z0-9]{5}$/i);
  if (m2) return m2[1];
  return '';
}

function ctxFlag(): string {
  return '--context kind-opspilot-lab';
}

/**
 * Apply = concrete mutate ops the agent can run after user confirm.
 * View = advice-only (CrashLoop root-cause, Kubernetes warnings, etc.).
 */
export function getSuggestionAction(incident: AutoFixIncident): SuggestionAction {
  if (!hasUsableSuggestion(incident.suggestedFix)) return null;
  const type = (incident.type || '').trim();
  if (!APPLY_FIX_TYPES.has(type)) return 'view';
  // Need a deployment target for the mutate preview to be meaningful.
  if (!deploymentName(incident.resource, incident.metadata)) return 'view';
  return 'apply';
}

/** @deprecated use getSuggestionAction — kept for call-site clarity during transition. */
export function isAutoFixApplicable(incident: AutoFixIncident): boolean {
  return getSuggestionAction(incident) === 'apply';
}

/** Copyable kubectl steps (never executed by SaaS). */
export function buildAutoFixCommands(incident: AutoFixIncident): AutoFixCommand[] {
  const ns = (incident.namespace || 'default').trim() || 'default';
  const type = (incident.type || '').trim();
  const pod = podName(incident.resource, incident.metadata);
  const deploy = deploymentName(incident.resource, incident.metadata);
  const ctx = ctxFlag();
  const cmds: AutoFixCommand[] = [];

  if (pod) {
    cmds.push({
      label: 'Inspect recent logs (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} logs ${pod} --tail=100 --previous 2>/dev/null || kubectl ${ctx} -n ${ns} logs ${pod} --tail=100`,
    });
    cmds.push({
      label: 'Describe pod (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} describe pod ${pod}`,
    });
  }

  if (type === 'OOMKilled' && deploy) {
    cmds.push({
      label: 'Raise memory limit (apply — edit values first)',
      kind: 'apply',
      command: `kubectl ${ctx} -n ${ns} set resources deployment/${deploy} -c <container> --limits=memory=512Mi --requests=memory=256Mi`,
    });
  }

  if (type === 'ImagePullBackOff' && deploy) {
    cmds.push({
      label: 'Check image on deployment (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} get deploy ${deploy} -o jsonpath='{.spec.template.spec.containers[*].image}{"\\n"}'`,
    });
    cmds.push({
      label: 'Edit deployment image / pull secrets (apply)',
      kind: 'apply',
      command: `kubectl ${ctx} -n ${ns} edit deploy ${deploy}`,
    });
  }

  if (type === 'CrashLoopBackOff' && deploy) {
    cmds.push({
      label: 'Related deployment (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} get deploy ${deploy} -o wide`,
    });
  }

  if (type === 'DeploymentUnhealthy' && deploy) {
    cmds.push({
      label: 'Deployment status (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} get deploy ${deploy} -o wide`,
    });
    cmds.push({
      label: 'Describe deployment (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} describe deploy ${deploy}`,
    });
    cmds.push({
      label: 'Restart deployment (apply)',
      kind: 'apply',
      command: `kubectl ${ctx} -n ${ns} rollout restart deployment/${deploy}`,
    });
    cmds.push({
      label: 'Scale deployment (apply)',
      kind: 'apply',
      command: `kubectl ${ctx} -n ${ns} scale deployment/${deploy} --replicas=<N>`,
    });
  } else if (
    deploy &&
    type !== 'ImagePullBackOff' &&
    type !== 'OOMKilled' &&
    type !== 'CrashLoopBackOff'
  ) {
    cmds.push({
      label: 'Related deployment (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} get deploy ${deploy} -o wide`,
    });
  }

  if (cmds.length === 0) {
    cmds.push({
      label: 'List pods in namespace (dry-run)',
      kind: 'dry-run',
      command: `kubectl ${ctx} -n ${ns} get pods -o wide`,
    });
  }

  return cmds;
}

export function splitCommands(commands: AutoFixCommand[]): {
  dryRun: AutoFixCommand[];
  apply: AutoFixCommand[];
} {
  return {
    dryRun: commands.filter((c) => c.kind === 'dry-run'),
    apply: commands.filter((c) => c.kind === 'apply'),
  };
}

export function resolveDeploymentTarget(incident: AutoFixIncident): {
  namespace: string;
  deployment: string;
  container: string;
} {
  const prefill = resolveApplyPrefill(incident);
  const namespace = (incident.namespace || 'default').trim() || 'default';
  const deployment = deploymentName(incident.resource, incident.metadata);
  return {
    namespace,
    deployment,
    container: prefill.container,
  };
}

/** Prefill Apply form from incident snapshot / metadata (agent-captured). */
export function resolveApplyPrefill(incident: AutoFixIncident): ApplyPrefill {
  const m = asMeta(incident.metadata);
  const snap = asMeta(incident.snapshot);
  const snapContainer = asMeta(snap.container);

  const pick = (...vals: unknown[]): string => {
    for (const v of vals) {
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return '';
  };

  const container = pick(
    snapContainer.name,
    m.container,
    m.containerName,
  );
  const currentImage = pick(
    snapContainer.image,
    m.image,
    m.containerImage,
  );
  const memoryLimit = pick(snapContainer.memoryLimit, m.memoryLimit);
  const memoryRequest = pick(snapContainer.memoryRequest, m.memoryRequest);
  const desiredReplicas = pick(m.desired, m.replicas, snap.desired);

  let source: ApplyPrefill['source'] = 'none';
  if (snapContainer.name || snapContainer.image || snapContainer.memoryLimit) {
    source = 'snapshot';
  } else if (m.container || m.image || m.memoryLimit || m.desired) {
    source = 'metadata';
  }

  return {
    container,
    currentImage,
    newImage: '',
    memoryLimit,
    memoryRequest,
    suggestedMemoryLimit: suggestMemoryBump(memoryLimit) || '512Mi',
    desiredReplicas: desiredReplicas || '1',
    source,
  };
}

/** Merge cluster-live values on top of snapshot/metadata prefill. */
export function mergeClusterPrefill(
  base: ApplyPrefill,
  live: {
    container?: string;
    image?: string;
    memoryLimit?: string;
    memoryRequest?: string;
    replicas?: string | number;
  },
): ApplyPrefill {
  const container = (live.container || base.container || '').trim();
  const currentImage = (live.image || base.currentImage || '').trim();
  const memoryLimit = (live.memoryLimit || base.memoryLimit || '').trim();
  const memoryRequest = (live.memoryRequest || base.memoryRequest || '').trim();
  const desiredReplicas =
    live.replicas !== undefined && live.replicas !== null && String(live.replicas) !== ''
      ? String(live.replicas)
      : base.desiredReplicas;
  const touched = Boolean(
    live.container ||
      live.image ||
      live.memoryLimit ||
      live.memoryRequest ||
      (live.replicas !== undefined && live.replicas !== null),
  );
  return {
    container,
    currentImage,
    newImage: base.newImage,
    memoryLimit,
    memoryRequest,
    suggestedMemoryLimit:
      suggestMemoryBump(memoryLimit) || base.suggestedMemoryLimit || '512Mi',
    desiredReplicas: desiredReplicas || '1',
    source: touched ? 'cluster' : base.source,
  };
}

function suggestMemoryBump(current: string): string {
  const c = (current || '').trim();
  if (!c) return '';
  const m = c.match(/^(\d+)(Mi|Gi|M|G)$/);
  if (!m) return '';
  let n = Number(m[1]);
  let unit = m[2];
  if (unit === 'M') unit = 'Mi';
  if (unit === 'G') unit = 'Gi';
  // Rough 2× bump, then snap to a common preset when close.
  n = n * 2;
  if (unit === 'Mi' && n >= 1024) {
    n = Math.round(n / 1024);
    unit = 'Gi';
  }
  const candidate = `${n}${unit}`;
  for (const p of MEMORY_PRESETS) {
    if (p === candidate) return p;
  }
  // Prefer next preset above current when possible.
  const curMi = toMebibytes(c);
  for (const p of MEMORY_PRESETS) {
    if (toMebibytes(p) > curMi) return p;
  }
  return candidate;
}

function toMebibytes(q: string): number {
  const m = q.trim().match(/^(\d+)(Mi|Gi|M|G)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const u = m[2];
  if (u === 'Gi' || u === 'G') return n * 1024;
  return n;
}

export function isValidMemoryQuantity(value: string): boolean {
  return MEMORY_RE.test((value || '').trim());
}

export function isValidImageRef(value: string): boolean {
  const v = (value || '').trim();
  return v.length > 0 && v.length <= 255 && IMAGE_RE.test(v) && !v.includes(' ');
}

export type AgentFixPlan = {
  type:
    | 'set_deployment_memory'
    | 'set_deployment_image'
    | 'restart_deployment'
    | 'scale_deployment';
  params: Record<string, string>;
  summary: string;
};

/** Build an allowlisted agent op from user-chosen form values. */
export function buildAgentFixPlan(
  incident: AutoFixIncident,
  input: {
    memoryLimit?: string;
    memoryRequest?: string;
    container?: string;
    image?: string;
    deployAction?: string;
    replicas?: string;
  },
): AgentFixPlan {
  const action = getSuggestionAction(incident);
  if (action !== 'apply') {
    throw new Error('Incident is not eligible for agent apply');
  }
  const target = resolveDeploymentTarget(incident);
  if (!target.deployment) {
    throw new Error('Could not resolve deployment name');
  }
  const type = (incident.type || '').trim();

  if (type === 'DeploymentUnhealthy') {
    const deployAction = (input.deployAction || '').trim();
    if (deployAction === 'restart') {
      return {
        type: 'restart_deployment',
        params: {
          namespace: target.namespace,
          deployment: target.deployment,
        },
        summary: `Restart deployment ${target.namespace}/${target.deployment}`,
      };
    }
    if (deployAction === 'scale') {
      const replicas = Number((input.replicas || '').trim());
      if (!Number.isInteger(replicas) || replicas < 0 || replicas > 50) {
        throw new Error('Replicas must be an integer between 0 and 50');
      }
      return {
        type: 'scale_deployment',
        params: {
          namespace: target.namespace,
          deployment: target.deployment,
          replicas: String(replicas),
        },
        summary: `Scale deployment ${target.namespace}/${target.deployment} to ${replicas} replicas`,
      };
    }
    throw new Error('Choose an action: restart or scale');
  }

  const container = (input.container || target.container || '').trim();
  if (!container) {
    throw new Error('Container name is required');
  }

  if (type === 'OOMKilled') {
    const memoryLimit = (input.memoryLimit || '').trim();
    if (!isValidMemoryQuantity(memoryLimit)) {
      throw new Error('Invalid memory limit (use e.g. 512Mi or 1Gi)');
    }
    let memoryRequest = (input.memoryRequest || '').trim();
    if (!memoryRequest) {
      memoryRequest = memoryLimit;
    }
    if (!isValidMemoryQuantity(memoryRequest)) {
      throw new Error('Invalid memory request');
    }
    return {
      type: 'set_deployment_memory',
      params: {
        namespace: target.namespace,
        deployment: target.deployment,
        container,
        memoryLimit,
        memoryRequest,
      },
      summary: `Set ${target.namespace}/${target.deployment} container ${container} memory limit=${memoryLimit} request=${memoryRequest}`,
    };
  }

  if (type === 'ImagePullBackOff') {
    const image = (input.image || '').trim();
    if (!isValidImageRef(image)) {
      throw new Error('Invalid image reference');
    }
    return {
      type: 'set_deployment_image',
      params: {
        namespace: target.namespace,
        deployment: target.deployment,
        container,
        image,
      },
      summary: `Set ${target.namespace}/${target.deployment} container ${container} image=${image}`,
    };
  }

  throw new Error(`Unsupported apply type: ${type}`);
}
