import type {
  HarnessContentBlock,
  HarnessEvent,
  HarnessMessage,
  HarnessRequestResponse,
  HarnessRuntimeRequest,
  HarnessSession,
  HarnessSessionInfo,
  HarnessSnapshot,
  HarnessToolItem,
  HarnessTurn,
  HarnessUserMessage,
} from "@opencode-agent-harness/core";
import { HarnessError, nativeRef } from "@opencode-agent-harness/core";
import type { MuseNotification, NotificationSink } from "./host.js";
import { startToolBridgeServer, normalizeToolName, BRIDGE_MCP_SERVER_NAME, type ToolBridgeServer } from "./bridge.js";
import { MUSE_CAPABILITIES } from "./capabilities.js";
import {
  parseToolArgs,
  toFailure,
  toMessageStatus,
  toRequestStatus,
  toSessionStatus,
  toTokenUsage,
  toToolStatus,
  toTurnStatus,
  toUserInputStatus,
} from "./events.js";

const ADAPTER_ID = "muse";

interface EventConsumer {
  queue: HarnessEvent[];
  notify: (() => void) | null;
  closed: boolean;
}

/** Broadcast event bus: every subscriber gets an independent queue. */
class EventBus {
  private readonly consumers = new Set<EventConsumer>();
  private closed = false;

  publish(event: HarnessEvent): void {
    if (this.closed) return;
    for (const consumer of this.consumers) consumer.queue.push(event);
    for (const consumer of this.consumers) consumer.notify?.();
  }

  subscribe(): AsyncIterable<HarnessEvent> {
    const consumer: EventConsumer = { queue: [], notify: null, closed: false };
    this.consumers.add(consumer);
    const consumers = this.consumers;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HarnessEvent>> {
            while (consumer.queue.length === 0) {
              if (consumer.closed) return { done: true, value: undefined };
              await new Promise<void>((resolve) => {
                consumer.notify = resolve;
                if (consumer.queue.length > 0) resolve();
              });
              consumer.notify = null;
            }
            return { done: false, value: consumer.queue.shift() as HarnessEvent };
          },
          async return(): Promise<IteratorResult<HarnessEvent>> {
            consumer.closed = true;
            consumers.delete(consumer);
            consumer.notify?.();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const consumer of this.consumers) {
      consumer.closed = true;
      consumer.notify?.();
    }
    this.consumers.clear();
  }
}

interface ActiveTurn {
  turn: HarnessTurn;
  terminal: boolean;
}

interface UserInputQuestion {
  readonly id: string;
  readonly question: string;
  readonly selection: { readonly mode: string };
  readonly options: ReadonlyArray<{ readonly label: string }>;
}

/** The minimal host surface a session needs, so tests can supply a fake. */
export interface SessionConnection {
  mintCommandId(): string;
  command(
    method: string,
    params: Record<string, unknown>,
    options?: { commandId?: string },
  ): Promise<Record<string, unknown>>;
}

export interface SessionHost {
  readonly connection: SessionConnection;
  registerSink(sink: NotificationSink): void;
  unregisterSink(sessionId: string): void;
}

function now(): string {
  return new Date().toISOString();
}

function textContent(text: string): ReadonlyArray<HarnessContentBlock> {
  return [{ type: "text", text }];
}

/** Convert contract content blocks into MSP turn input parts. */
export function toTurnInputParts(message: HarnessUserMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({ type: "image", mediaType: block.mediaType, base64Data: block.data });
    } else if (block.type === "file") {
      // MSP has no file part; a file mention travels as text.
      parts.push({ type: "text", text: `@${block.name ?? "file"}` });
    }
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

export interface CreateSessionInput {
  /** Host-assigned session id, echoed in `HarnessSessionInfo.id`. */
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string | null;
  readonly toolBridge?: import("@opencode-agent-harness/core").HarnessToolBridge;
  readonly signal?: AbortSignal;
  /** Starting approval mode; omitted selects the host default. */
  readonly approvalMode?: string;
  /** Native Muse session id to resume instead of starting a new session. */
  readonly resumeSessionId?: string;
}

/**
 * One Muse session translated into the harness contract.
 *
 * The session owns the normalized event stream. It never lets an event for a
 * turn escape after that turn's `turn.terminal`, and it settles every open
 * message, tool, and request before the terminal.
 */
export class MuseHarnessSession implements HarnessSession, NotificationSink {
  readonly id: string;
  private readonly host: SessionHost;
  private readonly nativeId: string;
  private readonly bus = new EventBus();
  private readonly capabilities = MUSE_CAPABILITIES;
  private readonly toolBridge: import("@opencode-agent-harness/core").HarnessToolBridge | undefined;
  private readonly bridgeServer: ToolBridgeServer | undefined;
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly hostToNative = new Map<string, string>();
  private readonly nativeToHost = new Map<string, string>();
  private readonly messages = new Map<string, HarnessMessage>();
  private readonly tools = new Map<string, HarnessToolItem>();
  private readonly requests = new Map<string, HarnessRuntimeRequest>();
  private readonly requestRequirements = new Map<string, unknown>();
  private readonly requestQuestions = new Map<string, readonly UserInputQuestion[]>();
  private readonly requestWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private closing: Promise<void> | null = null;
  private closed = false;
  private sessionInfo: HarnessSessionInfo;

  private constructor(
    host: SessionHost,
    input: CreateSessionInput,
    nativeSessionId: string,
    startedAt: string,
    toolBridge?: import("@opencode-agent-harness/core").HarnessToolBridge,
    bridgeServer?: ToolBridgeServer,
  ) {
    this.host = host;
    this.id = input.sessionId;
    this.nativeId = nativeSessionId;
    this.toolBridge = toolBridge;
    this.bridgeServer = bridgeServer;
    this.sessionInfo = {
      id: input.sessionId,
      adapterId: ADAPTER_ID,
      status: "ready",
      cwd: input.cwd,
      model: input.model ?? null,
      capabilities: this.capabilities,
      lastError: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
  }

  static async create(
    host: SessionHost,
    input: CreateSessionInput,
  ): Promise<MuseHarnessSession> {
    const commandId = host.connection.mintCommandId();
    const bridgeServer = input.toolBridge
      ? await startToolBridgeServer(input.toolBridge)
      : undefined;
    const config = bridgeServer
      ? {
          mcpServers: {
            [BRIDGE_MCP_SERVER_NAME]: {
              transport: "streamableHttp",
              url: bridgeServer.url,
              headers: { Authorization: `Bearer ${bridgeServer.token}` },
              mode: "required",
            },
          },
        }
      : undefined;

    let result: Record<string, unknown>;
    if (input.resumeSessionId !== undefined) {
      try {
        result = await host.connection.command(
          "session/resume",
          {
            sessionId: input.resumeSessionId,
            ...(config === undefined ? {} : { config }),
          },
          { commandId },
        );
      } catch {
        // The retained session is gone (pruned, or a different host). Start
        // fresh with a new command id: reusing one is a protocol error.
        result = await host.connection.command(
          "session/start",
          {
            workspaceRoot: input.cwd,
            ...(input.model ? { modelId: input.model } : {}),
            ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
            ...(config === undefined ? {} : { config }),
          },
          { commandId: host.connection.mintCommandId() },
        );
      }
    } else {
      result = await host.connection.command(
        "session/start",
        {
          workspaceRoot: input.cwd,
          ...(input.model ? { modelId: input.model } : {}),
          ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
          ...(config === undefined ? {} : { config }),
        },
        { commandId },
      );
    }

    const session = result?.session as Record<string, unknown> | undefined;
    const nativeSessionId =
      typeof session?.sessionId === "string" ? session.sessionId : input.sessionId;
    const model =
      typeof session?.modelId === "string" ? session.modelId : input.model ?? null;
    const createdAt =
      typeof session?.createdAt === "string" ? session.createdAt : now();

    const created = new MuseHarnessSession(
      host,
      { ...input, model },
      nativeSessionId,
      createdAt,
      input.toolBridge,
      bridgeServer,
    );
    host.registerSink(created);
    created.emit({ type: "session.updated", session: created.info });
    return created;
  }

  /**
   * Attach to an already-started native session without issuing `session/start`.
   * Used by replay tests, which drive a recorded transcript through the
   * notification handler.
   */
  static fromNativeSession(
    host: SessionHost,
    input: CreateSessionInput,
    nativeSessionId: string,
    model: string | null = null,
  ): MuseHarnessSession {
    const created = new MuseHarnessSession(
      host,
      { ...input, model },
      nativeSessionId,
      now(),
    );
    host.registerSink(created);
    return created;
  }

  get info(): HarnessSessionInfo {
    return this.sessionInfo;
  }

  /** The native Muse session id, used for notification routing. */
  get sessionId(): string {
    return this.nativeId;
  }

  /** The native Muse session id, for resume and persistence. */
  get nativeSessionId(): string {
    return this.nativeId;
  }

  subscribe(): AsyncIterable<HarnessEvent> {
    return this.bus.subscribe();
  }

  private emit(event: HarnessEvent): void {
    if (!this.closed) this.bus.publish(event);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HarnessError({
        code: "session_stopped",
        adapterId: ADAPTER_ID,
        message: `Session ${this.id} is closed`,
      });
    }
  }

  private resolveTurnId(nativeTurnId: unknown): string {
    if (typeof nativeTurnId !== "string") return "";
    return this.nativeToHost.get(nativeTurnId) ?? nativeTurnId;
  }

  private nativeTurnId(hostTurnId: string): string | undefined {
    return this.hostToNative.get(hostTurnId);
  }

  // ------------------------------------------------------------------ turns

  async startTurn(input: import("@opencode-agent-harness/core").StartTurnInput): Promise<HarnessTurn> {
    this.assertOpen();
    const commandId = this.host.connection.mintCommandId();
    const result = await this.host.connection.command(
      "turn/start",
      {
        sessionId: this.nativeId,
        input: toTurnInputParts(input.message),
      },
      { commandId },
    );
    const nativeTurnId =
      typeof result?.turnId === "string" ? result.turnId : commandId;
    this.hostToNative.set(input.turnId, nativeTurnId);
    this.nativeToHost.set(nativeTurnId, input.turnId);

    const turn: HarnessTurn = {
      id: input.turnId,
      nativeRef: nativeRef(nativeTurnId, this.capabilities.identity.nativeTurnIds),
      ordinal: this.turns.size + 1,
      status: "running",
      model: input.model ?? this.sessionInfo.model,
      startedAt: now(),
      completedAt: null,
    };
    this.turns.set(input.turnId, { turn, terminal: false });
    return turn;
  }

  async interruptTurn(input: import("@opencode-agent-harness/core").InterruptTurnInput): Promise<void> {
    this.assertOpen();
    const nativeTurnId = this.nativeTurnId(input.turnId);
    if (nativeTurnId === undefined) {
      throw new HarnessError({
        code: "invalid_input",
        adapterId: ADAPTER_ID,
        message: `Unknown turn ${input.turnId}`,
      });
    }
    await this.host.connection.command(
      "turn/interrupt",
      { sessionId: this.nativeId, turnId: nativeTurnId },
    );
  }

  async steerTurn(input: import("@opencode-agent-harness/core").SteerTurnInput): Promise<void> {
    this.assertOpen();
    const nativeTurnId = this.nativeTurnId(input.turnId);
    if (nativeTurnId === undefined) {
      throw new HarnessError({
        code: "invalid_input",
        adapterId: ADAPTER_ID,
        message: `Unknown turn ${input.turnId}`,
      });
    }
    await this.host.connection.command(
      "turn/steer",
      {
        sessionId: this.nativeId,
        expectedTurnId: nativeTurnId,
        input: toTurnInputParts(input.message),
      },
    );
  }

  async respondToRequest(input: HarnessRequestResponse): Promise<void> {
    this.assertOpen();
    const request = this.requests.get(input.requestId);
    if (!request) {
      throw new HarnessError({
        code: "invalid_input",
        adapterId: ADAPTER_ID,
        message: `Unknown runtime request ${input.requestId}`,
      });
    }
    if (request.status !== "pending") return;

    if (request.kind === "approval") {
      const choiceId = input.optionId;
      if (choiceId === undefined) {
        throw new HarnessError({
          code: "invalid_input",
          adapterId: ADAPTER_ID,
          message: `Approval ${input.requestId} needs an optionId`,
        });
      }
      const requirementId = this.requestRequirements.get(request.id);
      await this.host.connection.command("approval/decide", {
        sessionId: this.nativeId,
        approvalId: request.id,
        choiceId,
        ...(requirementId === undefined ? {} : { requirementId }),
        ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      });
      return;
    }

    if (request.kind === "user_input") {
      const answers = this.toUserInputAnswers(input);
      await this.host.connection.command("userInput/answer", {
        sessionId: this.nativeId,
        userInputId: request.id,
        answers,
      });
    }
  }

  private toUserInputAnswers(input: HarnessRequestResponse): Array<Record<string, unknown>> {
    const questions = this.requestQuestions.get(input.requestId) ?? [];
    const answers: Array<Record<string, unknown>> = [];
    for (const question of questions) {
      const supplied = input.answers?.[question.id];
      const answer: Record<string, unknown> = { questionId: question.id };
      if (Array.isArray(supplied)) {
        answer.selectedLabels = supplied.map((label) => String(label));
      } else if (typeof supplied === "string") {
        answer.selectedLabel = supplied;
      } else if (supplied && typeof supplied === "object" && typeof (supplied as { freeText?: unknown }).freeText === "string") {
        answer.freeText = (supplied as { freeText: string }).freeText;
      } else if (questions.length === 1 && input.optionId !== undefined) {
        answer.selectedLabel = input.optionId;
      } else if (question.selection.mode === "single" && question.options[0] !== undefined) {
        answer.selectedLabel = question.options[0].label;
      } else {
        answer.freeText = "";
      }
      answers.push(answer);
    }
    return answers;
  }

  async getSnapshot(): Promise<HarnessSnapshot> {
    this.assertOpen();
    return {
      session: this.sessionInfo,
      turns: [...this.turns.values()].map((active) => active.turn),
      messages: [...this.messages.values()],
      tools: [...this.tools.values()],
      requests: [...this.requests.values()],
    };
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.closed) return;
      // Settle anything still open so the stream never ends with a hung item.
      for (const active of this.turns.values()) {
        if (!active.terminal) this.settleTurnItems(active);
      }
      for (const waiter of this.requestWaiters.values()) {
        waiter.reject(
          new HarnessError({
            code: "session_stopped",
            adapterId: ADAPTER_ID,
            message: "Session closed while waiting for a response",
          }),
        );
      }
      this.requestWaiters.clear();
      try {
        await this.host.connection.command(
          "session/leave",
          { sessionId: this.nativeId, stop: true },
        );
      } catch {
        // Leaving is best-effort; the host may already be gone.
      }
      this.host.unregisterSink(this.nativeId);
      this.updateSession("stopped");
      this.closed = true;
      this.bus.close();
      try {
        await this.toolBridge?.close?.();
      } catch {
        // Bridge cleanup is best-effort.
      }
      await this.bridgeServer?.close();
    })();
    return this.closing;
  }

  // ------------------------------------------------------------- notifications

  handleNotification(notification: MuseNotification): void {
    if (this.closed) return;
    const params = notification.params ?? {};
    switch (notification.method) {
      case "turn/started":
        this.onTurnStarted(params);
        break;
      case "turn/completed":
        this.onTurnCompleted(params);
        break;
      case "item/started":
        this.onItemStarted(params);
        break;
      case "item/updated":
        this.onItemUpdated(params);
        break;
      case "item/delta":
        this.onItemDelta(params);
        break;
      case "item/completed":
        this.onItemCompleted(params);
        break;
      case "approval/requested":
        this.onApprovalRequested(params);
        break;
      case "approval/resolved":
        this.onApprovalResolved(params);
        break;
      case "userInput/requested":
        this.onUserInputRequested(params);
        break;
      case "userInput/settled":
        this.onUserInputSettled(params);
        break;
      case "session/statusChanged":
        this.onSessionStatusChanged(params);
        break;
      case "session/closed":
        this.onSessionClosed(params);
        break;
      default:
        break;
    }
  }

  private onTurnStarted(params: Record<string, unknown>): void {
    const nativeTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (nativeTurnId === undefined) return;
    const hostTurnId = this.resolveTurnId(nativeTurnId);
    const existing = this.turns.get(hostTurnId);
    if (existing && existing.turn.status !== "pending") return;

    const turn: HarnessTurn = {
      id: hostTurnId,
      nativeRef: nativeRef(nativeTurnId, this.capabilities.identity.nativeTurnIds),
      ordinal: existing ? existing.turn.ordinal : this.turns.size + 1,
      status: "running",
      model: this.sessionInfo.model,
      startedAt: now(),
      completedAt: null,
    };
    this.turns.set(hostTurnId, { turn, terminal: false });
    this.emit({ type: "turn.started", turn });
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    const nativeTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (nativeTurnId === undefined) return;
    const hostTurnId = this.resolveTurnId(nativeTurnId);
    const active = this.turns.get(hostTurnId);
    if (!active || active.terminal) return;

    this.settleTurnItems(active);
    const terminal = typeof params.terminal === "string" ? params.terminal : "failed";
    const status = toTurnStatus(terminal);
    const failure = status === "failed" ? toFailure(params.error) : null;
    const turn: HarnessTurn = {
      ...active.turn,
      status,
      completedAt: now(),
      ...(params.usage === undefined ? {} : { tokenUsage: toTokenUsage(params.usage) }),
    };
    active.turn = turn;
    active.terminal = true;
    this.emit({ type: "turn.updated", turn });
    this.emit({ type: "turn.terminal", turn, failure });
  }

  private onItemStarted(params: Record<string, unknown>): void {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;
    const itemId = typeof item.itemId === "string" ? item.itemId : undefined;
    if (itemId === undefined) return;
    const kind = typeof item.kind === "string" ? item.kind : "";
    const turnId = this.resolveTurnId(item.turnId);
    const timestamp = now();

    if (kind === "agentMessage" || kind === "reasoning") {
      const message: HarnessMessage = {
        id: itemId,
        turnId,
        role: "assistant",
        content: [],
        status: "pending",
        createdAt: timestamp,
        completedAt: null,
      };
      this.messages.set(itemId, message);
      this.emit({ type: "message.started", message });
      return;
    }

    if (kind === "toolCall") {
      const tool: HarnessToolItem = {
        id: itemId,
        turnId,
        name: normalizeToolName(typeof item.tool === "string" ? item.tool : "unknown"),
        input: parseToolArgs(item.args),
        status: "running",
        startedAt: timestamp,
        completedAt: null,
      };
      this.tools.set(itemId, tool);
      this.emit({ type: "tool.started", item: tool });
    }
  }

  private onItemUpdated(params: Record<string, unknown>): void {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;
    const status = typeof item.status === "string" ? item.status : "inProgress";
    if (status === "inProgress") return;
    // A terminal whole-item update is equivalent to item/completed.
    this.onItemCompleted({ item });
  }

  private onItemDelta(params: Record<string, unknown>): void {
    const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (itemId === undefined || delta.length === 0) return;
    const field = typeof params.field === "string" ? params.field : "text";

    const message = this.messages.get(itemId);
    if (message) {
      if (field === "text") {
        this.emit({ type: "message.delta", messageId: itemId, text: delta });
      } else if (field.startsWith("summary.")) {
        this.emit({ type: "message.delta", messageId: itemId, reasoning: delta });
      }
      return;
    }

    const tool = this.tools.get(itemId);
    if (tool && field === "output") {
      this.emit({ type: "tool.delta", itemId, chunk: delta });
    }
  }

  private onItemCompleted(params: Record<string, unknown>): void {
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;
    const itemId = typeof item.itemId === "string" ? item.itemId : undefined;
    if (itemId === undefined) return;
    const kind = typeof item.kind === "string" ? item.kind : "";
    const status = typeof item.status === "string" ? item.status : "completed";
    const timestamp = now();

    if (kind === "agentMessage" || kind === "reasoning") {
      const message = this.messages.get(itemId);
      if (!message) return;
      const updated: HarnessMessage = {
        ...message,
        content:
          kind === "agentMessage"
            ? textContent(typeof item.text === "string" ? item.text : "")
            : [],
        status: toMessageStatus(status),
        completedAt: timestamp,
      };
      this.messages.set(itemId, updated);
      this.emit({ type: "message.completed", message: updated });
      return;
    }

    if (kind === "toolCall") {
      const tool = this.tools.get(itemId);
      if (!tool) return;
      const updated: HarnessToolItem = {
        ...tool,
        status: toToolStatus(status),
        output: typeof item.visibleOutput === "string" ? item.visibleOutput : undefined,
        error: typeof item.failureReason === "string" ? item.failureReason : undefined,
        completedAt: timestamp,
      };
      this.tools.set(itemId, updated);
      this.emit({ type: "tool.completed", item: updated });
    }
  }

  private onApprovalRequested(params: Record<string, unknown>): void {
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : undefined;
    if (approvalId === undefined) return;
    const choices = Array.isArray(params.availableChoices) ? params.availableChoices : [];
    const request: HarnessRuntimeRequest = {
      id: approvalId,
      turnId: this.resolveTurnId(params.turnId),
      nativeRef: nativeRef(approvalId, this.capabilities.identity.nativeRequestIds),
      kind: "approval",
      status: "pending",
      options: choices.map((choice) => ({
        id: String((choice as Record<string, unknown>).choiceId ?? ""),
        label: String((choice as Record<string, unknown>).label ?? ""),
      })),
      createdAt: now(),
      resolvedAt: null,
    };
    this.requests.set(request.id, request);
    if (params.currentRequirementId !== undefined) {
      this.requestRequirements.set(request.id, params.currentRequirementId);
    }
    this.emit({ type: "request.updated", request });
  }

  private onApprovalResolved(params: Record<string, unknown>): void {
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : undefined;
    if (approvalId === undefined) return;
    const request = this.requests.get(approvalId);
    if (!request) return;
    const decision = typeof params.decision === "string" ? params.decision : "abort";
    const updated: HarnessRuntimeRequest = {
      ...request,
      status: toRequestStatus(decision),
      resolvedAt: now(),
    };
    this.requests.set(request.id, updated);
    this.emit({ type: "request.updated", request: updated });
    this.requestWaiters.get(request.id)?.resolve();
    this.requestWaiters.delete(request.id);
  }

  private onUserInputRequested(params: Record<string, unknown>): void {
    const userInputId = typeof params.userInputId === "string" ? params.userInputId : undefined;
    if (userInputId === undefined) return;
    const questions = Array.isArray(params.questions)
      ? (params.questions as UserInputQuestion[])
      : [];
    const first = questions[0];
    const request: HarnessRuntimeRequest = {
      id: userInputId,
      turnId: this.resolveTurnId(params.turnId),
      nativeRef: nativeRef(userInputId, this.capabilities.identity.nativeRequestIds),
      kind: "user_input",
      status: "pending",
      question: first?.question,
      options: (first?.options ?? []).map((option) => ({ id: option.label, label: option.label })),
      createdAt: now(),
      resolvedAt: null,
    };
    this.requests.set(request.id, request);
    this.requestQuestions.set(request.id, questions);
    this.emit({ type: "request.updated", request });
  }

  private onUserInputSettled(params: Record<string, unknown>): void {
    const userInputId = typeof params.userInputId === "string" ? params.userInputId : undefined;
    if (userInputId === undefined) return;
    const request = this.requests.get(userInputId);
    if (!request) return;
    const outcome = typeof params.outcome === "string" ? params.outcome : "aborted";
    const updated: HarnessRuntimeRequest = {
      ...request,
      status: toUserInputStatus(outcome),
      resolvedAt: now(),
    };
    this.requests.set(request.id, updated);
    this.emit({ type: "request.updated", request: updated });
    this.requestWaiters.get(request.id)?.resolve();
    this.requestWaiters.delete(request.id);
  }

  private onSessionStatusChanged(params: Record<string, unknown>): void {
    const status = typeof params.status === "string" ? params.status : "idle";
    this.updateSession(toSessionStatus(status));
  }

  private onSessionClosed(_params: Record<string, unknown>): void {
    this.updateSession("stopped");
  }

  private updateSession(status: HarnessSessionInfo["status"]): void {
    this.sessionInfo = { ...this.sessionInfo, status, updatedAt: now() };
    this.emit({ type: "session.updated", session: this.sessionInfo });
  }

  /** Settle every message, tool, and request still open for this turn. */
  private settleTurnItems(active: ActiveTurn): void {
    const timestamp = now();
    for (const message of this.messages.values()) {
      if (message.turnId !== active.turn.id) continue;
      if (message.status === "pending" || message.status === "streaming") {
        const settled: HarnessMessage = { ...message, status: "failed", completedAt: timestamp };
        this.messages.set(message.id, settled);
        this.emit({ type: "message.completed", message: settled });
      }
    }
    for (const tool of this.tools.values()) {
      if (tool.turnId !== active.turn.id) continue;
      if (tool.status === "running") {
        const settled: HarnessToolItem = {
          ...tool,
          status: "cancelled",
          error: "Turn ended before the tool finished",
          completedAt: timestamp,
        };
        this.tools.set(tool.id, settled);
        this.emit({ type: "tool.completed", item: settled });
      }
    }
    for (const request of this.requests.values()) {
      if (request.turnId !== active.turn.id) continue;
      if (request.status === "pending") {
        const settled: HarnessRuntimeRequest = {
          ...request,
          status: "cancelled",
          resolvedAt: timestamp,
        };
        this.requests.set(request.id, settled);
        this.emit({ type: "request.updated", request: settled });
        this.requestWaiters.get(request.id)?.resolve();
        this.requestWaiters.delete(request.id);
      }
    }
  }
}
