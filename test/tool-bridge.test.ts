import { describe, expect, test } from "bun:test";
import type { HarnessEvent } from "@rasyid_rafi/opencode-agent-harness-core";
import { MuseHarnessAdapter } from "../src/index.js";

const tools = [
  {
    name: "lookup",
    description: "Look something up",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
    },
  },
];

describe("tool bridge", () => {
  test(
    "Muse calls an OpenCode tool through the per-session MCP server",
    async () => {
      const adapter = new MuseHarnessAdapter({
        hostOptions: { preset: "empty", trustWorkspace: true },
      });
      const bridge = {
        listTools: () => tools,
        callTool: async (call: { name: string; input: Record<string, unknown> }) => ({
          content: [{ type: "text" as const, text: `echo:${call.name}:${JSON.stringify(call.input)}` }],
        }),
      };

      try {
        const session = await adapter.openSession({
          sessionId: "bridge-test",
          cwd: process.cwd(),
          toolBridge: bridge,
        });

        const events: HarnessEvent[] = [];
        const terminal = new Promise<HarnessEvent>((resolve, reject) => {
          void (async () => {
            const timeout = setTimeout(
              () => reject(new Error("turn timed out")),
              90_000,
            );
            try {
              for await (const event of session.subscribe()) {
                events.push(event);
                if (event.type === "turn.terminal") {
                  clearTimeout(timeout);
                  resolve(event);
                  return;
                }
              }
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          })();
        });

        await session.startTurn({
          turnId: "turn-bridge",
          message: {
            content: [
              { type: "text", text: "Use the lookup tool with q=hello, then reply with the result." },
            ],
          },
        });

        const done = await terminal;
        expect(done.type).toBe("turn.terminal");
        if (done.type !== "turn.terminal") throw new Error("expected terminal");
        expect(done.turn.status).toBe("completed");

        const completed = events.filter(
          (event) => event.type === "tool.completed",
        );
        expect(completed.length).toBeGreaterThan(0);
        const first = completed[0];
        if (first?.type !== "tool.completed") throw new Error("expected tool.completed");
        expect(first.item.name).toBe("lookup");
        expect(first.item.status).toBe("completed");
        expect(first.item.output).toContain("echo:lookup");
        expect(first.item.output).toContain("hello");
      } finally {
        await adapter.close();
      }
    },
    { timeout: 120_000 },
  );
});
