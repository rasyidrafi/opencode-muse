import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { HarnessEvent } from "@rasyid_rafi/opencode-agent-harness-core";

/**
 * Convert the harness event stream into AI SDK stream parts.
 *
 * The converter owns the text/reasoning block lifecycle so the stream parts
 * stay balanced (`text-start` before `text-delta` before `text-end`). Tool
 * calls are emitted by the tool bridge, not here: the bridge knows the call id
 * that matches OpenCode's tool result.
 */
export class StreamConverter {
  private textId: string | null = null;
  private reasoningId: string | null = null;
  private textOpen = false;
  private reasoningOpen = false;

  convert(event: HarnessEvent): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    switch (event.type) {
      case "message.started":
        if (event.message.role !== "assistant") break;
        // Reasoning items complete separately; a reasoning block is opened on
        // its first delta so an empty item emits nothing.
        break;
      case "message.delta":
        if (event.text) {
          if (!this.textOpen) {
            this.textId = `text-${event.messageId}`;
            parts.push({ type: "text-start", id: this.textId });
            this.textOpen = true;
          }
          parts.push({ type: "text-delta", id: this.textId!, delta: event.text });
        } else if (event.reasoning) {
          if (!this.reasoningOpen) {
            this.reasoningId = `reasoning-${event.messageId}`;
            parts.push({ type: "reasoning-start", id: this.reasoningId });
            this.reasoningOpen = true;
          }
          parts.push({ type: "reasoning-delta", id: this.reasoningId!, delta: event.reasoning });
        }
        break;
      case "message.completed": {
        const isReasoning = this.reasoningOpen && this.reasoningId === `reasoning-${event.message.id}`;
        if (isReasoning) {
          parts.push({ type: "reasoning-end", id: this.reasoningId! });
          this.reasoningOpen = false;
          this.reasoningId = null;
          break;
        }
        if (this.textOpen && this.textId === `text-${event.message.id}`) {
          parts.push({ type: "text-end", id: this.textId });
          this.textOpen = false;
          this.textId = null;
        }
        break;
      }
      default:
        break;
    }
    return parts;
  }

  /** Close any open block; used when a step ends mid-block. */
  closeBlocks(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.textOpen && this.textId) parts.push({ type: "text-end", id: this.textId });
    if (this.reasoningOpen && this.reasoningId) {
      parts.push({ type: "reasoning-end", id: this.reasoningId });
    }
    this.textOpen = false;
    this.reasoningOpen = false;
    this.textId = null;
    this.reasoningId = null;
    return parts;
  }
}
