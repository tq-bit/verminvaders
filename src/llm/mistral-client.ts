// Minimal streaming Mistral chat-completions client (no SDK).

import { MistralError } from "../errors/mistral-error.ts";
import type { ChatMessage, ChatOptions, DeltaHandler } from "../types/index.d.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from "../constants/index.ts";
import { consumeSse } from "./sse.ts";

export class MistralClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string, baseUrl = "https://api.mistral.ai/v1") {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  // Streams the completion; returns the final answer text (not the thinking).
  async chat(messages: ChatMessage[], opts: ChatOptions = {}, onDelta?: DeltaHandler): Promise<string> {
    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? 0.3,
      ...(opts.responseSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "strategy_response",
                description: "Tuned executor params plus updated memory for the Verminvaders harness.",
                schema: opts.responseSchema,
                strict: true,
              },
            },
          }
        : opts.json
          ? { response_format: { type: "json_object" } }
          : {}),
    };
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.callOnce(body, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, onDelta);
      } catch (e) {
        lastErr = e as Error;
        const status = e instanceof MistralError ? e.status : 0;
        if (status >= 400 && status < 500 && status !== 429) throw e; // no retry on bad requests
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error("mistral call failed");
  }

  private async callOnce(body: unknown, timeoutMs: number, onDelta?: DeltaHandler): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new MistralError(`mistral api ${res.status}: ${text.slice(0, 200)}`, res.status);
      }
      if (!res.body) throw new MistralError("empty response body", 502);
      return await consumeSse(res.body, onDelta);
    } finally {
      clearTimeout(timer);
    }
  }
}
