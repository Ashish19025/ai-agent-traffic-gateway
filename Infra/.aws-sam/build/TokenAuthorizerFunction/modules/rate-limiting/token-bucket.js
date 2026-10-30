/**
 * Try to spend one token from the bucket at time `nowMs`.
 *
 * Why refill happens inside this function instead of a background
 * timer: a background timer needs something to be "running" all the
 * time, which doesn't work well with Redis (we don't want a timer per
 * client key). Instead, every time a request arrives, we calculate how
 * much time passed since the last request and top up the bucket right
 * then. This is "lazy refill" — same result as a real-time timer, no
 * background process needed.
 */
export function consumeToken(state, policy, nowMs) {
    if (policy.capacity <= 0 || policy.refillRatePerSecond <= 0) {
        throw new Error("invalid bucket policy: capacity and refillRatePerSecond must be positive");
    }
    const elapsedSeconds = Math.max(0, nowMs - state.lastRefillMs) / 1000;
    const refilledTokens = state.tokens + elapsedSeconds * policy.refillRatePerSecond;
    const tokens = Math.min(policy.capacity, refilledTokens);
    if (tokens < 1) {
        const tokensNeeded = 1 - tokens;
        const retryAfterSeconds = tokensNeeded / policy.refillRatePerSecond;
        return {
            allowed: false,
            state: { tokens, lastRefillMs: nowMs },
            retryAfterSeconds,
        };
    }
    return {
        allowed: true,
        state: { tokens: tokens - 1, lastRefillMs: nowMs },
        retryAfterSeconds: 0,
    };
}
/** The empty starting state for a brand-new client: full bucket. */
export function createInitialState(policy, nowMs) {
    return { tokens: policy.capacity, lastRefillMs: nowMs };
}
