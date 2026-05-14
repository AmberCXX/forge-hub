import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanDirContents, HUB_INSTALL_PRESERVE_ENTRIES, syncApiTokenFileAt } from "./cli.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("install runtime preservation", () => {
  test("preserves security evidence, events, and audit materials", () => {
    const preservedEntries = [
      "state",
      "evidence",
      "security-events.jsonl",
      "audit.jsonl",
      "api-token",
    ];
    for (const entry of preservedEntries) {
      const p = path.join(tmpDir, entry);
      if (entry.includes(".")) {
        fs.writeFileSync(p, entry);
      } else {
        fs.mkdirSync(p, { recursive: true });
      }
    }
    fs.writeFileSync(path.join(tmpDir, "old-runtime.ts"), "remove me");

    cleanDirContents(tmpDir, new Set(HUB_INSTALL_PRESERVE_ENTRIES));

    for (const entry of preservedEntries) {
      expect(fs.existsSync(path.join(tmpDir, entry))).toBe(true);
    }
    expect(fs.existsSync(path.join(tmpDir, "old-runtime.ts"))).toBe(false);
  });
});

describe("syncApiTokenFileAt", () => {
  test("atomically replaces an existing regular token file", () => {
    const tokenFile = path.join(tmpDir, "api-token");
    fs.writeFileSync(tokenFile, "old-token", { mode: 0o600 });

    syncApiTokenFileAt({
      hubDir: tmpDir,
      apiTokenFile: tokenFile,
      token: "new-token",
    });

    expect(fs.readFileSync(tokenFile, "utf-8")).toBe("new-token");
    expect(fs.lstatSync(tokenFile).isFile()).toBe(true);
    expect(fs.statSync(tokenFile).mode & 0o077).toBe(0);
  });

  test("replaces a symlink itself without writing through it", () => {
    const tokenFile = path.join(tmpDir, "api-token");
    const attackerTarget = path.join(tmpDir, "attacker-target");
    fs.symlinkSync(attackerTarget, tokenFile);

    syncApiTokenFileAt({
      hubDir: tmpDir,
      apiTokenFile: tokenFile,
      token: "safe-token",
    });

    expect(fs.lstatSync(tokenFile).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(tokenFile, "utf-8")).toBe("safe-token");
    expect(fs.existsSync(attackerTarget)).toBe(false);
  });
});
