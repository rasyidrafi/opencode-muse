import type { HarnessCapabilities } from "./capabilities.js";
import type { HarnessContentBlock, HarnessSnapshot, HarnessSessionInfo, HarnessTurn } from "./entities.js";
import type { HarnessEvent } from "./events.js";
import type { HarnessToolBridge } from "./tool-bridge.js";
export interface HarnessAdapterInfo {
    /** Stable adapter id, for example `muse` or `antigravity`. */
    readonly id: string;
    readonly label: string;
    readonly version?: string;
}
/** A user message sent to the harness. */
export interface HarnessUserMessage {
    readonly content: ReadonlyArray<HarnessContentBlock>;
}
export interface OpenSessionInput {
    /** Host-assigned session id. The adapter echoes it in `HarnessSessionInfo`. */
    readonly sessionId: string;
    readonly cwd: string;
    readonly model?: string | null;
    /** Tools the host is making available to the harness for this session. */
    readonly toolBridge?: HarnessToolBridge;
    readonly env?: Record<string, string>;
    /** Resume material from a previous session, when supported. */
    readonly resumeFrom?: HarnessSnapshot;
    readonly signal?: AbortSignal;
}
export interface StartTurnInput {
    /** Host-assigned turn id. The adapter echoes it in `HarnessTurn`. */
    readonly turnId: string;
    readonly message: HarnessUserMessage;
    readonly model?: string | null;
    /** Overrides the session tool bridge for this turn. */
    readonly toolBridge?: HarnessToolBridge;
    readonly signal?: AbortSignal;
}
export interface InterruptTurnInput {
    readonly turnId: string;
    readonly reason?: string;
}
export interface SteerTurnInput {
    readonly turnId: string;
    readonly message: HarnessUserMessage;
}
export type HarnessApprovalDecision = "accept" | "accept_for_session" | "accept_always" | "decline" | "cancel";
/**
 * Answer to a runtime request. `optionId` must be one of the ids the harness
 * supplied in `HarnessRuntimeRequest.options`; the adapter translates it to the
 * harness's own decision.
 */
export interface HarnessRequestResponse {
    readonly requestId: string;
    readonly decision?: HarnessApprovalDecision;
    readonly optionId?: string;
    readonly feedback?: string;
    readonly answers?: Record<string, unknown>;
}
/**
 * A harness adapter translates one external agent harness into the shared
 * contract. It is the only place where harness-specific protocol details live.
 */
export interface HarnessAdapter {
    readonly info: HarnessAdapterInfo;
    /**
     * Capabilities must be honest and stable for the lifetime of the adapter
     * instance. Hosts read them before using optional operations.
     */
    getCapabilities(): Promise<HarnessCapabilities> | HarnessCapabilities;
    openSession(input: OpenSessionInput): Promise<HarnessSession>;
}
/**
 * A live harness session. Events are broadcast: every call to `subscribe()`
 * starts a new independent consumer.
 */
export interface HarnessSession {
    readonly id: string;
    readonly info: HarnessSessionInfo;
    /**
     * Subscribe to the normalized event stream. Consumers must subscribe before
     * starting turns if they need the full stream; events emitted before a
     * subscription are not replayed.
     */
    subscribe(): AsyncIterable<HarnessEvent>;
    startTurn(input: StartTurnInput): Promise<HarnessTurn>;
    /**
     * Interrupt a running turn. Required; adapters that cannot interrupt must
     * declare `turns.supportsInterrupt: false` and reject with an
     * `unsupported` HarnessError.
     */
    interruptTurn(input: InterruptTurnInput): Promise<void>;
    /**
     * Answer an approval/question. Required when the harness can emit runtime
     * requests; adapters that cannot must declare the matching approval
     * capability `false`.
     */
    respondToRequest(input: HarnessRequestResponse): Promise<void>;
    /** Optional active steering; requires `turns.supportsSteering`. */
    steerTurn?(input: SteerTurnInput): Promise<void>;
    /** Optional snapshot; requires `threads.canReadSnapshot`. */
    getSnapshot?(): Promise<HarnessSnapshot>;
    close(): Promise<void>;
}
