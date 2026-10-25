// SSE stream consumption for chat-completions: parses "data: ..." lines,
// surfaces thinking and text deltas, returns the assembled answer.

import { MistralError } from "../errors/mistral-error.ts";
import type { ContentBlock, DeltaHandler, StreamChunk } from "../types/index.d.ts";

export async function consumeSse(body: ReadableStream<Uint8Array>, onDelta?: DeltaHandler): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  const handleChunk = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    let data: StreamChunk;
    try {
      data = JSON.parse(payload);
    } catch {
      return false; // ignore malformed keep-alives
    }
    for (const choice of data.choices ?? []) {
      const content = choice.delta?.content;
      if (typeof content === "string") {
        if (content) {
          answer += content;
          onDelta?.("text", content);
        }
      } else if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === "text" && block.text) {
            answer += block.text;
            onDelta?.("text", block.text);
          } else if (block.type === "thinking") {
            for (const t of block.thinking ?? []) {
              if (t?.text) onDelta?.("thinking", t.text);
            }
          }
        }
      }
    }
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      if (handleChunk(line.slice(6).trim())) {
        buffer = "";
        break;
      }
    }
  }
  if (!answer) {
    throw new MistralError("mistral api returned no answer text (thinking budget exhausted?)", 502);
  }
  return answer;
}
