# OpsPilot Evidence Snapshot Schema

Frozen, redacted evidence captured when an incident is detected.

```json
{
  "version": 1,
  "capturedAt": "2026-08-05T01:00:00Z",
  "resource": {
    "kind": "Pod",
    "name": "demo-exit2-abc",
    "namespace": "opspilot-demo",
    "uid": "optional",
    "nodeName": "optional"
  },
  "status": {
    "type": "CrashLoopBackOff",
    "phase": "Running",
    "cause": "Error (exit 2)",
    "waitingReason": "CrashLoopBackOff",
    "terminatedReason": "Error",
    "exitCode": 2,
    "restartCount": 3
  },
  "container": {
    "name": "crash",
    "image": "busybox:1.36"
  },
  "logs": {
    "snippet": "FATAL: database connection refused",
    "source": "previous|current"
  },
  "evidence": [
    "cause=Error (exit 2)",
    "exitCode=2",
    "log=FATAL: database connection refused"
  ]
}
```

Rules:
- Always redacted before leave-cluster / store
- No Secrets, no full env dumps
- Prefer CrashLoop / OOM / ImagePull completeness

## DeploymentRollout snapshot

Captured on each Deployment rollout (generation/revision/image change):

```json
{
  "version": 1,
  "capturedAt": "2026-08-05T03:00:00Z",
  "kind": "DeploymentRollout",
  "resource": { "kind": "Deployment", "name": "demo-api", "namespace": "opspilot-demo" },
  "rollout": { "generation": 3, "revision": "3", "strategy": "RollingUpdate" },
  "spec": {
    "replicas": 2,
    "containers": [{ "name": "demo-api", "image": "nginx:1.27-alpine", "ports": [80] }]
  },
  "status": {
    "updatedReplicas": 1,
    "readyReplicas": 1,
    "availableReplicas": 1,
    "unavailableReplicas": 1,
    "observedGeneration": 3
  },
  "evidence": ["generation=3", "replicas=2", "revision=3", "images=demo-api=nginx:1.27-alpine"]
}
```

Env vars / command args are intentionally omitted (secret risk).
