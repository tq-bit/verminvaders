// Mistral API client types.

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

export type DeltaKind = "thinking" | "text";
export type DeltaHandler = (kind: DeltaKind, text: string) => void;

// Streaming content block shapes of thinking models.
export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: Array<{ text?: string }>;
}

export interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | ContentBlock[] } }>;
}
