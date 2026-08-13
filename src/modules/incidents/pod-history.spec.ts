import {
  inferDeploymentFromPodName,
  incidentBelongsToPod,
  isDashboardAuditOnly,
  podHistoryResourceMatchers,
} from './pod-history';

describe('pod-history', () => {
  it('marks DeploymentRollout as dashboard audit-only', () => {
    expect(isDashboardAuditOnly('DeploymentRollout')).toBe(true);
    expect(isDashboardAuditOnly('CrashLoopBackOff')).toBe(false);
  });

  it('infers deployment name from ReplicaSet pod name', () => {
    expect(inferDeploymentFromPodName('demo-healthy-a-58b687cb5-mvlvt')).toBe(
      'demo-healthy-a',
    );
    expect(inferDeploymentFromPodName('demo-healthy-c-698b7fd778-9v9vn')).toBe(
      'demo-healthy-c',
    );
    expect(inferDeploymentFromPodName('short')).toBeNull();
  });

  it('builds resource matchers for pod + owner deployment', () => {
    expect(podHistoryResourceMatchers('demo-healthy-b-7fddb899d9-9jf7t')).toEqual([
      'pod/demo-healthy-b-7fddb899d9-9jf7t',
      'demo-healthy-b-7fddb899d9-9jf7t',
      'deployment/demo-healthy-b',
      'demo-healthy-b',
    ]);
  });

  it('matches pod and related deployment incidents', () => {
    const ns = 'opspilot-demo';
    const pod = 'demo-healthy-a-58b687cb5-mvlvt';
    expect(
      incidentBelongsToPod(
        { namespace: ns, resource: 'pod/demo-healthy-a-58b687cb5-mvlvt' },
        ns,
        pod,
      ),
    ).toBe(true);
    expect(
      incidentBelongsToPod(
        { namespace: ns, resource: 'deployment/demo-healthy-a' },
        ns,
        pod,
      ),
    ).toBe(true);
    expect(
      incidentBelongsToPod(
        { namespace: ns, resource: 'deployment/demo-healthy-b' },
        ns,
        pod,
      ),
    ).toBe(false);
    expect(
      incidentBelongsToPod(
        { namespace: 'other', resource: 'pod/demo-healthy-a-58b687cb5-mvlvt' },
        ns,
        pod,
      ),
    ).toBe(false);
  });
});
