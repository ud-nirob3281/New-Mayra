/**
 * MYRAA — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets MYRAA_DATA_DIR to a
 * writable folder under %APPDATA%\MYRAA, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import os from "os";
import path from "path";

/** Writable per-user data directory.
 *
 * Resolution order (Stonic-compatible persistence):
 *   1. MYRAA_DATA_DIR env (set by the packaged Electron app to %APPDATA%\MYRAA).
 *   2. ~/.safa/data — stable, survives working-directory changes & re-installs,
 *      exactly like Stonic's ~/.hermes/state.db. This fixes the "session.sqlite
 *      in cwd" bug where launching from a different directory silently created
 *      a brand-new database and the assistant "forgot" everything.
 */
const LEGACY_CWD_DATA_DIR = process.cwd();
export const DATA_DIR: string =
  process.env.MYRAA_DATA_DIR ||
  path.join(os.homedir(), ".safa", "data");

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

// ─── Legacy migration ────────────────────────────────────────────────────────
// Earlier builds wrote session.sqlite, MEMORY.md, memories.json.migrated and
// secrets.json to process.cwd(). If we now point at a stable dir and legacy
// files exist in the old cwd, copy them once so no conversation history or
// durable memories are lost. The stable copy wins if both exist.
const LEGACY_FILES = [
  "session.sqlite",
  "MEMORY.md",
  "memories.json.migrated",
  "secrets.json",
];
try {
  for (const name of LEGACY_FILES) {
    const legacyFile = path.join(LEGACY_CWD_DATA_DIR, name);
    const stableFile = path.join(DATA_DIR, name);
    if (!fs.existsSync(legacyFile)) continue;
    if (!fs.existsSync(stableFile)) {
      fs.copyFileSync(legacyFile, stableFile);
      console.log(`[Data Migration] Copied legacy ${name} → ${stableFile}`);
      continue;
    }
    // The stable copy may be an empty placeholder created by an earlier run
    // while the legacy file holds real content — restore it in that case.
    const stableSize = fs.statSync(stableFile).size;
    const legacySize = fs.statSync(legacyFile).size;
    if (stableSize === 0 && legacySize > 0) {
      fs.copyFileSync(legacyFile, stableFile);
      console.log(`[Data Migration] Restored legacy content of ${name} → ${stableFile} (${legacySize} bytes)`);
    }
  }
} catch (err: any) {
  console.error("[Data Migration] Failed to migrate legacy files:", err?.message || err);
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the writable data dir).
// ---------------------------------------------------------------------------
const SECRETS_FILE = dataFile("secrets.json");

interface Secrets {
  geminiApiKey?: string;
  sabitApiKey?: string;
}

function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

/** Persist a user-supplied key to the per-user secrets file. */
export function setGeminiApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("API key must not be empty.");

  try {
    const dataSecrets = readSecrets();
    dataSecrets.geminiApiKey = trimmed;
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(dataSecrets, null, 2), "utf-8");
    try {
      fs.chmodSync(SECRETS_FILE, 0o600); // owner-only where supported
    } catch {}
  } catch (err: any) {
    console.error("[Secrets] Error writing to secrets file:", err?.message || err);
  }
}

// Auto-migrate environment GEMINI_API_KEY to secrets.json on startup if missing.
try {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) {
    const currentKey = getGeminiApiKey();
    if (!currentKey) {
      setGeminiApiKey(envKey);
      console.log("[Secrets Migration] Successfully migrated environment GEMINI_API_KEY to secrets.json");
    }
  }
} catch (err: any) {
  console.error("[Secrets Migration] Error migrating key:", err?.message || err);
}

/**
 * Resolve the active Gemini API key.
 * Strictly reads from secrets.json under the writable data directory.
 */
export function getGeminiApiKey(): string | undefined {
  const dataKey = readSecrets().geminiApiKey?.trim();
  if (dataKey) return dataKey;

  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) return envKey;

  return undefined;
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  try {
    const dataSecrets = readSecrets();
    delete dataSecrets.geminiApiKey;
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(dataSecrets, null, 2), "utf-8");
  } catch {}
}

/** Resolve the active Sabit API key. Falls back to getGeminiApiKey() if missing. */
export function getSabitApiKey(): string | undefined {
  const dataKey = readSecrets().sabitApiKey?.trim();
  if (dataKey) return dataKey;

  return getGeminiApiKey();
}

/** Persist a user-supplied Sabit key to the per-user secrets file. */
export function setSabitApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("Sabit API key must not be empty.");

  try {
    const dataSecrets = readSecrets();
    dataSecrets.sabitApiKey = trimmed;
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(dataSecrets, null, 2), "utf-8");
    try {
      fs.chmodSync(SECRETS_FILE, 0o600); // owner-only where supported
    } catch {}
  } catch (err: any) {
    console.error("[Secrets] Error writing Sabit API key:", err?.message || err);
  }
}

/** Whether Sabit has a configured or inherited key. */
export function hasSabitApiKey(): boolean {
  return Boolean(getSabitApiKey());
}

/** Whether Sabit has a custom key defined in secrets (not falling back). */
export function hasCustomSabitApiKey(): boolean {
  return Boolean(readSecrets().sabitApiKey?.trim());
}

/** Remove the stored Sabit key. */
export function clearSabitApiKey(): void {
  try {
    const dataSecrets = readSecrets();
    delete dataSecrets.sabitApiKey;
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(dataSecrets, null, 2), "utf-8");
  } catch {}
}
