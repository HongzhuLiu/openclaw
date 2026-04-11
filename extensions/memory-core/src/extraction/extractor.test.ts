import { describe, expect, it } from "vitest";
import {
  extractConversationText,
  shouldProcess,
  VALID_CATEGORIES,
  __testing,
} from "./extractor.js";

describe("extractor", () => {
  describe("shouldProcess", () => {
    const defaults = { excludeTriggers: ["heartbeat", "cron", "memory"] };

    it("skips failed runs", () => {
      expect(shouldProcess({ success: false, messageCount: 10, ...defaults })).toBe(false);
    });

    it("skips excluded triggers", () => {
      expect(
        shouldProcess({ success: true, trigger: "heartbeat", messageCount: 10, ...defaults }),
      ).toBe(false);
      expect(shouldProcess({ success: true, trigger: "cron", messageCount: 10, ...defaults })).toBe(
        false,
      );
      expect(
        shouldProcess({ success: true, trigger: "memory", messageCount: 10, ...defaults }),
      ).toBe(false);
    });

    it("skips when messages < 3", () => {
      expect(shouldProcess({ success: true, messageCount: 2, ...defaults })).toBe(false);
    });

    it("allows valid runs", () => {
      expect(shouldProcess({ success: true, messageCount: 5, ...defaults })).toBe(true);
      expect(shouldProcess({ success: true, trigger: "user", messageCount: 5, ...defaults })).toBe(
        true,
      );
    });

    it("allows when trigger is undefined", () => {
      expect(shouldProcess({ success: true, messageCount: 5, ...defaults })).toBe(true);
    });
  });

  describe("extractConversationText", () => {
    it("returns null for fewer than 3 relevant messages", () => {
      const messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      expect(extractConversationText(messages, 4)).toBeNull();
    });

    it("extracts text from messages", () => {
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "What is TypeScript?" },
        { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
        { role: "user", content: "I prefer strict mode" },
        { role: "assistant", content: "Good choice!" },
      ];
      const result = extractConversationText(messages, 4);
      expect(result).toContain("[user]: What is TypeScript?");
      expect(result).toContain("[assistant]: TypeScript is a typed superset of JavaScript.");
      expect(result).toContain("[user]: I prefer strict mode");
      // system messages filtered out
      expect(result).not.toContain("You are helpful");
    });

    it("handles multipart content blocks", () => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];
      const result = extractConversationText(messages, 4);
      expect(result).toContain("[user]: Hello");
    });

    it("limits to maxMessages pairs", () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
      }));
      const result = extractConversationText(messages, 2);
      // Should only contain last 4 messages (2 pairs)
      expect(result).not.toContain("Message 0");
      expect(result).toContain("Message 19");
    });
  });

  describe("normalizeMemories", () => {
    const { normalizeMemories } = __testing;

    it("filters out low confidence entries", () => {
      const result = normalizeMemories(
        {
          memories: [
            { category: "fact", text: "Important fact", confidence: 0.9 },
            { category: "fact", text: "Uncertain thing", confidence: 0.3 },
          ],
        },
        5,
      );
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Important fact");
    });

    it("defaults unknown categories to fact", () => {
      const result = normalizeMemories(
        { memories: [{ category: "unknown_cat", text: "Some text", confidence: 0.8 }] },
        5,
      );
      expect(result[0].category).toBe("fact");
    });

    it("respects maxEntries limit", () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        category: "fact",
        text: `Memory ${i}`,
        confidence: 0.9,
      }));
      const result = normalizeMemories({ memories }, 3);
      expect(result).toHaveLength(3);
    });

    it("accepts all valid categories", () => {
      for (const cat of VALID_CATEGORIES) {
        const result = normalizeMemories(
          { memories: [{ category: cat, text: `Test ${cat}`, confidence: 0.8 }] },
          5,
        );
        expect(result[0].category).toBe(cat);
      }
    });

    it("handles empty or invalid input", () => {
      expect(normalizeMemories({ memories: [] }, 5)).toHaveLength(0);
      expect(normalizeMemories({ memories: null as never }, 5)).toHaveLength(0);
      expect(
        normalizeMemories({ memories: [{ category: "fact", text: "", confidence: 0.9 }] }, 5),
      ).toHaveLength(0);
    });
  });
});
