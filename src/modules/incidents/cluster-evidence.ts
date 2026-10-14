import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type PodContainerWait = {
  pod: string;
  container: string;
  ready: boolean;
  phase: string;
  waitingReason: string;
  waitingMessage: string;
  restarts: number;
};

export function kubeContext(): string {
  return (
    process.env.KUBE_CONTEXT ||
    process.env.OPSPILOT_KUBE_CONTEXT ||
    'kind-opspilot-lab'
  );
}

export function parsePodWaiting(doc: {
  items?: Array<{
    metadata?: { name?: string };
    status?: {
      phase?: string;
      containerStatuses?: Array<{
        name?: string;
        ready?: boolean;
        restartCount?: number;
        state?: {
          waiting?: { reason?: string; message?: string };
          terminated?: { reason?: string; message?: string };
        };
      }>;
    };
  }>;
}): PodContainerWait[] {
  const out: PodContainerWait[] = [];
  for (const item of doc.items || []) {
    const pod = String(item.metadata?.name || '');
    const phase = String(item.status?.phase || '');
    for (const cs of item.status?.containerStatuses || []) {
      const waiting = cs.state?.waiting;
      const terminated = cs.state?.terminated;
      out.push({
        pod,
        container: String(cs.name || ''),
        ready: Boolean(cs.ready),
        phase,
        waitingReason: String(waiting?.reason || terminated?.reason || ''),
        waitingMessage: String(waiting?.message || terminated?.message || ''),
        restarts: Number(cs.restartCount || 0),
      });
    }
  }
  return out;
}

export function formatWorkloadEvidence(
  namespace: string,
  deployment: string,
  waits: PodContainerWait[],
  eventsText: string,
): string {
  const lines = [
    `namespace=${namespace}`,
    `deployment=${deployment}`,
    `pods=${waits.length}`,
  ];
  for (const w of waits) {
    lines.push(
      [
        `pod=${w.pod}`,
        `container=${w.container}`,
        `phase=${w.phase}`,
        `ready=${w.ready}`,
        w.waitingReason ? `waitingReason=${w.waitingReason}` : '',
        w.waitingMessage ? `waitingMessage=${w.waitingMessage}` : '',
        `restarts=${w.restarts}`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
  const events = (eventsText || '').trim().slice(0, 2500);
  if (events) {
    lines.push('events:');
    lines.push(events);
  }
  return lines.join('\n').slice(0, 4000);
}

async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('kubectl', args, {
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

/** Read-only live inspect for Ask agent / MCP. Never mutates the cluster. */
export async function inspectKubernetesWorkload(
  namespace: string,
  deployment: string,
): Promise<string> {
  const ns = (namespace || '').trim();
  const deploy = (deployment || '').trim();
  if (!ns || !deploy) return 'missing namespace or deployment';
  const ctx = kubeContext();
  try {
    const podJson = await kubectl([
      '--context',
      ctx,
      '-n',
      ns,
      'get',
      'pods',
      '-l',
      `app=${deploy}`,
      '-o',
      'json',
    ]);
    const waits = parsePodWaiting(JSON.parse(podJson));
    let events = '';
    try {
      events = await kubectl([
        '--context',
        ctx,
        '-n',
        ns,
        'get',
        'events',
        '--field-selector',
        `involvedObject.kind=Pod`,
        '--sort-by=.lastTimestamp',
      ]);
      events = events
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          if (!t || /^(LAST SEEN|NAMESPACE)/i.test(t)) return false;
          return t.includes(deploy);
        })
        .slice(-15)
        .join('\n');
    } catch {
      events = '';
    }
    return formatWorkloadEvidence(ns, deploy, waits, events);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `inspect failed: ${msg}`;
  }
}
