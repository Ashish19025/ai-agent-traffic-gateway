# AI Agent Traffic Gateway (Civic Pulse)

A learning/portfolio project: an AWS serverless API gateway that authenticates both human users and machine/AI-agent clients, rate-limits them differently, logs structured request data, detects abusive traffic patterns on a schedule, and exposes an admin-only reporting endpoint.

Built with AWS SAM — Lambda (Fastify), API Gateway, DynamoDB, Cognito, EventBridge, and CloudWatch Logs Insights.

## Architecture

- **API Gateway + `GatewayFunction`** (Fastify via `@fastify/aws-lambda`) — serves all `/v1/*` routes behind a custom Lambda TOKEN authorizer.
- **`TokenAuthorizerFunction`** — verifies Cognito JWTs for two client types:
  - **Machine clients** (`client_credentials` OAuth flow, scope `gateway/invoke`) — identified as `callerType: "agent"`.
  - **Human clients** (Cognito Hosted UI / `USER_PASSWORD_AUTH`) — identified as `callerType: "human"`, carrying the user's email.
- **Rate limiting** — a DynamoDB-backed token bucket (`RateLimitTable`), keyed by client ID (agents) or email (humans), with separate bucket policies per caller type.
- **Structured logging** — every `/v1/*` request logs `callerType`, `identity`, `route`, `statusCode`, `latencyMs`, and `rateLimited` via Pino, queryable through CloudWatch Logs Insights.
- **`AnomalyDetectorFunction`** — runs every 5 minutes on an EventBridge schedule, scans the gateway's recent logs via Logs Insights, and flags clients exceeding a request-count or rate-limit-ratio threshold into `AnomalyFlagsTable`.
- **`/v1/report`** — aggregates recent traffic and anomaly data for a dashboard view. Restricted to human callers on an admin allowlist (see below).

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | none | liveness check |
| `GET /v1/data` | any valid token | rate-limited protected resource |
| `GET /v1/report` | human caller, email in `ADMIN_EMAILS` | traffic summary + anomaly flags |

## Deploying

```bash
npm install
npm run build
cd Infra
sam build
sam deploy --parameter-overrides AdminEmails="you@example.com,teammate@example.com"
```

`AdminEmails` is a comma-separated list of human-caller emails allowed to call `/v1/report`. Leave it unset to deny all report access until configured.

## Known limitations

- The authorizer grants an `Allow` on the entire API method ARN prefix for any valid token (needed to avoid authorizer-cache mismatches across routes), so route-level access control is enforced in the route handlers themselves (see `requireAdmin` in `src/gateway/app.ts`) rather than in the authorizer's IAM policy.
- `logs:StartQuery` / `logs:GetQueryResults` / `logs:DescribeLogGroups` IAM permissions use `Resource: "*"` — AWS does not support resource-level scoping for these actions, so this is the standard pattern.
- The `MachineAppClient` Cognito client secret should be rotated if it was ever shared outside of secure channels during development.

## Testing

```bash
npm test
```
