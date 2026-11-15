import type { HarnessNativeRefStrength } from "./ids.js";
/**
 * Capabilities are the contract's way of being honest about what a harness
 * actually does. Every flag must reflect observed behavior, not aspiration:
 * a flag left on that fails at runtime is an adapter bug.
 *
 * Hosts must check capabilities before using an optional operation and must
 * never branch on the adapter id.
 */
export interface HarnessSessionCapabilities {
    /** The harness can change models without reopening the session. */
    readonly supportsModelSwitch: boolean;
    /** A session can be resumed after the host process restarts. */
    readonly supportsResume: boolean;
    /** Pending approvals/questions survive a host restart. */
    readonly pendingRequestsSurviveRestart: boolean;
    /** How many turns the harness can run concurrently in one session. */
    readonly maxConcurrentTurns: number;
}
export interface HarnessThreadCapabilities {
    readonly exposesNativeThreadId: boolean;
    /** The harness can fork a conversation natively. */
    readonly canFork: boolean;
    /** The harness can read a full conversation snapshot. */
    readonly canReadSnapshot: boolean;
}
export interface HarnessTurnCapabilities {
    readonly exposesNativeTurnId: boolean;
    readonly emitsTurnStarted: boolean;
    readonly emitsTurnCompleted: boolean;
    readonly supportsInterrupt: boolean;
    /** The harness can modify an in-flight turn without restarting it. */
    readonly supportsSteering: boolean;
    /** Messages sent while a turn runs are queued by the harness. */
    readonly supportsQueuedMessages: boolean;
    /**
     * How much the host can trust the harness's terminal status:
     * - `strong`: the harness reports completion/failure reliably.
     * - `weak`: the harness reports a terminal state, but correlation is uncertain.
     * - `none`: the host must infer terminal state itself.
     */
    readonly terminalStatusQuality: "strong" | "weak" | "none";
}
export interface HarnessStreamingCapabilities {
    readonly streamsAssistantText: boolean;
    readonly streamsReasoning: boolean;
    readonly streamsToolOutput: boolean;
    readonly emitsMessageCompleted: boolean;
}
export interface HarnessToolCapabilities {
    readonly exposesToolItemIds: boolean;
    readonly emitsToolStarted: boolean;
    readonly emitsToolCompleted: boolean;
    readonly emitsToolOutput: boolean;
    /** The harness can consume MCP tools exposed by the host. */
    readonly supportsMcpTools: boolean;
}
export interface HarnessApprovalCapabilities {
    readonly supportsCommandApproval: boolean;
    readonly supportsFileReadApproval: boolean;
    readonly supportsFileChangeApproval: boolean;
    readonly approvalsHaveNativeRequestIds: boolean;
    /**
     * True when an approval can only be answered while the harness process is
     * alive. Hosts must not defer the answer.
     */
    readonly approvalCallbacksAreLiveOnly: boolean;
}
export interface HarnessInputCapabilities {
    readonly acceptsText: boolean;
    readonly acceptsImages: boolean;
    readonly acceptsFiles: boolean;
    /** Declared attachment ceiling, or `null` when the harness does not declare one. */
    readonly maxAttachments: number | null;
}
export interface HarnessIdentityCapabilities {
    readonly nativeThreadIds: HarnessNativeRefStrength;
    readonly nativeTurnIds: HarnessNativeRefStrength;
    readonly nativeItemIds: HarnessNativeRefStrength;
    readonly nativeRequestIds: HarnessNativeRefStrength;
}
export interface HarnessCapabilities {
    readonly sessions: HarnessSessionCapabilities;
    readonly threads: HarnessThreadCapabilities;
    readonly turns: HarnessTurnCapabilities;
    readonly streaming: HarnessStreamingCapabilities;
    readonly tools: HarnessToolCapabilities;
    readonly approvals: HarnessApprovalCapabilities;
    readonly input: HarnessInputCapabilities;
    readonly identity: HarnessIdentityCapabilities;
}
/**
 * A conservative starting point: everything optional is off and every native
 * id is treated as absent. Adapters override only what they have verified.
 */
export function disabledCapabilities(): HarnessCapabilities {
    return {
        sessions: {
            supportsModelSwitch: false,
            supportsResume: false,
            pendingRequestsSurviveRestart: false,
            maxConcurrentTurns: 1,
        },
        threads: {
            exposesNativeThreadId: false,
            canFork: false,
            canReadSnapshot: false,
        },
        turns: {
            exposesNativeTurnId: false,
            emitsTurnStarted: false,
            emitsTurnCompleted: false,
            supportsInterrupt: false,
            supportsSteering: false,
            supportsQueuedMessages: false,
            terminalStatusQuality: "none",
        },
        streaming: {
            streamsAssistantText: false,
            streamsReasoning: false,
            streamsToolOutput: false,
            emitsMessageCompleted: false,
        },
        tools: {
            exposesToolItemIds: false,
            emitsToolStarted: false,
            emitsToolCompleted: false,
            emitsToolOutput: false,
            supportsMcpTools: false,
        },
        approvals: {
            supportsCommandApproval: false,
            supportsFileReadApproval: false,
            supportsFileChangeApproval: false,
            approvalsHaveNativeRequestIds: false,
            approvalCallbacksAreLiveOnly: false,
        },
        input: {
            acceptsText: true,
            acceptsImages: false,
            acceptsFiles: false,
            maxAttachments: null,
        },
        identity: {
            nativeThreadIds: "none",
            nativeTurnIds: "none",
            nativeItemIds: "none",
            nativeRequestIds: "none",
        },
    };
}
