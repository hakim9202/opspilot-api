import { parsePodWaiting, formatWorkloadEvidence } from './cluster-evidence';

describe('cluster-evidence', () => {
  it('extracts CreateContainerConfigError secret message from pod json', () => {
    const waits = parsePodWaiting({
      items: [
        {
          metadata: { name: 'demo-healthy-c-abc' },
          status: {
            phase: 'Pending',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
                state: {
                  waiting: {
                    reason: 'CreateContainerConfigError',
                    message: 'secret "opspilot-missing-secret" not found',
                  },
                },
              },
            ],
          },
        },
      ],
    });
    expect(waits[0].waitingReason).toBe('CreateContainerConfigError');
    expect(waits[0].waitingMessage).toMatch(/opspilot-missing-secret/);
    const text = formatWorkloadEvidence(
      'opspilot-demo',
      'demo-healthy-c',
      waits,
      'Failed  secret "opspilot-missing-secret" not found',
    );
    expect(text).toMatch(/secret "opspilot-missing-secret"/);
  });
});
