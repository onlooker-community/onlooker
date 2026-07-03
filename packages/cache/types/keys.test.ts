import { describe, expect, test } from "vitest";
import { type CacheKey, type CustomCacheNamespace, ZCacheKey } from "./keys";

describe("@onlooker/cache types/keys", () => {
  describe("ZCacheKey schema", () => {
    test("should validate valid cache keys", () => {
      const validKeys = [
        "ol:test:123:data",
        "ol:env:test:state",
        "analytics:user:123",
        "custom:namespace:key",
      ];

      validKeys.forEach((key) => {
        const result = ZCacheKey.safeParse(key);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(key);
        }
      });
    });

    test("should reject invalid cache keys", () => {
      const invalidKeys = [
        "", // empty string
        "   ", // whitespace only
        "\t", // tab only
        "\n", // newline only
        "  \n  ", // mixed whitespace
      ];

      invalidKeys.forEach((key) => {
        const result = ZCacheKey.safeParse(key);
        expect(result.success).toBe(false);
      });
    });

    test("should provide meaningful error messages", () => {
      const emptyResult = ZCacheKey.safeParse("");
      expect(emptyResult.success).toBe(false);
      if (!emptyResult.success) {
        expect(emptyResult.error.issues[0].message).toBe("Cache key cannot be empty");
      }

      const whitespaceResult = ZCacheKey.safeParse("   ");
      expect(whitespaceResult.success).toBe(false);
      if (!whitespaceResult.success) {
        expect(whitespaceResult.error.issues[0].message).toBe("Cache key cannot be empty or whitespace only");
      }
    });

    test("should create branded CacheKey type", () => {
      const validKey = "ol:test:123:data";
      const result = ZCacheKey.parse(validKey);

      // Type assertion to ensure it's properly branded
      const typedKey: CacheKey = result;
      expect(typedKey).toBe(validKey);
    });
  });

  describe("CacheKey type", () => {
    test("should work with type-safe functions", () => {
      // Helper function that only accepts CacheKey
      const acceptsCacheKey = (key: CacheKey): string => key;

      const validKey = ZCacheKey.parse("ol:env:test:state");
      expect(acceptsCacheKey(validKey)).toBe("ol:env:test:state");
    });

    test("should maintain string behavior", () => {
      const key = ZCacheKey.parse("ol:test:123");

      // Should work with string methods
      expect(key.length).toBe(11);
      expect(key.startsWith("ol:")).toBe(true);
      expect(key.split(":")).toEqual(["ol", "test", "123"]);
      expect(key.includes("test")).toBe(true);
    });

    test("should be serializable", () => {
      const key = ZCacheKey.parse("ol:serialization:test");

      // Should serialize as regular string
      expect(JSON.stringify({ cacheKey: key })).toBe('{"cacheKey":"ol:serialization:test"}');

      // Should parse back correctly
      const parsed = JSON.parse('{"cacheKey":"ol:serialization:test"}') as { cacheKey: string };
      expect(parsed.cacheKey).toBe("ol:serialization:test");
    });
  });

  describe("CustomCacheNamespace type", () => {
    test("should support known custom namespaces in parsed cache keys", () => {
      // Type test - this will fail at compile time if types don't match
      const namespaces: CustomCacheNamespace[] = ["account_deletion", "analytics", "billing", "oauth"];
      const cacheKeys = namespaces.map((namespace) => ZCacheKey.parse(`${namespace}:test:123`));

      expect(cacheKeys).toEqual([
        "account_deletion:test:123",
        "analytics:test:123",
        "billing:test:123",
        "oauth:test:123",
      ]);
    });

    test("should be usable in cache key construction", () => {
      const namespace: CustomCacheNamespace = "analytics";
      const cacheKey = ZCacheKey.parse(`${namespace}:user:123`);
      expect(cacheKey).toBe("analytics:user:123");
    });
  });
});
