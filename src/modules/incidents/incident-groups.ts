/**
 * Group raw incidents into readable issue rows for the dashboard.
 * Key: cluster + namespace + resource + type
 */

import { isDashboardAuditOnly } from './pod-history';

export type IncidentLike = {
  id: string;
  type: string;
  severity: string;
  reason?: string | null;
  message?: string | null;
  namespace?: string | null;
  resource?: string | null;
  occurredAt: Date | string;
  suggestedFix?: string | null;
  snapshot?: unknown;
  metadata?: unknown;
  agent: { clusterName: string };
};

export type IncidentGroup = {
  key: string;
  type: string;
  severity: string;
  namespace: string;
  resource: string;
  clusterName: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Newest incident in the group (drives fix actions / detail link). */
  latest: IncidentLike;
  /** Older ids in the group (newest first after latest). */
  olderIds: string[];
};

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

export function incidentGroupKey(i: IncidentLike): string {
  return [
    i.agent.clusterName || '',
    i.namespace || '',
    i.resource || '',
    i.type || '',
  ].join('|');
}

/** Same workload identity without incident type (for collapsing warnings). */
function workloadKey(i: IncidentLike): string {
  return [i.agent.clusterName || '', i.namespace || '', i.resource || ''].join('|');
}

function podNameFromResource(resource?: string | null): string {
  const r = (resource || '').trim();
  if (r.startsWith('pod/')) return r.slice(4);
  return r;
}

/**
 * Collapse KubernetesWarning rows when a stronger pod incident already exists
 * for the same pod (CrashLoop / ImagePull / OOM).
 */
function isSuppressedWarning(
  i: IncidentLike,
  strongerWorkloads: Set<string>,
): boolean {
  if (i.type !== 'KubernetesWarning') return false;
  const wk = workloadKey(i);
  if (strongerWorkloads.has(wk)) return true;
  // Warning on pod/X while CrashLoop is also on pod/X
  const pod = podNameFromResource(i.resource);
  if (!pod) return false;
  for (const key of strongerWorkloads) {
    if (key.endsWith(`|pod/${pod}`) || key.endsWith(`|${pod}`)) return true;
  }
  return false;
}

const STRONGER_TYPES = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'OOMKilled',
]);

function metaString(metadata: unknown, key: string): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Create/rollout flash: Available=False / MinimumReplicasUnavailable that
 * recovered before the agent grace window. Never show these on the dashboard.
 * Sustained under-replication uses cause UnavailableReplicas (or ProgressDeadlineExceeded).
 */
export function isTransientReplicaNoise(i: IncidentLike): boolean {
  if (i.type !== 'DeploymentUnhealthy') return false;
  const cause =
    i.reason ||
    metaString(i.metadata, 'cause') ||
    metaString(i.metadata, 'conditionReason') ||
    '';
  return cause === 'MinimumReplicasUnavailable';
}

export function groupIncidents(incidents: IncidentLike[]): IncidentGroup[] {
  const stronger = new Set<string>();
  for (const i of incidents) {
    if (STRONGER_TYPES.has(i.type)) {
      stronger.add(workloadKey(i));
    }
  }

  const map = new Map<string, IncidentGroup>();

  // Input is usually newest-first; keep that order for "latest".
  for (const i of incidents) {
    if (isDashboardAuditOnly(i.type)) continue;
    if (isTransientReplicaNoise(i)) continue;
    if (isSuppressedWarning(i, stronger)) continue;

    const key = incidentGroupKey(i);
    const occurred = toDate(i.occurredAt);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        type: i.type,
        severity: i.severity,
        namespace: i.namespace || '—',
        resource: i.resource || '—',
        clusterName: i.agent.clusterName,
        count: 1,
        firstSeenAt: occurred,
        lastSeenAt: occurred,
        latest: i,
        olderIds: [],
      });
      continue;
    }

    existing.count += 1;
    if (occurred > existing.lastSeenAt) {
      existing.olderIds.unshift(existing.latest.id);
      existing.latest = i;
      existing.lastSeenAt = occurred;
      existing.severity = i.severity;
    } else {
      existing.olderIds.push(i.id);
      if (occurred < existing.firstSeenAt) {
        existing.firstSeenAt = occurred;
      }
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
}
