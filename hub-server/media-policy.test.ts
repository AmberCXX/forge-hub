import { describe, expect, test } from "bun:test";

import {
  assertBufferWithinMediaSizeLimit,
  assertContentLengthWithinMediaLimit,
  formatMediaSize,
  MediaSizeLimitError,
} from "./media-policy.js";

// ── formatMediaSize ─────────────────────────────────────────────────────────

describe("formatMediaSize", () => {
  test("bytes below 1024 return B suffix", () => {
    expect(formatMediaSize(0)).toBe("0B");
    expect(formatMediaSize(1)).toBe("1B");
    expect(formatMediaSize(512)).toBe("512B");
    expect(formatMediaSize(1023)).toBe("1023B");
  });

  test("exactly 1024 bytes returns 1KB", () => {
    expect(formatMediaSize(1024)).toBe("1KB");
  });

  test("KB range uses Math.ceil", () => {
    expect(formatMediaSize(1025)).toBe("2KB");
    expect(formatMediaSize(2048)).toBe("2KB");
    expect(formatMediaSize(2049)).toBe("3KB");
    expect(formatMediaSize(1024 * 1023)).toBe("1023KB");
  });

  test("exactly 1MB returns integer without decimal", () => {
    expect(formatMediaSize(1024 * 1024)).toBe("1MB");
  });

  test("MB range uses toFixed(1) for non-integer values", () => {
    expect(formatMediaSize(1.5 * 1024 * 1024)).toBe("1.5MB");
    expect(formatMediaSize(50 * 1024 * 1024)).toBe("50MB");
  });

  test("non-round MB shows one decimal place", () => {
    // 1.25 MB
    expect(formatMediaSize(1.25 * 1024 * 1024)).toBe("1.3MB");
  });
});

// ── assertBufferWithinMediaSizeLimit ────────────────────────────────────────

describe("assertBufferWithinMediaSizeLimit", () => {
  test("does not throw when buffer is within limit", () => {
    const buf = Buffer.alloc(100);
    expect(() => assertBufferWithinMediaSizeLimit(buf, "test", 200)).not.toThrow();
  });

  test("does not throw when buffer is exactly at limit", () => {
    const buf = Buffer.alloc(200);
    expect(() => assertBufferWithinMediaSizeLimit(buf, "test", 200)).not.toThrow();
  });

  test("throws MediaSizeLimitError when buffer exceeds limit", () => {
    const buf = Buffer.alloc(201);
    expect(() => assertBufferWithinMediaSizeLimit(buf, "测试文件", 200)).toThrow(MediaSizeLimitError);
  });

  test("error contains label and formatted sizes", () => {
    const buf = Buffer.alloc(2 * 1024 * 1024);
    try {
      assertBufferWithinMediaSizeLimit(buf, "大文件", 1024 * 1024);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MediaSizeLimitError);
      const err = e as MediaSizeLimitError;
      expect(err.label).toBe("大文件");
      expect(err.actualBytes).toBe(2 * 1024 * 1024);
      expect(err.maxBytes).toBe(1024 * 1024);
      expect(err.message).toContain("大文件");
      expect(err.message).toContain("1MB");
      expect(err.message).toContain("2MB");
    }
  });

  test("accepts Uint8Array as well as Buffer", () => {
    const arr = new Uint8Array(50);
    expect(() => assertBufferWithinMediaSizeLimit(arr, "test", 100)).not.toThrow();
  });
});

// ── assertContentLengthWithinMediaLimit ─────────────────────────────────────

describe("assertContentLengthWithinMediaLimit", () => {
  test("no-op when content-length header is missing", () => {
    const headers = new Headers();
    expect(() => assertContentLengthWithinMediaLimit(headers, "test", 100)).not.toThrow();
  });

  test("no-op when content-length is within limit", () => {
    const headers = new Headers({ "content-length": "50" });
    expect(() => assertContentLengthWithinMediaLimit(headers, "test", 100)).not.toThrow();
  });

  test("no-op when content-length equals limit", () => {
    const headers = new Headers({ "content-length": "100" });
    expect(() => assertContentLengthWithinMediaLimit(headers, "test", 100)).not.toThrow();
  });

  test("throws MediaSizeLimitError when content-length exceeds limit", () => {
    const headers = new Headers({ "content-length": "101" });
    expect(() => assertContentLengthWithinMediaLimit(headers, "下载", 100)).toThrow(MediaSizeLimitError);
  });

  test("no-op when content-length is not a finite number", () => {
    const headers = new Headers({ "content-length": "abc" });
    expect(() => assertContentLengthWithinMediaLimit(headers, "test", 100)).not.toThrow();
  });

  test("no-op when content-length is negative", () => {
    const headers = new Headers({ "content-length": "-1" });
    expect(() => assertContentLengthWithinMediaLimit(headers, "test", 100)).not.toThrow();
  });

  test("uses default max bytes when not specified", () => {
    // 50MB default; 51MB content-length should throw
    const headers = new Headers({ "content-length": String(51 * 1024 * 1024) });
    expect(() => assertContentLengthWithinMediaLimit(headers, "test")).toThrow(MediaSizeLimitError);
  });

  test("does not throw with default max bytes when within limit", () => {
    const headers = new Headers({ "content-length": String(49 * 1024 * 1024) });
    expect(() => assertContentLengthWithinMediaLimit(headers, "test")).not.toThrow();
  });
});
