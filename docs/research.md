# Research: menjalankan Muse Code di dalam OpenCode

Tanggal: 2026-11-11
Versi yang diteliti: Muse Code 1.4.15 (`muse serve`), OpenCode 2.2.6, `@muse-code/sdk` 1.4.15, `@opencode/plugin` 2.2.7.

## 1. Kesimpulan

Muse Code bisa dijalankan di dalam OpenCode sebagai sebuah **OpenCode plugin** yang menjalankan
**adapter harness-agnostic** (`@opencode-agent-harness/core`). Arsitekturnya:

```
OpenCode (TUI / run)
  └─ plugin opencode-muse
       └─ loopback Anthropic Messages proxy
            └─ HarnessAdapter (kontrak harness-agnostic)
                 └─ @muse-code/sdk  →  muse serve (Muse Session Protocol / MSP)
```

- OpenCode hanya melihat sebuah provider Anthropic lokal (persis seperti `opencode-antigrvity`).
- Adapter menormalisasi MSP Muse menjadi `HarnessEvent` sesuai kontrak. Renderer tidak perlu
  mengetahui detail MSP.
- Tool bridge: OpenCode mengeksekusi tool-nya sendiri dan mengeksposnya ke Muse sebagai MCP
  server per-sesi.

Semua jalur kunci di bawah ini diuji live di mesin ini.

## 2. Kontrak harness-agnostic

Sumber: `../opencode-agent-harness` (`docs/contract.md`, `src/`).

| Bagian | Isi |
| --- | --- |
| `HarnessAdapter` | `info`, `getCapabilities()`, `openSession()` |
| `HarnessSession` | `subscribe()`, `startTurn()`, `interruptTurn()`, `respondToRequest()`, `steerTurn?`, `getSnapshot?`, `close()` |
| `HarnessEvent` | `session.updated`, `session.error`, `turn.started`, `turn.updated`, `turn.terminal`, `message.started`, `message.delta`, `message.completed`, `tool.started`, `tool.delta`, `tool.completed`, `request.updated` |
| `HarnessCapabilities` | 8 grup: `sessions`, `threads`, `turns`, `streaming`, `tools`, `approvals`, `input`, `identity` |
| `HarnessError` | kode stabil: `open_failed`, `close_failed`, `session_stopped`, `protocol_error`, `unsupported`, `interrupt_timeout`, `request_failed`, `event_stream_failed`, `usage_limit`, `auth_required`, `invalid_input` |
| `HarnessToolBridge` | `listTools()`, `callTool()`, `close?()` — diimplementasi host, dikonsumsi adapter |
| `HarnessConformanceDriver` | glue harness-spesifik untuk `runHarnessConformance` |

Aturan desain:

1. Capability harus jujur (flag menyala tapi gagal = bug).
2. Event dinormalisasi; host tidak melihat detail protokol harness.
3. Host memegang id sesi/turn; id natif harness bersifat opaque (`HarnessNativeRef`).
4. Operasi opsional digerbang capability, bukan `adapter.info.id`.
5. Terminal bersifat terminal: semua message/tool/request harus diselesaikan sebelum
   `turn.terminal`, dan tidak ada event turn setelah itu.

## 3. Pemetaan MSP → kontrak

### 3.1 Capabilities Muse Code 1.4.15

| Grup | Field | Nilai | Bukti |
| --- | --- | --- | --- |
| sessions | `supportsModelSwitch` | `true` | `session/setModel` |
| sessions | `supportsResume` | `true` | `sessionDurability: "durable"` (live) |
| sessions | `pendingRequestsSurviveRestart` | `true` | persistensi approval + SDK test `facade-persistent-approval` |
| sessions | `maxConcurrentTurns` | `1` | satu foreground turn; sisanya queue |
| threads | `exposesNativeThreadId` | `true` | `sessionId` |
| threads | `canFork` | `true` | `session/fork` |
| threads | `canReadSnapshot` | `true` | `session/read`, `view/page` |
| turns | `exposesNativeTurnId` | `true` | `turnId` UUIDv7 |
| turns | `emitsTurnStarted` | `true` | `turn/started` |
| turns | `emitsTurnCompleted` | `true` | `turn/completed` |
| turns | `supportsInterrupt` | `true` | `turn/interrupt` |
| turns | `supportsSteering` | `true` | `turn/steer` |
| turns | `supportsQueuedMessages` | `true` | `ifBusy: "queue"` |
| turns | `terminalStatusQuality` | `"strong"` | terminal closed enum |
| streaming | `streamsAssistantText` | `true` | `item/delta` field `text` |
| streaming | `streamsReasoning` | `true` | `item/delta` field `summary.N` |
| streaming | `streamsToolOutput` | `true` | `item/delta` field `output` |
| streaming | `emitsMessageCompleted` | `true` | `item/completed` |
| tools | `exposesToolItemIds` | `true` | `itemId` UUIDv7 |
| tools | `emitsToolStarted` | `true` | `item/started` |
| tools | `emitsToolCompleted` | `true` | `item/completed` |
| tools | `emitsToolOutput` | `true` | `item/delta` field `output` |
| tools | `supportsMcpTools` | `true` | `config.mcpServers` + grant `sessionMcp` |
| approvals | `supportsCommandApproval` | `true` | subject `shell` |
| approvals | `supportsFileReadApproval` | `true` | subject `fileAccess` (`read`) |
| approvals | `supportsFileChangeApproval` | `true` | subject `fileAccess` (`write`) |
| approvals | `approvalsHaveNativeRequestIds` | `true` | `approvalId` |
| approvals | `approvalCallbacksAreLiveOnly` | `false` | approval bertahan lintas restart |
| input | `acceptsText` | `true` | part `text` |
| input | `acceptsImages` | `true` | part `image` |
| input | `acceptsFiles` | `false` | hanya `@path` di teks; `video` tidak ada di kontrak |
| input | `maxAttachments` | `null` | tidak dideklarasikan |
| identity | `nativeThreadIds` | `"strong"` | `sessionId` durable |
| identity | `nativeTurnIds` | `"strong"` | `turnId` UUIDv7 durable |
| identity | `nativeItemIds` | `"strong"` | `itemId` UUIDv7 durable |
| identity | `nativeRequestIds` | `"strong"` | `approvalId` durable |

### 3.2 Event

| MSP | HarnessEvent | Catatan |
| --- | --- | --- |
| `turn/started` | `turn.started` | `turnId` natif = `commandId` untuk turn segar |
| `turn/completed` | `turn.updated` + `turn.terminal` | `terminal`: `completed`/`failed`/`cancelled` |
| `item/started` kind `agentMessage` | `message.started` | role `assistant` |
| `item/delta` field `text` | `message.delta.text` | teks assistant |
| `item/completed` kind `agentMessage` | `message.completed` | snapshot konten final |
| `item/started` kind `reasoning` | `message.started` | reasoning ephemeral |
| `item/delta` field `summary.N` | `message.delta.reasoning` | bukan bagian dari konten |
| `item/completed` kind `reasoning` | `message.completed` | konten kosong |
| `item/started` kind `toolCall` | `tool.started` | `input` dari `args` (JSON) |
| `item/delta` field `output` | `tool.delta` | output tool |
| `item/completed` kind `toolCall` | `tool.completed` | status + output final |
| `approval/requested` | `request.updated` (`pending`) | `kind: "approval"` |
| `approval/resolved` | `request.updated` (`resolved`/`expired`/`cancelled`) | `decision` menentukan status |
| `userInput/requested` | `request.updated` (`pending`) | `kind: "user_input"` |
| `userInput/settled` | `request.updated` (`resolved`/`expired`/`cancelled`) | `outcome` menentukan status |
| `session/statusChanged` | `session.updated` | status load session |
| process exit / transport EOF | `session.error` + terminal semua turn terbuka | lihat jebakan |

### 3.3 Permintaan balik (host → Muse)

| Kontrak | MSP |
| --- | --- |
| `respondToRequest` (approval) | `approval/decide` (`choiceId` = `ApprovalChoice.choiceId`, `requirementId` = `currentRequirementId`) |
| `respondToRequest` (user_input) | `userInput/answer` |
| `interruptTurn` | `turn/interrupt` |
| `steerTurn` | `turn/steer` |
| `startTurn` | `turn/start` (`input` parts) |

### 3.4 Kesalahan

| MSP | HarnessError |
| --- | --- |
| `TurnErrorKind.authRequired` | `auth_required` |
| `TurnErrorKind.modelError` + `quota` | `usage_limit` (+ `retryAfterMs` bila ada) |
| `commandRejected` | `invalid_input` / `unsupported` tergantung `reason` |
| transport EOF / proses mati | `event_stream_failed` + `session.error` |
| timeout interrupt | `interrupt_timeout` |

## 4. Tool bridge — terverifikasi live

Probe: `muse serve --preset empty` + `session/start` dengan `config.mcpServers.bridge`
(stdio, `node mcp-echo.mjs`), lalu sebuah turn meminta model memanggil tool `lookup`.

Hasil:

1. `initialize` mengabulkan `sessionMcp`, `sessionDurability: durable`.
2. **Tanpa** `--trust-workspace`: MCP ditahan —
   `MCP startup withheld 1 server: workspace is untrusted.`
   Model melaporkan "no lookup tool".
3. **Dengan** `--trust-workspace`: MCP di-spawn, model memanggil `lookup`, bridge
   mengembalikan `echo:lookup:{"q":"hello"}`.

Konsekuensi desain:

- Adapter harus menjalankan host dengan `--trust-workspace` (atau memastikan workspace
  dipercaya) bila tool bridge MCP dipakai.
- `--preset empty` menghapus built-in tools; MCP per-sesi tetap aktif. Ini persis
  kombinasi "custom tools saja, built-in tools mati".
- MCP Muse berjalan **di luar sandbox** (dokumentasi resmi). Tool bridge OpenCode → Muse
  harus menjadi batas kepercayaan dan mematuhi siklus hidup `HarnessToolBridge`
  (scope per sesi, reject saat interrupt/close/exit).

## 5. Render pesan — referensi `opencode-antigrvity`

Proxy OpenCode berbicara Anthropic Messages API. `opencode-antigrvity` adalah referensi
terbaik untuk rendering (ACP → Anthropic):

- `src/translate.ts` — event → blok Anthropic:
  - `text` → `{ type: "text" }`
  - `reasoning` → `{ type: "thinking", thinking, signature }`
  - aktivitas tool/plan → `{ type: "thinking" }` terpisah
  - `usage` → `input_tokens`/`output_tokens`/`cache_*` (ACP total bersifat inklusif;
    `input_tokens` Anthropic mengecualikan cache)
- `src/proxy.ts` — SSE: `message_start`, `content_block_start/delta/stop`,
  `message_delta` (stop reason + usage), `message_stop`, heartbeat `ping`, error mapping.
- `src/host-tools.ts` — jembatan tool host sebagai MCP server per-sesi dengan token,
  antrian pending, dan rekonsiliasi hasil.
- `src/prompt.ts` — normalisasi pesan OpenCode → part input harness.

Untuk Muse, alurnya sama: `HarnessEvent` → blok Anthropic. Tool call Muse dirender
sebagai **aktivitas** (thinking/text), bukan `tool_use`, karena Muse yang memiliki loop
tool. Model didaftarkan dengan `capabilities.tools: false` (seperti `open-muse`).

## 6. Model permission & pertanyaan di OpenCode (hasil audit source)

Audit `anomalyco/opencode@dev` (via opensrc) menjawab pertanyaan "apakah approval
dan question dikelola OpenCode?":

- **Approval** = `Permission.Service` (`packages/core/src/permission.ts`).
  **Setiap tool memanggil `permission.assert(...)` di dalam `execute`-nya
  sendiri**, bukan di loop sesi. Contoh: `tool/plugin/shell.ts`
  (`action: "shell"`), `read.ts`, `edit.ts` (lewat `fileWrite.authorize`),
  `webfetch.ts`, `websearch.ts`, `skill.ts`, `question.ts`.
- **Question** = tool bawaan `question` (`packages/core/src/tool/plugin/question.ts`).
  Tool itu `permission.assert({ action: "question" })` lalu `forms.ask(...)`
  menampilkan form ke user. Jadi pertanyaan memang sebuah tool.
- Tool snapshot disaring oleh permission agent
  (`packages/core/src/tool.ts` → `registry.snapshot(permissions)`;
  `packages/core/src/session/context.ts` menggabungkan `agent.info.permissions`
  dan `session.permissions`).

Konsekuensi untuk `opencode-muse`: karena bridge mengeksekusi tool OpenCode
lewat `ctx.tool.list()` → `tool.execute()`, **approval dan question otomatis
dikelola OpenCode**. Tidak perlu mekanisme terpisah. Tool yang mencapai Muse
persis sama dengan tool yang diizinkan agent.

Bukti live (plugin `opencode-muse`, agent `build`):

```text
[opencode-muse] permission.evaluate: action=shell resources=["echo ..."] effect=allow
```

Tool yang terekspos untuk agent `build` (policy `my-opencode`): `edit`, `patch`,
`shell`, `skill`, `subagent`, `openchamber_secret`, `write`. `question` adalah
`deny`, jadi tidak ditawarkan ke Muse — ubah rule itu jadi `allow` dan Muse bisa
bertanya lewat OpenCode.

## 7. Arsitektur final: `LanguageModelV3` (OpenCode punya loop)

Audit repo resmi `anomalyco/opencode` (`plugin/provider/claude-agent`) mengubah
arsitektur menjadi jauh lebih sederhana:

- Provider mengimplementasikan **`LanguageModelV3`** (`doStream`).
- OpenCode memperlakukan harness sebagai **model**, bukan memperlakukannya lewat
  proxy Anthropic.
- Tool OpenCode di-expose ke harness lewat **MCP server** (`tools/server.ts`).
- Saat harness panggil tool, stream mengirim **`tool-call` part**; OpenCode
  mengeksekusinya (dengan permission), lalu result di-feed di step berikutnya
  (`pending.resolve`).
- Agent role + instructions diteruskan lewat `systemPrompt.append` /
  `providerOptions`.
- Title/compaction/generate = one-off request terpisah.
- Fork/rewind via session record + checkpoint.

Ini persis "ALL IS OPENCODE, muse only as the model". Karena OpenCode yang punya
loop, **semua fitur OpenCode works native** (permission, question, compaction,
fork, rewind, title, agent prompt, images) tanpa tambalan.

### Implementasi

| File | Isi |
| --- | --- |
| `language-model.ts` | `LanguageModelV3`: prompt → turn Muse, tool-call parts, park/resume |
| `session-registry.ts` | sesi live, pending tool call, resume/fork via store |
| `prompt.ts` | ekstraksi teks/gambar/tool-result dari `LanguageModelV3Prompt` |
| `convert.ts` | `HarnessEvent` → AI SDK stream parts |
| `plugin.ts` | daftar provider `aisdk:muse`, supply AI SDK, hook headers + agent instructions |

Plugin mendaftarkan provider dengan `package: "aisdk:muse"` dan memasok AI SDK
lewat `ctx.aisdk.hook("sdk")`, jadi tak perlu build bundle terpisah.

## 8. Status implementasi

```
opencode-muse/
  package.json
  tsconfig.json
  docs/research.md
  src/
    capabilities.ts     # MUSE_CAPABILITIES (observasi host 1.4.15)
    host.ts             # spawn/supervise muse serve, koneksi MSP mentah
    events.ts           # pemetaan status/gagal/usage MSP -> kontrak
    session.ts          # MuseHarnessSession: MSP -> HarnessEvent
    adapter.ts          # MuseHarnessAdapter
    bridge.ts           # MCP server per-sesi (tool bridge)
    prompt.ts           # ekstraksi LanguageModelV3Prompt (teks/gambar/tool)
    convert.ts          # HarnessEvent -> AI SDK stream parts
    session-registry.ts # sesi live, pending tool call, resume/fork
    language-model.ts   # Muse sebagai LanguageModelV3
    shared.ts           # singleton registry bersama dengan plugin
    plugin.ts           # Plugin.define: provider, AI SDK, hooks
  test/
    conformance.test.ts # runHarnessConformance + driver host nyata
    replay.test.ts      # replay transkrip MSP nyata
    tool-bridge.test.ts # round trip tool bridge live
    record.ts           # perekam transkrip MSP
    fixtures/           # transkrip MSP terekam
```

Tahap:

1. **Adapter + konfirmasi** — selesai. `MuseHarnessAdapter`, capability mapping,
   event translation, `runHarnessConformance` untuk simple turn + tool bridge.
2. **Provider `LanguageModelV3`** — selesai. `doStream` menjalankan turn Muse,
   tool call di-emit sebagai AI SDK `tool-call`, step park saat tool menunggu.
3. **Plugin OpenCode** — selesai. Provider `aisdk:muse`, AI SDK via
   `ctx.aisdk.hook("sdk")`, headers sesi/direktori/fork, agent role +
   instructions via `providerOptions`.
4. **Fitur OpenCode** — selesai. Permission & question dikelola OpenCode;
   compaction/title/generate via one-off turn; resume & fork via store
   `ctx.storage`; gambar via part `image`.
5. **Verifikasi** — conformance, replay, tool bridge, dan OpenCode end-to-end
   (turn, tool multi-step, gambar, agent prompt, resume, fork, title) lolos.

## 9. Risiko dan jebakan

- **Workspace trust**: MCP per-sesi ditahan bila workspace untrusted (terbukti).
- **Approval option ids**: jangan pernah membuat id sendiri; pakai `choiceId` dari Muse.
- **Terminal settlement**: pastikan semua `message`/`tool`/`request` diselesaikan sebelum
  `turn.terminal`; proses exit harus menutup semua yang terbuka.
- **Sandbox**: MCP Muse di luar sandbox; tool bridge OpenCode harus jadi batas kepercayaan.
- **Presets**: `--preset empty` menghapus built-in tools; tanpa preset, tool bawaan Muse ikut
  aktif.
- **Model catalog**: `muse model/list` + variant reasoning effort; cache + reload berkala.
- **Resuming**: sesi Muse durable; pemetaan OpenCode session ↔ Muse session harus dibedakan
  dari sekadar retry request.
- **Kontrak v0.1**: harness masih early; breaking change sebelum 1.0 diharapkan.

## 10. Referensi

- `../opencode-agent-harness` — kontrak, `docs/adding-a-harness.md`, `docs/tool-bridge.md`,
  `src/testing/`
- `~/.opensrc/repos/github.com/rasyidrafi/opencode-antigrvity/main` — referensi render
  Anthropic + proxy + host-tools (ACP, bukan kontrak)
- `~/.opensrc/repos/github.com/meta-models/muse-code-sdk/1.4.15/clients/sdk-ts` — SDK MSP
  resmi (`MuseClient.spawn`, `startSession`, `run`, `onApproval`, `Connection`)
- MSP schema: `/tmp/opencode/muse-schema/msp.schema.json` (dari
  `muse schema generate-json-schema`)
- Publik: `pgarciaq/opencode-muse` (Muse-native MSP), `jaylamping/open-muse`
  (proxy OpenAI-compatible)
