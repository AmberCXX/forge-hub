import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { HUB_DIR } from "./config.js";
import { initSearch, isSearchEnabled, indexMessage, searchHistory, closeSearch } from "./search.js";

const DB_PATH = path.join(HUB_DIR, "search.db");

// Between tests: close the DB + delete the file so initSearch creates a fresh one
afterEach(() => {
  closeSearch();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

describe("search", () => {
  test("initSearch(true) creates the database file", () => {
    initSearch(true);
    expect(fs.existsSync(DB_PATH)).toBe(true);
    expect(isSearchEnabled()).toBe(true);
  });

  test("initSearch(false) keeps search disabled", () => {
    initSearch(false);
    expect(isSearchEnabled()).toBe(false);
    // All operations should be safe no-ops
    expect(() => indexMessage("wechat", "in", "user", "hello")).not.toThrow();
    expect(searchHistory("hello")).toEqual([]);
  });

  test("indexMessage + searchHistory finds by keyword", () => {
    initSearch(true);

    indexMessage("wechat", "in", "Alice", "hello world");
    indexMessage("wechat", "out", "Forge", "goodbye world");

    const results = searchHistory("hello");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.content === "hello world")).toBe(true);
  });

  test("searchHistory filters by channel", () => {
    initSearch(true);

    indexMessage("wechat", "in", "Alice", "hello from wechat");
    indexMessage("telegram", "in", "Bob", "hello from telegram");

    const wxResults = searchHistory("hello", { channel: "wechat" });
    expect(wxResults).toHaveLength(1);
    expect(wxResults[0].channel).toBe("wechat");

    const tgResults = searchHistory("hello", { channel: "telegram" });
    expect(tgResults).toHaveLength(1);
    expect(tgResults[0].channel).toBe("telegram");
  });

  test("searchHistory respects limit", () => {
    initSearch(true);

    for (let i = 0; i < 10; i++) {
      indexMessage("wechat", "in", "Alice", `message number ${i}`);
    }

    const results = searchHistory("message", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  test("searchHistory with sinceTs filters by timestamp", () => {
    initSearch(true);

    indexMessage("wechat", "in", "Alice", "ancient message");

    const pastTs = "2020-01-01T00:00:00.000Z";
    const futureTs = "2099-01-01T00:00:00.000Z";

    const fromPast = searchHistory("ancient", { sinceTs: pastTs });
    expect(fromPast.length).toBeGreaterThanOrEqual(1);

    const fromFuture = searchHistory("ancient", { sinceTs: futureTs });
    expect(fromFuture).toHaveLength(0);
  });

  test("searchHistory returns results with correct shape", () => {
    initSearch(true);

    indexMessage("telegram", "out", "Forge", "test content here");

    const results = searchHistory("test");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const r = results[0];
    expect(typeof r.ts).toBe("string");
    expect(r.channel).toBe("telegram");
    expect(r.direction).toBe("out");
    expect(r.sender).toBe("Forge");
    expect(r.content).toBe("test content here");
  });

  test("closeSearch makes subsequent operations safe no-ops", () => {
    initSearch(true);

    indexMessage("wechat", "in", "Alice", "before close");
    closeSearch();

    expect(isSearchEnabled()).toBe(false);
    expect(() => indexMessage("wechat", "in", "Alice", "after close")).not.toThrow();
    expect(searchHistory("before")).toEqual([]);
  });
});
