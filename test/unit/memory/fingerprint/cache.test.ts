import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setProvider } from "../../../../src/providers/index.ts";
import { CachedExtractor } from "../../../../src/memory/fingerprint/cache.ts";
import type { LLMProvider } from "../../../../src/providers/types.ts";

describe("Extraction Cache", () => {
  const testCacheFile = path.join(import.meta.dir, "temp-fingerprint-cache.jsonl");
  let extractor: CachedExtractor;
  let llmCallCount = 0;

  beforeEach(() => {
    llmCallCount = 0;
    extractor = new CachedExtractor(testCacheFile);

    // Mock Provider that counts how many times the LLM is hit
    const mockProvider: LLMProvider = {
      name: "anthropic",
      createMessageStream: async function* () {
        llmCallCount++;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            tool: "jest",
            error_class: "TypeError",
            file: "test.ts",
            expression: "cannot read property"
          })
        };
      }
    };
    setProvider(mockProvider);
  });

  afterEach(async () => {
    setProvider(null);
    await extractor.clearForTesting();
  });

  it("should call the LLM extractor on first encounter and write to cache", async () => {
    const errorText = "TypeError: cannot read property of undefined at test.ts:5";
    const result = await extractor.getOrCreate(errorText, "jest test", {
      model: "mock-model"
    });

    expect(result.coarse).toBe("jest|TypeError");
    expect(llmCallCount).toBe(1);
  });

  it("should return the cached fingerprint on second encounter without LLM invocation", async () => {
    const errorText = "TypeError: cannot read property of undefined at test.ts:5";
    
    // First lookup: writes to cache
    const result1 = await extractor.getOrCreate(errorText, "jest test", {
      model: "mock-model"
    });
    
    // Second lookup: retrieves from memory cache
    const result2 = await extractor.getOrCreate(errorText, "jest test", {
      model: "mock-model"
    });

    expect(result1).toEqual(result2);
    expect(llmCallCount).toBe(1); // LLM called exactly once
  });

  it("should persist cache to disk and load it upon new instance startup", async () => {
    const errorText1 = "TypeError: cannot read property of undefined at test.ts:5";
    const errorText2 = "SyntaxError: unexpected token at main.ts:12";

    // Write two entries to the cache
    await extractor.getOrCreate(errorText1, "jest test", { model: "mock-model" });
    
    // Mock provider should return a different output for the second error to test unique keys
    const mockProvider2: LLMProvider = {
      name: "anthropic",
      createMessageStream: async function* () {
        llmCallCount++;
        yield {
          type: "text_delta",
          text: JSON.stringify({
            tool: "eslint",
            error_class: "SyntaxError",
            file: "main.ts",
            expression: "unexpected token"
          })
        };
      }
    };
    setProvider(mockProvider2);
    
    await extractor.getOrCreate(errorText2, "eslint main.ts", { model: "mock-model" });
    expect(llmCallCount).toBe(2);

    // Create a NEW extractor reading from the same file (simulating agent restart)
    const newExtractor = new CachedExtractor(testCacheFile);
    
    // Disable LLM provider completely (should throw if called)
    setProvider({
      name: "anthropic",
      createMessageStream: () => {
        throw new Error("LLM should not be called!");
      }
    });

    // Lookups should hit the persisted cache and load successfully
    const result1 = await newExtractor.getOrCreate(errorText1, "jest test", { model: "mock-model" });
    const result2 = await newExtractor.getOrCreate(errorText2, "eslint main.ts", { model: "mock-model" });

    expect(result1.coarse).toBe("jest|TypeError");
    expect(result2.coarse).toBe("eslint|SyntaxError");
    
    // Clean up new extractor's file
    await newExtractor.clearForTesting();
  });
});
