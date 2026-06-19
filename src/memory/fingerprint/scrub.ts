/**
 * Universal Scrubber
 * Deterministically normalizes volatile output (ANSI codes, absolute paths,
 * line/column numbers, timestamps, memory addresses, and durations)
 * without using LLMs, ensuring stable keys for fingerprint caching.
 */

// Regex patterns for scrubbing
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

// Matches ISO timestamps: e.g., 2026-06-19T18:03:32.123Z or 2026-06-19T18:03:32+08:00
const ISO_TIMESTAMP_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi;

// Matches standard times: e.g., 18:03:32.123
const TIME_REGEX = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/gi;

// Matches standard dates: e.g., 2026-06-19
const DATE_REGEX = /\b\d{4}-\d{2}-\d{2}\b/gi;

// Matches hex memory addresses: e.g., 0x7ffee3bf or 0x000000010c2c10b0
const HEX_ADDRESS_REGEX = /\b0x[0-9a-fA-F]+\b/g;

// Matches durations: e.g., 15ms, 1.25s, 3 seconds, 0.4s
const DURATION_REGEX = /\b\d+(?:\.\d+)?\s*(?:ms|seconds?|s)\b/gi;

// Matches paths with line/column info: e.g., src/buggy.ts:7:20 -> src/buggy.ts:<line>:<col>
const PATH_LINE_COL_REGEX = /(\b[\w\.-]+(?:\/[\w\.-]+)*\.[a-zA-Z0-9]+):(\d+):(\d+)\b/g;

// Matches paths with line info: e.g., src/buggy.ts:7 -> src/buggy.ts:<line>
const PATH_LINE_REGEX = /(\b[\w\.-]+(?:\/[\w\.-]+)*\.[a-zA-Z0-9]+):(\d+)\b/g;

// Matches "line 12" and "column 34" patterns
const LINE_NUMBER_LABEL_REGEX = /\bline\s+(\d+)\b/gi;
const COL_NUMBER_LABEL_REGEX = /\bcol(?:umn)?\s+(\d+)\b/gi;

export function scrub(text: string, repoRoot: string): string {
  if (!text) return "";

  // 1. Remove ANSI escape codes
  let scrubbed = text.replace(ANSI_REGEX, "");

  // 2. Replace absolute paths under repoRoot with relative paths.
  // We normalize potential trailing slashes in the repoRoot.
  const normalizedRoot = repoRoot.replace(/\/$/, "");
  const escapedRoot = normalizedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootPattern = new RegExp(escapedRoot + "/?", "g");
  scrubbed = scrubbed.replace(rootPattern, "");

  // 3. Normalize line:col patterns
  scrubbed = scrubbed.replace(PATH_LINE_COL_REGEX, "$1:<line>:<col>");
  scrubbed = scrubbed.replace(PATH_LINE_REGEX, "$1:<line>");
  scrubbed = scrubbed.replace(LINE_NUMBER_LABEL_REGEX, "line <line>");
  scrubbed = scrubbed.replace(COL_NUMBER_LABEL_REGEX, "col <col>");

  // 4. Normalize timestamps and dates
  scrubbed = scrubbed.replace(ISO_TIMESTAMP_REGEX, "<timestamp>");
  scrubbed = scrubbed.replace(TIME_REGEX, "<time>");
  scrubbed = scrubbed.replace(DATE_REGEX, "<date>");

  // 5. Normalize hex memory addresses
  scrubbed = scrubbed.replace(HEX_ADDRESS_REGEX, "<address>");

  // 6. Normalize durations
  scrubbed = scrubbed.replace(DURATION_REGEX, "<duration>");

  return scrubbed;
}
