/**
 * memory_forget tool: search matching memories and remove them from source files.
 *
 * Two-phase flow:
 * - Phase 1 (no `confirm`): search and return candidates with preview
 * - Phase 2 (`confirm: true` + `targets`): delete specified line ranges from files
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  resolveSessionAgentId,
  resolveMemorySearchConfig,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { getMemoryManagerContext, loadMemoryToolRuntime } from "./tools.shared.js";

export const MemoryForgetSchema = Type.Object({
  query: Type.String(),
  confirm: Type.Optional(Type.Boolean()),
  targets: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String(),
        startLine: Type.Number(),
        endLine: Type.Number(),
      }),
    ),
  ),
});

type ForgetTarget = { path: string; startLine: number; endLine: number };

/**
 * Remove specified line ranges from a file. Lines are 1-based.
 * Returns the number of lines removed.
 */
export async function removeLinesFromFile(
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<number> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");

  // Clamp to valid range (1-based)
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, endLine);
  if (start > end) return 0;

  // Remove the line range (convert to 0-based)
  const removed = end - start + 1;
  lines.splice(start - 1, removed);

  // Clean up consecutive blank lines left behind
  const cleaned = collapseBlankLines(lines);
  await fs.writeFile(filePath, cleaned.join("\n"), "utf-8");
  return removed;
}

/** Collapse runs of 3+ consecutive blank lines down to 2. */
function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks++;
      if (blanks <= 2) result.push(line);
    } else {
      blanks = 0;
      result.push(line);
    }
  }
  return result;
}

export function createMemoryForgetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) return null;

  return {
    label: "Memory Forget",
    name: "memory_forget",
    description: [
      "Search and remove memories from memory files.",
      "Phase 1: call with `query` only — returns matching candidates (path, lines, preview).",
      "Phase 2: call again with `confirm: true` and `targets` array to delete the selected entries.",
      "Always show candidates to the user and get confirmation before phase 2.",
    ].join(" "),
    parameters: MemoryForgetSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const query = readStringParam(params, "query", { required: true });
      const confirm = params.confirm === true;
      const targets = params.targets as ForgetTarget[] | undefined;

      // Phase 2: confirmed deletion
      if (confirm && Array.isArray(targets) && targets.length > 0) {
        return await executeForget({ cfg, agentId, targets });
      }

      // Phase 1: search candidates
      return await searchCandidates({ cfg, agentId, query, sessionKey: options.agentSessionKey });
    },
  };
}

async function searchCandidates(params: {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  sessionKey?: string;
}): Promise<ReturnType<typeof jsonResult>> {
  const memory = await getMemoryManagerContext({ cfg: params.cfg, agentId: params.agentId });
  if ("error" in memory) {
    return jsonResult({ success: false, error: memory.error ?? "memory unavailable" });
  }

  let results: MemorySearchResult[];
  try {
    results = await memory.manager.search(params.query, {
      maxResults: 10,
      sessionKey: params.sessionKey,
    });
  } catch (error) {
    return jsonResult({
      success: false,
      error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (results.length === 0) {
    return jsonResult({
      success: true,
      candidates: [],
      message: "No matching memories found.",
    });
  }

  const candidates = results
    .filter((r) => r.source === "memory")
    .map((r) => ({
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      score: r.score,
      preview: r.snippet.slice(0, 200),
    }));

  return jsonResult({
    success: true,
    candidates,
    message:
      candidates.length > 0
        ? `Found ${candidates.length} matching memories. Review the candidates and call again with confirm=true and targets array to delete.`
        : "No deletable memory entries found (matches were from non-memory sources).",
  });
}

async function executeForget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  targets: ForgetTarget[];
}): Promise<ReturnType<typeof jsonResult>> {
  const { cfg, agentId, targets } = params;
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  // Group targets by file path, sort by startLine descending (delete from bottom up)
  const byFile = new Map<string, ForgetTarget[]>();
  for (const target of targets) {
    const existing = byFile.get(target.path) ?? [];
    existing.push(target);
    byFile.set(target.path, existing);
  }

  let totalRemoved = 0;
  const errors: string[] = [];

  for (const [relPath, fileTargets] of byFile) {
    const absPath = path.join(workspaceDir, relPath);

    // Sort descending by startLine so earlier deletions don't shift later line numbers
    const sorted = fileTargets.toSorted((a, b) => b.startLine - a.startLine);

    for (const target of sorted) {
      try {
        const removed = await removeLinesFromFile(absPath, target.startLine, target.endLine);
        totalRemoved += removed;
      } catch (error) {
        errors.push(
          `${relPath}:${target.startLine}-${target.endLine}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Trigger reindex by touching the memory search manager
  try {
    const { getMemorySearchManager } = await loadMemoryToolRuntime();
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    if (manager) {
      // The file watcher will pick up changes; force an immediate status refresh
      await manager.search("", { maxResults: 1 });
    }
  } catch {
    // Reindex is best-effort
  }

  return jsonResult({
    success: errors.length === 0,
    removed: totalRemoved,
    errors: errors.length > 0 ? errors : undefined,
    message:
      errors.length === 0
        ? `Successfully removed ${totalRemoved} lines from ${byFile.size} file(s).`
        : `Removed ${totalRemoved} lines with ${errors.length} error(s).`,
  });
}
