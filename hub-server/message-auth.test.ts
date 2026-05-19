import { describe, expect, test } from "bun:test";

import { getAuthSenderId, isAuthorizedSenderMatch } from "./message-auth.js";
import type { InboundMessage } from "./types.js";

function makeMsg(overrides: Partial<InboundMessage> & { raw?: Record<string, unknown> }): InboundMessage {
  return {
    channel: "test",
    from: "User",
    fromId: "default-from-id",
    content: "hello",
    raw: {},
    ...overrides,
  };
}

// ── getAuthSenderId ──────────────────────────────────────────────────────────

describe("getAuthSenderId", () => {
  test("returns raw.auth_sender_id when present and non-empty", () => {
    const msg = makeMsg({ raw: { auth_sender_id: "auth-123" } });
    expect(getAuthSenderId(msg)).toBe("auth-123");
  });

  test("falls back to fromId when auth_sender_id is missing", () => {
    const msg = makeMsg({ fromId: "fallback-id", raw: {} });
    expect(getAuthSenderId(msg)).toBe("fallback-id");
  });

  test("falls back to fromId when auth_sender_id is empty string", () => {
    const msg = makeMsg({ fromId: "fallback-id", raw: { auth_sender_id: "" } });
    expect(getAuthSenderId(msg)).toBe("fallback-id");
  });

  test("falls back to fromId when auth_sender_id is not a string", () => {
    const msg = makeMsg({ fromId: "fallback-id", raw: { auth_sender_id: 42 } });
    expect(getAuthSenderId(msg)).toBe("fallback-id");
  });

  test("uses handle_id for imessage channel when auth_sender_id missing", () => {
    const msg = makeMsg({
      channel: "imessage",
      fromId: "fromid-fallback",
      raw: { handle_id: "+1234567890" },
    });
    expect(getAuthSenderId(msg)).toBe("+1234567890");
  });

  test("prefers auth_sender_id over handle_id for imessage", () => {
    const msg = makeMsg({
      channel: "imessage",
      fromId: "fromid-fallback",
      raw: { auth_sender_id: "auth-override", handle_id: "+1234567890" },
    });
    expect(getAuthSenderId(msg)).toBe("auth-override");
  });

  test("falls back to fromId for imessage when handle_id is empty", () => {
    const msg = makeMsg({
      channel: "imessage",
      fromId: "fromid-fallback",
      raw: { handle_id: "" },
    });
    expect(getAuthSenderId(msg)).toBe("fromid-fallback");
  });

  test("does not use handle_id for non-imessage channels", () => {
    const msg = makeMsg({
      channel: "telegram",
      fromId: "tg-from-id",
      raw: { handle_id: "should-be-ignored" },
    });
    expect(getAuthSenderId(msg)).toBe("tg-from-id");
  });
});

// ── isAuthorizedSenderMatch ──────────────────────────────────────────────────

describe("isAuthorizedSenderMatch", () => {
  test("exact match for non-imessage channels", () => {
    expect(isAuthorizedSenderMatch("telegram", "12345", "12345")).toBe(true);
  });

  test("no match for different IDs on non-imessage channels", () => {
    expect(isAuthorizedSenderMatch("telegram", "12345", "67890")).toBe(false);
  });

  test("case-sensitive for non-imessage channels", () => {
    expect(isAuthorizedSenderMatch("wechat", "User@im.wechat", "user@im.wechat")).toBe(false);
  });

  test("case-insensitive match for imessage", () => {
    expect(isAuthorizedSenderMatch("imessage", "User@iCloud.COM", "user@icloud.com")).toBe(true);
  });

  test("case-insensitive for imessage phone numbers (no-op but consistent)", () => {
    expect(isAuthorizedSenderMatch("imessage", "+1234567890", "+1234567890")).toBe(true);
  });

  test("different imessage handles do not match", () => {
    expect(isAuthorizedSenderMatch("imessage", "alice@icloud.com", "bob@icloud.com")).toBe(false);
  });
});
