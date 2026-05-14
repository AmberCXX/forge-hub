export interface RiskFlags {
  hasZeroWidth: boolean;
  hasBidiControl: boolean;
  hasTagBlock: boolean;
  hasVariationSelector: boolean;
  mixedScript: boolean;
  looksLikeBase64: boolean;
  wasTruncated: boolean;
}

export interface SanitizeResult {
  displayValue: string;
  riskFlags: RiskFlags;
}

// Strip 用 /g（replace 需要），detect 用不带 /g 的副本（避免 lastIndex 残留）
const TAG_STRIP = /[\u{E0000}-\u{E007F}]/gu;
const TAG_TEST = /[\u{E0000}-\u{E007F}]/u;
const ZERO_WIDTH_STRIP = /[​‌‍⁠﻿]/g;
const ZERO_WIDTH_TEST = /[​‌‍⁠﻿]/;
const BIDI_STRIP = /[‎‏‪-‮⁦-⁩]/g;
const BIDI_TEST = /[‎‏‪-‮⁦-⁩]/;
const VS_STRIP = /[︀-️]/g;
const VS_TEST = /[︀-️]/;
const MIXED_SCRIPT_LATIN = /[a-zA-Z]/;
const MIXED_SCRIPT_CYRILLIC = /[Ѐ-ӿ]/;
const BASE64_RE = /[A-Za-z0-9+/=]{20,}/;

function stripInvisibles(s: string): string {
  return s
    .replace(TAG_STRIP, "")
    .replace(ZERO_WIDTH_STRIP, "")
    .replace(BIDI_STRIP, "")
    .replace(VS_STRIP, "");
}

function xmlEncode(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sanitizeExternalField(input: string, maxLen: number): SanitizeResult {
  const normalized = input.normalize("NFKC");

  let current = normalized;
  let prev: string;
  do {
    prev = current;
    current = stripInvisibles(current);
  } while (current !== prev);

  const hasZeroWidth = ZERO_WIDTH_TEST.test(normalized);
  const hasBidiControl = BIDI_TEST.test(normalized);
  const hasTagBlock = TAG_TEST.test(normalized);
  const hasVariationSelector = VS_TEST.test(normalized);
  const mixedScript = MIXED_SCRIPT_LATIN.test(current) && MIXED_SCRIPT_CYRILLIC.test(current);
  const looksLikeBase64 = BASE64_RE.test(current);
  const wasTruncated = current.length > maxLen;

  const truncated = current.slice(0, maxLen);
  const displayValue = xmlEncode(truncated);

  return {
    displayValue,
    riskFlags: {
      hasZeroWidth,
      hasBidiControl,
      hasTagBlock,
      hasVariationSelector,
      mixedScript,
      looksLikeBase64,
      wasTruncated,
    },
  };
}

export function sanitizeDisplayName(input: string): SanitizeResult {
  return sanitizeExternalField(input, 64);
}

export function sanitizeMessagePreview(input: string): SanitizeResult {
  return sanitizeExternalField(input, 500);
}

export function sanitizeFileName(input: string): SanitizeResult {
  return sanitizeExternalField(input, 128);
}

export function sanitizeCaption(input: string): SanitizeResult {
  return sanitizeExternalField(input, 500);
}
