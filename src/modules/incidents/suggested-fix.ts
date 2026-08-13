/**
 * Demoted rule-based fallback for incidents.
 * Used only when no LLM key is configured (OPENAI_API_KEY / CURSOR_API_KEY).
 */

export type IncidentSuggestionInput = {
  type?: string | null;
  reason?: string | null;
  title?: string | null;
  message?: string | null;
  metadata?: unknown;
};

function asMeta(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return metadata as Record<string, unknown>;
}

function haystack(input: IncidentSuggestionInput): string {
  const m = asMeta(input.metadata);
  const parts = [
    input.type,
    input.reason,
    input.title,
    input.message,
    m.cause,
    m.terminatedReason,
    m.waitingReason,
    m.status,
    m.logSnippet,
    m.exitCode != null ? `exit ${m.exitCode}` : '',
  ];
  return parts
    .filter((p) => p !== undefined && p !== null && String(p) !== '')
    .map((p) => String(p).toLowerCase())
    .join(' ');
}

/** Rule fallback — not used when an LLM provider is configured. */
export function ruleSuggestFix(input: IncidentSuggestionInput): string {
  const text = haystack(input);
  const m = asMeta(input.metadata);
  const exitCode = m.exitCode != null ? String(m.exitCode) : '';

  if (/oomkilled|oom kill|out of memory/.test(text)) {
    return 'Raise the container memory limit or reduce memory usage; check for leaks and tune the app under the pod memory request/limit.';
  }
  if (/imagepullbackoff|errimagepull|manifest unknown|pull access denied/.test(text)) {
    return 'Verify the image name/tag, registry credentials (imagePullSecrets), and that the cluster can reach the registry.';
  }
  if (/crashloopbackoff|crash.?loop/.test(text) || input.type === 'CrashLoopBackOff') {
    if (/database|connection refused|econnrefused|postgres|mysql|mongodb|redis/.test(text)) {
      return 'Check database connectivity from the pod: service DNS, host/port, credentials, and network policies.';
    }
    if (exitCode === '2' || /exit\s*2\b/.test(text)) {
      return 'Inspect container logs for the config or dependency error behind exit code 2; fix startup checks so the process exits 0.';
    }
    return 'Inspect recent container logs and the process command/args; fix the application error that causes a non-zero exit.';
  }
  if (/deploymentunhealthy|minimumreplicasunavailable|progressdeadline/.test(text)) {
    return 'Check pod failures under this deployment (CrashLoop, probes, scheduling) and fix readiness/liveness or replica capacity.';
  }
  if (/backoff|failed|warning/.test(text)) {
    return 'Investigate the associated CrashLoopBackOff or container exit on this pod and fix the underlying process failure.';
  }
  return 'Review incident message, reason, and recent logs; identify the failing dependency or config and remediate it.';
}
