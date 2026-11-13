import { describe, expect, test } from "bun:test";
import { MuseHarnessAdapter, MuseHarnessSession } from "../src/index.js";

describe("model selection", () => {
  test(
    "the requested model reaches the session and can be switched",
    async () => {
      const adapter = new MuseHarnessAdapter({
        hostOptions: { preset: "empty", trustWorkspace: true },
      });
      try {
        const session = (await adapter.openSession({
          sessionId: "model-live",
          cwd: process.cwd(),
          model: "muse-spark-1.3",
        })) as MuseHarnessSession;
        expect(session.info.model).toBe("muse-spark-1.3");

        await session.setModel("muse-ember-1.0");
        expect(session.info.model).toBe("muse-ember-1.0");
      } finally {
        await adapter.close();
      }
    },
    { timeout: 120_000 },
  );
});
