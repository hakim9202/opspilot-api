# OpsPilot API

NestJS SaaS backend for OpsPilot. Receives agent registration, heartbeats, and structured incident events. Provides a minimal dashboard for connected agents and recent incidents.

## Stack

- NestJS
- PostgreSQL (Docker Compose)
- Prisma ORM

## Quick start

```bash
docker compose up -d
cp .env.example .env
npm install
npx prisma migrate deploy
npx prisma db seed
npm run start:dev
```

- API: http://localhost:3000
- Dashboard: http://localhost:3000/dashboard
- Incident evidence snapshot: http://localhost:3000/dashboard/incidents/:id
- License: http://localhost:3000/dashboard/license
- Security one-pager: http://localhost:3000/dashboard/security
- Redaction settings: http://localhost:3000/dashboard/redaction
- Health: http://localhost:3000/v1/health
- Doc copy: [docs/security-one-pager.md](docs/security-one-pager.md)
- Snapshot schema: [docs/snapshot-schema.md](docs/snapshot-schema.md)

## Lab licensing (no real money)

Fake entitlements for commercial-flow testing:

| Plan | Max clusters |
|---|---|
| `free` | 1 |
| `team` | 5 |
| `enterprise` | unlimited |

- Dashboard: http://localhost:3000/dashboard/license
- API: `GET /v1/license`, `POST /v1/license/plan` `{ "plan": "team" }`
- Registering a **new** cluster over the limit returns **403**
- Re-registering the **same** cluster name replaces the agent (allowed)

## Lab install token

Seeded for local testing:

```text
install_lab_opspilot_mvp
```

## MVP endpoints

| Method | Path | Auth |
|---|---|---|
| POST | `/v1/agents/register` | installation token in body |
| POST | `/v1/agents/heartbeat` | Bearer agent access token |
| POST | `/v1/events/batch` | Bearer agent access token |
| GET | `/v1/agents` | none (lab) |
| POST | `/v1/agents/:id/revoke` | none (lab) — rotates token, rejects future auth |
| GET | `/v1/agents/config` | Bearer agent token — redaction patterns |
| GET/POST/PATCH/DELETE | `/v1/agents/settings/redaction` | none (lab) |
| GET | `/v1/incidents` | none (lab) |
| GET | `/v1/health` | none |
