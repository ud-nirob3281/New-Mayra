/**
 * MemoryPluginRegistry — Pluggable memory backend discovery & activation.
 *
 * TypeScript port of Stonic AI's plugin memory discovery system.
 *
 * Mirrors Stonic's `plugins/memory/<name>/` pattern:
 *   - Plugin providers ship in `hermes-agent/memory/plugins/`
 *   - Each plugin exports a MemoryProvider implementation
 *   - The active provider is chosen via config (MEMORY_PROVIDER env / memory.provider)
 *   - Only ONE external provider runs at a time (MemoryManager enforces this too)
 *
 * The builtin provider is always registered first. Plugin providers are
 * discovered from the plugins directory and activated by name.
 */

import { MemoryProvider } from "./memory_provider";
import { BuiltinMemoryProvider } from "./builtin_provider";

export type MemoryPluginLoader = () => MemoryProvider;

export interface MemoryPluginManifest {
  name: string;
  description: string;
  /** Optional loader used for lazy activation. Defaults to auto-discovery. */
  load?: MemoryPluginLoader;
}

/** Registry of known plugin providers (name → loader). */
const pluginRegistry = new Map<string, MemoryPluginManifest>();

export function registerMemoryPlugin(manifest: MemoryPluginManifest): void {
  if (pluginRegistry.has(manifest.name)) {
    console.warn(
      `[MemoryPluginRegistry] Plugin '${manifest.name}' already registered, overwriting.`
    );
  }
  pluginRegistry.set(manifest.name, manifest);
}

export function listMemoryPlugins(): MemoryPluginManifest[] {
  return Array.from(pluginRegistry.values());
}

export function hasMemoryPlugin(name: string): boolean {
  return pluginRegistry.has(name);
}

/**
 * Resolve the active memory provider name.
 * Priority: MEMORY_PROVIDER env var → memory.provider config → "builtin".
 */
export function resolveActiveProviderName(): string {
  if (process.env.MEMORY_PROVIDER && process.env.MEMORY_PROVIDER.trim()) {
    return process.env.MEMORY_PROVIDER.trim();
  }
  try {
    const cfg = process.env.MEMORY_CONFIG ? JSON.parse(process.env.MEMORY_CONFIG) : null;
    if (cfg && typeof cfg.provider === "string" && cfg.provider) {
      return cfg.provider;
    }
  } catch {}
  return "builtin";
}

/**
 * Build the provider list for a session.
 * Always includes the builtin provider first (Stonic pattern), then the
 * single active external plugin if configured and available.
 */
export function buildProvidersForSession(
  sessionId: string,
  options?: Record<string, any>
): MemoryProvider[] {
  const providers: MemoryProvider[] = [];
  try {
    providers.push(new BuiltinMemoryProvider());
  } catch (e) {
    console.error("[MemoryPluginRegistry] Failed to init builtin provider:", e);
  }

  const active = resolveActiveProviderName();
  if (active && active !== "builtin") {
    if (pluginRegistry.has(active)) {
      try {
        const manifest = pluginRegistry.get(active)!;
        const provider = manifest.load ? manifest.load() : null;
        if (provider) {
          providers.push(provider);
          console.info(
            `[MemoryPluginRegistry] Activated external memory provider '${active}'.`
          );
        }
      } catch (e) {
        console.warn(
          `[MemoryPluginRegistry] Plugin '${active}' failed to load: ${e instanceof Error ? e.message : e}`
        );
      }
    } else {
      console.warn(
        `[MemoryPluginRegistry] Memory provider '${active}' not found. Available: ${listMemoryPlugins().map((p) => p.name).join(", ") || "builtin"}. Falling back to builtin.`
      );
    }
  }

  return providers;
}