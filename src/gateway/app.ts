import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply} from "fastify";
import { consumeTokenForClient } from "./modules/rate-limiting/token-bucket-store.js";
import type { BucketPolicy } from "./modules/rate-limiting/token-bucket.js";

// Placeholder policy until the classification/auth stage decides this
// per-client instead of hardcoding one rate for everyone.
const AGENT_POLICY: BucketPolicy = { capacity: 5, refillRatePerSecond: 1 };
const HUMAN_POLICY: BucketPolicy = { capacity: 20, refillRatePerSecond: 5 };

interface AuthorizerContext {
  callerType?: "agent" | "human";
  clientId?: string;
  email?: string;
  accessToken?: string;
}

function getAuthorizerContext(request: FastifyRequest): AuthorizerContext {
  const awsLambdaRequest = request as FastifyRequest & { awsLambda?: { event?: { requestContext?: { authorizer?: AuthorizerContext } } } }
  return awsLambdaRequest.awsLambda?.event?.requestContext?.authorizer ?? {};
}

async function checkRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authContext = getAuthorizerContext(request);
  const callertype = authContext.callerType ?? "agent";
  const clientKey = callertype === "human" ? authContext.email : authContext.clientId;

  if(!clientKey) {
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

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/data", { preHandler: checkRateLimit }, async () => {
    return { data: "this is a protected resource" };
  })

  return app;
}
