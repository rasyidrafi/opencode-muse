import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type { HarnessToolResult } from "@rasyid_rafi/opencode-agent-harness-core";
import type { MuseSessionRegistry, ToolDefinition } from "./session-registry.js";
import { toAIUsage } from "./session-registry.js";
import {
  allImages,
  fullConversationText,
  latestUserTurn,
  toolResultsByCallId,
  type ToolResult,
} from "./prompt.js";

export const PROVIDER_ID = "muse";

export const HEADERS = {
  kind: "x-opencode-muse-kind",
  session: "x-opencode-session-id",
  directory: "x-opencode-muse-directory",
  forkSource: "x-opencode-muse-fork-source",
} as const;

export const AGENT_OPTION = "museAgent";
export const INSTRUCTIONS_OPTION = "museInstructions";

/** Mirrors OpenCode's `SessionRequestKind`: only `primary` drives the live turn. */
export type RequestKind = "primary" | "compaction" | "title" | "generate";

/** Convert an AI SDK tool result into the harness bridge shape. */
export function toToolResult(result: ToolResult): HarnessToolResult {
  const output = result.output as Record<string, unknown> | undefined;
  let text = "";
  if (output && typeof output === "object") {
    if ((output.type === "text" || output.type === "error-text") && typeof output.value === "string") {
      text = output.value;
    } else if (output.type === "execution-denied") {
      // A denied tool never ran; the reason is the whole answer.
      text = typeof output.reason === "string" ? output.reason : "Tool execution was denied by the user.";
    } else if (output.type === "content" && Array.isArray(output.value)) {
      text = output.value
        .map((part) =>
          part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
            ? String((part as Record<string, unknown>).text ?? "")
            : "",
        )
        .join("");
    } else if (output.type === "json" || output.type === "error-json") {
      text = JSON.stringify(output.value);
    } else {
      text = String(output);
    }
  } else {
    text = String(output);
  }
  const isError =
    output?.type === "error-text" || output?.type === "error-json" || output?.type === "execution-denied";
  return { content: [{ type: "text", text }], isError };
}

function functionTools(options: LanguageModelV3CallOptions): LanguageModelV3FunctionTool[] {
  return (options.tools ?? []).filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function");
}

/**
 * Muse Code as an OpenCode language model.
 *
 * OpenCode owns the agent loop. Each `doStream` call is one step: the prompt
 * carries the conversation, Muse runs its own turn against it, and tool calls
 * are surfaced as AI SDK `tool-call` parts so OpenCode executes them with its
 * own permission system and feeds the results back on the next step.
 */
export class MuseLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = PROVIDER_ID;
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly settings: Record<string, unknown>,
    private readonly registry: MuseSessionRegistry,
    /**
     * Key OpenCode nests provider options under. It is the model's canonical
     * provider when one is set (`providerOptionKey` in OpenCode), so the
     * agent/instructions options must be read from the same key they were
     * written under.
     */
    private readonly providerOptionKey = PROVIDER_ID,
  ) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Muse models only support streaming");
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const headers = options.headers ?? {};
    const kind = (headers[HEADERS.kind] as RequestKind | undefined) ?? "primary";
    const sessionID = headers[HEADERS.session];
    const directory = headers[HEADERS.directory] ?? process.cwd();
    const forkSource = headers[HEADERS.forkSource];

    const tools = functionTools(options);
    const toolDefs: ToolDefinition[] = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
    this.registry.setTools(toolDefs);

    if (kind !== "primary") {
      // Compaction and generate branch the chat: they keep the chat's tools
      // so the request matches the cached shape. Titles stand alone.
      const branch = kind === "compaction" || kind === "generate";
      return this.runUtility(kind, options, directory, branch ? toolDefs : []);
    }
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new Error("Muse model request is missing the session header");
    }

    let live = await this.registry.get(sessionID, directory, forkSource, this.modelId);
    let reseed = false;
    if (!live.isFresh && options.prompt.length < live.promptLength) {
      // OpenCode rewrote the history (compaction, rewind): the native session
      // still holds the old context, so recycle it and reseed from the full
      // prompt below.
      await this.registry.close(sessionID);
      live = await this.registry.get(sessionID, directory, forkSource, this.modelId);
      reseed = true;
    }
    if (live.isFresh) {
      // A resumed session already holds the conversation Muse has seen, so
      // seed the diff just before the new user message.
      const lastIsUser = options.prompt.length > 0 && options.prompt[options.prompt.length - 1]?.role === "user";
      live.promptLength = Math.max(0, options.prompt.length - (lastIsUser ? 1 : 0));
      live.markSeen();
    }
    const fresh = options.prompt.slice(live.promptLength);

    // Resolve tool calls Muse parked on.
    for (const [id, result] of toolResultsByCallId(fresh)) {
      live.resolvePending(id, toToolResult(result));
    }

    // Deliver a new user message: start a turn, or steer the running one.
    const turn = latestUserTurn(fresh);
    if (turn) {
      const running = live.hasActiveTurn ? live.activeTurnId : null;
      if (running !== null) {
        // OpenCode promotes input that arrives mid-turn as a steer. Dropping
        // it would lose the message, so inject it into the running turn.
        try {
          await live.muse.steerTurn({
            turnId: running,
            message: {
              content: [
                ...(turn.text.length > 0 ? [{ type: "text" as const, text: turn.text }] : []),
                ...turn.images.map((image) => ({
                  type: "image" as const,
                  mediaType: image.mediaType,
                  data: image.data,
                })),
              ],
            },
          });
        } catch {
          // The turn ended before the steer landed; fall through to a new one.
          live.setActiveTurn(false);
        }
      }
      if (!live.hasActiveTurn) {
        const providerOptions = options.providerOptions?.[this.providerOptionKey] as
          | Record<string, unknown>
          | undefined;
        const agent = typeof providerOptions?.[AGENT_OPTION] === "string" ? providerOptions[AGENT_OPTION] : "";
        const instructions =
          typeof providerOptions?.[INSTRUCTIONS_OPTION] === "string" ? providerOptions[INSTRUCTIONS_OPTION] : "";
        const preamble = [agent, instructions].filter((text) => text.length > 0).join("\n\n");
        // After a history rewrite the fresh native session has seen nothing,
        // so seed it with the whole condensed conversation, not just the
        // delta. A forked session is in the same position on its first turn.
        const seedFull = reseed || live.takeFullSeed();
        const body = seedFull ? fullConversationText(options.prompt) : turn.text;
        const attachments = seedFull ? allImages(options.prompt) : turn.images;
        const text = live.prependPreamble(preamble) && preamble.length > 0
          ? `${preamble}\n\n${body}`
          : body;
        const turnId = `muse_turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await live.muse.startTurn({
          turnId,
          message: {
            content: [
              ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
              ...attachments.map((image) => ({
                type: "image" as const,
                mediaType: image.mediaType,
                data: image.data,
              })),
            ],
          },
        });
        live.setActiveTurn(true, turnId);
      }
    }

    live.promptLength = options.prompt.length;

    // Cancelling the step must stop Muse: a native turn left running would keep
    // producing events, and its finish would leak into the next step.
    const abort = new AbortController();
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal;
    let interrupted = false;
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      abort.abort();
      void live.interrupt();
    };
    if (signal.aborted) interrupt();
    else signal.addEventListener("abort", interrupt, { once: true });

    let controller: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (value) => {
        controller = value;
        try {
          value.enqueue({ type: "stream-start", warnings: [] });
        } catch {
          // Closed.
        }
        live.attach(value);
      },
      cancel: () => {
        interrupt();
        live.detach();
      },
    });
    void controller;
    return { stream };
  }

  /** Title, compaction summary, and generate run as one-off Muse turns. */
  private async runUtility(
    kind: RequestKind,
    options: LanguageModelV3CallOptions,
    directory: string,
    tools: ToolDefinition[],
  ): Promise<LanguageModelV3StreamResult> {
    const content: Array<{ type: "text"; text: string }> = [];
    for (const message of options.prompt) {
      if (message.role !== "system" && message.role !== "user") continue;
      if (typeof message.content === "string") {
        content.push({ type: "text", text: message.content });
        continue;
      }
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
      }
    }
    void kind;

    let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    let resolveController!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveController = resolve;
    });

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (value) => {
        controller = value;
        value.enqueue({ type: "stream-start", warnings: [] });
        resolveController();
      },
      cancel: () => {
        options.abortSignal?.throwIfAborted();
      },
    });

    void (async () => {
      await ready;
      controller.enqueue({ type: "text-start", id: "utility-0" });
      try {
        const result = await this.registry.runOnce(directory, content, options.abortSignal, tools, this.modelId);
        controller.enqueue({ type: "text-delta", id: "utility-0", delta: result.text });
        controller.enqueue({ type: "text-end", id: "utility-0" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: toAIUsage(result.usage),
        });
      } catch (error) {
        controller.enqueue({ type: "error", error });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "error", raw: "error" },
          usage: toAIUsage({}),
        });
      } finally {
        controller.close();
      }
    })();

    return { stream };
  }
}
