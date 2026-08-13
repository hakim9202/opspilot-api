import { filterLiveFailureIncidents, isKnownFailurePodStatus } from './live-failures';

describe('agents heartbeat inventory mapping (live fields)', () => {
  it('keeps ready/cpu/memory when present', () => {
    const p = {
      namespace: 'opspilot-demo',
      name: 'demo-a',
      status: 'Running',
      ready: '1/1',
      restarts: 0,
      age: '5m',
      cpu: '12m',
      memory: '24Mi',
    };
    const mapped = {
      namespace: String(p.namespace),
      name: String(p.name),
      status: String(p.status || 'Unknown'),
      ready: p.ready != null && String(p.ready).trim() ? String(p.ready) : undefined,
      restarts: Number.isFinite(Number(p.restarts)) ? Number(p.restarts) : 0,
      age: String(p.age || ''),
      cpu: p.cpu != null && String(p.cpu).trim() ? String(p.cpu) : undefined,
      memory: p.memory != null && String(p.memory).trim() ? String(p.memory) : undefined,
    };
    expect(mapped.ready).toBe('1/1');
    expect(mapped.cpu).toBe('12m');
    expect(mapped.memory).toBe('24Mi');
  });

  it('still treats CrashLoop as live failure', () => {
    expect(isKnownFailurePodStatus('CrashLoopBackOff')).toBe(true);
    const kept = filterLiveFailureIncidents(
      [
        {
          id: '1',
          type: 'CrashLoopBackOff',
          severity: 'critical',
          namespace: 'opspilot-demo',
          resource: 'pod/x-abc12345-xyz12',
          occurredAt: new Date(),
          agent: { clusterName: 'opspilot-lab' },
        },
      ],
      [
        {
          clusterName: 'opspilot-lab',
          status: 'online',
          podInventory: [
            {
              namespace: 'opspilot-demo',
              name: 'x-abc12345-xyz12',
              status: 'CrashLoopBackOff',
              ready: '0/1',
              cpu: '1m',
            },
          ],
        },
      ],
    );
    expect(kept).toHaveLength(1);
  });
});
