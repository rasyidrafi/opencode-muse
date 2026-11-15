/**
 * Tool bridge: how the host (OpenCode) exposes its own tools to an external
 * harness and how harness tool calls are routed back.
 *
 * The host implements `HarnessToolBridge`. The adapter is responsible for
 * advertising the bridge's tools to its harness through the harness's native
 * mechanism (usually MCP) and for forwarding `tools/call` to `callTool`.
 *
 * A bridge is scoped: the host may change the tool set between turns, so the
 * latest bridge supplied to `openSession`/`startTurn` wins.
 */
export interface HarnessToolDefinition {
    readonly name: string;
    readonly description?: string;
    /** JSON Schema object describing the tool input. */
    readonly inputSchema: Record<string, unknown>;
}
export interface HarnessToolCall {
    /** Host-generated call id, used for logging and correlation. */
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
}
export type HarnessToolContentBlock = {
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
export interface HarnessToolResult {
    readonly content: ReadonlyArray<HarnessToolContentBlock>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
}
export interface HarnessToolBridge {
    listTools(): Promise<HarnessToolDefinition[]> | HarnessToolDefinition[];
    callTool(call: HarnessToolCall): Promise<HarnessToolResult>;
    /** Called when the session/turn no longer needs the bridge. */
    close?(): Promise<void> | void;
}
const TOOL_NAME_PATTERN = /^[\w.-]{1,128}$/;

export function validateToolDefinition(tool: unknown): HarnessToolDefinition {
    if (typeof tool !== "object" || tool === null) {
        throw new TypeError("Tool definition must be an object");
    }
    const candidate = tool as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !TOOL_NAME_PATTERN.test(candidate.name)) {
        throw new TypeError(`Invalid tool name: ${String(candidate.name)}`);
    }
    if (candidate.description !== undefined && typeof candidate.description !== "string") {
        throw new TypeError(`Invalid description for tool ${candidate.name}`);
    }
    if (typeof candidate.inputSchema !== "object" ||
        candidate.inputSchema === null ||
        Array.isArray(candidate.inputSchema)) {
        throw new TypeError(`Invalid inputSchema for tool ${candidate.name}`);
    }
    return {
        name: candidate.name,
        ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
        inputSchema: candidate.inputSchema as Record<string, unknown>,
    };
}

export function textToolResult(text: string, isError = false): HarnessToolResult {
    return { content: [{ type: "text", text }], isError };
}
