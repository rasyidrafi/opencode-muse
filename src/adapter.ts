import type {
  HarnessAdapter,
  HarnessAdapterInfo,
  HarnessCapabilities,
  HarnessSession,
  OpenSessionInput,
} from "@rasyid_rafi/opencode-agent-harness-core";
import { MuseHost, type MuseHostOptions } from "./host.js";
import { MuseHarnessSession, type CreateSessionInput } from "./session.js";
import { MUSE_CAPABILITIES } from "./capabilities.js";

export interface MuseAdapterOptions {
  /** Reuse an existing host instead of spawning one. */
  readonly host?: MuseHost;
  /** Options used when this adapter spawns its own host. */
  readonly hostOptions?: MuseHostOptions;
}

/** OpenCode's open-session input plus Muse-specific resume material. */
export interface MuseOpenSessionInput extends OpenSessionInput {
  /** Native Muse session id to resume instead of starting a new session. */
  readonly resumeSessionId?: string;
}

/**
 * Muse Code adapter for the harness-agnostic contract.
 *
 * The adapter is the only place that knows MSP. It spawns one `muse serve`
 * host per adapter instance (unless a host is injected) and translates every
 * session's native protocol into the normalized event stream.
 */
export class MuseHarnessAdapter implements HarnessAdapter {
  readonly info: HarnessAdapterInfo = {
    id: "muse",
    label: "Muse Code",
    version: "1.4.15",
  };

  private readonly injectedHost: MuseHost | undefined;
  private readonly hostOptions: MuseHostOptions;
  private host: MuseHost | undefined;
  private hostPromise: Promise<MuseHost> | undefined;

  constructor(options: MuseAdapterOptions = {}) {
    this.injectedHost = options.host;
    this.hostOptions = options.hostOptions ?? {};
  }

  getCapabilities(): HarnessCapabilities {
    return MUSE_CAPABILITIES;
  }

  /** Read the Muse model catalog. */
  async listModels(): Promise<Array<Record<string, unknown>>> {
    const host = await this.ensureHost();
    return host.listModels();
  }

  async openSession(input: MuseOpenSessionInput): Promise<HarnessSession> {
    const host = await this.ensureHost();
    const createInput: CreateSessionInput = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      model: input.model,
      ...(input.toolBridge === undefined ? {} : { toolBridge: input.toolBridge }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
    };
    return MuseHarnessSession.create(host, createInput);
  }

  private async ensureHost(): Promise<MuseHost> {
    if (this.injectedHost) return this.injectedHost;
    if (this.host) return this.host;
    if (!this.hostPromise) {
      this.hostPromise = MuseHost.spawn(this.hostOptions).then((host) => {
        this.host = host;
        return host;
      });
    }
    return this.hostPromise;
  }

  /** Close the adapter's own host. Injected hosts stay owned by the caller. */
  async close(): Promise<void> {
    if (this.injectedHost) return;
    const host = this.host ?? (this.hostPromise ? await this.hostPromise.catch(() => undefined) : undefined);
    this.host = undefined;
    this.hostPromise = undefined;
    await host?.close();
  }
}
