/**
 * Shared harness contract conformance suite, vendored from
 * `@rasyid_rafi/opencode-agent-harness-core/testing`. Runs the scenarios that
 * the adapter's declared capabilities allow.
 */
import type {
  HarnessAdapter,
  HarnessSession,
  OpenSessionInput,
  HarnessToolBridge,
  HarnessEvent,
} from "../../src/contract/index.js";
import { isHarnessError } from "../../src/contract/index.js";
import { assertCapabilitiesShape, assertTurnEventContract } from "./assertions.js";

/**
 * Harness-specific glue for the conformance suite. Each adapter author
 * implements this to drive their harness through the shared scenarios.
 */
export interface HarnessConformanceDriver {
  /** Start a turn the harness will complete on its own. */
  startSimpleTurn(session: HarnessSession, turnId: string): Promise<void>;
  /** Start a turn the harness keeps running until interrupted. */
  startLongTurn?(session: HarnessSession, turnId: string): Promise<void>;
  /** Start a turn that makes the harness raise an approval request. */
  startApprovalTurn?(session: HarnessSession, turnId: string): Promise<void>;
  /** Start a turn that makes the harness call a tool through the bridge. */
  startToolTurn?(session: HarnessSession, turnId: string): Promise<void>;
}

export interface HarnessConformanceOptions {
  readonly adapter: HarnessAdapter;
  readonly driver: HarnessConformanceDriver;
  readonly toolBridge?: HarnessToolBridge;
  readonly openSession?: Partial<OpenSessionInput>;
  readonly timeoutMs?: number;
}

export interface ConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export interface ConformanceResult {
  readonly checks: ReadonlyArray<ConformanceCheck>;
  readonly success: boolean;
}

interface Waiter {
  predicate: (event: HarnessEvent) => boolean;
  resolve: (event: HarnessEvent) => void;
}

/** Collects a broadcast event stream and lets tests wait for conditions. */
export class EventCollector {
  readonly events: HarnessEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private done = false;

  async start(iterable: AsyncIterable<HarnessEvent>): Promise<void> {
    try {
      for await (const event of iterable) {
        this.events.push(event);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(event))
            waiter.resolve(event);
        }
      }
    }
    finally {
      this.done = true;
    }
  }

  waitFor(predicate: (event: HarnessEvent) => boolean, timeoutMs: number): Promise<HarnessEvent> {
    const existing = this.events.find(predicate);
    if (existing)
      return Promise.resolve(existing);
    if (this.done)
      return Promise.reject(new Error("event stream ended before the condition was met"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let waiter: Waiter;
      const timer = setTimeout(() => {
        if (settled)
          return;
        settled = true;
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error("timed out waiting for an event"));
      }, timeoutMs);
      waiter = {
        predicate,
        resolve: (event) => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timer);
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          resolve(event);
        },
      };
      this.waiters.push(waiter);
    });
  }
}

function isTerminalFor(turnId: string) {
  return (event: HarnessEvent) => event.type === "turn.terminal" && event.turn.id === turnId;
}

/**
 * Run the shared conformance scenarios against a harness adapter. This checks
 * the contract's observable behavior; it does not prove that the harness
 * honors its own capabilities under every condition. Adapter-specific tests
 * should add replay fixtures for those.
 */
export async function runHarnessConformance(options: HarnessConformanceOptions): Promise<ConformanceResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const checks: ConformanceCheck[] = [];

  async function record(name: string, scenario: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    try {
      await scenario();
      checks.push({ name, passed: true, durationMs: Date.now() - startedAt });
    }
    catch (error) {
      checks.push({
        name,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const capabilities = await options.adapter.getCapabilities();
  await record("capabilities shape", async () => {
    assertCapabilitiesShape(capabilities);
  });

  let opened: HarnessSession | undefined;
  await record("open session", async () => {
    opened = await options.adapter.openSession({
      sessionId: "conformance",
      cwd: process.cwd(),
      toolBridge: options.toolBridge,
      ...options.openSession,
    });
  });
  if (!opened)
    return { checks, success: false };
  const session = opened;

  const collector = new EventCollector();
  const collecting = collector.start(session.subscribe());

  await record("simple turn", async () => {
    await options.driver.startSimpleTurn(session, "turn-simple");
    await collector.waitFor(isTerminalFor("turn-simple"), timeoutMs);
    assertTurnEventContract(collector.events, "turn-simple");
  });

  const startLongTurn = options.driver.startLongTurn;
  if (capabilities.turns.supportsInterrupt && startLongTurn) {
    await record("interrupt turn", async () => {
      await startLongTurn(session, "turn-interrupt");
      await collector.waitFor((event) => event.type === "turn.started" && event.turn.id === "turn-interrupt", timeoutMs);
      await session.interruptTurn({ turnId: "turn-interrupt" });
      const terminal = await collector.waitFor(isTerminalFor("turn-interrupt"), timeoutMs);
      if (terminal.type !== "turn.terminal")
        throw new Error("expected a turn.terminal event");
      if (terminal.turn.status !== "interrupted" && terminal.turn.status !== "cancelled") {
        throw new Error(`expected interrupted or cancelled, got ${terminal.turn.status}`);
      }
      assertTurnEventContract(collector.events, "turn-interrupt");
    });
  }

  const startApprovalTurn = options.driver.startApprovalTurn;
  if (capabilities.approvals.supportsCommandApproval && startApprovalTurn) {
    await record("approval request", async () => {
      await startApprovalTurn(session, "turn-approval");
      const request = await collector.waitFor((event) => event.type === "request.updated" &&
        event.request.turnId === "turn-approval" &&
        event.request.status === "pending", timeoutMs);
      if (request.type !== "request.updated")
        throw new Error("expected a request.updated event");
      await session.respondToRequest({
        requestId: request.request.id,
        decision: "accept",
        ...(request.request.options?.[0] ? { optionId: request.request.options[0].id } : {}),
      });
      await collector.waitFor(isTerminalFor("turn-approval"), timeoutMs);
      assertTurnEventContract(collector.events, "turn-approval");
    });
  }

  const startToolTurn = options.driver.startToolTurn;
  if (capabilities.tools.supportsMcpTools && startToolTurn && options.toolBridge) {
    await record("tool bridge", async () => {
      await startToolTurn(session, "turn-tool");
      const completed = await collector.waitFor((event) => event.type === "tool.completed" && event.item.turnId === "turn-tool", timeoutMs);
      if (completed.type !== "tool.completed")
        throw new Error("expected a tool.completed event");
      if (completed.item.status !== "completed") {
        throw new Error(`tool call failed: ${completed.item.error ?? completed.item.status}`);
      }
      await collector.waitFor(isTerminalFor("turn-tool"), timeoutMs);
      assertTurnEventContract(collector.events, "turn-tool");
    });
  }

  await record("close", async () => {
    await session.close();
    let rejected = false;
    try {
      await session.startTurn({ turnId: "after-close", message: { content: [] } });
    }
    catch (error) {
      rejected = isHarnessError(error) && error.code === "session_stopped";
    }
    if (!rejected) {
      throw new Error("startTurn after close did not reject with session_stopped");
    }
  });

  await collecting;
  return { checks, success: checks.every((check) => check.passed) };
}
