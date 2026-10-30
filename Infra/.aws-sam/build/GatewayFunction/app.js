import Fastify from "fastify";
import { consumeTokenForClient } from "./modules/rate-limiting/token-bucket-store.js";
// Placeholder policy until the classification/auth stage decides this
// per-client instead of hardcoding one rate for everyone.
const AGENT_POLICY = { capacity: 5, refillRatePerSecond: 1 };
const HUMAN_POLICY = { capacity: 20, refillRatePerSecond: 5 };
// This function extracts the authorizer context from the Fastify request object.
function getAuthorizerContext(request) {
    const awsLambdaRequest = request;
    return awsLambdaRequest.awsLambda?.event?.requestContext?.authorizer ?? {};
}
// This function checks the rate limit for a given request and sends an appropriate response if the limit is exceeded.
async function checkRateLimit(request, reply) {
    const authContext = getAuthorizerContext(request);
    const callertype = authContext.callerType ?? "agent";
    const clientKey = callertype === "human" ? authContext.email : authContext.clientId;
    if (!clientKey) {
        reply.code(400).send({ error: "missing client identifier in request" });
        return;
    }
    const policy = callertype === "human" ? HUMAN_POLICY : AGENT_POLICY;
    const result = await consumeTokenForClient(clientKey, policy, Date.now());
    if (!result.allowed) {
        reply
            .code(429)
            .header("Retry-After", Math.ceil(result.retryAfterSeconds).toString())
            .send({ error: "rate limit exceeded", retryAfterSeconds: result.retryAfterSeconds });
    }
}
export function buildApp() {
    const app = Fastify({ logger: true });
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/v1/data", { preHandler: checkRateLimit }, async (request) => {
        const authContext = getAuthorizerContext(request);
        return { data: "this is a protected resource",
            callerType: authContext.callerType ?? "agent",
            identity: authContext.callerType === "human" ? authContext.email : authContext.clientId,
        };
    });
    app.addHook("onResponse", async (request, reply) => {
        if (request.url.startsWith("/v1/")) {
            const authContext = getAuthorizerContext(request);
            request.log.info({
                callerType: authContext.callerType ?? "agent",
                identity: authContext.callerType === "human" ? authContext.email : authContext.clientId,
                route: request.url,
                method: request.method,
                statusCode: reply.statusCode,
                latencyMs: reply.elapsedTime,
                rateLimited: reply.statusCode === 429,
            }, "request completed");
        }
    });
    return app;
}
