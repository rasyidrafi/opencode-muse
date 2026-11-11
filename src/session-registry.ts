import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { HarnessEvent, HarnessToolBridge, HarnessToolResult } from "@opencode-agent-harness/core";
import { MuseHarnessAdapter } from "./adapter.js";
import type { MuseHarnessSession } from "./session.js";
import { StreamConverter } from "./convert.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Durable OpenCode session id -> native Muse session id mapping. */
export interface SessionStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface PendingCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  resolve: (result: HarnessToolResult) => void;
  reject: (error: Error) => void;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  [key: string]: number | undefined;
}

/** Convert our flat usage counters to the AI SDK v3 usage shape. */
export function toAIUsage(usage: Usage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokens,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokens,
      reasoning: usage.reasoningTokens,
    },
  };
}

/**
 * One OpenCode chat session mapped to one Muse session.
 *
 * OpenCode owns the agent loop: each `doStream` call is one step. A step ends
 * when Muse parks on a tool call (the bridge emits a `tool-call` part and the
 * step finishes with `tool-calls`); OpenCode executes the tool and calls
 * `doStream` again with the result, which resolves the parked call and lets
 * Muse continue.
 */
export class LiveSession {
  readonly openCodeSessionId: string;
  readonly muse: MuseHarnessSession;
  readonly pending = new Map<string, PendingCall>();

  private readonly converter = new StreamConverter();
  private controller: ReadableStreamDefaultController<LanguageModelV3StreamPart> | null = null;
  private queue: LanguageModelV3StreamPart[] = [];
  private turnActive = false;
  private lastPromptLength = 0;
  private counter = 0;
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private stepUsage: Usage = {};
  private preamble = "";
  private preambleSent = false;
  private fresh = true;

  /** True until the first step seeds the prompt diff. */
  get isFresh(): boolean {
    return this.fresh;
  }

  markSeen(): void {
    this.fresh = false;
  }

  /** Prepend the agent role/instructions once, and again when they change. */
  prependPreamble(preamble: string): boolean {
    if (preamble.length === 0) return false;
    if (this.preambleSent && this.preamble === preamble) return false;
    this.preamble = preamble;
    this.preambleSent = true;
    return true;
  }

  constructor(openCodeSessionId: string, muse: MuseHarnessSession) {
    this.openCodeSessionId = openCodeSessionId;
    this.muse = muse;
    void this.pump();
  }

  get promptLength(): number {
    return this.lastPromptLength;
  }

  set promptLength(value: number) {
    this.lastPromptLength = value;
  }

  get hasActiveTurn(): boolean {
    return this.turnActive;
  }

  setActiveTurn(value: boolean): void {
    this.turnActive = value;
  }

  get toolCounter(): number {
    return ++this.counter;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Subscribe the session's event stream once and pump it into the current step. */
  private async pump(): Promise<void> {
    try {
      for await (const event of this.muse.subscribe()) {
        if (this.closed) return;
        for (const part of this.converter.convert(event)) this.enqueue(part);
        if (event.type === "turn.terminal") {
          this.turnActive = false;
          this.mergeUsage(event.turn.tokenUsage as Usage | undefined);
          if (this.pending.size === 0) this.endStep("stop");
        }
      }
    } catch {
      // The session stream ended; nothing to pump.
    }
  }

  private mergeUsage(usage: Usage | undefined): void {
    if (!usage) return;
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        this.stepUsage[key] = (this.stepUsage[key] ?? 0) + value;
      }
    }
  }

  private enqueue(part: LanguageModelV3StreamPart): void {
    if (this.controller) {
      try {
        this.controller.enqueue(part);
        return;
      } catch {
        // The controller closed between the check and the enqueue.
      }
    }
    if (this.queue.length < 10_000) this.queue.push(part);
  }

  /** Attach a new step's stream, flushing anything buffered while detached. */
  attach(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>): void {
    this.controller = controller;
    for (const part of this.queue) controller.enqueue(part);
    this.queue = [];
  }

  detach(): void {
    this.controller = null;
  }

  /** Emit a tool call to OpenCode and park the step. */
  emitToolCall(call: { toolCallId: string; toolName: string; input: unknown }): void {
    this.enqueue({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: typeof call.input === "string" ? call.input : JSON.stringify(call.input),
    });
    this.schedulePark();
  }

  private schedulePark(): void {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    // A short debounce collects tool calls Muse issued in parallel.
    this.parkTimer = setTimeout(() => {
      this.parkTimer = null;
      this.endStep("tool-calls");
    }, 50);
    this.parkTimer.unref?.();
  }

  /** End the current step. */
  endStep(finishReason: "stop" | "tool-calls"): void {
    if (this.parkTimer) {
      clearTimeout(this.parkTimer);
      this.parkTimer = null;
    }
    for (const part of this.converter.closeBlocks()) this.enqueue(part);
    const usage = this.stepUsage;
    this.stepUsage = {};
    this.enqueue({
      type: "finish",
      finishReason: finishReason === "tool-calls"
        ? { unified: "tool-calls", raw: "tool_use" }
        : { unified: "stop", raw: "stop" },
      usage: toAIUsage(usage),
    });
    const controller = this.controller;
    this.controller = null;
    if (controller) {
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    }
  }

  /** Resolve a parked tool call from an OpenCode tool result. */
  resolvePending(toolCallId: string, result: HarnessToolResult): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    this.pending.delete(toolCallId);
    pending.resolve(result);
  }

  /** Reject every parked call; used when the session ends or errors. */
  clearPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.clearPending(new Error("Session closed"));
    await this.muse.close();
  }
}

/**
 * The registry owns every live session and the adapter that serves them.
 */
export class MuseSessionRegistry {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly adapter: MuseHarnessAdapter;
  private readonly store: SessionStore | undefined;
  private tools: ToolDefinition[] = [];

  constructor(adapter: MuseHarnessAdapter, store?: SessionStore) {
    this.adapter = adapter;
    this.store = store;
  }

  setTools(tools: ReadonlyArray<ToolDefinition>): void {
    this.tools = [...tools];
  }

  /** Read the Muse model catalog through the session's host. */
  async listModels(): Promise<Array<Record<string, unknown>>> {
    return this.adapter.listModels();
  }

  /** Get or create the live session for an OpenCode session id. */
  async get(openCodeSessionId: string, cwd: string, resumeFrom?: string): Promise<LiveSession> {
    const existing = this.sessions.get(openCodeSessionId);
    if (existing) return existing;

    const persisted = (await this.store?.get(openCodeSessionId)) ??
      (resumeFrom === undefined ? undefined : await this.store?.get(resumeFrom));

    let live: LiveSession | undefined;
    const bridge: HarnessToolBridge = {
      listTools: () => this.tools,
      callTool: async (call) => {
        const current = live;
        if (!current) throw new Error("Session is not ready");
        const id = `muse_tool_${current.toolCounter}`;
        const result = new Promise<HarnessToolResult>((resolve, reject) => {
          current.pending.set(id, { id, name: call.name, input: call.input, resolve, reject });
        });
        current.emitToolCall({ toolCallId: id, toolName: call.name, input: call.input });
        return result;
      },
    };

    const muse = await this.adapter.openSession({
      sessionId: openCodeSessionId,
      cwd,
      ...(persisted === undefined ? {} : { resumeSessionId: persisted }),
      toolBridge: bridge,
    });
    live = new LiveSession(openCodeSessionId, muse as MuseHarnessSession);
    this.sessions.set(openCodeSessionId, live);
    if (this.store) {
      await this.store.set(openCodeSessionId, live.muse.nativeSessionId).catch(() => undefined);
    }
    return live;
  }

  peek(openCodeSessionId: string): LiveSession | undefined {
    return this.sessions.get(openCodeSessionId);
  }

  async close(openCodeSessionId: string): Promise<void> {
    const live = this.sessions.get(openCodeSessionId);
    if (!live) return;
    this.sessions.delete(openCodeSessionId);
    await live.close();
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) await session.close();
    this.sessions.clear();
  }

  /** Run a one-off Muse turn that does not touch a live session. */
  async runOnce(
    cwd: string,
    content: Array<{ type: "text"; text: string }>,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: Usage }> {
    const session = await this.adapter.openSession({
      sessionId: `oneoff_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      cwd,
      toolBridge: {
        listTools: () => [],
        callTool: async (call) => ({
          content: [{ type: "text", text: `Tool ${call.name} is not available for this request.` }],
          isError: true,
        }),
      },
    });
    const events: HarnessEvent[] = [];
    const terminal = new Promise<void>((resolve) => {
      void (async () => {
        for await (const event of session.subscribe()) {
          events.push(event);
          if (event.type === "turn.terminal") resolve();
        }
      })();
    });
    await session.startTurn({
      turnId: `oneoff_turn_${Date.now()}`,
      message: { content },
    });
    await Promise.race([
      terminal,
      new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("one-off turn timed out")), 120_000);
        timer.unref?.();
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      }),
    ]);
    let text = "";
    for (const event of events) {
      if (event.type === "message.delta" && event.text) text += event.text;
      if (event.type === "message.completed" && event.message.role === "assistant") {
        text = event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
      }
    }
    const terminalEvent = events.find((event) => event.type === "turn.terminal");
    const usage: Usage =
      terminalEvent?.type === "turn.terminal" ? (terminalEvent.turn.tokenUsage as Usage | undefined) ?? {} : {};
    await session.close();
    return { text, usage };
  }
}
