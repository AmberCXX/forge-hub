import { describe, expect, test } from "bun:test";

import { isNetworkError, isILinkRejection, SEND_RETRY_DELAY_MS } from "./send-retry.js";

// ── isNetworkError ───────────────────────────────────────────────────────────

describe("isNetworkError", () => {
  test("detects 'socket' errors", () => {
    expect(isNetworkError("Socket hang up")).toBe(true);
    expect(isNetworkError("SOCKET_TIMEOUT")).toBe(true);
  });

  test("detects 'fetch failed' errors", () => {
    expect(isNetworkError("fetch failed")).toBe(true);
    expect(isNetworkError("TypeError: Fetch Failed")).toBe(true);
  });

  test("detects ECONNRESET", () => {
    expect(isNetworkError("read ECONNRESET")).toBe(true);
    expect(isNetworkError("Error: econnreset")).toBe(true);
  });

  test("detects ECONNREFUSED", () => {
    expect(isNetworkError("connect ECONNREFUSED 127.0.0.1:8080")).toBe(true);
  });

  test("detects ETIMEDOUT", () => {
    expect(isNetworkError("connect ETIMEDOUT 1.2.3.4:443")).toBe(true);
  });

  test("detects EPIPE", () => {
    expect(isNetworkError("write EPIPE")).toBe(true);
  });

  test("case insensitive matching", () => {
    expect(isNetworkError("FETCH FAILED")).toBe(true);
    expect(isNetworkError("Socket Hang Up")).toBe(true);
    expect(isNetworkError("ECONNRESET")).toBe(true);
  });

  test("returns false for non-network errors", () => {
    expect(isNetworkError("401 Unauthorized")).toBe(false);
    expect(isNetworkError("Bad Request")).toBe(false);
    expect(isNetworkError("JSON parse error")).toBe(false);
    expect(isNetworkError("Permission denied")).toBe(false);
    expect(isNetworkError("file not found")).toBe(false);
    expect(isNetworkError("")).toBe(false);
  });

  test("returns false for partial keyword matches that are not actual network errors", () => {
    // "sock" without the full "socket" — currently isNetworkError does substring
    // matching with .includes("socket"), so "sock" alone should not match
    expect(isNetworkError("sock drawer")).toBe(false);
  });
});

// ── isILinkRejection ────────────────────────────────────────────────────────

describe("isILinkRejection", () => {
  test("detects iLink sendmessage failures", () => {
    expect(isILinkRejection("Error: sendmessage 失败: ret=-2 errcode=undefined errmsg=")).toBe(true);
    expect(isILinkRejection("sendmessage 失败: ret=-1 errcode=40001 errmsg=invalid token")).toBe(true);
  });

  test("returns false for network errors", () => {
    expect(isILinkRejection("fetch failed")).toBe(false);
    expect(isILinkRejection("ECONNRESET")).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isILinkRejection("401 Unauthorized")).toBe(false);
    expect(isILinkRejection("")).toBe(false);
  });
});

// ── SEND_RETRY_DELAY_MS ─────────────────────────────────────────────────────

describe("SEND_RETRY_DELAY_MS", () => {
  test("is a positive number", () => {
    expect(SEND_RETRY_DELAY_MS).toBeGreaterThan(0);
  });
});
