// Minimal Mistral chat-completions client (no SDK). Handles thinking models
// whose content arrives as an array of blocks (thinking/text), JSON response
// format, timeouts and one retry on transient errors.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: Array<{ text?: string }>;
}

export class MistralError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class MistralClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string, baseUrl = "https://api.mistral.ai/v1") {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  // Returns the final text answer (never the thinking blocks).
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const body = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens ?? 6000,
      temperature: opts.temperature ?? 0.3,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    };
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.callOnce(body, opts.timeoutMs ?? 120000);
      } catch (e) {
        lastErr = e as Error;
        const status = e instanceof MistralError ? e.status : 0;
        if (status >= 400 && status < 500 && status !== 429) throw e; // no retry on bad requests
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr ?? new Error("mistral call failed");
  }

  private async callOnce(body: unknown, timeoutMs: number): Promise<string> {
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
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | ContentBlock[] } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      const text = this.extractText(content);
      if (!text) throw new MistralError("mistral api returned no answer text (thinking budget exhausted?)", 502);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // thinking models: content is an array of blocks; take the text block.
  // plain models: content is a string.
  extractText(content: string | ContentBlock[] | undefined): string | null {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block.type === "text" && block.text) return block.text;
    }
    return null;
  }
}
