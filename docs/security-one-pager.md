# OpsPilot Security One-Pager

**Audience:** customer security / platform teams evaluating agent install.

## Summary

OpsPilot Agent is a **read-only** collector that runs inside the customer Kubernetes cluster. It watches approved resources, redacts secrets, and sends **structured incidents** over HTTPS to the OpsPilot SaaS. It does **not** mutate the cluster and does **not** open inbound ports.

## Permissions (RBAC)

| Allowed | Denied |
|---|---|
| `get` / `list` / `watch` on pods, pod logs, events, namespaces, nodes, services | All `create` / `update` / `patch` / `delete` |
| `get` / `list` / `watch` on deployments, replicasets, statefulsets, daemonsets | Access to Kubernetes **Secrets** |
| Outbound HTTPS to OpsPilot API | Inbound listeners / NodePorts for the agent |

## Data sent to SaaS

- Structured events: type, severity, reason, exit code, short **redacted** log snippet
- Agent heartbeats and identity metadata
- **Not** sent: full Secrets, unrestricted env dumps, full continuous log streams, raw pod YAML dumps

## Controls

1. **Revoke agent** — Dashboard or `POST /v1/agents/:id/revoke` rotates the access token and sets status `revoked`. Heartbeats and event uploads are rejected immediately.
2. **Redaction patterns** — Built-in scrubbing plus customer regexes at `/dashboard/redaction`, pushed to agents on heartbeat / `GET /v1/agents/config`.
3. **Install tokens** — One-time/environment install tokens; deactivate to block new registrations.

## Network

```
Customer cluster (agent)  --HTTPS outbound only-->  OpsPilot SaaS API
```

No inbound exposure required for the agent.

## AI suggestions

Optional. When enabled, the SaaS generates fix tips from already-redacted incident fields. AI never runs inside the customer cluster and never receives Secrets.

---

*Live copy also served at `/dashboard/security`.*
