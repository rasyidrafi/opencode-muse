# opencode-muse

Run [Muse Code](https://dev.meta.ai/docs/muse-code) inside
[OpenCode](https://opencode.ai) through the harness-agnostic adapter contract
from [`opencode-agent-harness`](../opencode-agent-harness).

## How it works

```text
OpenCode (owns the agent loop)
  └─ plugin opencode-muse
       └─ LanguageModelV3 (Muse is the model)
            └─ HarnessAdapter → @muse-code/sdk → muse serve (MSP)
```

The plugin registers a `muse` provider and supplies its AI SDK
(`ctx.aisdk.hook("sdk")`), so OpenCode treats Muse Code as a **language model**.
OpenCode owns the loop, the conversation, and every tool call:

- Muse runs its turn and calls OpenCode's tools through a per-session MCP bridge.
- Each tool call is emitted as an AI SDK `tool-call` part; **OpenCode executes
  it** with its own permission system, then feeds the result back on the next
  step. This is the same architecture as OpenCode's built-in Claude Code
  provider.
- Approval, questions, compaction, titles, forking, resuming, agent prompts,
  and images all work because OpenCode owns the loop.

## Requirements

| | |
| --- | --- |
| OpenCode | v2.2+ |
| Muse Code CLI | 1.4.x, signed in (`muse login`) |
| Node / Bun | Node >= 22, or Bun >= 1.4 |
| OS | Linux, macOS |

## Install

```sh
opencode plugin add @rasyid_rafi/opencode-muse
```

or from a local checkout:

```sh
git clone https://github.com/rasyidrafi/opencode-muse.git
```

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/absolute/path/to/opencode-muse" }],
}
```

Then run:

```sh
opencode run --model muse/muse-spark-1.3 "Summarize this repository"
```

## Configuration

Environment variables read by the plugin:

| Variable | Default | Description |
| --- | --- | --- |
| `MUSE_BIN` | `muse` | Muse Code binary. |
| `MUSE_PRESET` | _(host default)_ | Host preset. Set `empty` to run with no built-in tools. |

Example — run Muse with no built-in tools (custom MCP tools only):

```sh
MUSE_PRESET=empty opencode run --model muse/muse-spark-1.3 "..."
```

Custom tools for Muse are configured on the Muse side, not in OpenCode:

```sh
muse mcp add my-tools --project -- node /path/to/mcp-server.js
```

With `MUSE_PRESET=empty`, Muse starts with no built-in tools and uses only the
MCP servers you configured. The per-session MCP server requires
`--trust-workspace`, which the plugin always passes.

## Permissions, approval, and questions

The plugin does not build its own approval or question flow. Every tool Muse
calls is an **OpenCode tool**, executed by OpenCode's own executor, so OpenCode's
permission system applies unchanged.

- Each OpenCode tool calls `permission.assert(...)` inside its own `execute`.
  The bridge forwards the call, so the check runs with the session's rules and
  prompts the user when a rule says `ask`.
- Questions are the OpenCode `question` tool. It is permission-gated
  (`action: "question"`) and renders an OpenCode form. If the agent allows it,
  it is exposed to Muse like any other tool.

Which tools reach Muse is exactly the agent's permission set. For example, the
`my-opencode` policy sets `question: "deny"`, so `question` is not offered to
Muse; change that rule to `allow` and Muse can ask the user directly.

## Development

```sh
bun install
bun run check      # tsc --noEmit && bun test
bun test           # unit, conformance, replay, tool bridge
bun run build      # emit dist/ types
```

Record a fresh MSP transcript for the replay tests:

```sh
bun run test/record.ts simple empty "Reply with exactly: ok"
APPROVAL_MODE=allowAll bun run test/record.ts tool none "Run: echo hi"
```

## Layout

```text
src/
  capabilities.ts     observed Muse capabilities
  host.ts             spawn/supervise muse serve, raw MSP connection
  events.ts           MSP status/failure/usage mapping
  session.ts          MuseHarnessSession: MSP -> HarnessEvent
  adapter.ts          MuseHarnessAdapter
  bridge.ts           per-session MCP tool bridge
  prompt.ts           LanguageModelV3 prompt extraction (text, images, tools)
  convert.ts          HarnessEvent -> AI SDK stream parts
  session-registry.ts live sessions, parked tool calls, resume/fork
  language-model.ts   Muse as a LanguageModelV3
  shared.ts           registry singleton shared with the plugin
  plugin.ts           OpenCode plugin: provider, AI SDK, hooks
test/
  conformance.test.ts  shared contract conformance against a real host
  replay.test.ts       recorded MSP transcripts
  tool-bridge.test.ts  live tool bridge round trip
  record.ts            transcript recorder
  fixtures/            recorded MSP transcripts
docs/
  research.md          research, protocol mapping, and architecture audit
```

## Status

The plugin passes the shared conformance suite for simple turns and the tool
bridge, and runs real turns end to end with OpenCode owning the loop. See
[`docs/research.md`](docs/research.md) for the protocol mapping, capabilities,
and the architecture audit that motivated this design.
