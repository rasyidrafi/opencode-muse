import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider";

/**
 * Prompt extraction for the Muse language model.
 *
 * OpenCode hands the provider a full `LanguageModelV3Prompt`. Muse keeps its
 * own conversation, so only the *new* messages since the previous step are
 * forwarded: the latest user turn (text + images) and any tool results that
 * answer the calls Muse parked on.
 */

export interface ImageAttachment {
  readonly mediaType: string;
  readonly data: string;
}

export interface ToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
}

export interface UserTurn {
  readonly text: string;
  readonly images: ReadonlyArray<ImageAttachment>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert a `file` part to a Muse image part; non-images are ignored. */
export function filePartToImage(part: LanguageModelV3FilePart): ImageAttachment | undefined {
  if (!part.mediaType.startsWith("image/")) return undefined;
  if (part.data instanceof Uint8Array) {
    return { mediaType: part.mediaType, data: Buffer.from(part.data).toString("base64") };
  }
  if (typeof part.data === "string") {
    // AI SDK file data is base64; a data URL is also accepted.
    const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is.exec(part.data.trim());
    if (match) return { mediaType: match[1] || part.mediaType, data: match[2] };
    return { mediaType: part.mediaType, data: part.data };
  }
  return undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

/** The last user message in the prompt, with its text and image attachments. */
export function latestUserTurn(prompt: LanguageModelV3Prompt): UserTurn | undefined {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (!message || message.role !== "user") continue;
    const images: ImageAttachment[] = [];
    for (const part of message.content) {
      if (part.type !== "file") continue;
      const image = filePartToImage(part);
      if (image) images.push(image);
    }
    return { text: textOfContent(message.content), images };
  }
  return undefined;
}

/** Tool results carried by `tool` messages (and assistant tool-result parts). */
export function collectToolResults(messages: ReadonlyArray<LanguageModelV3Prompt[number]>): ToolResult[] {
  const results: ToolResult[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          results.push({ toolCallId: part.toolCallId, toolName: part.toolName, output: part.output });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          results.push({ toolCallId: part.toolCallId, toolName: part.toolName, output: part.output });
        }
      }
    }
  }
  return results;
}

/** The system prompt text, which carries OpenCode's instructions. */
export function systemText(prompt: LanguageModelV3Prompt): string {
  const parts: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") parts.push(message.content);
  }
  return parts.join("\n");
}

/** Tool results keyed by call id, for resolving parked Muse tool calls. */
export function toolResultsByCallId(messages: ReadonlyArray<LanguageModelV3Prompt[number]>): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const result of collectToolResults(messages)) map.set(result.toolCallId, result);
  return map;
}
