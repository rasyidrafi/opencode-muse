import { Model, Plugin, Provider } from "@opencode/plugin";
import { MuseHarnessAdapter } from "./adapter.js";
import { HEADERS, MuseLanguageModel } from "./language-model.js";
import { MuseSessionRegistry, type SessionStore } from "./session-registry.js";
import { setGlobalRegistry } from "./shared.js";

export const PLUGIN_ID = "opencode-muse";
export const PROVIDER_ID = "muse";
export const PROVIDER_NAME = "Muse Code";
export const PROVIDER_PACKAGE = "aisdk:muse";

const AGENT_OPTION = "museAgent";
const INSTRUCTIONS_OPTION = "museInstructions";

const EXCLUDED_INSTRUCTIONS = new Set(["core/date", "core/environment", "core/codemode"]);

interface SystemPart {
  readonly text: string;
  readonly metadata?: unknown;
}

/**
 * OpenCode's own instruction files, excluding what Muse supplies itself (the
 * date and environment). The first system part is OpenCode's stock prompt,
 * which Muse does not need; only the instruction sources OpenCode loaded are
 * forwarded.
 */
function instructionsText(system: ReadonlyArray<SystemPart>): string {
  const texts: string[] = [];
  for (const part of system.slice(1)) {
    const metadata = part.metadata as
      | { experimental?: { instructions?: ReadonlyArray<{ key: string; text: string }> } }
      | undefined;
    if (!metadata?.experimental?.instructions) continue;
    for (const source of metadata.experimental.instructions) {
      if (EXCLUDED_INSTRUCTIONS.has(source.key)) continue;
      texts.push(source.text);
    }
  }
  return texts.join("\n\n");
}

function toModelInfo(providerID: ReturnType<typeof Provider.ID.make>, model: Record<string, unknown>) {
  const modelId = String(model.modelId ?? "");
  const base = Model.Info.default(providerID, Model.ID.make(modelId));
  const contextLimit = typeof model.contextLimit === "number" ? model.contextLimit : 1_048_576;
  const outputLimit = typeof model.outputLimit === "number" ? model.outputLimit : 8_192;
  const variants = Array.isArray(model.variants) ? model.variants : [];
  return {
    ...base,
    modelID: Model.ID.make(modelId),
    name: typeof model.displayLabel === "string" ? model.displayLabel : modelId,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: contextLimit, output: outputLimit },
    variants: variants.map((variant) => ({ id: Model.VariantID.make(String(variant)) })),
  };
}

/**
 * OpenCode plugin entrypoint.
 *
 * Registers the `muse` provider and supplies its AI SDK. OpenCode owns the
 * agent loop; Muse is the language model, and OpenCode's tools reach Muse
 * through the harness tool bridge.
 */
export const MusePlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const adapter = new MuseHarnessAdapter({
      hostOptions: {
        museBin: process.env.MUSE_BIN ?? "muse",
        ...(process.env.MUSE_PRESET === undefined ? {} : { preset: process.env.MUSE_PRESET }),
        trustWorkspace: true,
      },
    });
    const store: SessionStore = {
      get: async (key) => {
        const value = await ctx.storage.get(key);
        return typeof value === "string" ? value : undefined;
      },
      set: async (key, value) => {
        await ctx.storage.set(key, value);
      },
    };
    const registry = new MuseSessionRegistry(adapter, store);
    setGlobalRegistry(registry);

    const providerID = Provider.ID.make(PROVIDER_ID);

    let models: Array<Record<string, unknown>> = [];
    try {
      models = await registry.listModels();
    } catch (error) {
      console.warn("[opencode-muse] model discovery failed:", error);
    }
    const modelInfos = models.map((model) => toModelInfo(providerID, model));

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: PROVIDER_NAME,
          activation: "enabled",
          package: PROVIDER_PACKAGE,
        },
        models: modelInfos,
      });
    });

    // Supply the AI SDK for the provider: OpenCode calls this instead of
    // loading a package from npm.
    await ctx.aisdk.hook(
      "sdk",
      (event) => {
        event.sdk = {
          languageModel: (modelID: string) => new MuseLanguageModel(modelID, event.options, registry),
        };
      },
      { providerID },
    );

    // Tag every request with the session, directory, and fork lineage.
    await ctx.session.hook(
      "model.request",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return;
        event.headers[HEADERS.kind] = event.kind;
        if (event.kind !== "primary") return;
        event.headers[HEADERS.session] = event.sessionID;
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID });
          event.headers[HEADERS.directory] = session.location.directory;
          const fork = (session as { fork?: { sessionID?: string } }).fork;
          if (fork?.sessionID) event.headers[HEADERS.forkSource] = fork.sessionID;
        } catch {
          // Keep the default directory.
        }
      },
      { providerID },
    );

    // Forward the agent role and OpenCode's instruction files.
    for (const kind of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(
        kind,
        async (event) => {
          const agent = await ctx.agent.get({ agentID: event.agent });
          event.options[AGENT_OPTION] = agent.data.system ?? "";
          event.options[INSTRUCTIONS_OPTION] = instructionsText(event.system as ReadonlyArray<SystemPart>);
        },
        { providerID },
      );
    }

    return async () => {
      await registry.closeAll();
      await adapter.close();
    };
  },
});

export default MusePlugin;
