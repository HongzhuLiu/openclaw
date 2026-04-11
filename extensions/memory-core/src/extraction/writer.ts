/**
 * Memory writer: SHA-256 dedup + append to memory/YYYY-MM-DD.md.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  writeFileWithinRoot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryEntry = {
  category: string;
  text: string;
};

export type WriterContext = {
  cfg: OpenClawConfig;
  agentId: string;
  timezone: string;
};

/** Build `<!-- mem:xxxxxxxxxxxx -->` marker from first 12 hex chars of SHA-256. */
export function buildMemMarker(text: string): string {
  const hash = hashText(text).slice(0, 12);
  return `<!-- mem:${hash} -->`;
}

/**
 * Read existing mem markers from the tail of the daily file (last N lines).
 * Returns a Set of marker strings found.
 */
export async function readExistingMarkers(
  filePath: string,
  tailLines: number = 20,
): Promise<Set<string>> {
  const markers = new Set<string>();
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const tail = lines.slice(-tailLines);
    const markerPattern = /<!-- mem:([a-f0-9]+) -->/;
    for (const line of tail) {
      const match = markerPattern.exec(line);
      if (match) {
        markers.add(match[0]);
      }
    }
  } catch {
    // File doesn't exist yet — no existing markers.
  }
  return markers;
}

/** Format a HH:MM timestamp in the given timezone. */
export function formatTimeInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

/** Format a YYYY-MM-DD date stamp in the given timezone. */
export function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Format a single memory entry as markdown block. */
export function formatEntry(entry: MemoryEntry, time: string): string {
  const marker = buildMemMarker(entry.text);
  return `## ${time} [${entry.category}]\n${entry.text}\n\n${marker}\n`;
}

/**
 * Deduplicate and append entries to memory/YYYY-MM-DD.md.
 * Returns the number of entries actually written.
 */
export async function writeMemoryEntries(params: {
  entries: MemoryEntry[];
  ctx: WriterContext;
  nowMs?: number;
}): Promise<number> {
  const { entries, ctx } = params;
  if (entries.length === 0) {
    return 0;
  }

  const nowMs = params.nowMs ?? Date.now();
  const dateStamp = formatDateStamp(nowMs, ctx.timezone);
  const timeStamp = formatTimeInTimezone(nowMs, ctx.timezone);
  const relativePath = `memory/${dateStamp}.md`;

  const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, ctx.agentId);
  const absPath = path.join(workspaceDir, relativePath);

  // Read existing markers for dedup
  const existingMarkers = await readExistingMarkers(absPath);

  // Filter out duplicates
  const newEntries = entries.filter((entry) => {
    const marker = buildMemMarker(entry.text);
    return !existingMarkers.has(marker);
  });

  if (newEntries.length === 0) {
    return 0;
  }

  // Build content to append
  const blocks = newEntries.map((entry) => formatEntry(entry, timeStamp));
  const appendContent = "\n" + blocks.join("\n");

  // Read existing content and append
  let existing = "";
  try {
    existing = await fs.readFile(absPath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  const newContent = existing + appendContent;

  await writeFileWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    data: newContent,
    encoding: "utf-8",
    mkdir: true,
  });

  return newEntries.length;
}
