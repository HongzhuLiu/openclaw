/**
 * Auto-capture extraction engine.
 * Listens to agent_end events, extracts memories via LLM, writes to daily file.
 */

import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryCorePluginConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { completeJson, type LlmClientConfig } from "./llm-client.js";
import { ExtractionRateLimiter } from "./rate-limiter.js";
import { writeMemoryEntries, type MemoryEntry, type WriterContext } from "./writer.js";

const log = createSubsystemLogger("memory-auto-capture");

export const VALID_CATEGORIES = [
  "preference",
  "decision",
  "correction",
  "fact",
  "workflow",
  "entity",
] as const;
export type MemoryCategory = (typeof VALID_CATEGORIES)[number];

export type AutoCaptureConfig = {
  enabled: boolean;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxMessagesPerRun: number;
  rateLimitPerHour: number;
  excludeTriggers: string[];
  maxEntriesPerRun: number;
  timeoutMs: number;
};

const DEFAULT_CONFIG: AutoCaptureConfig = {
  enabled: true,
  model: "openai/gpt-5.4",
  maxMessagesPerRun: 4,
  rateLimitPerHour: 20,
  excludeTriggers: ["heartbeat", "cron", "memory"],
  maxEntriesPerRun: 5,
  timeoutMs: 30000,
};

type ExtractedMemory = {
  category: string;
  text: string;
  confidence: number;
};

type ExtractionResult = {
  memories: ExtractedMemory[];
};

const SYSTEM_PROMPT = `You are a memory extraction assistant. Analyze the conversation and extract important memories worth persisting.

For each memory, classify it into one of these categories:
- preference: User preferences, likes, dislikes, style choices
- decision: Decisions made, approaches chosen, trade-offs accepted
- correction: Corrections to prior assumptions, bug fixes, mistakes learned from
- fact: Factual information about the project, people, systems, or domain
- workflow: Processes, procedures, habits, or recurring patterns
- entity: Named entities (people, projects, tools, services) and their relationships

Return a JSON object with a "memories" array. Each entry has:
- "category": one of the categories above
- "text": concise description of the memory (1-2 sentences)
- "confidence": float 0.0-1.0 indicating how important this is to remember

Only extract genuinely useful long-term memories. Skip ephemeral task details.
If nothing is worth remembering, return {"memories": []}.`;

/** Resolve auto-capture config from plugin config. */
export function resolveAutoCaptureConfig(cfg: OpenClawConfig): AutoCaptureConfig {
  const pluginConfig = resolveMemoryCorePluginConfig(cfg) ?? {};
  const raw = pluginConfig;
  const ac = (raw.autoCapture ?? {}) as Record<string, unknown>;

  return {
    enabled: typeof ac.enabled === "boolean" ? ac.enabled : DEFAULT_CONFIG.enabled,
    model: typeof ac.model === "string" ? ac.model : DEFAULT_CONFIG.model,
    apiKey: typeof ac.apiKey === "string" ? ac.apiKey : undefined,
    baseUrl: typeof ac.baseUrl === "string" ? ac.baseUrl : undefined,
    maxMessagesPerRun:
      typeof ac.maxMessagesPerRun === "number"
        ? ac.maxMessagesPerRun
        : DEFAULT_CONFIG.maxMessagesPerRun,
    rateLimitPerHour:
      typeof ac.rateLimitPerHour === "number"
        ? ac.rateLimitPerHour
        : DEFAULT_CONFIG.rateLimitPerHour,
    excludeTriggers: Array.isArray(ac.excludeTriggers)
      ? (ac.excludeTriggers as string[])
      : DEFAULT_CONFIG.excludeTriggers,
    maxEntriesPerRun:
      typeof ac.maxEntriesPerRun === "number"
        ? ac.maxEntriesPerRun
        : DEFAULT_CONFIG.maxEntriesPerRun,
    timeoutMs: typeof ac.timeoutMs === "number" ? ac.timeoutMs : DEFAULT_CONFIG.timeoutMs,
  };
}

/** Resolve LLM client config from auto-capture config. */
function resolveLlmConfig(ac: AutoCaptureConfig): LlmClientConfig | null {
  const apiKey = ac.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("No API key configured for auto-capture LLM");
    return null;
  }

  // Derive base URL from model prefix if not explicitly set
  let baseUrl = ac.baseUrl;
  if (!baseUrl) {
    const provider = ac.model.includes("/") ? ac.model.split("/")[0] : "openai";
    if (provider === "openai") {
      baseUrl = "https://api.openai.com/v1";
    } else {
      log.warn(`No baseUrl configured for provider "${provider}"`);
      return null;
    }
  }

  return {
    model: ac.model,
    apiKey,
    baseUrl,
    timeoutMs: ac.timeoutMs,
  };
}

/**
 * Extract user+assistant text from the messages array.
 * Takes the last N pairs (user+assistant rounds).
 */
export function extractConversationText(messages: unknown[], maxMessages: number): string | null {
  // Filter to user and assistant messages
  const relevant: Array<{ role: string; content: string }> = [];
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n")
          : null;
    if (!content?.trim()) {
      continue;
    }
    relevant.push({ role, content: content.trim() });
  }

  if (relevant.length < 3) {
    return null;
  }

  // Take last N messages
  const tail = relevant.slice(-maxMessages * 2);
  return tail.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
}

/** Validate and normalize extracted memories. */
function normalizeMemories(raw: ExtractionResult, maxEntries: number): MemoryEntry[] {
  if (!Array.isArray(raw.memories)) {
    return [];
  }

  const valid: MemoryEntry[] = [];
  for (const mem of raw.memories) {
    if (typeof mem.text !== "string" || !mem.text.trim()) {
      continue;
    }
    if (typeof mem.confidence === "number" && mem.confidence < 0.5) {
      continue;
    }

    const category = VALID_CATEGORIES.includes(mem.category as MemoryCategory)
      ? mem.category
      : "fact";

    valid.push({ category, text: mem.text.trim() });
    if (valid.length >= maxEntries) {
      break;
    }
  }
  return valid;
}

// Singleton rate limiter (shared across all agent_end calls in this process)
let rateLimiter: ExtractionRateLimiter | null = null;

function getRateLimiter(maxPerHour: number): ExtractionRateLimiter {
  if (!rateLimiter) {
    rateLimiter = new ExtractionRateLimiter({ maxPerHour });
  }
  return rateLimiter;
}

/**
 * Pre-filter: should this agent_end event be processed?
 */
export function shouldProcess(params: {
  success: boolean;
  trigger?: string;
  messageCount: number;
  excludeTriggers: string[];
}): boolean {
  if (!params.success) {
    return false;
  }
  if (params.trigger && params.excludeTriggers.includes(params.trigger)) {
    return false;
  }
  if (params.messageCount < 3) {
    return false;
  }
  return true;
}

export type AgentEndHandlerParams = {
  event: { messages: unknown[]; success: boolean };
  ctx: { trigger?: string; agentId?: string; workspaceDir?: string };
  cfg: OpenClawConfig;
};

/**
 * Main handler for agent_end hook. Fire-and-forget — never throws.
 */
export async function handleAgentEnd(params: AgentEndHandlerParams): Promise<void> {
  try {
    const { event, ctx, cfg } = params;
    const acConfig = resolveAutoCaptureConfig(cfg);
    if (!acConfig.enabled) {
      return;
    }

    // Pre-filter
    if (
      !shouldProcess({
        success: event.success,
        trigger: ctx.trigger,
        messageCount: event.messages.length,
        excludeTriggers: acConfig.excludeTriggers,
      })
    ) {
      return;
    }

    // Rate limit
    const limiter = getRateLimiter(acConfig.rateLimitPerHour);
    if (!limiter.canProceed()) {
      log.info("Auto-capture rate limited, skipping");
      return;
    }

    // Extract conversation text
    const conversationText = extractConversationText(event.messages, acConfig.maxMessagesPerRun);
    if (!conversationText) {
      return;
    }

    // Resolve LLM config
    const llmConfig = resolveLlmConfig(acConfig);
    if (!llmConfig) {
      return;
    }

    // Call LLM
    const result = await completeJson<ExtractionResult>(llmConfig, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Analyze this conversation and extract memories:\n\n${conversationText}`,
      },
    ]);

    if (!result) {
      return;
    }

    // Normalize and validate
    const entries = normalizeMemories(result, acConfig.maxEntriesPerRun);
    if (entries.length === 0) {
      return;
    }

    // Record rate limit (non-empty result)
    limiter.record();

    // Resolve timezone
    const timezone = cfg.agents?.defaults?.userTimezone ?? "UTC";
    const agentId = ctx.agentId ?? "default";

    // Write
    const writerCtx: WriterContext = { cfg, agentId, timezone };
    const written = await writeMemoryEntries({ entries, ctx: writerCtx });
    if (written > 0) {
      log.info(`Auto-captured ${written} memories`);
    }
  } catch (error) {
    // fire-and-forget: log but never throw
    log.warn(`Auto-capture error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Exported for testing. */
export const __testing = {
  normalizeMemories,
  resolveLlmConfig,
  get rateLimiter() {
    return rateLimiter;
  },
  resetRateLimiter() {
    rateLimiter = null;
  },
};
