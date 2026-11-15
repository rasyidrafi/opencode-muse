import type { HarnessFailure, HarnessMessage, HarnessRuntimeRequest, HarnessSessionInfo, HarnessToolItem, HarnessTurn } from "./entities.js";
/**
 * Normalized event stream emitted by a harness session.
 *
 * Ordering guarantees an adapter must honor:
 * - `turn.started` precedes every event belonging to that turn.
 * - `turn.terminal` is the last event for a turn. Every open message, tool
 *   item, and runtime request for that turn must be settled before it.
 * - `message.started` precedes its `message.delta`/`message.completed`.
 * - `tool.started` precedes its `tool.delta`/`tool.completed`.
 * - A turn that fails or is interrupted still emits `turn.terminal`.
 */
export type HarnessEvent = {
    readonly type: "session.updated";
    readonly session: HarnessSessionInfo;
} | {
    readonly type: "turn.started";
    readonly turn: HarnessTurn;
} | {
    readonly type: "turn.updated";
    readonly turn: HarnessTurn;
} | {
    readonly type: "turn.terminal";
    readonly turn: HarnessTurn;
    /** Failure detail when `turn.status` is `failed`; otherwise `null`. */
    readonly failure: HarnessFailure | null;
} | {
    readonly type: "message.started";
    readonly message: HarnessMessage;
} | {
    readonly type: "message.delta";
    readonly messageId: string;
    /** Incremental assistant text, appended to the running text block. */
    readonly text?: string;
    /** Incremental reasoning text; ephemeral, not part of message content. */
    readonly reasoning?: string;
} | {
    readonly type: "message.completed";
    readonly message: HarnessMessage;
} | {
    readonly type: "tool.started";
    readonly item: HarnessToolItem;
} | {
    readonly type: "tool.delta";
    readonly itemId: string;
    readonly chunk: string;
} | {
    readonly type: "tool.completed";
    readonly item: HarnessToolItem;
} | {
    readonly type: "request.updated";
    readonly request: HarnessRuntimeRequest;
} | {
    readonly type: "session.error";
    readonly error: HarnessFailure;
};
export const HARNESS_TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
    "completed",
    "interrupted",
    "cancelled",
    "failed",
]);

export function isTerminalTurn(event: HarnessEvent): boolean {
    return event.type === "turn.terminal";
}
