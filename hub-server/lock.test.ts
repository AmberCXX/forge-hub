/**
 * lock.ts — 核心锁定函数单元测试
 *
 * 只测不依赖 Hub 进程 / WebSocket 的纯函数和文件操作：
 * loadLockState / isLocked, setLocked, setUnlocked,
 * assertLockPhraseHealthy, getLockPhrase, isLockTrigger
 *
 * config.ts 和 lock.ts 的路径常量在 import 时就定死，普通 env override
 * 来不及生效。和 lock-state.test.ts 一样，用 spawnSync 子进程隔离。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
let hubDir: string;

beforeEach(() => {
  hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-lock-test-"));
  fs.mkdirSync(path.join(hubDir, "state"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(hubDir, { recursive: true, force: true });
});

/** 在子进程中执行一段 TS，返回最后一行 JSON parse 的结果 */
function runInIsolation(code: string): unknown {
  const child = spawnSync(process.execPath, ["-e", code], {
    cwd: testDir,
    env: { ...process.env, FORGE_HUB_DIR: hubDir },
    encoding: "utf-8",
  });
  if (child.status !== 0) {
    throw new Error(`子进程退出 ${child.status}\nstdout: ${child.stdout}\nstderr: ${child.stderr}`);
  }
  const lastLine = child.stdout.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(lastLine);
}

// ── loadLockState / isLocked ───────────────────────────────────────────────

describe("loadLockState / isLocked — default unlocked", () => {
  test("isLocked returns false when no lock.json exists", () => {
    const result = runInIsolation(`
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      cfg.loadLockState();
      console.log(JSON.stringify({ locked: cfg.isLocked() }));
    `);
    expect(result).toEqual({ locked: false });
  });

  test("isLocked returns true after loading a locked lock.json", () => {
    fs.writeFileSync(
      path.join(hubDir, "lock.json"),
      JSON.stringify({ locked: true, at: "2026-01-01T00:00:00Z", by: "test" }),
    );
    const result = runInIsolation(`
      const cfg = require("./config.ts");
      cfg.loadLockState();
      console.log(JSON.stringify({
        locked: cfg.isLocked(),
        by: cfg.getLockState().by,
      }));
    `);
    expect(result).toEqual({ locked: true, by: "test" });
  });

  test("corrupted lock.json → fail-closed (assume locked)", () => {
    fs.writeFileSync(path.join(hubDir, "lock.json"), "NOT JSON{{{");
    const result = runInIsolation(`
      const cfg = require("./config.ts");
      cfg.loadLockState();
      console.log(JSON.stringify({
        locked: cfg.isLocked(),
        byContainsRecovery: cfg.getLockState().by.includes("recovery"),
      }));
    `);
    expect(result).toEqual({ locked: true, byContainsRecovery: true });
  });
});

// ── setLocked ──────────────────────────────────────────────────────────────

describe("setLocked — sets locked state, writes to disk", () => {
  test("setLocked writes lock.json and flips isLocked to true", () => {
    const result = runInIsolation(`
      const fs = require("fs");
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      cfg.setLocked("telegram:用户");
      const data = JSON.parse(fs.readFileSync(cfg.LOCK_FILE, "utf-8"));
      console.log(JSON.stringify({
        locked: cfg.isLocked(),
        fileLocked: data.locked,
        by: data.by,
        hasAt: !!data.at,
      }));
    `);
    expect(result).toEqual({
      locked: true,
      fileLocked: true,
      by: "telegram:用户",
      hasAt: true,
    });
  });

  test("setLocked appends audit entry", () => {
    const result = runInIsolation(`
      const fs = require("fs");
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      cfg.setLocked("cli");
      const lines = fs.readFileSync(cfg.AUDIT_FILE, "utf-8").trim().split("\\n");
      const entry = JSON.parse(lines[lines.length - 1]);
      console.log(JSON.stringify({ action: entry.action, by: entry.by }));
    `);
    expect(result).toEqual({ action: "lock", by: "cli" });
  });
});

// ── setUnlocked ────────────────────────────────────────────────────────────

describe("setUnlocked — clears locked state", () => {
  test("setUnlocked clears lock and removes lock.json", () => {
    const result = runInIsolation(`
      const fs = require("fs");
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      cfg.setLocked("test");
      cfg.setUnlocked();
      console.log(JSON.stringify({
        locked: cfg.isLocked(),
        fileExists: fs.existsSync(cfg.LOCK_FILE),
      }));
    `);
    expect(result).toEqual({ locked: false, fileExists: false });
  });

  test("setUnlocked writes audit entry before clearing state", () => {
    const result = runInIsolation(`
      const fs = require("fs");
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      cfg.setLocked("test");
      cfg.setUnlocked();
      const lines = fs.readFileSync(cfg.AUDIT_FILE, "utf-8").trim().split("\\n");
      const last = JSON.parse(lines[lines.length - 1]);
      console.log(JSON.stringify({ action: last.action }));
    `);
    expect(result).toEqual({ action: "unlock" });
  });

  test("setUnlocked throws when audit file is unwritable (fail-closed)", () => {
    const result = runInIsolation(`
      const fs = require("fs");
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      cfg.setLocked("test");
      // 把 audit.jsonl 替换成目录让 appendFileSync 失败
      fs.rmSync(cfg.AUDIT_FILE, { force: true });
      fs.mkdirSync(cfg.AUDIT_FILE);
      let threw = false;
      try { cfg.setUnlocked(); } catch (err) {
        threw = String(err).includes("audit 不可写，拒绝 unlock");
      }
      console.log(JSON.stringify({
        threw,
        locked: cfg.isLocked(),
        lockFileExists: fs.existsSync(cfg.LOCK_FILE),
      }));
    `);
    expect(result).toEqual({ threw: true, locked: true, lockFileExists: true });
  });
});

// ── assertLockPhraseHealthy ────────────────────────────────────────────────

describe("assertLockPhraseHealthy — throws on missing/corrupt lock-phrase.json", () => {
  test("no lock-phrase.json → does not throw (phrase disabled)", () => {
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      let threw = false;
      try { lock.assertLockPhraseHealthy(); } catch { threw = true; }
      console.log(JSON.stringify({ threw }));
    `);
    expect(result).toEqual({ threw: false });
  });

  test("valid lock-phrase.json → does not throw", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: "panic-123" }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      let threw = false;
      try { lock.assertLockPhraseHealthy(); } catch { threw = true; }
      console.log(JSON.stringify({ threw }));
    `);
    expect(result).toEqual({ threw: false });
  });

  test("corrupt JSON → throws LockPhraseConfigError", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), "{invalid json!!!");
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      let threw = false;
      let errorName = "";
      try { lock.assertLockPhraseHealthy(); } catch (err) {
        threw = true;
        errorName = err.name;
      }
      console.log(JSON.stringify({ threw, errorName }));
    `);
    expect(result).toEqual({ threw: true, errorName: "LockPhraseConfigError" });
  });

  test("phrase is non-string → throws LockPhraseConfigError", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: 42 }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      let threw = false;
      let errorName = "";
      try { lock.assertLockPhraseHealthy(); } catch (err) {
        threw = true;
        errorName = err.name;
      }
      console.log(JSON.stringify({ threw, errorName }));
    `);
    expect(result).toEqual({ threw: true, errorName: "LockPhraseConfigError" });
  });
});

// ── getLockPhrase ──────────────────────────────────────────────────────────

describe("getLockPhrase — returns phrase from file", () => {
  test("returns empty string when file does not exist", () => {
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({ phrase: lock.getLockPhrase() }));
    `);
    expect(result).toEqual({ phrase: "" });
  });

  test("returns trimmed phrase", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: "  my secret phrase  " }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({ phrase: lock.getLockPhrase() }));
    `);
    expect(result).toEqual({ phrase: "my secret phrase" });
  });

  test("returns empty string when phrase is null", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: null }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({ phrase: lock.getLockPhrase() }));
    `);
    expect(result).toEqual({ phrase: "" });
  });

  test("returns empty string when phrase key is missing", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ other: "stuff" }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({ phrase: lock.getLockPhrase() }));
    `);
    expect(result).toEqual({ phrase: "" });
  });
});

// ── isLockTrigger (checkMessageForLockPhrase) ──────────────────────────────

describe("isLockTrigger — detects exact match", () => {
  test("returns true on exact match (after trim)", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: "紧急锁定" }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({
        exact: lock.isLockTrigger("紧急锁定"),
        trimmed: lock.isLockTrigger("  紧急锁定  "),
      }));
    `);
    expect(result).toEqual({ exact: true, trimmed: true });
  });

  test("returns false on partial match", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: "紧急锁定" }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({
        prefix: lock.isLockTrigger("请紧急锁定"),
        suffix: lock.isLockTrigger("紧急锁定！"),
      }));
    `);
    expect(result).toEqual({ prefix: false, suffix: false });
  });

  test("returns false when no phrase configured", () => {
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({
        anything: lock.isLockTrigger("anything"),
        empty: lock.isLockTrigger(""),
      }));
    `);
    expect(result).toEqual({ anything: false, empty: false });
  });

  test("returns false when phrase is empty string", () => {
    fs.writeFileSync(path.join(hubDir, "lock-phrase.json"), JSON.stringify({ phrase: "" }));
    const result = runInIsolation(`
      const lock = require("./lock.ts");
      console.log(JSON.stringify({
        empty: lock.isLockTrigger(""),
      }));
    `);
    expect(result).toEqual({ empty: false });
  });
});
