import type { HarnessUserMessage } from "../../src/contract/index.js";

/** Helper to build a user message. */
export function userMessage(text: string): HarnessUserMessage {
  return { content: [{ type: "text", text }] };
}
