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

export type InventoryContainer = {
  name?: string;
  status?: string;
  health?: string;
};

export type AgentInventory = {
  clusterName: string;
  status?: string;
  podInventory?: unknown;
  containerInventory?: unknown;
};

/** Incident types that count as active failures on the main board. */
export const DASHBOARD_FAILURE_TYPES = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'OOMKilled',
  'DeploymentUnhealthy',
  'KubernetesWarning',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
]);

/** Docker-host incident types shown on the dashboard. */
export const DOCKER_DASHBOARD_FAILURE_TYPES = new Set([
  'ContainerExited',
  'ContainerUnhealthy',
  'ContainerRestartLoop',
  'ContainerOOMKilled',
]);

const HEALTHY_CONTAINER_STATUSES = new Set([
  'running',
  'created',
  'paused',
  'removing',
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

function parseContainers(raw: unknown): InventoryContainer[] {
  return Array.isArray(raw) ? (raw as InventoryContainer[]) : [];
}

/** True when container inventory status indicates an active failure. */
export function isKnownFailureContainerStatus(
  status?: string | null,
  health?: string | null,
): boolean {
  const h = (health || '').trim().toLowerCase();
  if (h === 'unhealthy') return true;
  const s = (status || '').trim().toLowerCase();
  if (!s || HEALTHY_CONTAINER_STATUSES.has(s)) return false;
  return /exited|dead|restarting|unhealthy|oom/.test(s);
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

function containerKey(cluster: string, name: string): string {
  return `${cluster}|${name}`;
}

export function buildLiveDockerFailureIndex(
  agents: AgentInventory[],
): Set<string> {
  const failing = new Set<string>();
  for (const agent of agents) {
    if (agent.status === 'revoked') continue;
    const cluster = agent.clusterName || '';
    for (const c of parseContainers(agent.containerInventory)) {
      const name = (c.name || '').trim();
      if (!name) continue;
      if (!isKnownFailureContainerStatus(c.status, c.health)) continue;
      failing.add(containerKey(cluster, name));
    }
  }
  return failing;
}

/**
 * Keep docker failure incidents tied to containers that still exist and are
 * failing in the latest container inventory.
 */
export function filterLiveDockerFailureIncidents(
  incidents: IncidentLike[],
  agents: AgentInventory[],
): IncidentLike[] {
  const failing = buildLiveDockerFailureIndex(agents);
  if (failing.size === 0) return [];

  return incidents.filter((i) => {
    if (!DOCKER_DASHBOARD_FAILURE_TYPES.has(i.type)) return false;
    const cluster = i.agent?.clusterName || '';
    if (!cluster) return false;
    const { kind, name } = resourceKindName(i.resource);
    if (kind !== 'container' || !name) return false;
    return failing.has(containerKey(cluster, name));
  });
}
