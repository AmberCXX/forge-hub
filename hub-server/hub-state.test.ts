import { describe, expect, test } from "bun:test";
import type { HubConfig, InboundMessage } from "./types.js";
import { getCurrentConfig, setCurrentConfig, setOnMessage, onMessage } from "./hub-state.js";

// ── getCurrentConfig / setCurrentConfig ────────────────────────────────────

describe("getCurrentConfig / setCurrentConfig", () => {
  test("round-trips a config through set + get", () => {
    const cfg: HubConfig = {
      port: 9999,
      host: "127.0.0.1",
      primary_instance: "test-inst",
      show_instance_tag: false,
    };

    setCurrentConfig(cfg);
    const got = getCurrentConfig();
    expect(got.port).toBe(9999);
    expect(got.host).toBe("127.0.0.1");
    expect(got.primary_instance).toBe("test-inst");
    expect(got.show_instance_tag).toBe(false);
  });

  test("setCurrentConfig overwrites previous config", () => {
    const first: HubConfig = { port: 1, host: "a", primary_instance: "x", show_instance_tag: true };
    const second: HubConfig = { port: 2, host: "b", primary_instance: "y", show_instance_tag: false };

    setCurrentConfig(first);
    setCurrentConfig(second);

    const got = getCurrentConfig();
    expect(got.port).toBe(2);
    expect(got.host).toBe("b");
    expect(got.primary_instance).toBe("y");
    expect(got.show_instance_tag).toBe(false);
  });

  test("getCurrentConfig returns the exact reference set by setCurrentConfig", () => {
    const cfg: HubConfig = { port: 3000, host: "0.0.0.0", primary_instance: "ref-test", show_instance_tag: true };
    setCurrentConfig(cfg);
    expect(getCurrentConfig()).toBe(cfg); // same reference
  });
});

// ── default before setCurrentConfig ────────────────────────────────────────

describe("default config before setCurrentConfig", () => {
  test("getCurrentConfig throws when _currentConfig is null", async () => {
    // 直接 import 无法保证 null（其他 test 可能已 set），
    // 所以用 isolated Bun subprocess 测试模块初始 throw 行为
    const proc = Bun.spawn(["bun", "-e", `
      import { getCurrentConfig } from "./hub-state.js";
      try {
        getCurrentConfig();
        process.exit(1); // 没 throw → 失败
      } catch (e) {
        if (String(e).includes("currentConfig 未初始化")) process.exit(0);
        process.exit(2);
      }
    `], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });

    const code = await proc.exited;
    expect(code).toBe(0);
  });
});

// ── setOnMessage / onMessage ───────────────────────────────────────────────

describe("setOnMessage / onMessage", () => {
  const makeMsg = (partial?: Partial<InboundMessage>): InboundMessage => ({
    channel: "test",
    from: "user",
    fromId: "uid-1",
    content: "hello",
    raw: {},
    ...partial,
  });

  test("delegates to registered sync handler", async () => {
    const calls: InboundMessage[] = [];
    setOnMessage((msg) => {
      calls.push(msg);
      return { accepted: true, reason: "accepted" as const };
    });

    const msg = makeMsg({ channel: "wechat", from: "凡", fromId: "fan-001", content: "你好" });
    const result = await onMessage(msg);

    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("accepted");
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toBe("你好");
    expect(calls[0].fromId).toBe("fan-001");
  });

  test("delegates to registered async handler", async () => {
    setOnMessage(async (msg) => {
      await new Promise((r) => setTimeout(r, 5));
      return { accepted: true, reason: "queued" as const, detail: "async ok" };
    });

    const result = await onMessage(makeMsg({ channel: "tg", content: "hi" }));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("queued");
    expect(result.detail).toBe("async ok");
  });

  test("onMessage default (no handler) returns handler_missing", async () => {
    // 用 subprocess 测试 _onMessage 为 null 的默认行为
    const proc = Bun.spawn(["bun", "-e", `
      import { onMessage } from "./hub-state.js";
      const r = await onMessage({ channel:"t", from:"u", fromId:"u1", content:"hi", raw:{} });
      if (!r.accepted && r.reason === "handler_missing") process.exit(0);
      process.exit(1);
    `], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });

    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
