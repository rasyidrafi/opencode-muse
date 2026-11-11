import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  assertTurnEventContract,
  assistantText,
  type HarnessEvent,
} from "@opencode-agent-harness/core/testing";
import {
  MuseHarnessSession,
  type SessionHost,
} from "../src/index.js";
import type { MuseNotification } from "../src/index.js";

function fakeHost(): SessionHost {
  return {
    connection: {
      mintCommandId: () => "cmd-fixture",
      command: async () => ({}),
    },
    registerSink: () => {},
    unregisterSink: () => {},
  };
}

async function loadFixture(name: string): Promise<MuseNotification[]> {
  const text = await readFile(`test/fixtures/${name}.jsonl`, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MuseNotification);
}

async function replay(name: string): Promise<HarnessEvent[]> {
  const frames = await loadFixture(name);
  const session = MuseHarnessSession.fromNativeSession(
    fakeHost(),
    { sessionId: "replay", cwd: "/tmp" },
    "native-session",
  );
  const events: HarnessEvent[] = [];
  const collecting = (async () => {
    for await (const event of session.subscribe()) events.push(event);
  })();
  for (const frame of frames) session.handleNotification(frame);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.close();
  await collecting;
  return events;
}

describe("replay: recorded MSP transcripts", () => {
  test("simple turn honors the event contract", async () => {
    const events = await replay("simple");
    const types = events.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.terminal");
    expect(types.filter((type) => type === "turn.terminal")).toHaveLength(1);

    const turnEvents = events.filter(
      (event) =>
        event.type === "turn.started" ||
        event.type === "turn.updated" ||
        event.type === "turn.terminal",
    );
    const started = turnEvents.find((event) => event.type === "turn.started");
    expect(started?.type === "turn.started" ? started.turn.id : undefined).toBeDefined();
    const turnId = (started as { turn: { id: string } }).turn.id;

    assertTurnEventContract(events, turnId);
    expect(assistantText(events, turnId)).toBe("ok");
  });

  test("no event is emitted after the turn terminal", async () => {
    const events = await replay("simple");
    const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
    expect(terminalIndex).toBeGreaterThan(-1);
    // session.updated may follow the terminal (it is not a turn event).
    for (const event of events.slice(terminalIndex + 1)) {
      expect(event.type).toBe("session.updated");
    }
  });

  test("tool calls map to started/delta/completed and settle before the terminal", async () => {
    const events = await replay("tool");
    const started = events.filter((event) => event.type === "tool.started");
    const completed = events.filter((event) => event.type === "tool.completed");
    const deltas = events.filter((event) => event.type === "tool.delta");
    expect(started.length).toBeGreaterThan(0);
    expect(completed.length).toBeGreaterThan(0);
    expect(deltas.length).toBeGreaterThan(0);

    const first = started[0];
    if (first?.type !== "tool.started") throw new Error("expected tool.started");
    expect(first.item.name).toBe("bash");
    expect(first.item.status).toBe("running");
    expect(first.item.input).toEqual({
      command: "echo hello-from-tool",
      description: "Echo hello from tool",
    });

    const turnId = first.item.turnId;
    assertTurnEventContract(events, turnId);

    // Every started tool must settle, and the rejected one maps to cancelled.
    const statuses = completed.map((event) =>
      event.type === "tool.completed" ? event.item.status : undefined,
    );
    expect(statuses).toContain("cancelled");
  });
});
