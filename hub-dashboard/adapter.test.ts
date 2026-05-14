import { describe, expect, test } from "bun:test";

import { adaptInstance } from "./src/adapter";

describe("adaptInstance", () => {
  test("does not assign loaded channels to tool-only instances", () => {
    const ai = adaptInstance(
      { id: "tool-1", isChannel: false },
      0,
      ["wechat", "telegram"],
    );

    expect(ai.isChannel).toBe(false);
    expect(ai.channels).toEqual([]);
  });

  test("uses loaded channels as the all-channel display fallback for channel instances", () => {
    const ai = adaptInstance(
      { id: "channel-1", isChannel: true },
      0,
      ["wechat", "telegram"],
    );

    expect(ai.isChannel).toBe(true);
    expect(ai.channels).toEqual(["wechat", "telegram"]);
  });
});
