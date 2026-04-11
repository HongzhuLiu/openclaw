/**
 * memory_store tool: explicit memory write from the agent.
 */

import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  resolveSessionAgentId,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { VALID_CATEGORIES, type MemoryCategory } from "./extraction/extractor.js";
import { writeMemoryEntries, type WriterContext } from "./extraction/writer.js";

export const MemoryStoreSchema = Type.Object({
  text: Type.String(),
  category: Type.Optional(Type.String()),
});

export function createMemoryStoreTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }

  return {
    label: "Memory Store",
    name: "memory_store",
    description:
      "Explicitly store a memory to the daily memory file (memory/YYYY-MM-DD.md). Use this to persist important information, preferences, decisions, or corrections that should be remembered in future conversations. Deduplicates by content hash.",
    parameters: MemoryStoreSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const text = readStringParam(params, "text", { required: true });
      const rawCategory = readStringParam(params, "category") ?? "";
      const category = VALID_CATEGORIES.includes(rawCategory as MemoryCategory)
        ? rawCategory
        : "fact";

      const timezone = cfg.agents?.defaults?.userTimezone ?? "UTC";
      const writerCtx: WriterContext = { cfg, agentId, timezone };

      try {
        const written = await writeMemoryEntries({
          entries: [{ category, text }],
          ctx: writerCtx,
        });

        if (written === 0) {
          return jsonResult({
            stored: false,
            reason: "duplicate",
            message: "Memory already exists (duplicate content hash).",
          });
        }

        return jsonResult({
          stored: true,
          category,
          message: `Memory stored successfully in today's memory file.`,
        });
      } catch (error) {
        return jsonResult({
          stored: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
