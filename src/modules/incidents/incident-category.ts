import type { IncidentLike } from './incident-groups';

export type IncidentCategory =
  | 'docker'
  | 'pod'
  | 'deployment'
  | 'replicaset'
  | 'other';

export type DashboardCategoryTab = 'all' | IncidentCategory;

export function resourceKind(resource?: string | null): string {
  const r = (resource || '').trim().toLowerCase();
  const slash = r.indexOf('/');
  if (slash > 0) return r.slice(0, slash);
  return '';
}

export function inferIncidentCategory(i: IncidentLike): IncidentCategory {
  const kind = resourceKind(i.resource);
  if (kind === 'container') return 'docker';
  if (kind === 'pod') return 'pod';
  if (kind === 'deployment') return 'deployment';
  if (kind === 'replicaset') return 'replicaset';

  const meta = (i.metadata ?? {}) as Record<string, string>;
  if ((meta.source || '').toLowerCase() === 'docker') return 'docker';
  if (i.namespace) return 'pod';
  return 'other';
}

export function normalizeDashboardCategoryTab(
  raw?: string | null,
): DashboardCategoryTab {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'docker' || v === 'container' || v === 'containers') return 'docker';
  if (v === 'pod' || v === 'pods') return 'pod';
  if (v === 'deployment' || v === 'deployments' || v === 'deploy') {
    return 'deployment';
  }
  if (v === 'replicaset' || v === 'replicasets' || v === 'rs') {
    return 'replicaset';
  }
  if (v === 'other') return 'other';
  return 'all';
}

export function filterIncidentsByCategory(
  incidents: IncidentLike[],
  category: DashboardCategoryTab,
): IncidentLike[] {
  if (category === 'all') return incidents;
  return incidents.filter((i) => inferIncidentCategory(i) === category);
}

export function categoryTabLabel(category: DashboardCategoryTab): string {
  switch (category) {
    case 'docker':
      return 'Docker';
    case 'pod':
      return 'Pods';
    case 'deployment':
      return 'Deployments';
    case 'replicaset':
      return 'ReplicaSets';
    case 'other':
      return 'Other';
    default:
      return 'All';
  }
}
