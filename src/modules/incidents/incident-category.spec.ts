import {
  categoryTabLabel,
  filterIncidentsByCategory,
  inferIncidentCategory,
  normalizeDashboardCategoryTab,
  resourceKind,
} from './incident-category';
import type { IncidentLike } from './incident-groups';

describe('incident-category', () => {
  const base = (over: Partial<IncidentLike>): IncidentLike => ({
    id: '1',
    type: 'x',
    severity: 'warning',
    occurredAt: new Date(),
    agent: { clusterName: 'lab' },
    ...over,
  });

  it('parses resource kinds', () => {
    expect(resourceKind('pod/demo-a')).toBe('pod');
    expect(resourceKind('container/foo')).toBe('container');
    expect(resourceKind('deployment/demo-b')).toBe('deployment');
  });

  it('infers categories from resource', () => {
    expect(
      inferIncidentCategory(base({ resource: 'container/web' })),
    ).toBe('docker');
    expect(
      inferIncidentCategory(base({ resource: 'pod/demo-a', namespace: 'ns' })),
    ).toBe('pod');
    expect(
      inferIncidentCategory(
        base({ resource: 'deployment/demo-b', namespace: 'ns' }),
      ),
    ).toBe('deployment');
    expect(
      inferIncidentCategory(
        base({ resource: 'replicaset/demo-rs', namespace: 'ns' }),
      ),
    ).toBe('replicaset');
  });

  it('normalizes tab query values', () => {
    expect(normalizeDashboardCategoryTab(undefined)).toBe('all');
    expect(normalizeDashboardCategoryTab('pods')).toBe('pod');
    expect(normalizeDashboardCategoryTab('docker')).toBe('docker');
  });

  it('filters by category tab', () => {
    const list = [
      base({ id: '1', resource: 'pod/a', namespace: 'ns' }),
      base({ id: '2', resource: 'container/b' }),
    ];
    expect(filterIncidentsByCategory(list, 'pod')).toHaveLength(1);
    expect(filterIncidentsByCategory(list, 'docker')).toHaveLength(1);
    expect(categoryTabLabel('pod')).toBe('Pods');
  });
});
