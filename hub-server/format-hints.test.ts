import { describe, expect, test } from "bun:test";

import { channelPluginsMeta, populate, type ChannelMetaEntry, type ChannelSendEntry } from "./channel-registry.js";

describe("formatHints pipeline", () => {
  test("populate stores formatHints in channelPluginsMeta", () => {
    const sendMap = new Map<string, ChannelSendEntry>();
    const metaMap = new Map<string, ChannelMetaEntry>();

    sendMap.set("echo", {
      send: async () => ({ success: true }),
    });
    metaMap.set("echo", {
      name: "echo",
      displayName: "Echo",
      aliases: [],
      formatHints: "Plain text only. No formatting.",
    });

    populate(sendMap, metaMap);

    const meta = channelPluginsMeta.get("echo");
    expect(meta).toBeDefined();
    expect(meta!.formatHints).toBe("Plain text only. No formatting.");
  });

  test("populate handles undefined formatHints", () => {
    const sendMap = new Map<string, ChannelSendEntry>();
    const metaMap = new Map<string, ChannelMetaEntry>();

    sendMap.set("test", {
      send: async () => ({ success: true }),
    });
    metaMap.set("test", {
      name: "test",
      displayName: "Test",
      aliases: [],
      // no formatHints
    });

    populate(sendMap, metaMap);

    const meta = channelPluginsMeta.get("test");
    expect(meta).toBeDefined();
    expect(meta!.formatHints).toBeUndefined();
  });

  test("populate clears old entries before filling new", () => {
    const sendMap1 = new Map<string, ChannelSendEntry>();
    const metaMap1 = new Map<string, ChannelMetaEntry>();
    sendMap1.set("old", { send: async () => ({ success: true }) });
    metaMap1.set("old", {
      name: "old",
      displayName: "Old",
      aliases: [],
      formatHints: "old hints",
    });

    populate(sendMap1, metaMap1);
    expect(channelPluginsMeta.has("old")).toBe(true);

    // Second populate with different channel should clear old
    const sendMap2 = new Map<string, ChannelSendEntry>();
    const metaMap2 = new Map<string, ChannelMetaEntry>();
    sendMap2.set("new", { send: async () => ({ success: true }) });
    metaMap2.set("new", {
      name: "new",
      displayName: "New",
      aliases: [],
      formatHints: "new hints",
    });

    populate(sendMap2, metaMap2);
    expect(channelPluginsMeta.has("old")).toBe(false);
    expect(channelPluginsMeta.get("new")?.formatHints).toBe("new hints");
  });

  test("ChannelMetaEntry type accepts formatHints string", () => {
    const entry: ChannelMetaEntry = {
      name: "wechat",
      displayName: "WeChat",
      aliases: ["wx"],
      formatHints: "Supports plain text. Markdown is auto-stripped.",
    };

    expect(entry.formatHints).toBe("Supports plain text. Markdown is auto-stripped.");
  });

  test("multiple channels each carry their own formatHints", () => {
    const sendMap = new Map<string, ChannelSendEntry>();
    const metaMap = new Map<string, ChannelMetaEntry>();

    const channels = [
      { name: "wechat", hints: "Plain text only." },
      { name: "telegram", hints: "Supports MarkdownV2." },
      { name: "homeland", hints: "Supports full Markdown." },
    ];

    for (const ch of channels) {
      sendMap.set(ch.name, { send: async () => ({ success: true }) });
      metaMap.set(ch.name, {
        name: ch.name,
        displayName: ch.name,
        aliases: [],
        formatHints: ch.hints,
      });
    }

    populate(sendMap, metaMap);

    for (const ch of channels) {
      expect(channelPluginsMeta.get(ch.name)?.formatHints).toBe(ch.hints);
    }
  });
});
