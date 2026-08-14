/**
 * HttpMemoryProvider — Generic REST-backed memory plugin.
 *
 * TypeScript port of the Stonic memory plugin pattern (mem0/honcho-style).
 * Ships as the reference plugin for the MemoryPluginRegistry. Active when
 * MEMORY_PROVIDER=http (or a provider name resolved to http) and a base URL
 * is configured.
 *
 * Configuration (env):
 *   MEMORY_PROVIDER=http           → activate this plugin
 *   MEMORY_HTTP_URL=...            → backend endpoint (e.g. http://localhost:8080/mem0)
 *   MEMORY_HTTP_KEY=...            → optional bearer key
 *
 * Endpoints used (all optional, degrade gracefully to no-ops):
 *   POST {url}/sync      { sessionId, role, content }   → persist a turn
 *   POST {url}/prefetch  { query, sessionId }            → recall context
 *   POST {url}/extract   { messages }                    → pre-compress insights
 */

import { MemoryProvider, ToolSchema, ProviderInitOptions } from "../memory_provider";
import { registerMemoryPlugin } from "../plugin_registry";

class HttpMemoryProvider extends MemoryProvider {
  get name(): string {
    return "http";
  }

  private baseUrl = process.env.MEMORY_HTTP_URL || "";
  private apiKey = process.env.MEMORY_HTTP_KEY || "";
  private ready = false;

  isAvailable(): boolean {
    return !!this.baseUrl;
  }

  initialize(sessionId: string, options?: ProviderInitOptions): void {
    this.ready = this.isAvailable();
    if (!this.ready) {
      console.warn(
        "[HttpMemoryProvider] MEMORY_HTTP_URL not set — plugin is a no-op. Provide a base URL to activate external memory sync."
      );
    } else {
      console.info(
        `[HttpMemoryProvider] Initialized for session ${sessionId} → ${this.baseUrl}`
      );
    }
  }

  private async post(path: string, body: Record<string, any>): Promise<any> {
    if (!this.ready) return null;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch (e) {
      return null;
    }
  }

  systemPromptBlock(): string {
    if (!this.ready) return "";
    return "[MEMORY BACKEND] External memory provider (http) is active — turns are mirrored to the configured backend.";
  }

  syncTurn(userContent: string, assistantContent: string, sessionId?: string): void {
    void this.post("/sync", { sessionId, role: "user", content: userContent });
    void this.post("/sync", { sessionId, role: "model", content: assistantContent });
  }

  prefetch(query: string, sessionId?: string): string {
    if (!this.ready) return "";
    let result = "";
    void this.post("/prefetch", { query, sessionId }).then((data) => {
      if (data && (data.context || data.result)) {
        const text = data.context || data.result;
        result = `[EXTERNAL MEMORY RECALL (http)]\n${typeof text === "string" ? text : JSON.stringify(text)}`;
      }
    });
    return result;
  }

  onPreCompress(messages: Array<Record<string, any>>): string {
    if (!this.ready) return "";
    void this.post("/extract", { messages }).then((data) => {
      if (data && (data.insights || data.summary)) {
        return data.insights || data.summary;
      }
      return "";
    });
    return "";
  }

  getToolSchemas(): ToolSchema[] {
    return [];
  }

  shutdown(): void {
    this.ready = false;
  }
}

registerMemoryPlugin({
  name: "http",
  description: "Generic REST-backed memory backend (mem0/honcho-style).",
  load: () => new HttpMemoryProvider(),
});

export { HttpMemoryProvider };