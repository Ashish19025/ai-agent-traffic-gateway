/**
 * A bucket's current state: how many tokens are left, and when we last
 * topped it up. We pass this in and get a new one back — nothing here
 * mutates, which makes the function trivial to test and reason about.
 */
export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * The rules for one client's bucket: how big it can get, and how fast
 * it refills.
 */
export interface BucketPolicy {
  capacity: number;
  refillRatePerSecond: number;
}

export interface ConsumeResult {
  allowed: boolean;
  state: BucketState;
  retryAfterSeconds: number;
}

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
export function consumeToken(
  state: BucketState,
  policy: BucketPolicy,
  nowMs: number,
): ConsumeResult {
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
export function createInitialState(policy: BucketPolicy, nowMs: number): BucketState {
  return { tokens: policy.capacity, lastRefillMs: nowMs };
}
