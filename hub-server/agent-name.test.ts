import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setCurrentConfig } from "./hub-state.js";
import { getInstances, getChannelInstanceCount } from "./instance-manager.js";
import { getOutboundFrom } from "./history.js";
import type { HubConfig } from "./types.js";

function makeConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    port: 9900,
    host: "127.0.0.1",
    primary_instance: "",
    show_instance_tag: false,
    ...overrides,
  };
}

describe("getOutboundFrom", () => {
  beforeEach(() => {
    delete process.env.HUB_AGENT_NAME;
    setCurrentConfig(makeConfig());
    // Clear instances map
    getInstances().clear();
  });

  afterEach(() => {
    delete process.env.HUB_AGENT_NAME;
  });

  test("default returns 'Forge'", () => {
    expect(getOutboundFrom(undefined)).toBe("Forge");
  });

  test("with HUB_AGENT_NAME env returns env value", () => {
    process.env.HUB_AGENT_NAME = "CustomBot";
    expect(getOutboundFrom(undefined)).toBe("CustomBot");
  });

  test("with config agent_name returns config value", () => {
    setCurrentConfig(makeConfig({ agent_name: "ConfigBot" }));
    expect(getOutboundFrom(undefined)).toBe("ConfigBot");
  });

  test("env takes priority over config", () => {
    process.env.HUB_AGENT_NAME = "EnvBot";
    setCurrentConfig(makeConfig({ agent_name: "ConfigBot" }));
    expect(getOutboundFrom(undefined)).toBe("EnvBot");
  });

  test("control characters are stripped", () => {
    process.env.HUB_AGENT_NAME = "Hello\nWorld\r\x00Test";
    expect(getOutboundFrom(undefined)).toBe("HelloWorldTest");
  });

  test("truncated at 50 chars", () => {
    process.env.HUB_AGENT_NAME = "A".repeat(100);
    expect(getOutboundFrom(undefined)).toBe("A".repeat(50));
  });

  test("empty name after sanitization falls back to Forge", () => {
    process.env.HUB_AGENT_NAME = "\n\r\x00";
    expect(getOutboundFrom(undefined)).toBe("Forge");
  });

  test("whitespace-only name after sanitization falls back to Forge", () => {
    process.env.HUB_AGENT_NAME = "   \n\r   ";
    expect(getOutboundFrom(undefined)).toBe("Forge");
  });

  test("multi-instance adds tag suffix", () => {
    const instances = getInstances();

    // Create two mock instances to make getChannelInstanceCount() > 1
    const mockWs = {
      send: () => 0,
      close: () => {},
      data: { instanceId: "inst-1" },
    } as any;

    instances.set("inst-1", {
      id: "inst-1",
      tag: "P",
      description: "Primary",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });

    instances.set("inst-2", {
      id: "inst-2",
      tag: "S",
      description: "Secondary",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });

    // With multiple channel instances, should add tag suffix
    const result = getOutboundFrom("inst-1");
    expect(result).toBe("Forge (Primary@P)");
  });

  test("multi-instance with only description (no tag)", () => {
    const instances = getInstances();
    const mockWs = { send: () => 0, close: () => {}, data: { instanceId: "a" } } as any;

    instances.set("a", {
      id: "a",
      description: "Worker",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });
    instances.set("b", {
      id: "b",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });

    expect(getOutboundFrom("a")).toBe("Forge (Worker)");
  });

  test("multi-instance with only tag (no description)", () => {
    const instances = getInstances();
    const mockWs = { send: () => 0, close: () => {}, data: { instanceId: "a" } } as any;

    instances.set("a", {
      id: "a",
      tag: "X",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });
    instances.set("b", {
      id: "b",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });

    expect(getOutboundFrom("a")).toBe("Forge (@X)");
  });

  test("single instance does not add suffix even with tag/description", () => {
    const instances = getInstances();
    const mockWs = { send: () => 0, close: () => {}, data: { instanceId: "only" } } as any;

    instances.set("only", {
      id: "only",
      tag: "P",
      description: "Primary",
      isChannel: true,
      connectedAt: new Date().toISOString(),
      ws: mockWs,
      send: () => 0,
      close: () => {},
    });

    expect(getOutboundFrom("only")).toBe("Forge");
  });

  test("unknown instanceId returns base name", () => {
    expect(getOutboundFrom("nonexistent")).toBe("Forge");
  });
});
