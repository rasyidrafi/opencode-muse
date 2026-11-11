import type { MuseSessionRegistry } from "./session-registry.js";

/**
 * The plugin and the provider entrypoint are separate modules: OpenCode loads
 * the plugin from TypeScript source but imports the provider from its bundled
 * JavaScript. They share the process, so the registry lives on `globalThis`.
 */
const KEY = "__opencodeMuseRegistry__";

export function setGlobalRegistry(registry: MuseSessionRegistry): void {
  (globalThis as Record<string, unknown>)[KEY] = registry;
}

export function getGlobalRegistry(): MuseSessionRegistry | undefined {
  return (globalThis as Record<string, unknown>)[KEY] as MuseSessionRegistry | undefined;
}
