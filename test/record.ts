/**
 * Record a real MSP notification transcript from `muse serve`.
 *
 * Usage: bun run test/record.ts <fixture-name> [preset]
 *
 * The recorded frames are replayed by `test/replay.test.ts`, which is the
 * harness guide's recommended way to test projection code: real protocol
 * frames, not hand-written guesses.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { MuseHost } from "../src/index.js";
import { MuseHarnessSession } from "../src/session.js";

const fixture = process.argv[2] ?? "simple";
const preset = process.argv[3] === "none" ? undefined : (process.argv[3] ?? "empty");
const prompt =
  process.argv[4] ?? "Reply with exactly: ok";

await mkdir("test/fixtures", { recursive: true });

const host = await MuseHost.spawn({
  ...(preset === undefined ? {} : { preset }),
  trustWorkspace: true,
  onStderr: (chunk) => process.stderr.write(`[muse] ${chunk}`),
});

const session = await MuseHarnessSession.create(host, {
  sessionId: `record-${fixture}`,
  cwd: process.cwd(),
  ...(process.env.APPROVAL_MODE ? { approvalMode: process.env.APPROVAL_MODE } : {}),
});

const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
const original = session.handleNotification.bind(session);
session.handleNotification = (notification) => {
  notifications.push({ method: notification.method, params: notification.params });
  original(notification);
};

const terminal = new Promise<void>((resolve) => {
  void (async () => {
    for await (const event of session.subscribe()) {
      if (event.type === "turn.terminal" && event.turn.id === "turn-1") {
        resolve();
        return;
      }
    }
  })();
});

await session.startTurn({
  turnId: "turn-1",
  message: { content: [{ type: "text", text: prompt }] },
});

await Promise.race([
  terminal,
  new Promise<void>((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 90_000)),
]);

// Give the host a moment to flush trailing notifications.
await new Promise((resolve) => setTimeout(resolve, 500));

await session.close();
await host.close();

const path = `test/fixtures/${fixture}.jsonl`;
await writeFile(
  path,
  notifications.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
console.log(`recorded ${notifications.length} notifications to ${path}`);
console.log(notifications.map((entry) => entry.method).join(", "));
