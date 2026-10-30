import { describe, expect, it } from "vitest";
import { consumeToken, createInitialState, type BucketPolicy } from "./token-bucket.js";

const policy: BucketPolicy = { capacity: 3, refillRatePerSecond: 1 };

describe("consumeToken", () => {
  it("allows requests while tokens remain", () => {
    const start = createInitialState(policy, 0);

    const first = consumeToken(start, policy, 0);
    expect(first.allowed).toBe(true);
    expect(first.state.tokens).toBe(2);

    const second = consumeToken(first.state, policy, 0);
    expect(second.allowed).toBe(true);
    expect(second.state.tokens).toBe(1);
  });

  it("denies the request once the bucket is empty", () => {
    const start = createInitialState(policy, 0);

    const afterThree = [0, 0, 0].reduce(
      (state, nowMs) => consumeToken(state, policy, nowMs).state,
      start,
    );

    const fourth = consumeToken(afterThree, policy, 0);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeCloseTo(1, 5);
  });

  it("refills over time instead of needing a background timer", () => {
    const start = createInitialState(policy, 0);
    const afterThreeConsumes = [0, 0, 0].reduce(
      (state, nowMs) => consumeToken(state, policy, nowMs).state,
      start,
    );
    const emptied = consumeToken(afterThreeConsumes, policy, 0);
    expect(emptied.allowed).toBe(false);

    // 2 seconds later, at 1 token/sec, we should have regained 2 tokens.
    const retried = consumeToken(emptied.state, policy, 2000);
    expect(retried.allowed).toBe(true);
    expect(retried.state.tokens).toBeCloseTo(1, 5);
  });

  it("never refills past capacity", () => {
    const start = createInitialState(policy, 0);
    const idleFor100Seconds = consumeToken(start, policy, 100_000);
    expect(idleFor100Seconds.state.tokens).toBeLessThanOrEqual(policy.capacity - 1);
  });
});
