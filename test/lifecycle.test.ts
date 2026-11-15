import { describe, expect, test } from "bun:test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { HarnessEvent } from "../src/contract/index.js";
import {
  HEADERS,
  LiveSession,
  MuseHarnessAdapter,
  MuseHarnessSession,
  MuseLanguageModel,
  MuseSessionRegistry,
  toToolResult,
  type MuseNotification,
  type SessionHost,
} from "../src/index.js";

interface RecordedCommand {
  method: string;
  params: Record<string, unknown>;
}

interface FakeHost {
  host: SessionHost;
  commands: RecordedCommand[];
}

/** A host that records commands and answers from a fixed method -> result map. */
function fakeHost(results: Record<string, Record<string, unknown>> = {}): FakeHost {
  const commands: RecordedCommand[] = [];
  let counter = 0;
  const host: SessionHost = {
    connection: {
      mintCommandId: () => `cmd-${counter++}`,
      command: async (method: string, params: Record<string, unknown>) => {
        commands.push({ method, params });
        return results[method] ?? {};
      },
    },
    registerSink: () => {},
    unregisterSink: () => {},
  };
  return { host, commands };
}

/** Subscribe, run `body`, then close and return every event in stream order. */
async function drive(session: MuseHarnessSession, body: () => Promise<void>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const collecting = (async () => {
    for await (const event of session.subscribe()) events.push(event);
  })();
  await body();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.close();
  await collecting;
  return events;
}

function fakeController(): {
  parts: LanguageModelV3StreamPart[];
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
  closed: () => boolean;
} {
  const parts: LanguageModelV3StreamPart[] = [];
  let closed = false;
  return {
    parts,
    controller: {
      enqueue: (part: LanguageModelV3StreamPart) => {
        parts.push(part);
      },
      close: () => {
        closed = true;
      },
    } as unknown as ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    closed: () => closed,
  };
}

describe("MuseHarnessSession construction", () => {
  test("a fork starts a fresh native session instead of reusing the source id", async () => {
    // A server-side fork inherits the source's MCP bridge, so the registry
    // never issues one: the fork starts fresh and reseeds history as text.
    const opened: Record<string, unknown>[] = [];
    const adapter = {
      listModels: async () => [],
      openSession: async (input: Record<string, unknown>) => {
        opened.push(input);
        return MuseHarnessSession.fromNativeSession(
          fakeHost().host,
          { sessionId: input.sessionId as string, cwd: input.cwd as string },
          "fresh-native",
        );
      },
    } as unknown as MuseHarnessAdapter;
    const registry = new MuseSessionRegistry(adapter);
    const live = await registry.get("oc-fork", "/tmp", "oc-source", "muse-spark-1.3");
    try {
      expect(opened[0]).not.toHaveProperty("resumeSessionId");
      expect(opened[0]).not.toHaveProperty("forkSessionId");
      expect(opened[0]).toMatchObject({ model: "muse-spark-1.3" });
      expect(live.takeFullSeed()).toBe(true);
    } finally {
      await registry.close("oc-fork");
    }
  });

  test("a resume keeps the native id and forwards the model", async () => {
    const { host, commands } = fakeHost({
      "session/resume": { session: { sessionId: "source-native", modelId: "muse-ember-1.0" } },
    });
    const session = await MuseHarnessSession.create(host, {
      sessionId: "oc-resume",
      cwd: "/tmp",
      resumeSessionId: "source-native",
      model: "muse-ember-1.0",
    });
    expect(commands[0]?.method).toBe("session/resume");
    expect(commands[0]?.params.modelId).toBe("muse-ember-1.0");
    expect(session.nativeSessionId).toBe("source-native");
    await session.close();
  });

  test("a fresh start forwards the model", async () => {
    const { host, commands } = fakeHost({
      "session/start": { session: { sessionId: "fresh-native", modelId: "muse-spark-1.3" } },
    });
    const session = await MuseHarnessSession.create(host, {
      sessionId: "oc-start",
      cwd: "/tmp",
      model: "muse-spark-1.3",
    });
    expect(commands[0]?.method).toBe("session/start");
    expect(commands[0]?.params.modelId).toBe("muse-spark-1.3");
    await session.close();
  });
});

describe("MuseHarnessSession turns", () => {
  test("startTurn is pending until turn/started confirms it", async () => {
    const { host } = fakeHost({ "turn/start": { turnId: "native-turn" } });
    const session = MuseHarnessSession.fromNativeSession(host, { sessionId: "oc", cwd: "/tmp" }, "native");
    const events = await drive(session, async () => {
      const turn = await session.startTurn({
        turnId: "t1",
        message: { content: [{ type: "text", text: "hi" }] },
      });
      expect(turn.status).toBe("pending");
      session.handleNotification({
        method: "turn/started",
        params: { turnId: "native-turn", sessionId: "native" },
      } satisfies MuseNotification);
    });
    const started = events.find((event) => event.type === "turn.started");
    expect(started?.type === "turn.started" ? started.turn.status : undefined).toBe("running");
  });

  test("approval/updated refreshes the choices and requirement", async () => {
    const { host, commands } = fakeHost({ "approval/decide": { status: "accepted" } });
    const session = MuseHarnessSession.fromNativeSession(host, { sessionId: "oc", cwd: "/tmp" }, "native");
    const events = await drive(session, async () => {
      session.handleNotification({
        method: "approval/requested",
        params: {
          approvalId: "ap1",
          sessionId: "native",
          turnId: "t1",
          currentRequirementId: { approvalId: "ap1", sourceIndex: 0 },
          availableChoices: [{ choiceId: "allow", label: "Allow" }],
        },
      } satisfies MuseNotification);
      session.handleNotification({
        method: "approval/updated",
        params: {
          approvalId: "ap1",
          sessionId: "native",
          currentRequirementId: { approvalId: "ap1", sourceIndex: 1 },
          availableChoices: [{ choiceId: "allow-stage-2", label: "Allow stage 2" }],
        },
      } satisfies MuseNotification);
      await session.respondToRequest({
        requestId: "ap1",
        decision: "accept",
        optionId: "allow-stage-2",
      });
    });
    const updated = events.filter((event) => event.type === "request.updated");
    const last = updated[updated.length - 1];
    expect(last?.type === "request.updated" ? last.request.options : undefined).toEqual([
      { id: "allow-stage-2", label: "Allow stage 2" },
    ]);
    const decide = commands.find((entry) => entry.method === "approval/decide");
    expect(decide?.params).toMatchObject({
      approvalId: "ap1",
      choiceId: "allow-stage-2",
      requirementId: { approvalId: "ap1", sourceIndex: 1 },
    });
  });

  test("setModel issues session/setModel and updates the info", async () => {
    const { host, commands } = fakeHost({
      "session/setModel": { status: "accepted" },
    });
    const session = MuseHarnessSession.fromNativeSession(
      host,
      { sessionId: "oc", cwd: "/tmp", model: "muse-spark-1.3" },
      "native",
      "muse-spark-1.3",
    );
    await session.setModel("muse-ember-1.0");
    const command = commands.find((entry) => entry.method === "session/setModel");
    expect(command?.params).toMatchObject({
      sessionId: "native",
      model: { modelId: "muse-ember-1.0" },
    });
    expect(session.info.model).toBe("muse-ember-1.0");
    await session.close();
  });
});

describe("LiveSession step settling", () => {
  test("a finish buffered while detached closes the next step", async () => {
    const { host } = fakeHost({ "turn/start": { turnId: "native-turn" } });
    const session = MuseHarnessSession.fromNativeSession(host, { sessionId: "oc", cwd: "/tmp" }, "native");
    const live = new LiveSession("oc", session);
    try {
      // A cancelled step detached its controller, so the finish queued.
      live.endStep("stop");
      const step = fakeController();
      live.attach(step.controller);
      expect(step.parts.some((part) => part.type === "finish")).toBe(true);
      expect(step.closed()).toBe(true);
    } finally {
      await live.close();
    }
  });

  test("a step with no turn running settles at once", async () => {
    const { host } = fakeHost();
    const session = MuseHarnessSession.fromNativeSession(host, { sessionId: "oc", cwd: "/tmp" }, "native");
    const live = new LiveSession("oc", session);
    try {
      const step = fakeController();
      live.attach(step.controller);
      expect(step.parts.some((part) => part.type === "finish")).toBe(true);
      expect(step.closed()).toBe(true);
    } finally {
      await live.close();
    }
  });

  test("a user message that arrives mid-turn is steered, not dropped", async () => {
    const { host, commands } = fakeHost({
      "turn/start": { turnId: "native-turn" },
      "turn/steer": { status: "accepted" },
    });
    const session = MuseHarnessSession.fromNativeSession(host, { sessionId: "oc", cwd: "/tmp" }, "native");
    const adapter = {
      listModels: async () => [],
      openSession: async () => session,
    } as unknown as MuseHarnessAdapter;
    const registry = new MuseSessionRegistry(adapter);
    const model = new MuseLanguageModel("muse-spark-1.3", {}, registry, "muse");
    const request = (messages: unknown[]) =>
      ({
        prompt: messages,
        tools: [],
        headers: {
          [HEADERS.kind]: "primary",
          [HEADERS.session]: "oc",
          [HEADERS.directory]: "/tmp",
        },
      }) as unknown as LanguageModelV3CallOptions;

    const first = await model.doStream(
      request([
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "first" }] },
      ]),
    );
    const second = await model.doStream(
      request([
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "working" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ]),
    );

    const steer = commands.find((entry) => entry.method === "turn/steer");
    expect(steer?.params).toMatchObject({ expectedTurnId: "native-turn" });
    await first.stream.cancel();
    await second.stream.cancel();
  });

  test("a turn that ends with pending tool calls still settles the step", async () => {
    const { host } = fakeHost({ "turn/start": { turnId: "native-turn" } });
    const session = MuseHarnessSession.fromNativeSession(host, { sessionId: "oc", cwd: "/tmp" }, "native");
    const live = new LiveSession("oc", session);
    try {
      await session.startTurn({ turnId: "t1", message: { content: [{ type: "text", text: "hi" }] } });
      session.handleNotification({
        method: "turn/started",
        params: { turnId: "native-turn", sessionId: "native" },
      } satisfies MuseNotification);
      live.setActiveTurn(true, "t1");

      // The bridge registers the parked call before emitting it.
      live.pending.set("tc1", {
        id: "tc1",
        name: "lookup",
        input: { q: "x" },
        resolve: () => {},
        reject: () => {},
      });
      live.emitToolCall({ toolCallId: "tc1", toolName: "lookup", input: { q: "x" } });
      expect(live.pendingCount()).toBe(1);

      session.handleNotification({
        method: "turn/completed",
        params: { turnId: "native-turn", sessionId: "native", terminal: "failed" },
      } satisfies MuseNotification);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(live.pendingCount()).toBe(0);
      expect(live.hasActiveTurn).toBe(false);
      const step = fakeController();
      live.attach(step.controller);
      expect(step.parts.some((part) => part.type === "finish")).toBe(true);
      expect(step.closed()).toBe(true);
    } finally {
      await live.close();
    }
  });
});

describe("toToolResult", () => {
  test("error-text keeps its message instead of stringifying the envelope", () => {
    const result = toToolResult({
      toolCallId: "tc1",
      toolName: "bash",
      output: { type: "error-text", value: "command failed" },
    });
    expect(result.content).toEqual([{ type: "text", text: "command failed" }]);
    expect(result.isError).toBe(true);
  });

  test("execution-denied reports the reason", () => {
    const result = toToolResult({
      toolCallId: "tc1",
      toolName: "bash",
      output: { type: "execution-denied", reason: "user declined" },
    });
    expect(result.content).toEqual([{ type: "text", text: "user declined" }]);
    expect(result.isError).toBe(true);
  });

  test("text and json outputs pass through", () => {
    expect(
      toToolResult({ toolCallId: "tc1", toolName: "t", output: { type: "text", value: "ok" } }).content,
    ).toEqual([{ type: "text", text: "ok" }]);
    expect(
      toToolResult({ toolCallId: "tc1", toolName: "t", output: { type: "json", value: { a: 1 } } }).content,
    ).toEqual([{ type: "text", text: '{"a":1}' }]);
  });
});
