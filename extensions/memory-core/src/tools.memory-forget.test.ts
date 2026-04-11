import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeLinesFromFile } from "./tools.memory-forget.js";

describe("memory_forget", () => {
  async function createTempFile(content: string): Promise<{ dir: string; filePath: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forget-test-"));
    const filePath = path.join(dir, "test.md");
    await fs.writeFile(filePath, content, "utf-8");
    return { dir, filePath };
  }

  describe("removeLinesFromFile", () => {
    it("removes a range of lines from a file", async () => {
      const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
      const { dir, filePath } = await createTempFile(content);

      const removed = await removeLinesFromFile(filePath, 2, 4);
      expect(removed).toBe(3);

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toBe("line 1\nline 5");

      await fs.rm(dir, { recursive: true });
    });

    it("removes a single line", async () => {
      const content = ["line 1", "line 2", "line 3"].join("\n");
      const { dir, filePath } = await createTempFile(content);

      const removed = await removeLinesFromFile(filePath, 2, 2);
      expect(removed).toBe(1);

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toBe("line 1\nline 3");

      await fs.rm(dir, { recursive: true });
    });

    it("clamps to valid range", async () => {
      const content = ["line 1", "line 2", "line 3"].join("\n");
      const { dir, filePath } = await createTempFile(content);

      const removed = await removeLinesFromFile(filePath, 0, 100);
      expect(removed).toBe(3);

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toBe("");

      await fs.rm(dir, { recursive: true });
    });

    it("returns 0 for invalid range", async () => {
      const content = "line 1\nline 2";
      const { dir, filePath } = await createTempFile(content);

      const removed = await removeLinesFromFile(filePath, 5, 3);
      expect(removed).toBe(0);

      await fs.rm(dir, { recursive: true });
    });

    it("collapses excessive blank lines after deletion", async () => {
      const content = ["line 1", "", "## Memory", "content", "", "<!-- mem:abc -->", "", "", "line end"].join("\n");
      const { dir, filePath } = await createTempFile(content);

      // Remove the memory entry (lines 3-6)
      await removeLinesFromFile(filePath, 3, 6);

      const result = await fs.readFile(filePath, "utf-8");
      // Should not have 3+ consecutive blank lines
      expect(result).not.toMatch(/\n\n\n\n/);
      expect(result).toContain("line 1");
      expect(result).toContain("line end");

      await fs.rm(dir, { recursive: true });
    });
  });
});
