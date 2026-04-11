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
  model: "primary",
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

## Language Rule
OUTPUT LANGUAGE MUST MATCH THE DOMINANT LANGUAGE OF THE CONVERSATION.
If the conversation is in Chinese, write memories in Chinese.
If the conversation is in English, write memories in English.

## Categories
- preference: User preferences, likes, dislikes, style choices
- decision: Decisions made, approaches chosen, trade-offs accepted
- correction: Corrections to prior assumptions, bug fixes, mistakes learned from
- fact: Factual information about the project, people, systems, or domain
- workflow: Processes, procedures, habits, or recurring patterns
- entity: Named entities (people, projects, tools, services) and their relationships

## What to extract
ONLY extract information that is:
1. Personalized: Specific to this user/project, not general knowledge
2. Long-term valid: Still useful in future sessions
3. Specific and clear: Has concrete details, not vague generalizations

## What NOT to extract
- General knowledge anyone would know
- System/platform metadata (message IDs, timestamps, channel info)
- Temporary task details or in-progress debugging steps
- Tool output, error logs, or boilerplate
- Recall queries ("Do you remember X?", "你还记得X吗?")
- Information about the current conversation itself (meta-commentary)

Return a JSON object with a "memories" array. Each entry has:
- "category": one of the categories above
- "text": concise description of the memory (1-2 sentences, in the conversation's language)
- "confidence": float 0.0-1.0 indicating how important this is to remember

Maximum 5 memories per extraction.
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

/**
 * Resolve the actual model id + provider from config.
 * Supports "primary" (use main agent model) or explicit "provider/model".
 */
function resolveModelAndProvider(
  ac: AutoCaptureConfig,
  cfg: OpenClawConfig,
  ctx: { modelProviderId?: string; modelId?: string },
): { providerId: string; modelId: string } | null {
  if (ac.model === "primary" || !ac.model) {
    // Use the model from the current agent run context
    const providerId = ctx.modelProviderId;
    const modelId = ctx.modelId;
    if (providerId && modelId) {
      return { providerId, modelId };
    }
    // Fallback: read from agent defaults
    const primary = cfg.agents?.defaults?.model?.primary;
    if (typeof primary === "string" && primary.includes("/")) {
      const [prov, ...rest] = primary.split("/");
      return { providerId: prov, modelId: rest.join("/") };
    }
    log.warn("Auto-capture: cannot resolve primary model");
    return null;
  }

  // Explicit model: "provider/model"
  if (ac.model.includes("/")) {
    const [prov, ...rest] = ac.model.split("/");
    return { providerId: prov, modelId: rest.join("/") };
  }

  // Bare model name — assume openai
  return { providerId: "openai", modelId: ac.model };
}

/** Resolve LLM client config from OpenClaw provider config. */
function resolveLlmConfig(
  ac: AutoCaptureConfig,
  cfg: OpenClawConfig,
  ctx: { modelProviderId?: string; modelId?: string },
): LlmClientConfig | null {
  const resolved = resolveModelAndProvider(ac, cfg, ctx);
  if (!resolved) return null;

  // Read provider config from OpenClaw config
  const providerConfig = cfg.models?.providers?.[resolved.providerId] as
    | Record<string, unknown>
    | undefined;

  const apiKey =
    ac.apiKey ??
    (typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey : undefined) ??
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn(`Auto-capture: no API key for provider "${resolved.providerId}"`); 
    return null;
  }

  const baseUrl =
    ac.baseUrl ??
    (typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined);
  if (!baseUrl) {
    log.warn(`Auto-capture: no baseUrl for provider "${resolved.providerId}"`);
    return null;
  }

  return {
    model: resolved.modelId,
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
  ctx: { trigger?: string; agentId?: string; workspaceDir?: string; modelProviderId?: string; modelId?: string };
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

    // Resolve LLM config from OpenClaw provider config
    const llmConfig = resolveLlmConfig(acConfig, cfg, {
      modelProviderId: ctx.modelProviderId,
      modelId: ctx.modelId,
    });
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

    // Resolve timezone — prefer config, fallback to env TZ, then Asia/Shanghai
    const timezone = cfg.agents?.defaults?.userTimezone ?? process.env.TZ ?? "Asia/Shanghai";
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
