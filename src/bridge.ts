import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { HarnessToolBridge } from "@opencode-agent-harness/core";

/**
 * The tool bridge is how OpenCode's own tools become available to Muse.
 *
 * Muse spawns or connects to MCP servers declared at `session/start`. This
 * module exposes the host's `HarnessToolBridge` as a streamable-HTTP MCP
 * server scoped to one session: the URL carries an unguessable bearer token,
 * and every `tools/call` is forwarded to `bridge.callTool` unchanged.
 */

export interface ToolBridgeServer {
  /** The streamable-HTTP endpoint Muse should connect to. */
  readonly url: string;
  /** Bearer token Muse must present. */
  readonly token: string;
  /** The MCP session id issued at initialize. */
  readonly sessionId: string | null;
  close(): Promise<void>;
}

/** The MCP server name this bridge is declared under in `mcpServers`. */
export const BRIDGE_MCP_SERVER_NAME = "opencode";

/** Muse prefixes MCP tool names with `mcp__<server>__`; the host knows its own tools. */
export function normalizeToolName(name: string): string {
  const prefix = `mcp__${BRIDGE_MCP_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function readBody(request: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error("MCP request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function handleMessage(
  message: Record<string, unknown>,
  bridge: HarnessToolBridge,
  sessionId: string | null,
): Promise<Record<string, unknown> | null> {
  const method = typeof message.method === "string" ? message.method : "";
  const id = message.id;

  if (method === "initialize") {
    const issued = randomBytes(16).toString("hex");
    const params = (message.params ?? {}) as Record<string, unknown>;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-muse-bridge", version: "0.1.0" },
      },
      // The session id travels in the Mcp-Session-Id header, not the body.
      ...(sessionId === null ? {} : {}),
      __sessionId: issued,
    } as unknown as Record<string, unknown>;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }

  if (method === "tools/list") {
    const tools = await bridge.listTools();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const rawName = typeof params.name === "string" ? params.name : "";
    const name = normalizeToolName(rawName);
    const input =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await bridge.callTool({ id: randomUUID(), name, input });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
        },
      };
    } catch (error) {
      // A failing host tool is a tool error, not a protocol error: the model
      // can correct.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        },
      };
    }
  }

  if (id !== undefined) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  return null;
}

/**
 * Start a loopback MCP server that forwards to `bridge`.
 *
 * The endpoint is bound to 127.0.0.1 on an ephemeral port and protected by a
 * random bearer token, so it cannot be reached or guessed by another session.
 */
export async function startToolBridgeServer(bridge: HarnessToolBridge): Promise<ToolBridgeServer> {
  const token = randomBytes(32).toString("hex");
  let mcpSessionId: string | null = null;
  let issuedSessionId: string | null = null;

  const server = createServer((request, response) => {
    void handleRequest(request, response, bridge, token, () => mcpSessionId, (value) => {
      mcpSessionId = value;
    }, () => issuedSessionId, (value) => {
      issuedSessionId = value;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    get sessionId() {
      return issuedSessionId;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bridge: HarnessToolBridge,
  token: string,
  getSession: () => string | null,
  setSession: (value: string) => void,
  getIssued: () => string | null,
  setIssued: (value: string) => void,
): Promise<void> {
  if (request.method === "GET") {
    // The streamable-HTTP transport may open a server-to-client SSE stream.
    // The bridge has no server-initiated messages, so it is not needed.
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "GET is not supported" }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    response.writeHead(413, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "bad request" }));
    return;
  }

  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    message = parsed as Record<string, unknown>;
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }

  const result = await handleMessage(message, bridge, getSession());
  if (result === null) {
    response.writeHead(202);
    response.end();
    return;
  }

  // Recover the session id the handler minted for initialize.
  const minted = (result as Record<string, unknown> & { __sessionId?: string }).__sessionId;
  if (typeof minted === "string") {
    setSession(minted);
    setIssued(minted);
    delete (result as Record<string, unknown> & { __sessionId?: string }).__sessionId;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const sessionId = getIssued();
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;

  response.writeHead(200, headers);
  response.end(JSON.stringify(result));
}
