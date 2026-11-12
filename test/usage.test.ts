import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  allImages,
  fullConversationText,
  MuseHarnessSession,
  toAIUsage,
  toTokenUsage,
  type MuseNotification,
  type SessionHost,
} from "../src/index.js";

function fakeHost(): SessionHost {
  return {
    connection: {
      mintCommandId: () => "cmd-usage",
      command: async () => ({}),
    },
    registerSink: () => {},
    unregisterSink: () => {},
  };
}

async function replayFrames(frames: MuseNotification[]) {
  const session = MuseHarnessSession.fromNativeSession(
    fakeHost(),
    { sessionId: "usage", cwd: "/tmp" },
    "native-session",
  );
  const events: unknown[] = [];
  const collecting = (async () => {
    for await (const event of session.subscribe()) events.push(event);
  })();
  for (const frame of frames) session.handleNotification(frame);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.close();
  await collecting;
  return { session, events };
}

async function replayFixture(name: string) {
  const text = await readFile(`test/fixtures/${name}.jsonl`, "utf8");
  const frames = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MuseNotification);
  return replayFrames(frames);
}

function terminalOf(events: unknown[]) {
  const terminal = events.find(
    (event): event is { type: "turn.terminal"; turn: { tokenUsage?: Record<string, number | undefined> } } =>
      (event as { type?: string }).type === "turn.terminal",
  );
  if (!terminal) throw new Error("expected a turn.terminal event");
  return terminal.turn.tokenUsage;
}

describe("usage accounting", () => {
  test("toTokenUsage maps split cache counters", () => {
    expect(
      toTokenUsage({ inputTokens: 100, outputTokens: 10, reasoningTokens: 2, cachedTokens: 60 }),
    ).toEqual({ inputTokens: 100, outputTokens: 10, reasoningTokens: 2, cachedInputTokens: 60, totalTokens: 110 });
    expect(
      toTokenUsage({ inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cachedTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 5 }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: 0,
      cachedInputTokens: 40,
      cacheWriteTokens: 5,
      totalTokens: 110,
    });
    expect(toTokenUsage(undefined)).toBeUndefined();
    expect(toTokenUsage(null)).toBeUndefined();
  });

  test("toAIUsage splits fresh and cached input, and text and reasoning output", () => {
    expect(toAIUsage({})).toEqual({
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    });
    expect(
      toAIUsage({ inputTokens: 34751, cachedInputTokens: 34417, outputTokens: 549, reasoningTokens: 453 }),
    ).toEqual({
      inputTokens: { total: 34751, noCache: 334, cacheRead: 34417, cacheWrite: undefined },
      outputTokens: { total: 549, text: 96, reasoning: 453 },
    });
    expect(
      toAIUsage({ inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 10 }),
    ).toEqual({
      inputTokens: { total: 100, noCache: 35, cacheRead: 60, cacheWrite: 5 },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    });
  });

  test("simple turn reports its session/tokenUsage on the terminal", async () => {
    const { events } = await replayFixture("simple");
    expect(terminalOf(events)).toEqual({
      inputTokens: 18721,
      outputTokens: 17,
      reasoningTokens: 7,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 18738,
    });
  });

  test("multi-completion turn keeps the last context and sums completions", async () => {
    const { events } = await replayFixture("tool");
    expect(terminalOf(events)).toEqual({
      inputTokens: 34751,
      outputTokens: 89 + 309 + 254 + 158 + 549,
      reasoningTokens: 17 + 196 + 185 + 86 + 453,
      cachedInputTokens: 34417,
      cacheWriteTokens: 0,
      totalTokens: 35300,
    });
  });

  test("a repeated report of the same completion is not counted twice", async () => {
    const report = (totalTokens: number, outputTokens: number) => ({
      method: "session/tokenUsage",
      params: {
        turnId: "t1",
        sessionId: "native-session",
        promptTokens: 100,
        totalTokens,
        usage: {
          inputTokens: 100,
          outputTokens,
          reasoningTokens: 1,
          cachedTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });
    const { events } = await replayFrames([
      { method: "turn/started", params: { turnId: "t1", sessionId: "native-session" } },
      report(110, 10),
      report(110, 10),
      { method: "turn/completed", params: { turnId: "t1", sessionId: "native-session", terminal: "completed" } },
    ]);
    expect(terminalOf(events)).toMatchObject({ inputTokens: 100, outputTokens: 10, totalTokens: 110 });
  });

  test("turn/completed usage is the fallback when no tokenUsage arrived", async () => {
    const { events } = await replayFrames([
      { method: "turn/started", params: { turnId: "t1", sessionId: "native-session" } },
      {
        method: "turn/completed",
        params: {
          turnId: "t1",
          sessionId: "native-session",
          terminal: "completed",
          usage: { inputTokens: 50, outputTokens: 5, reasoningTokens: 0, cachedTokens: 0 },
        },
      },
    ]);
    expect(terminalOf(events)).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  test("session/contextUsage is retained on the session", async () => {
    const { session } = await replayFrames([
      {
        method: "session/contextUsage",
        params: { sessionId: "native-session", usedTokens: 18989, windowTokens: 1007997, pressure: "normal" },
      },
    ]);
    expect(session.contextUsage).toEqual({ usedTokens: 18989, windowTokens: 1007997, pressure: "normal" });
  });

  test("prompt helpers reseed a rewritten history", () => {
    const prompt = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ] as never;
    expect(fullConversationText(prompt)).toBe("sys\n\nfirst\n\nsecond");
    expect(allImages([{ role: "user", content: "no files" }] as never)).toEqual([]);
  });
});
