import {
  spawnMspConnection,
  type Connection,
  type MuseServeChild,
  type ProcessExit,
} from "@muse-code/sdk";

/** A raw MSP notification, as it arrives on the connection. */
export interface MuseNotification {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** A session that wants to receive the notifications routed to its id. */
export interface NotificationSink {
  /** The native Muse session id notifications are addressed to. */
  readonly sessionId: string;
  handleNotification(notification: MuseNotification): void;
}

export interface MuseHostOptions {
  /** Muse binary path. Defaults to `muse` on PATH. */
  readonly museBin?: string;
  /** Extra arguments for `muse serve`. */
  readonly args?: readonly string[];
  /** Working directory for the host process. */
  readonly cwd?: string;
  /** Environment for the host process. */
  readonly env?: NodeJS.ProcessEnv;
  /** Host preset, for example `empty` (no built-in tools). */
  readonly preset?: string;
  /** Start the host with `--trust-workspace`; required for per-session MCP. */
  readonly trustWorkspace?: boolean;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onStderr?: (chunk: string) => void;
}

/**
 * One `muse serve` process and its raw MSP connection.
 *
 * The host owns the connection and routes notifications to registered sinks by
 * `sessionId`. Server-initiated requests (`approval/request`,
 * `userInput/request`) only need the presentation receipt; the decision or
 * answer travels later as a command.
 */
export class MuseHost {
  readonly connection: Connection;
  readonly initializeResult: { readonly museHome: string };
  readonly exited: Promise<ProcessExit>;
  private readonly child: MuseServeChild;
  private readonly sinks = new Map<string, NotificationSink>();
  private closed = false;

  private constructor(
    connection: Connection,
    initializeResult: { readonly museHome: string },
    child: MuseServeChild,
    exited: Promise<ProcessExit>,
  ) {
    this.connection = connection;
    this.initializeResult = initializeResult;
    this.child = child;
    this.exited = exited;
  }

  static async spawn(options: MuseHostOptions = {}): Promise<MuseHost> {
    // `muse serve` is the MSP host; extra args follow the subcommand.
    const args = ["serve", ...(options.args ?? [])];
    if (options.preset !== undefined) args.push("--preset", options.preset);
    if (options.trustWorkspace === true) args.push("--trust-workspace");

    const handshake = spawnMspConnection({
      command: options.museBin ?? "muse",
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    });

    let spawned;
    try {
      spawned = await handshake.initialize({
        clientInfo: {
          name: options.clientName ?? "opencode_muse",
          version: options.clientVersion ?? "0.1.0",
        },
        capabilities: {
          // Per-session MCP servers (the tool bridge) need this grant.
          requestedCapabilities: ["sessionMcp"],
        },
      });
    } catch (error) {
      await handshake.close().catch(() => undefined);
      throw error;
    }

    const host = new MuseHost(
      spawned.connection,
      spawned.initializeResult,
      spawned.child,
      spawned.exited,
    );
    host.startRouting();
    return host;
  }

  get museHome(): string {
    return this.initializeResult.museHome;
  }

  /** Read the model catalog (`model/list`). */
  async listModels(): Promise<Array<Record<string, unknown>>> {
    const result = await this.connection.request("model/list", {});
    return Array.isArray(result?.models) ? (result.models as Array<Record<string, unknown>>) : [];
  }

  private startRouting(): void {
    this.connection.onNotification((notification) => {
      if (this.closed) return;
      const params = notification.params as Record<string, unknown> | undefined;
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
      if (sessionId === undefined) return;
      this.sinks.get(sessionId)?.handleNotification({ method: notification.method, params });
    });

    // The presentation receipt acknowledges that a surface showed the request.
    // It changes no state; the decision/answer arrives as approval/decide or
    // userInput/answer.
    this.connection.onServerRequest(async () => {
      return {};
    });
  }

  registerSink(sink: NotificationSink): void {
    this.sinks.set(sink.sessionId, sink);
  }

  unregisterSink(sessionId: string): void {
    this.sinks.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close();
  }
}
