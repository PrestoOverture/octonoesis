import { describe, expect, it } from "bun:test";
import { scrub } from "../../../../src/memory/fingerprint/scrub.ts";

describe("Universal Scrubber", () => {
  const repoRoot = "/Users/kwang/projects/coding_agent";

  it("should strip ANSI escape sequences", () => {
    const input = "\u001b[31mError:\u001b[39m \u001b[1mSomething went wrong\u001b[22m";
    const expected = "Error: Something went wrong";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should replace absolute paths under repoRoot with relative paths", () => {
    const input = `at handleUser (${repoRoot}/src/buggy.ts)`;
    const expected = "at handleUser (src/buggy.ts)";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should handle repoRoot with or without trailing slash", () => {
    const input = `at handleUser (${repoRoot}/src/buggy.ts)`;
    const expected = "at handleUser (src/buggy.ts)";
    expect(scrub(input, repoRoot + "/")).toBe(expected);
  });

  it("should normalize line and column numbers on relative paths", () => {
    const input = "at src/buggy.ts:7:20 and other/file.js:12";
    const expected = "at src/buggy.ts:<line>:<col> and other/file.js:<line>";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should normalize labeled line and column numbers", () => {
    const input = "Error on line 145, column 12 (col 12)";
    const expected = "Error on line <line>, col <col> (col <col>)";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should normalize timestamps and dates", () => {
    const input = "Time: 2026-06-19T18:03:32.123Z, date: 2026-06-19, clock: 18:03:32";
    const expected = "Time: <timestamp>, date: <date>, clock: <time>";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should normalize memory addresses", () => {
    const input = "Crash at address 0x7ffee3bf and pointer 0x000000010c2c10b0";
    const expected = "Crash at address <address> and pointer <address>";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should normalize durations", () => {
    const input = "Tests passed in 15ms (1.25s) / 3 seconds";
    const expected = "Tests passed in <duration> (<duration>) / <duration>";
    expect(scrub(input, repoRoot)).toBe(expected);
  });

  it("should NOT strip error codes like TS2345 or other alphanumerics", () => {
    const input = "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
    // Should remain exactly as is (excluding paths/numbers we don't normalize)
    expect(scrub(input, repoRoot)).toBe(input);
  });

  it("should handle empty or undefined input gracefully", () => {
    expect(scrub("", repoRoot)).toBe("");
  });
});
