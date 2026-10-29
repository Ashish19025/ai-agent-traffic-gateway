import Fastify from "fastify";
import { consumeTokenForClient } from "./modules/rate-limiting/token-bucket-store.js";
// Placeholder policy until the classification/auth stage decides this
// per-client instead of hardcoding one rate for everyone.
const DEFAULT_POLICY = { capacity: 5, refillRatePerSecond: 1 };
export function buildApp() {
    const app = Fastify({ logger: true });
    app.get("/health", async () => ({ status: "ok" }));
    app.post("/v1/check", async (request, reply) => {
        const clientId = request.headers["x-client-id"];
        if (typeof clientId !== "string" || clientId.length === 0) {
            return reply.code(400).send({ error: "missing x-client-id header" });
        }
        const result = await consumeTokenForClient(clientId, DEFAULT_POLICY, Date.now());
        if (!result.allowed) {
            return reply
                .code(429)
                .header("Retry-After", Math.ceil(result.retryAfterSeconds).toString())
                .send({ error: "rate limit exceeded", retryAfterSeconds: result.retryAfterSeconds });
        }
        return reply.send({ allowed: true, tokensRemaining: result.state.tokens });
    });
    return app;
}
