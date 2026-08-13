/**
 * Dashboard incident list: only failures on pods that still exist in inventory.
 */

import { inferDeploymentFromPodName } from './pod-history';
import type { IncidentLike } from './incident-groups';

export type InventoryPod = {
  namespace?: string;
  name?: string;
  status?: string;
};

export type AgentInventory = {
  clusterName: string;
  status?: string;
  podInventory?: unknown;
};

/** Incident types that count as active failures on the main board. */
export const DASHBOARD_FAILURE_TYPES = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'OOMKilled',
  'DeploymentUnhealthy',
  'KubernetesWarning',
]);

const HEALTHY_STATUSES = new Set([
  'Running',
  'Succeeded',
  'Completed',
  'Pending',
  'ContainerCreating',
  'PodInitializing',
  'Terminating',
]);

/** True when inventory status indicates the pod is currently failing. */
export function isKnownFailurePodStatus(status?: string | null): boolean {
  const s = (status || '').trim();
  if (!s || HEALTHY_STATUSES.has(s)) return false;
  return /CrashLoop|ImagePull|ErrImage|OOM|Error|InvalidImage|CreateContainerConfig|RunContainerError|Failed|Evicted|BackOff/i.test(
    s,
  );
}

function parsePods(raw: unknown): InventoryPod[] {
  return Array.isArray(raw) ? (raw as InventoryPod[]) : [];
}

export type LiveFailureIndex = {
  /** cluster|namespace|podName */
  failingPods: Set<string>;
  /** cluster|namespace|deploymentName — derived from failing pods */
  failingDeployments: Set<string>;
};

function key(cluster: string, ns: string, name: string): string {
  return `${cluster}|${ns}|${name}`;
}

export function buildLiveFailureIndex(agents: AgentInventory[]): LiveFailureIndex {
  const failingPods = new Set<string>();
  const failingDeployments = new Set<string>();

  for (const agent of agents) {
    if (agent.status === 'revoked') continue;
    const cluster = agent.clusterName || '';
    for (const p of parsePods(agent.podInventory)) {
      const ns = (p.namespace || '').trim();
      const name = (p.name || '').trim();
      if (!ns || !name) continue;
      if (!isKnownFailurePodStatus(p.status)) continue;
      failingPods.add(key(cluster, ns, name));
      const deploy = inferDeploymentFromPodName(name);
      if (deploy) {
        failingDeployments.add(key(cluster, ns, deploy));
      }
    }
  }

  return { failingPods, failingDeployments };
}

function resourceKindName(resource?: string | null): { kind: string; name: string } {
  const r = (resource || '').trim();
  const slash = r.indexOf('/');
  if (slash > 0) {
    return { kind: r.slice(0, slash).toLowerCase(), name: r.slice(slash + 1) };
  }
  // Bare name — treat as pod for matching.
  return { kind: 'pod', name: r };
}

/**
 * Keep only failure-type incidents tied to pods (or their deployments) that
 * currently exist and are failing in agent inventory.
 */
export function filterLiveFailureIncidents(
  incidents: IncidentLike[],
  agents: AgentInventory[],
): IncidentLike[] {
  const index = buildLiveFailureIndex(agents);
  if (index.failingPods.size === 0 && index.failingDeployments.size === 0) {
    return [];
  }

  return incidents.filter((i) => {
    if (!DASHBOARD_FAILURE_TYPES.has(i.type)) return false;
    const cluster = i.agent?.clusterName || '';
    const ns = (i.namespace || '').trim();
    if (!cluster || !ns) return false;
    const { kind, name } = resourceKindName(i.resource);
    if (!name) return false;

    if (kind === 'pod' || kind === '') {
      return index.failingPods.has(key(cluster, ns, name));
    }
    if (kind === 'deployment') {
      return index.failingDeployments.has(key(cluster, ns, name));
    }
    // Other kinds (ReplicaSet, etc.): match if name equals a failing pod.
    return index.failingPods.has(key(cluster, ns, name));
  });
}
