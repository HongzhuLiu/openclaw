/**
 * Lightweight OpenAI-compatible LLM client using native fetch.
 * No external dependencies — works with any OpenAI-API-compatible endpoint.
 */

import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

const log = createSubsystemLogger("memory-auto-capture");

export type LlmClientConfig = {
  /** Full model string, e.g. "openai/gpt-5.4" */
  model: string;
  /** API key for the provider */
  apiKey: string;
  /** Base URL for the API (e.g. "https://api.openai.com/v1") */
  baseUrl: string;
  /** Request timeout in ms */
  timeoutMs: number;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
};

/**
 * Call the chat completions endpoint and parse the response as JSON.
 * Returns null if the call fails or the response is not valid JSON.
 */
export async function completeJson<T>(
  config: LlmClientConfig,
  messages: ChatMessage[],
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model.includes("/")
          ? config.model.split("/").slice(1).join("/")
          : config.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn(`LLM call failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      log.warn("LLM returned empty content");
      return null;
    }

    return JSON.parse(content) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      log.warn("LLM call timed out");
    } else {
      log.warn(`LLM call error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
