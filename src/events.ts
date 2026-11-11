import type {
  HarnessFailure,
  HarnessFailureClass,
  HarnessMessageStatus,
  HarnessRequestStatus,
  HarnessSessionStatus,
  HarnessToolItemStatus,
  HarnessTurnStatus,
} from "@opencode-agent-harness/core";

/** MSP item status -> contract tool status. */
export function toToolStatus(status: string): HarnessToolItemStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "timedOut":
      return "failed";
    case "cancelled":
    case "rejected":
      return "cancelled";
    default:
      return "running";
  }
}

/** MSP item status -> contract message status. */
export function toMessageStatus(status: string): HarnessMessageStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "timedOut":
    case "cancelled":
    case "rejected":
      return "failed";
    default:
      return "streaming";
  }
}

/** MSP turn terminal -> contract turn status. */
export function toTurnStatus(terminal: string): HarnessTurnStatus {
  switch (terminal) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

/** MSP approval decision -> contract request status. */
export function toRequestStatus(decision: string): HarnessRequestStatus {
  switch (decision) {
    case "timedOut":
      return "expired";
    case "abort":
      return "cancelled";
    default:
      // approved*, denied* all answer the request.
      return "resolved";
  }
}

/** MSP userInput outcome -> contract request status. */
export function toUserInputStatus(outcome: string): HarnessRequestStatus {
  switch (outcome) {
    case "answered":
    case "clarified":
      return "resolved";
    case "timedOut":
      return "expired";
    default:
      // cancelled, interrupted, aborted
      return "cancelled";
  }
}

/** MSP session load state -> contract session status. */
export function toSessionStatus(status: string): HarnessSessionStatus {
  switch (status) {
    case "running":
      return "running";
    case "notLoaded":
      return "stopped";
    default:
      return "ready";
  }
}

function toFailureClass(kind: string): HarnessFailureClass {
  switch (kind) {
    case "authRequired":
      return "auth";
    case "projectionError":
    case "logError":
    case "mcpLinkError":
      return "protocol";
    case "modelError":
    case "environmentError":
    case "workflowLaunchError":
    case "launchError":
    case "configError":
    case "stepLimit":
      return "unknown";
    default:
      return "protocol";
  }
}

/** Translate an MSP `turn/completed` error into a contract failure. */
export function toFailure(error: unknown): HarnessFailure {
  if (!error || typeof error !== "object") {
    return { class: "unknown", message: String(error), retryable: false };
  }
  const value = error as Record<string, unknown>;
  const kind = typeof value.kind === "string" ? value.kind : "unknown";
  const message = typeof value.message === "string" ? value.message : "Turn failed";
  const quota = value.quota;
  const class_: HarnessFailureClass = quota && typeof quota === "object" ? "usage_limit" : toFailureClass(kind);
  return {
    class: class_,
    message,
    ...(typeof kind === "string" ? { code: kind } : {}),
    retryable: value.retryable === true,
  };
}

/** MSP `TokenUsage` -> contract token usage. */
export function toTokenUsage(usage: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      totalTokens?: number;
    }
  | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const input = typeof value.inputTokens === "number" ? value.inputTokens : undefined;
  const output = typeof value.outputTokens === "number" ? value.outputTokens : undefined;
  const reasoning = typeof value.reasoningTokens === "number" ? value.reasoningTokens : undefined;
  const cached = typeof value.cachedTokens === "number" ? value.cachedTokens : undefined;
  const total =
    typeof input === "number" && typeof output === "number" ? input + output : undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

/** Parse a tool call's verbatim `args` JSON without ever exposing half-parsed input. */
export function parseToolArgs(args: unknown): unknown {
  if (typeof args !== "string" || args.length === 0) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // The wire keeps model-emitted almost-JSON verbatim. Do not guess: report an
    // empty object so the host sees a settled call, not a crash.
    return {};
  }
}
