import {
  buildLiveFailureIndex,
  filterLiveFailureIncidents,
  isKnownFailurePodStatus,
} from './live-failures';
import type { IncidentLike } from './incident-groups';

describe('live-failures', () => {
  const agents = [
    {
      clusterName: 'opspilot-lab',
      status: 'online',
      podInventory: [
        {
          namespace: 'opspilot-demo',
          name: 'demo-healthy-a-aaa111bbb-cccc1',
          status: 'Running',
        },
        {
          namespace: 'opspilot-demo',
          name: 'demo-healthy-c-698b7fd778-9v9vn',
          status: 'CrashLoopBackOff',
        },
        {
          namespace: 'opspilot-demo',
          name: 'gone-pod-oldrs1234-xxxxx',
          status: 'Running',
        },
      ],
    },
  ];

  it('detects known failure pod statuses', () => {
    expect(isKnownFailurePodStatus('CrashLoopBackOff')).toBe(true);
    expect(isKnownFailurePodStatus('ImagePullBackOff')).toBe(true);
    expect(isKnownFailurePodStatus('Running')).toBe(false);
    expect(isKnownFailurePodStatus('Pending')).toBe(false);
  });

  it('indexes only failing live pods and their deployments', () => {
    const idx = buildLiveFailureIndex(agents);
    expect(idx.failingPods.has('opspilot-lab|opspilot-demo|demo-healthy-c-698b7fd778-9v9vn')).toBe(
      true,
    );
    expect(idx.failingPods.has('opspilot-lab|opspilot-demo|demo-healthy-a-aaa111bbb-cccc1')).toBe(
      false,
    );
    expect(idx.failingDeployments.has('opspilot-lab|opspilot-demo|demo-healthy-c')).toBe(true);
  });

  it('hides incidents for deleted pods and healthy pods', () => {
    const incidents: IncidentLike[] = [
      {
        id: '1',
        type: 'CrashLoopBackOff',
        severity: 'critical',
        namespace: 'opspilot-demo',
        resource: 'pod/old-gone-pod-rs123456-abcde',
        occurredAt: new Date(),
        agent: { clusterName: 'opspilot-lab' },
      },
      {
        id: '2',
        type: 'CrashLoopBackOff',
        severity: 'critical',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-healthy-c-698b7fd778-9v9vn',
        occurredAt: new Date(),
        agent: { clusterName: 'opspilot-lab' },
      },
      {
        id: '3',
        type: 'CrashLoopBackOff',
        severity: 'critical',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-healthy-a-aaa111bbb-cccc1',
        occurredAt: new Date(),
        agent: { clusterName: 'opspilot-lab' },
      },
      {
        id: '4',
        type: 'DeploymentRollout',
        severity: 'info',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-c',
        occurredAt: new Date(),
        agent: { clusterName: 'opspilot-lab' },
      },
      {
        id: '5',
        type: 'DeploymentUnhealthy',
        severity: 'warning',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-c',
        occurredAt: new Date(),
        agent: { clusterName: 'opspilot-lab' },
      },
    ];

    const kept = filterLiveFailureIncidents(incidents, agents);
    expect(kept.map((i) => i.id).sort()).toEqual(['2', '5']);
  });

  it('returns empty when no failing pods in inventory', () => {
    const healthyOnly = [
      {
        clusterName: 'opspilot-lab',
        status: 'online',
        podInventory: [
          { namespace: 'opspilot-demo', name: 'demo-healthy-a-aaa111bbb-cccc1', status: 'Running' },
        ],
      },
    ];
    const kept = filterLiveFailureIncidents(
      [
        {
          id: '1',
          type: 'CrashLoopBackOff',
          severity: 'critical',
          namespace: 'opspilot-demo',
          resource: 'pod/demo-healthy-a-aaa111bbb-cccc1',
          occurredAt: new Date(),
          agent: { clusterName: 'opspilot-lab' },
        },
      ],
      healthyOnly,
    );
    expect(kept).toHaveLength(0);
  });
});
