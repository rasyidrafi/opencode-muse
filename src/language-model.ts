import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type { HarnessToolResult } from "@rasyid_rafi/opencode-agent-harness-core";
import type { MuseSessionRegistry } from "./session-registry.js";
import { toAIUsage } from "./session-registry.js";
import { latestUserTurn, toolResultsByCallId, type ToolResult } from "./prompt.js";

export const PROVIDER_ID = "muse";

export const HEADERS = {
  kind: "x-opencode-muse-kind",
  session: "x-opencode-session-id",
  directory: "x-opencode-muse-directory",
  forkSource: "x-opencode-muse-fork-source",
} as const;

export const AGENT_OPTION = "museAgent";
export const INSTRUCTIONS_OPTION = "museInstructions";

export type RequestKind = "primary" | "title" | "summary" | "generate";

function toToolResult(result: ToolResult): HarnessToolResult {
  const output = result.output as Record<string, unknown> | undefined;
  let text = "";
  if (output && typeof output === "object") {
    if (output.type === "text" && typeof output.value === "string") {
      text = output.value;
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
    this.registry.setTools(
      tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema as Record<string, unknown>,
      })),
    );

    if (kind !== "primary") {
      return this.runUtility(kind, options, directory);
    }
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new Error("Muse model request is missing the session header");
    }

    const live = await this.registry.get(sessionID, directory, forkSource);
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

    // Start a Muse turn for a new user message.
    const turn = latestUserTurn(fresh);
    if (turn && !live.hasActiveTurn) {
      const providerOptions = options.providerOptions?.[this.providerOptionKey] as
        | Record<string, unknown>
        | undefined;
      const agent = typeof providerOptions?.[AGENT_OPTION] === "string" ? providerOptions[AGENT_OPTION] : "";
      const instructions =
        typeof providerOptions?.[INSTRUCTIONS_OPTION] === "string" ? providerOptions[INSTRUCTIONS_OPTION] : "";
      const preamble = [agent, instructions].filter((text) => text.length > 0).join("\n\n");
      const text = live.prependPreamble(preamble) && preamble.length > 0
        ? `${preamble}\n\n${turn.text}`
        : turn.text;
      await live.muse.startTurn({
        turnId: `muse_turn_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        message: {
          content: [
            ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
            ...turn.images.map((image) => ({
              type: "image" as const,
              mediaType: image.mediaType,
              data: image.data,
            })),
          ],
        },
      });
      live.setActiveTurn(true);
    }

    live.promptLength = options.prompt.length;

    let controller: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (value) => {
        controller = value;
        live.attach(value);
        try {
          value.enqueue({ type: "stream-start", warnings: [] });
        } catch {
          // Closed.
        }
      },
      cancel: () => {
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
        const result = await this.registry.runOnce(directory, content, options.abortSignal);
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
