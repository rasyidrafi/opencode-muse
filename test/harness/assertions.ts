/**
 * Structural validation and ordering assertions for the vendored harness
 * contract. Ported from `@rasyid_rafi/opencode-agent-harness-core/testing`.
 */
import type { HarnessCapabilities, HarnessEvent } from "../../src/contract/index.js";

/**
 * Structural validation for a capabilities object. Adapters should call this
 * in tests to catch a missing group or a mistyped flag before shipping.
 */
export function validateCapabilities(capabilities: HarnessCapabilities): string[] {
  const errors: string[] = [];
  if (typeof capabilities !== "object" || capabilities === null) {
    return ["capabilities must be an object"];
  }
  const groups = [
    "sessions",
    "threads",
    "turns",
    "streaming",
    "tools",
    "approvals",
    "input",
    "identity",
  ];
  for (const group of groups) {
    if (typeof (capabilities as Record<string, unknown>)[group] !== "object" ||
        (capabilities as Record<string, unknown>)[group] === null) {
      errors.push(`capabilities.${group} is required`);
    }
  }
  if (errors.length > 0)
    return errors;
  const candidate = capabilities as Record<string, Record<string, unknown>>;
  const booleanFields: Array<[string, unknown]> = [
    ["sessions.supportsModelSwitch", candidate.sessions.supportsModelSwitch],
    ["sessions.supportsResume", candidate.sessions.supportsResume],
    ["sessions.pendingRequestsSurviveRestart", candidate.sessions.pendingRequestsSurviveRestart],
    ["threads.exposesNativeThreadId", candidate.threads.exposesNativeThreadId],
    ["threads.canFork", candidate.threads.canFork],
    ["threads.canReadSnapshot", candidate.threads.canReadSnapshot],
    ["turns.exposesNativeTurnId", candidate.turns.exposesNativeTurnId],
    ["turns.emitsTurnStarted", candidate.turns.emitsTurnStarted],
    ["turns.emitsTurnCompleted", candidate.turns.emitsTurnCompleted],
    ["turns.supportsInterrupt", candidate.turns.supportsInterrupt],
    ["turns.supportsSteering", candidate.turns.supportsSteering],
    ["turns.supportsQueuedMessages", candidate.turns.supportsQueuedMessages],
    ["streaming.streamsAssistantText", candidate.streaming.streamsAssistantText],
    ["streaming.streamsReasoning", candidate.streaming.streamsReasoning],
    ["streaming.streamsToolOutput", candidate.streaming.streamsToolOutput],
    ["streaming.emitsMessageCompleted", candidate.streaming.emitsMessageCompleted],
    ["tools.exposesToolItemIds", candidate.tools.exposesToolItemIds],
    ["tools.emitsToolStarted", candidate.tools.emitsToolStarted],
    ["tools.emitsToolCompleted", candidate.tools.emitsToolCompleted],
    ["tools.emitsToolOutput", candidate.tools.emitsToolOutput],
    ["tools.supportsMcpTools", candidate.tools.supportsMcpTools],
    ["approvals.supportsCommandApproval", candidate.approvals.supportsCommandApproval],
    ["approvals.supportsFileReadApproval", candidate.approvals.supportsFileReadApproval],
    ["approvals.supportsFileChangeApproval", candidate.approvals.supportsFileChangeApproval],
    ["approvals.approvalsHaveNativeRequestIds", candidate.approvals.approvalsHaveNativeRequestIds],
    ["approvals.approvalCallbacksAreLiveOnly", candidate.approvals.approvalCallbacksAreLiveOnly],
    ["input.acceptsText", candidate.input.acceptsText],
    ["input.acceptsImages", candidate.input.acceptsImages],
    ["input.acceptsFiles", candidate.input.acceptsFiles],
  ];
  for (const [path, value] of booleanFields) {
    if (typeof value !== "boolean")
      errors.push(`capabilities.${path} must be a boolean`);
  }
  if (typeof candidate.sessions.maxConcurrentTurns !== "number" || candidate.sessions.maxConcurrentTurns < 1) {
    errors.push("capabilities.sessions.maxConcurrentTurns must be a positive number");
  }
  if (candidate.input.maxAttachments !== null && typeof candidate.input.maxAttachments !== "number") {
    errors.push("capabilities.input.maxAttachments must be a number or null");
  }
  if (!["strong", "weak", "none"].includes(candidate.turns.terminalStatusQuality as string)) {
    errors.push("capabilities.turns.terminalStatusQuality must be strong, weak, or none");
  }
  const strengths = ["strong", "weak", "none"];
  for (const [path, value] of [
    ["identity.nativeThreadIds", candidate.identity.nativeThreadIds],
    ["identity.nativeTurnIds", candidate.identity.nativeTurnIds],
    ["identity.nativeItemIds", candidate.identity.nativeItemIds],
    ["identity.nativeRequestIds", candidate.identity.nativeRequestIds],
  ] as Array<[string, unknown]>) {
    if (!strengths.includes(value as string))
      errors.push(`capabilities.${path} must be strong, weak, or none`);
  }
  return errors;
}

export function assertCapabilitiesShape(capabilities: HarnessCapabilities): void {
  const errors = validateCapabilities(capabilities);
  if (errors.length > 0) {
    throw new Error(`Invalid capabilities:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
}

/** Collect every event belonging to a turn, in stream order. */
export function collectTurnEvents(events: ReadonlyArray<HarnessEvent>, turnId: string): HarnessEvent[] {
  const messageTurns = new Map<string, string | null>();
  const toolTurns = new Map<string, string>();
  const collected: HarnessEvent[] = [];
  for (const event of events) {
    switch (event.type) {
      case "message.started":
      case "message.completed":
        messageTurns.set(event.message.id, event.message.turnId);
        if (event.message.turnId === turnId)
          collected.push(event);
        break;
      case "message.delta":
        if (messageTurns.get(event.messageId) === turnId)
          collected.push(event);
        break;
      case "tool.started":
      case "tool.completed":
        toolTurns.set(event.item.id, event.item.turnId);
        if (event.item.turnId === turnId)
          collected.push(event);
        break;
      case "tool.delta":
        if (toolTurns.get(event.itemId) === turnId)
          collected.push(event);
        break;
      case "turn.started":
      case "turn.updated":
      case "turn.terminal":
        if (event.turn.id === turnId)
          collected.push(event);
        break;
      case "request.updated":
        if (event.request.turnId === turnId)
          collected.push(event);
        break;
      default:
        break;
    }
  }
  return collected;
}

/**
 * Assert the ordering guarantees of the contract for one turn:
 * - `turn.started` comes before any message/tool/request event.
 * - `turn.terminal` is the last event for the turn.
 * - Every open message, tool, and request is settled before the terminal.
 */
export function assertTurnEventContract(events: ReadonlyArray<HarnessEvent>, turnId: string): void {
  const turnEvents = collectTurnEvents(events, turnId);
  if (turnEvents.length === 0) {
    throw new Error(`No events were emitted for turn ${turnId}`);
  }
  const terminalIndex = turnEvents.findIndex((event) => event.type === "turn.terminal");
  if (terminalIndex === -1) {
    throw new Error(`Turn ${turnId} never reached a terminal event`);
  }
  const terminal = turnEvents[terminalIndex];
  if (terminal.type !== "turn.terminal") {
    throw new Error("unreachable");
  }
  const startedIndex = turnEvents.findIndex((event) => event.type === "turn.started");
  if (startedIndex !== -1) {
    for (const event of turnEvents.slice(0, startedIndex)) {
      if (event.type !== "turn.updated") {
        throw new Error(`Turn ${turnId} emitted ${event.type} before turn.started`);
      }
    }
  }
  for (const event of turnEvents.slice(terminalIndex + 1)) {
    throw new Error(`Turn ${turnId} emitted ${event.type} after turn.terminal`);
  }
  const settledMessages = new Set<string>();
  const settledTools = new Set<string>();
  const settledRequests = new Set<string>();
  for (const event of turnEvents.slice(0, terminalIndex + 1)) {
    if (event.type === "message.completed")
      settledMessages.add(event.message.id);
    if (event.type === "tool.completed")
      settledTools.add(event.item.id);
    if (event.type === "request.updated" && event.request.status !== "pending") {
      settledRequests.add(event.request.id);
    }
  }
  for (const event of turnEvents.slice(0, terminalIndex)) {
    if (event.type === "message.started" && !settledMessages.has(event.message.id)) {
      throw new Error(`Message ${event.message.id} was not settled before the turn terminal`);
    }
    if (event.type === "tool.started" && !settledTools.has(event.item.id)) {
      throw new Error(`Tool ${event.item.id} was not settled before the turn terminal`);
    }
    if (event.type === "request.updated" && event.request.status === "pending" && !settledRequests.has(event.request.id)) {
      throw new Error(`Request ${event.request.id} was pending at the turn terminal`);
    }
  }
  const status = terminal.turn.status;
  if (status !== "completed" && status !== "interrupted" && status !== "cancelled" && status !== "failed") {
    throw new Error(`Turn ${turnId} terminal has non-terminal status ${status}`);
  }
}

/** Extract the final assistant text emitted for a turn. */
export function assistantText(events: ReadonlyArray<HarnessEvent>, turnId: string): string {
  let text = "";
  for (const event of collectTurnEvents(events, turnId)) {
    if (event.type === "message.delta" && event.text)
      text += event.text;
    if (event.type === "message.completed" && event.message.role === "assistant") {
      text = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
  }
  return text;
}
