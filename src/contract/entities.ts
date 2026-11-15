import type { HarnessNativeRef } from "./ids.js";
/** Content blocks are the harness-neutral representation of message content. */
export type HarnessContentBlock = {
    readonly type: "text";
    readonly text: string;
} | {
    readonly type: "image";
    readonly mediaType: string;
    readonly data: string;
} | {
    readonly type: "file";
    readonly mediaType: string;
    readonly data: string;
    readonly name?: string;
};
export type HarnessSessionStatus = "starting" | "ready" | "running" | "waiting" | "stopped" | "error";
export interface HarnessSessionInfo {
    /** Host-assigned session id. */
    readonly id: string;
    readonly adapterId: string;
    readonly status: HarnessSessionStatus;
    readonly cwd: string;
    readonly model: string | null;
    readonly capabilities: import("./capabilities.js").HarnessCapabilities;
    readonly lastError: string | null;
    /** ISO-8601 timestamps. */
    readonly createdAt: string;
    readonly updatedAt: string;
}
export type HarnessTurnStatus = "pending" | "running" | "completed" | "interrupted" | "cancelled" | "failed";
export interface HarnessTokenUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly totalTokens?: number;
}
export interface HarnessTurn {
    /** Host-assigned turn id. */
    readonly id: string;
    readonly nativeRef: HarnessNativeRef;
    /** 1-based position of this turn in the session. */
    readonly ordinal: number;
    readonly status: HarnessTurnStatus;
    readonly model: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly tokenUsage?: HarnessTokenUsage;
}
export type HarnessMessageRole = "user" | "assistant" | "system";
export type HarnessMessageStatus = "pending" | "streaming" | "completed" | "failed";
export interface HarnessMessage {
    /** Adapter-assigned id. The host uses it as the primary key for rendering. */
    readonly id: string;
    readonly turnId: string | null;
    readonly role: HarnessMessageRole;
    readonly content: ReadonlyArray<HarnessContentBlock>;
    readonly status: HarnessMessageStatus;
    readonly createdAt: string;
    readonly completedAt: string | null;
}
export type HarnessToolItemStatus = "running" | "completed" | "failed" | "cancelled";
export interface HarnessToolItem {
    /** Adapter-assigned id. The host uses it as the primary key for rendering. */
    readonly id: string;
    readonly turnId: string;
    readonly name: string;
    /** Parsed tool arguments. Adapters must not expose a half-parsed object. */
    readonly input: unknown;
    readonly status: HarnessToolItemStatus;
    /** Textual output for simple tool results. */
    readonly output?: string;
    /** Rich output blocks for tools that return images/files. */
    readonly content?: ReadonlyArray<HarnessContentBlock>;
    readonly error?: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
}
export type HarnessRequestKind = "approval" | "user_input" | "auth_refresh" | "dynamic_tool_call";
export type HarnessRequestStatus = "pending" | "resolved" | "expired" | "cancelled";
/**
 * Approval options are passed through from the harness unchanged. `id` is the
 * harness's own option id and must be echoed back in the response; hosts must
 * not invent ids of their own.
 */
export interface HarnessApprovalOption {
    readonly id: string;
    readonly label: string;
    readonly warning?: string;
}
export interface HarnessRuntimeRequest {
    /** Adapter-assigned id. The host uses it as the primary key for rendering. */
    readonly id: string;
    readonly turnId: string | null;
    readonly nativeRef: HarnessNativeRef;
    readonly kind: HarnessRequestKind;
    readonly status: HarnessRequestStatus;
    /** Question text for `user_input` requests. */
    readonly question?: string;
    /** Approval choices for `approval` requests. */
    readonly options?: ReadonlyArray<HarnessApprovalOption>;
    readonly createdAt: string;
    readonly resolvedAt: string | null;
}
export type HarnessFailureClass = "protocol" | "usage_limit" | "auth" | "timeout" | "cancelled" | "unknown";
export interface HarnessFailure {
    readonly class: HarnessFailureClass;
    readonly message: string;
    readonly code?: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    readonly details?: unknown;
}
/** Point-in-time view of a session, used for resume and debugging. */
export interface HarnessSnapshot {
    readonly session: HarnessSessionInfo;
    readonly turns: ReadonlyArray<HarnessTurn>;
    readonly messages: ReadonlyArray<HarnessMessage>;
    readonly tools: ReadonlyArray<HarnessToolItem>;
    readonly requests: ReadonlyArray<HarnessRuntimeRequest>;
}
