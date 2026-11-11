import { disabledCapabilities, type HarnessCapabilities } from "@opencode-agent-harness/core";

/**
 * Capabilities observed from a real Muse Code 1.4.15 host (`muse serve`).
 *
 * Every flag here was verified against the live protocol: `initialize` grants
 * `sessionMcp`, `sessionDurability` is `durable`, `turn/start`/`turn/interrupt`/
 * `turn/steer` work, per-session MCP servers start under `--trust-workspace`,
 * and approval ids survive a restart. Do not turn a flag on without observing
 * the behaviour; the conformance suite treats a lying flag as an adapter bug.
 */
export const MUSE_CAPABILITIES: HarnessCapabilities = {
  ...disabledCapabilities(),
  sessions: {
    ...disabledCapabilities().sessions,
    supportsModelSwitch: true,
    supportsResume: true,
    pendingRequestsSurviveRestart: true,
    maxConcurrentTurns: 1,
  },
  threads: {
    ...disabledCapabilities().threads,
    exposesNativeThreadId: true,
    canFork: true,
    canReadSnapshot: true,
  },
  turns: {
    ...disabledCapabilities().turns,
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsSteering: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    ...disabledCapabilities().streaming,
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    emitsMessageCompleted: true,
  },
  tools: {
    ...disabledCapabilities().tools,
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
  },
  approvals: {
    ...disabledCapabilities().approvals,
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: false,
  },
  input: {
    ...disabledCapabilities().input,
    acceptsText: true,
    acceptsImages: true,
    acceptsFiles: false,
    maxAttachments: null,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
};
