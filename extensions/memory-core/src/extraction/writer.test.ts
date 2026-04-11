import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMemMarker,
  formatDateStamp,
  formatEntry,
  formatTimeInTimezone,
  readExistingMarkers,
} from "./writer.js";

describe("writer", () => {
  describe("buildMemMarker", () => {
    it("produces consistent markers for same text", () => {
      const marker1 = buildMemMarker("hello world");
      const marker2 = buildMemMarker("hello world");
      expect(marker1).toBe(marker2);
      expect(marker1).toMatch(/^<!-- mem:[a-f0-9]{12} -->$/);
    });

    it("produces different markers for different text", () => {
      const marker1 = buildMemMarker("hello");
      const marker2 = buildMemMarker("world");
      expect(marker1).not.toBe(marker2);
    });
  });

  describe("formatDateStamp", () => {
    it("formats date in UTC", () => {
      // 2026-01-15 12:00 UTC
      const ms = new Date("2026-01-15T12:00:00Z").getTime();
      expect(formatDateStamp(ms, "UTC")).toBe("2026-01-15");
    });

    it("handles timezone offset", () => {
      // 2026-01-15 23:30 UTC = 2026-01-16 in Asia/Shanghai (+8)
      const ms = new Date("2026-01-15T23:30:00Z").getTime();
      expect(formatDateStamp(ms, "Asia/Shanghai")).toBe("2026-01-16");
    });
  });

  describe("formatTimeInTimezone", () => {
    it("formats HH:MM in UTC", () => {
      const ms = new Date("2026-01-15T14:30:00Z").getTime();
      expect(formatTimeInTimezone(ms, "UTC")).toBe("14:30");
    });
  });

  describe("formatEntry", () => {
    it("formats a memory entry as markdown", () => {
      const entry = { category: "fact", text: "User prefers TypeScript" };
      const result = formatEntry(entry, "14:30");
      expect(result).toContain("## 14:30 [fact]");
      expect(result).toContain("User prefers TypeScript");
      expect(result).toMatch(/<!-- mem:[a-f0-9]{12} -->/);
    });
  });

  describe("readExistingMarkers", () => {
    it("returns empty set for non-existent file", async () => {
      const markers = await readExistingMarkers("/nonexistent/path/file.md");
      expect(markers.size).toBe(0);
    });

    it("reads markers from file tail", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "writer-test-"));
      const filePath = path.join(tmpDir, "test.md");
      const content = [
        "## 10:00 [fact]",
        "Some content",
        "",
        "<!-- mem:aabbccdd1122 -->",
        "",
        "## 10:05 [preference]",
        "Other content",
        "",
        "<!-- mem:112233445566 -->",
        "",
      ].join("\n");
      await fs.writeFile(filePath, content, "utf-8");

      const markers = await readExistingMarkers(filePath, 20);
      expect(markers.size).toBe(2);
      expect(markers.has("<!-- mem:aabbccdd1122 -->")).toBe(true);
      expect(markers.has("<!-- mem:112233445566 -->")).toBe(true);

      await fs.rm(tmpDir, { recursive: true });
    });
  });
});
