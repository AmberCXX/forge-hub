import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enqueueAppend, drainQueuedWrites } from "./write-queue.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await drainQueuedWrites();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-wq-"));
  tempDirs.push(dir);
  return dir;
}

describe("write-queue", () => {
  test("enqueueAppend creates file and writes content", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "out.txt");

    enqueueAppend(filePath, "hello\n");
    await drainQueuedWrites();

    const content = await fs.promises.readFile(filePath, "utf-8");
    expect(content).toBe("hello\n");
  });

  test("enqueueAppend creates parent directory with dirMode", async () => {
    const dir = makeTmpDir();
    const nested = path.join(dir, "a", "b");
    const filePath = path.join(nested, "out.txt");

    enqueueAppend(filePath, "deep\n", { dirMode: 0o755 });
    await drainQueuedWrites();

    const stat = await fs.promises.stat(nested);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o755);

    const content = await fs.promises.readFile(filePath, "utf-8");
    expect(content).toBe("deep\n");
  });

  test("multiple writes to same file are serialized (content appears in order)", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "serial.txt");

    enqueueAppend(filePath, "A");
    enqueueAppend(filePath, "B");
    enqueueAppend(filePath, "C");
    await drainQueuedWrites();

    const content = await fs.promises.readFile(filePath, "utf-8");
    expect(content).toBe("ABC");
  });

  test("drainQueuedWrites waits for all pending writes", async () => {
    const dir = makeTmpDir();
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");

    enqueueAppend(fileA, "1");
    enqueueAppend(fileB, "2");
    enqueueAppend(fileA, "3");

    await drainQueuedWrites();

    const contentA = await fs.promises.readFile(fileA, "utf-8");
    const contentB = await fs.promises.readFile(fileB, "utf-8");
    expect(contentA).toBe("13");
    expect(contentB).toBe("2");
  });

  test("onError callback is invoked on write failure", async () => {
    const dir = makeTmpDir();
    // Point to a path where the parent is a file, not a directory — mkdir will fail
    const blocker = path.join(dir, "blocker");
    await fs.promises.writeFile(blocker, "I am a file");
    const filePath = path.join(blocker, "sub", "out.txt");

    const errors: { err: unknown; filePath: string }[] = [];

    enqueueAppend(filePath, "fail\n", {
      onError(err, fp) {
        errors.push({ err, filePath: fp });
      },
    });
    await drainQueuedWrites();

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toBe(filePath);
    expect(errors[0].err).toBeInstanceOf(Error);
  });

  test("file permissions match fileMode option", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "secret.txt");

    enqueueAppend(filePath, "private\n", { fileMode: 0o600 });
    await drainQueuedWrites();

    const stat = await fs.promises.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
