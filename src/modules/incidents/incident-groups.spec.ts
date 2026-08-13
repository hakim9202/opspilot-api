import {
  groupIncidents,
  incidentGroupKey,
  isTransientReplicaNoise,
} from './incident-groups';

describe('incident-groups', () => {
  const base = {
    severity: 'critical',
    suggestedFix: 'Fix it',
    agent: { clusterName: 'opspilot-lab' },
  };

  it('groups by cluster+namespace+resource+type', () => {
    const groups = groupIncidents([
      {
        ...base,
        id: '1',
        type: 'CrashLoopBackOff',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-exit2-a',
        occurredAt: new Date('2026-08-05T10:00:00Z'),
        reason: 'Error (exit 2)',
      },
      {
        ...base,
        id: '2',
        type: 'CrashLoopBackOff',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-exit2-a',
        occurredAt: new Date('2026-08-05T09:00:00Z'),
        reason: 'Error (exit 2)',
      },
      {
        ...base,
        id: '3',
        type: 'DeploymentUnhealthy',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-exit2',
        occurredAt: new Date('2026-08-05T09:30:00Z'),
        severity: 'warning',
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe('CrashLoopBackOff');
    expect(groups[0].count).toBe(2);
    expect(groups[0].latest.id).toBe('1');
    expect(groups[0].olderIds).toEqual(['2']);
    expect(groups[1].type).toBe('DeploymentUnhealthy');
    expect(groups[1].count).toBe(1);
  });

  it('suppresses KubernetesWarning when CrashLoop exists for same pod', () => {
    const groups = groupIncidents([
      {
        ...base,
        id: 'c',
        type: 'CrashLoopBackOff',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-x',
        occurredAt: new Date('2026-08-05T10:00:00Z'),
      },
      {
        ...base,
        id: 'w',
        type: 'KubernetesWarning',
        severity: 'warning',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-x',
        occurredAt: new Date('2026-08-05T10:01:00Z'),
        reason: 'BackOff',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('CrashLoopBackOff');
  });

  it('builds a stable group key', () => {
    expect(
      incidentGroupKey({
        id: '1',
        type: 'OOMKilled',
        severity: 'critical',
        namespace: 'ns',
        resource: 'pod/p',
        occurredAt: new Date(),
        agent: { clusterName: 'c' },
      }),
    ).toBe('c|ns|pod/p|OOMKilled');
  });

  it('hides MinimumReplicasUnavailable rollout flash', () => {
    const noise = {
      ...base,
      id: 'n',
      type: 'DeploymentUnhealthy',
      severity: 'warning',
      namespace: 'opspilot-demo',
      resource: 'deployment/demo-healthy-c',
      reason: 'MinimumReplicasUnavailable',
      occurredAt: new Date('2026-08-06T15:40:29Z'),
      metadata: { cause: 'MinimumReplicasUnavailable' },
    };
    expect(isTransientReplicaNoise(noise)).toBe(true);
    expect(groupIncidents([noise])).toHaveLength(0);
  });

  it('still shows sustained UnavailableReplicas DeploymentUnhealthy', () => {
    const groups = groupIncidents([
      {
        ...base,
        id: 's',
        type: 'DeploymentUnhealthy',
        severity: 'warning',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-c',
        reason: 'UnavailableReplicas',
        occurredAt: new Date('2026-08-06T15:45:00Z'),
        metadata: { cause: 'UnavailableReplicas' },
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].latest.reason).toBe('UnavailableReplicas');
  });

  it('hides DeploymentRollout from the main dashboard', () => {
    const groups = groupIncidents([
      {
        ...base,
        id: 'r',
        type: 'DeploymentRollout',
        severity: 'info',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-a',
        reason: 'revision 1',
        occurredAt: new Date('2026-08-06T15:40:29Z'),
      },
      {
        ...base,
        id: 'c',
        type: 'CrashLoopBackOff',
        namespace: 'opspilot-demo',
        resource: 'pod/x',
        occurredAt: new Date('2026-08-06T15:41:00Z'),
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('CrashLoopBackOff');
  });
});
