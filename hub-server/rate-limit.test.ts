import { describe, expect, test } from "bun:test";

import { checkPermissionRate, pruneRateLimitMap, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";

// ── checkPermissionRate ──────────────────────────────────────────────────────

describe("checkPermissionRate", () => {
  // Use unique instance IDs per test to avoid cross-test pollution
  // (the module-level Map persists across tests within a single run)

  test("accepts requests under the limit", () => {
    const id = `test-under-${Date.now()}`;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(checkPermissionRate(id)).toBe(true);
    }
  });

  test("rejects when limit is reached", () => {
    const id = `test-over-${Date.now()}`;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      checkPermissionRate(id);
    }
    expect(checkPermissionRate(id)).toBe(false);
  });

  test("different instances have independent limits", () => {
    const idA = `test-indep-a-${Date.now()}`;
    const idB = `test-indep-b-${Date.now()}`;

    // Fill up A
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      checkPermissionRate(idA);
    }
    expect(checkPermissionRate(idA)).toBe(false);

    // B should still be fine
    expect(checkPermissionRate(idB)).toBe(true);
  });

  test("expired timestamps are pruned and allow new requests", () => {
    const id = `test-expiry-${Date.now()}`;

    // Stub Date.now to simulate time passing
    const realNow = Date.now;
    let fakeTime = realNow.call(Date);

    Date.now = () => fakeTime;
    try {
      // Fill up the limit
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        checkPermissionRate(id);
      }
      expect(checkPermissionRate(id)).toBe(false);

      // Advance time past the window
      fakeTime += RATE_LIMIT_WINDOW_MS + 1;

      // Old timestamps should be pruned, so requests are accepted again
      expect(checkPermissionRate(id)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

// ── pruneRateLimitMap ────────────────────────────────────────────────────────

describe("pruneRateLimitMap", () => {
  test("removes entries whose timestamps are all expired", () => {
    const id = `test-prune-${Date.now()}`;

    const realNow = Date.now;
    let fakeTime = realNow.call(Date);
    Date.now = () => fakeTime;

    try {
      // Add one request
      checkPermissionRate(id);

      // Advance past the window
      fakeTime += RATE_LIMIT_WINDOW_MS + 1;

      pruneRateLimitMap();

      // After pruning, the full limit should be available again
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        expect(checkPermissionRate(id)).toBe(true);
      }
    } finally {
      Date.now = realNow;
    }
  });

  test("retains entries with at least one fresh timestamp", () => {
    const id = `test-prune-retain-${Date.now()}`;

    const realNow = Date.now;
    let fakeTime = realNow.call(Date);
    Date.now = () => fakeTime;

    try {
      // Fill half the limit
      for (let i = 0; i < RATE_LIMIT_MAX / 2; i++) {
        checkPermissionRate(id);
      }

      // Advance but NOT past the window
      fakeTime += RATE_LIMIT_WINDOW_MS / 2;

      pruneRateLimitMap();

      // Add more — the old entries should still count
      // We already have RATE_LIMIT_MAX/2 non-expired entries,
      // so we can add RATE_LIMIT_MAX/2 more
      for (let i = 0; i < RATE_LIMIT_MAX / 2; i++) {
        expect(checkPermissionRate(id)).toBe(true);
      }
      // Now at the limit
      expect(checkPermissionRate(id)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
