/**
 * Pod / workload history helpers for agent drill-down (not the main incident board).
 */

/** Types kept in DB but hidden from the main dashboard issues table. */
export const DASHBOARD_AUDIT_ONLY_TYPES = new Set(['DeploymentRollout']);

export function isDashboardAuditOnly(type: string): boolean {
  return DASHBOARD_AUDIT_ONLY_TYPES.has(type);
}

/**
 * Infer owning Deployment name from a ReplicaSet-managed pod name.
 * e.g. demo-healthy-a-58b687cb5-mvlvt → demo-healthy-a
 */
export function inferDeploymentFromPodName(podName: string): string | null {
  const name = (podName || '').trim();
  if (!name) return null;
  const parts = name.split('-');
  if (parts.length < 3) return null;
  const podSuffix = parts[parts.length - 1];
  const rsHash = parts[parts.length - 2];
  // Pod template hash is typically 8–10 chars; random pod suffix ~5.
  if (!/^[a-z0-9]+$/i.test(podSuffix) || podSuffix.length < 4 || podSuffix.length > 6) {
    return null;
  }
  if (!/^[a-z0-9]+$/i.test(rsHash) || rsHash.length < 6 || rsHash.length > 14) {
    return null;
  }
  const deploy = parts.slice(0, -2).join('-');
  return deploy || null;
}

/** Resource strings to match when building a pod's event timeline. */
export function podHistoryResourceMatchers(
  podName: string,
  deploymentName?: string | null,
): string[] {
  const deploy = deploymentName ?? inferDeploymentFromPodName(podName);
  const out = [`pod/${podName}`, podName];
  if (deploy) {
    out.push(`deployment/${deploy}`, deploy);
  }
  return out;
}

export function incidentBelongsToPod(
  incident: { namespace?: string | null; resource?: string | null },
  namespace: string,
  podName: string,
  deploymentName?: string | null,
): boolean {
  if ((incident.namespace || '') !== namespace) return false;
  const resource = (incident.resource || '').trim();
  if (!resource) return false;
  const matchers = podHistoryResourceMatchers(podName, deploymentName);
  return matchers.some((m) => resource === m || resource.endsWith(`/${m}`));
}
