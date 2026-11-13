import { describe, expect, test } from "bun:test";
import type { HarnessEvent } from "@rasyid_rafi/opencode-agent-harness-core";
import { MuseHarnessAdapter, MuseHarnessSession } from "../src/index.js";

async function runTurn(
  session: MuseHarnessSession,
  turnId: string,
  text: string,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const terminal = new Promise<HarnessEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("turn timed out")), 90_000);
    void (async () => {
      for await (const event of session.subscribe()) {
        events.push(event);
        if (event.type === "turn.terminal") {
          clearTimeout(timeout);
          resolve(event);
          return;
        }
      }
      clearTimeout(timeout);
      reject(new Error("event stream ended before the turn terminal"));
    })();
  });
  await session.startTurn({ turnId, message: { content: [{ type: "text", text }] } });
  await terminal;
  return events;
}

describe("fork", () => {
  test(
    "a fork is an independent native session that leaves the source usable",
    async () => {
      const adapter = new MuseHarnessAdapter({
        hostOptions: { preset: "empty", trustWorkspace: true },
      });
      try {
        const source = (await adapter.openSession({
          sessionId: "fork-source",
          cwd: process.cwd(),
        })) as MuseHarnessSession;
        await runTurn(source, "source-turn", "Reply with exactly: ok");
        const sourceNative = source.nativeSessionId;

        // A fork starts its own native session instead of reattaching to the
        // source's id, so the source keeps its notification sink. History
        // reseeds as text on the fork's first turn.
        const fork = (await adapter.openSession({
          sessionId: "fork-target",
          cwd: process.cwd(),
        })) as MuseHarnessSession;

        expect(fork.nativeSessionId).not.toBe(sourceNative);

        const forkEvents = await runTurn(fork, "fork-turn", "Reply with exactly: ok");
        const forkTerminal = forkEvents.find((event) => event.type === "turn.terminal");
        expect(forkTerminal?.type === "turn.terminal" ? forkTerminal.turn.status : undefined).toBe("completed");

        // The source session still runs turns on its own native id.
        expect(source.nativeSessionId).toBe(sourceNative);
        const sourceEvents = await runTurn(source, "source-turn-2", "Reply with exactly: ok");
        const sourceTerminal = sourceEvents.find((event) => event.type === "turn.terminal");
        expect(sourceTerminal?.type === "turn.terminal" ? sourceTerminal.turn.status : undefined).toBe(
          "completed",
        );
      } finally {
        await adapter.close();
      }
    },
    { timeout: 180_000 },
  );
});
