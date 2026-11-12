import { describe, expect, test } from "bun:test";
import {
  runHarnessConformance,
  userMessage,
  type HarnessConformanceDriver,
} from "@rasyid_rafi/opencode-agent-harness-core/testing";
import { MuseHarnessAdapter } from "../src/index.js";

/**
 * Harness-specific glue for the shared conformance suite.
 *
 * The scenarios are gated by the adapter's capabilities: this driver provides
 * only `startSimpleTurn`, so the interrupt, approval, and tool-bridge
 * scenarios stay skipped until their drivers are added. That keeps the run
 * deterministic while the adapter is still being built.
 */
const driver: HarnessConformanceDriver = {
  async startSimpleTurn(session, turnId) {
    await session.startTurn({
      turnId,
      message: userMessage("Reply with exactly: ok"),
    });
  },
  async startToolTurn(session, turnId) {
    await session.startTurn({
      turnId,
      message: userMessage("Use the lookup tool with q=hello, then reply with the result."),
    });
  },
};

const toolBridge = {
  listTools: () => [
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
  ],
  callTool: async (call: { name: string; input: Record<string, unknown> }) => ({
    content: [{ type: "text" as const, text: `echo:${call.name}:${JSON.stringify(call.input)}` }],
  }),
};

describe("MuseHarnessAdapter conformance", () => {
  test(
    "passes the shared scenarios against a real muse serve host",
    async () => {
      const adapter = new MuseHarnessAdapter({
        hostOptions: { preset: "empty", trustWorkspace: true },
      });
      try {
        const result = await runHarnessConformance({
          adapter,
          driver,
          toolBridge,
          timeoutMs: 60_000,
        });
        for (const check of result.checks.filter((entry) => !entry.passed)) {
          console.error(`FAIL ${check.name}: ${check.error}`);
        }
        const names = result.checks.map((check) => check.name);
        expect(names).toContain("simple turn");
        expect(names).toContain("tool bridge");
        expect(result.success).toBe(true);
      } finally {
        await adapter.close();
      }
    },
    { timeout: 120_000 },
  );
});
