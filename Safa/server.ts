import express from 'express';
import http from 'http';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from '@google/genai';
import dotenv from 'dotenv';
import * as fs from 'fs';
import {
  loadMemories,
  saveMemories,
  loadLearnedRules,
  saveLearnedRules,
  getRelevantContextForPrompt,
  formatSystemInstructionsWithContext,
  memoryManager,
  triggerBackgroundMemoryReview,
  getStableId,
  StreamingContextScrubber,
} from './memory_manager';
import { Memory, LearnedRule } from './src/lib/memoryTypes';
import {
  analyzeAndSplitUserRequest,
  ResultCollector,
} from './server_scheduler';
import { agentCore } from './agent_core';
import { buildSoulSystemPrompt, loadSoulConfig, saveSoulConfig } from './soul';
import {
  DATA_DIR,
  dataFile,
  getGeminiApiKey,
  hasGeminiApiKey,
  setGeminiApiKey,
  getSabitApiKey,
  hasSabitApiKey,
  setSabitApiKey,
  hasCustomSabitApiKey,
  clearSabitApiKey,
} from './server_paths';

// ─── Dialogue History Cache (Stonic-compatible) ─────────────────────────────
// Thin in-memory cache over SQLite. Always sourced from session_db on first access.
// Bounded: only the last 500 turns are held in memory to prevent unbounded growth.
// Raised from 50 → 500 (Stonic parity): 50 turns truncated long conversations,
// so reconnects only restored a small window and earlier context was lost.
const DIALOGUE_CACHE_MAX = 500;
const sessionHistoryCache = new Map<string, { role: string; text: string }[]>();

/**
 * Load (or restore from cache) the dialogue history for a session.
 * Sources from SQLite (session_db.ts) on cache miss — survives restarts.
 *
 * FIXED (Stonic parity): Stonic reloads the full transcript from SQLite on
 * every single turn — there is no in-memory cache that can go stale. Here we
 * used to cache the result, including an EMPTY result, so after the first
 * connect (0 messages) the cache returned [] forever and reconnects never
 * re-read the messages that were persisted meanwhile — the assistant
 * "forgot" everything on reconnect. Empty results are no longer cached, so
 * every reconnect re-reads SQLite.
 */
async function getDialogueHistory(
  sessionId: string,
): Promise<{ role: string; text: string }[]> {
  const cached = sessionHistoryCache.get(sessionId);
  if (cached && cached.length > 0) return cached;
  try {
    const { getSessionMessages } = await import('./session_db');
    const dbMsgs = getSessionMessages(sessionId, DIALOGUE_CACHE_MAX);
    const loaded = (dbMsgs || []).map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: m.content,
    }));
    // Only cache non-empty history — an empty result must never shadow
    // messages that get persisted after this read (Stonic reloads every turn).
    if (loaded.length > 0) {
      sessionHistoryCache.set(sessionId, loaded);
    }
    console.log(
      `[DialogueHistory] Restored ${loaded.length} messages from SQLite for session: ${sessionId}`,
    );
    return loaded;
  } catch (err) {
    console.error('[DialogueHistory] Error loading from SQLite:', err);
    return [];
  }
}

/** Append a turn to the cache + persist to SQLite (caller handles persistence). */
function appendDialogueTurn(
  sessionId: string,
  turn: { role: string; text: string },
): void {
  let hist = sessionHistoryCache.get(sessionId);
  if (!hist) {
    hist = [];
    sessionHistoryCache.set(sessionId, hist);
  }
  // Avoid exact duplicates
  if (hist.length === 0 || hist[hist.length - 1].text !== turn.text) {
    hist.push(turn);
  }
  // Bound the cache
  if (hist.length > DIALOGUE_CACHE_MAX) {
    hist.splice(0, hist.length - DIALOGUE_CACHE_MAX);
  }
}

/** Invalidate the cache for a session (e.g., on session switch). */
function invalidateDialogueCache(sessionId?: string): void {
  if (sessionId) sessionHistoryCache.delete(sessionId);
  else sessionHistoryCache.clear();
}

async function performReviewLLMCall(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return "";
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `${systemPrompt}\n\n${userPrompt}`,
    });
    return response.text || "";
  } catch (err) {
    console.error("[BackgroundReview LLM Call Error]:", err);
    return "";
  }
}

// Compatibility alias — Sabit's pre-existing code references `sessionHistoryMap`
// with key "sabit_session". We expose the same Map interface so Sabit's logic,
// routing, and behavior remain completely untouched. DO NOT modify Sabit code.
const sessionHistoryMap = sessionHistoryCache;

// --- Sabit Concurrency & Acquisition Guard ---
export type SabitTaskStatus =
  | 'idle'
  | 'acquiring'
  | 'running'
  | 'waiting_for_user'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

let globalWss: WebSocketServer | null = null;
let globalSabitWss: WebSocketServer | null = null;

export interface SabitTask {
  id: string;
  taskGoal: string;
  status: SabitTaskStatus;
  startedAt: string | null;
  completedAt: string | null;
  error?: string;
}

export let currentSabitTaskObj: SabitTask = {
  id: '',
  taskGoal: '',
  status: 'idle',
  startedAt: null,
  completedAt: null,
};

export interface SabitRuntimeState {
  connectionState: 'connected' | 'disconnected' | 'reconnecting';
  sessionState: 'active' | 'closed';
  taskState: SabitTaskStatus;
  activeTaskId: string | null;
  activeTaskGoal: string | null;
  manualDisconnected: boolean;
}

export let sabitRuntimeState: SabitRuntimeState = {
  connectionState: 'disconnected',
  sessionState: 'closed',
  taskState: 'idle',
  activeTaskId: null,
  activeTaskGoal: null,
  manualDisconnected: false,
};

let sabitRecoveryTimeoutId: NodeJS.Timeout | null = null;

export function logSabitWS(state: string, details?: string, error?: any) {
  let logMsg = `[SABIT WS] ${state}`;
  if (details) logMsg += ` - ${details}`;
  if (error) {
    if (error.stack) {
      logMsg += `\nError Stack:\n${error.stack}`;
    } else {
      logMsg += ` - Error: ${JSON.stringify(error)}`;
    }
  }
  console.log(logMsg);
}

export function broadcastSabitRuntimeState() {
  const payload = JSON.stringify({
    type: 'sabit_runtime_state',
    sabitRuntimeState: {
      connectionState: sabitRuntimeState.connectionState,
      sessionState: sabitRuntimeState.sessionState,
      taskState: sabitRuntimeState.taskState,
      activeTaskId: sabitRuntimeState.activeTaskId,
      activeTaskGoal: sabitRuntimeState.activeTaskGoal,
      manualDisconnected: sabitRuntimeState.manualDisconnected,
    },
  });

  const isBusy =
    sabitRuntimeState.taskState === 'acquiring' ||
    sabitRuntimeState.taskState === 'running' ||
    sabitRuntimeState.taskState === 'recovering';
  const legacyPayload = JSON.stringify({
    type: 'sabit_task_status',
    task: {
      id: sabitRuntimeState.activeTaskId || '',
      taskGoal: sabitRuntimeState.activeTaskGoal || '',
      status: sabitRuntimeState.taskState,
      startedAt: currentSabitTaskObj.startedAt,
      completedAt: currentSabitTaskObj.completedAt,
      error: currentSabitTaskObj.error,
    },
    isBusy,
    currentTask: isBusy ? sabitRuntimeState.activeTaskGoal || '' : '',
  });

  if (globalWss && globalWss.clients) {
    for (const client of globalWss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        try {
          client.send(payload);
        } catch (e) {}
        try {
          client.send(legacyPayload);
        } catch (e) {}
      }
    }
  }

  if (globalSabitWss && globalSabitWss.clients) {
    for (const client of globalSabitWss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        try {
          client.send(payload);
        } catch (e) {}
        try {
          client.send(legacyPayload);
        } catch (e) {}
      }
    }
  }
}

export function broadcastSabitTaskState() {
  // Maintain backward compatibility
  broadcastSabitRuntimeState();
}

export function transitionSabitTaskState(
  status: SabitTaskStatus,
  error?: string,
) {
  const prevStatus = sabitRuntimeState.taskState;
  const taskId =
    sabitRuntimeState.activeTaskId || currentSabitTaskObj.id || 'none';
  const reason = error
    ? error
    : status === 'completed'
      ? 'Goal completed successfully'
      : status === 'failed'
        ? 'Failed'
        : status === 'cancelled'
          ? 'Cancelled by user'
          : 'State transition';
  console.log(
    `[SABIT TASK] ${taskId} | ${prevStatus} -> ${status} | reason: ${reason}`,
  );
  console.log(
    `[Task State Machine] Transitioning taskState from ${prevStatus} to ${status}`,
  );
  sabitRuntimeState.taskState = status;
  currentSabitTaskObj.status = status;

  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    currentSabitTaskObj.completedAt = new Date().toISOString();
    if (error) {
      currentSabitTaskObj.error = error;
    }

    sabitRuntimeState.activeTaskId = null;
    sabitRuntimeState.activeTaskGoal = null;
    isCurrentlyDelegated = false;
    isSabitBusy = false;
    currentSabitTask = null;

    if (status === 'completed') {
      logSabitWS('TASK_COMPLETED', `Goal completed successfully`);
    } else if (status === 'failed') {
      logSabitWS('TASK_FAILED', `Failed with error: ${error}`);
    } else {
      logSabitWS('TASK_CANCELLED', `Cancelled by user`);
    }

    if (
      (prevStatus === 'acquiring' ||
        prevStatus === 'running' ||
        prevStatus === 'recovering') &&
      activeMairaLiveSession
    ) {
      try {
        let notificationText = '';
        if (status === 'completed') {
          notificationText = `SYSTEM NOTIFICATION: Sabit has successfully completed the delegated task: "${currentSabitTaskObj.taskGoal}". (Task ID: ${currentSabitTaskObj.id}). Please announce this successful result to the user clearly and enthusiastically.`;
        } else if (status === 'failed') {
          notificationText = `SYSTEM NOTIFICATION: Sabit failed to complete the delegated task: "${currentSabitTaskObj.taskGoal}". (Task ID: ${currentSabitTaskObj.id}). Reason: ${error || 'Unknown error'}. Please explain this failure clearly to the user, and offer to execute the task yourself using your available tools.`;
        } else if (status === 'cancelled') {
          notificationText = `SYSTEM NOTIFICATION: The delegated task was cancelled: "${currentSabitTaskObj.taskGoal}". (Task ID: ${currentSabitTaskObj.id}). Please inform the user that the task has been successfully cancelled.`;
        }

        console.log(
          `[Result Protocol] Informing Maira of Sabit status "${status}" with message: "${notificationText}"`,
        );
        activeMairaLiveSession.sendClientContent({
          turns: {
            role: 'user',
            parts: [{ text: notificationText }],
          },
        });
      } catch (e) {
        console.error(
          '[Result Protocol] Failed to send status notification to Maira session:',
          e,
        );
      }
    }

    if (resetTaskStateTimeoutId) {
      clearTimeout(resetTaskStateTimeoutId);
    }
    resetTaskStateTimeoutId = setTimeout(() => {
      currentSabitTaskObj = {
        id: '',
        taskGoal: '',
        status: 'idle',
        startedAt: null,
        completedAt: null,
      };
      broadcastSabitRuntimeState();
      resetTaskStateTimeoutId = null;
    }, 2000);
  } else if (
    status === 'acquiring' ||
    status === 'running' ||
    status === 'waiting_for_user'
  ) {
    isSabitBusy = true;
    if (error) {
      currentSabitTaskObj.error = error;
    }
    if (status === 'acquiring') {
      currentSabitTaskObj.startedAt = new Date().toISOString();
      currentSabitTaskObj.completedAt = null;
      currentSabitTaskObj.error = undefined;
    }
    if (status === 'waiting_for_user' && activeMairaLiveSession) {
      try {
        const notificationText = `SYSTEM NOTIFICATION: Sabit's active task "${currentSabitTaskObj.taskGoal}" is WAITING FOR USER ACTION. Instruction for user: "${error || 'User intervention required on screen'}". Please inform the user so they can complete the action on screen.`;
        activeMairaLiveSession.sendClientContent({
          turns: {
            role: 'user',
            parts: [{ text: notificationText }],
          },
        });
      } catch (e) {
        console.error('[Waiting For User Protocol] Failed to inform Maira:', e);
      }
    }
  }

  broadcastSabitRuntimeState();
}

export function setSabitTaskStatus(status: SabitTaskStatus, error?: string) {
  transitionSabitTaskState(status, error);
}

export function resumeSabitTask(userResponseText: string): boolean {
  if (sabitRuntimeState.taskState !== 'waiting_for_user') {
    return false;
  }
  const taskGoal =
    sabitRuntimeState.activeTaskGoal ||
    currentSabitTaskObj.taskGoal ||
    'active task';
  console.log(
    `[Sabit Task Resume] Resuming task "${taskGoal}" with user response: "${userResponseText}"`,
  );
  transitionSabitTaskState('running');

  if (activeSabitLiveSession) {
    try {
      activeSabitLiveSession.sendClientContent({
        turns: {
          role: 'user',
          parts: [
            {
              text: `SYSTEM DIRECTIVE (CRITICAL - IMMEDIATE SCREEN VERIFICATION MANDATORY): The user stated that they completed the required action on screen / responded: "${userResponseText}". You MUST NOT blindly assume the action is complete. You MUST IMMEDIATELY call 'desktopBrowserSnapshot' as your very first tool right now to inspect the live screen state. Inspect the snapshot: IF the required action is verified as complete (e.g., WhatsApp Web login succeeded, QR code disappeared, input field appeared), continue executing the task ("${taskGoal}") immediately! IF the action is NOT complete (e.g., QR code still visible, login incomplete), call 'sabitWaitingForUser' again explaining precisely what is still required and do NOT proceed until verified.`,
            },
          ],
        },
        turnComplete: true,
      });
      console.log(
        '[Sabit Task Resume] Verification resume directive sent to Sabit Gemini Live session.',
      );
    } catch (e) {
      console.error(
        '[Sabit Task Resume] Error sending resume directive to Sabit session:',
        e,
      );
    }
  }

  if (activeMairaLiveSession) {
    try {
      activeMairaLiveSession.sendClientContent({
        turns: {
          role: 'user',
          parts: [
            {
              text: `SYSTEM NOTIFICATION: Sabit's active task "${taskGoal}" has been RESUMED following the user's input ("${userResponseText}"). Sabit is now taking a fresh snapshot to verify screen state and continue execution in the background.`,
            },
          ],
        },
      });
    } catch (e) {}
  }

  return true;
}

export function cancelSabitTask(
  reason: string = 'Task explicitly cancelled by user.',
): boolean {
  console.log(`[Sabit Task Cancel] Cancelling Sabit task. Reason: ${reason}`);

  setSabitTaskStatus('cancelled', reason);
  isCurrentlyDelegated = false;
  mairaActiveTaskGoal = null;

  if (activeSabitToolCall) {
    console.log(
      `[Sabit Task Cancel] Resolving active Sabit tool call: ${activeSabitToolCall.name}`,
    );
    activeSabitToolCall.resolve({
      ok: false,
      error: reason,
    });
    activeSabitToolCall = null;
  }

  // Terminate active Playwright browser worker session for Sabit
  callDesktopAgent('browserSessionClose', { _caller: 'sabit' }).catch(e => {
    console.error(
      '[Sabit Task Cancel] Error closing Sabit browser session:',
      e,
    );
  });

  if (activeSabitLiveSession) {
    try {
      activeSabitLiveSession.sendClientContent({
        turns: {
          role: 'user',
          parts: [
            {
              text: 'SYSTEM DIRECTIVE (CRITICAL): The user has explicitly cancelled your active task. You MUST immediately stop executing any tools, cease all browser automation, and tell the user politely in your professional voice that you have stopped and the task is cancelled.',
            },
          ],
        },
        turnComplete: true,
      });
    } catch (e) {}
  }

  if (activeMairaLiveSession) {
    try {
      activeMairaLiveSession.sendClientContent({
        turns: {
          role: 'user',
          parts: [
            {
              text: `SYSTEM NOTIFICATION: Sabit's active task has been CANCELLED (${reason}).`,
            },
          ],
        },
      });
    } catch (e) {}
  }

  currentSabitTaskObj = {
    id: '',
    taskGoal: '',
    status: 'cancelled',
    startedAt: null,
    completedAt: new Date().toISOString(),
    error: reason,
  };
  broadcastSabitRuntimeState();
  return true;
}

let isCurrentlyDelegated = false;
let resetTaskStateTimeoutId: any = null;
let isSabitBusy = false;
let currentSabitTask: string | null = null;
export let activeSabitLiveSession: any = null;
let activeSabitToolCall: any = null;
let activeSabitClientWs: any = null;
export let activeMairaLiveSession: any = null;
let isSabitManuallyDisconnectedByUser = false;
let mairaActiveTaskGoal: string | null = null;

import { SHARED_TOOL_DECLARATIONS } from './server_tools';

export function getSabitStatusSummary(): string {
  let sabitStatusSummary = '';
  if (sabitRuntimeState.connectionState === 'connected') {
    if (
      sabitRuntimeState.taskState === 'acquiring' ||
      sabitRuntimeState.taskState === 'running' ||
      sabitRuntimeState.taskState === 'recovering' ||
      sabitRuntimeState.taskState === 'waiting_for_user'
    ) {
      sabitStatusSummary = `SABIT IS CONNECTED BUT BUSY executing a task: "${sabitRuntimeState.activeTaskGoal}" (Task ID: ${sabitRuntimeState.activeTaskId}, Status: ${sabitRuntimeState.taskState}).
CRITICAL DIRECTIVE FOR MAIRA: Sabit is currently busy. If the user gives a new browser automation or background task right now:
1. DO NOT call 'delegateToSabit'.
2. DO NOT say "Sabit is busy" or refuse or ask for confirmation.
3. Immediately execute the user's new request YOURSELF using your browser/desktop tools! You will run isolated in your own browser worker and profile.`;
    } else {
      sabitStatusSummary = `SABIT IS CONNECTED AND IDLE. He is fully available to receive tasks! Always use 'delegateToSabit' immediately for any background, search, or automation tasks.`;
    }
  } else {
    if (!getSabitApiKey()) {
      sabitStatusSummary = `SABIT IS OFFLINE because Sabit's API key is not configured in Settings. If the user asks for browser/background automation, do NOT call 'delegateToSabit'. Instead, execute it yourself and explain that Sabit's API key is not configured.`;
    } else if (sabitRuntimeState.manualDisconnected) {
      sabitStatusSummary = `SABIT IS OFFLINE because the user manually disconnected Sabit from the UI. If the user asks for browser/background automation, do NOT call 'delegateToSabit'. Instead, execute it yourself and tell the user they manually disconnected Sabit.`;
    } else {
      sabitStatusSummary = `SABIT IS OFFLINE due to a connection issue or is currently reconnecting. If the user asks for browser/background automation, do NOT call 'delegateToSabit'. Instead, execute it yourself and tell the user Sabit is experiencing a temporary connection issue.`;
    }
  }
  return sabitStatusSummary;
}

export function getSabitStatus() {
  const isBusy =
    sabitRuntimeState.taskState === 'acquiring' ||
    sabitRuntimeState.taskState === 'running' ||
    sabitRuntimeState.taskState === 'recovering';
  return {
    isBusy,
    currentTask: isBusy ? sabitRuntimeState.activeTaskGoal || '' : '',
  };
}

export function acquireSabitTask(task: string): boolean {
  const isBusy =
    sabitRuntimeState.taskState === 'acquiring' ||
    sabitRuntimeState.taskState === 'running' ||
    sabitRuntimeState.taskState === 'recovering';
  if (isBusy) {
    return false;
  }
  if (resetTaskStateTimeoutId) {
    clearTimeout(resetTaskStateTimeoutId);
    resetTaskStateTimeoutId = null;
  }
  const taskId = Math.random().toString(36).substring(2, 11);
  sabitRuntimeState.activeTaskId = taskId;
  sabitRuntimeState.activeTaskGoal = task;
  currentSabitTaskObj = {
    id: taskId,
    taskGoal: task,
    status: 'acquiring',
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  isSabitBusy = true;
  currentSabitTask = task;
  transitionSabitTaskState('acquiring');
  return true;
}

export function releaseSabitTask(reason: string = 'Sabit disconnected'): void {
  const isBusy =
    sabitRuntimeState.taskState === 'acquiring' ||
    sabitRuntimeState.taskState === 'running' ||
    sabitRuntimeState.taskState === 'recovering';
  if (isBusy) {
    transitionSabitTaskState('failed', reason);
  } else {
    transitionSabitTaskState('idle');
  }
  isCurrentlyDelegated = false;
}

dotenv.config();

// ---------------------------------------------------------------------------
// MYRAA V2 â€” Logging (Feature 7).
// Appends timestamped lines to logs/{commands,startup,errors}.log.
// Never throws; logging failures are swallowed so they can't break the app.
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, 'logs');
try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch {
  /* already exists */
}

function appendLog(fileName: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => {});
  } catch {
    /* logging is best-effort */
  }
}
const logCommand = (m: string) => appendLog('commands.log', m);
const logStartup = (m: string) => appendLog('startup.log', m);
const logError = (m: string) => appendLog('errors.log', m);

// ---------------------------------------------------------------------------
// Emotion classification (Fix 4) â€” drives the assistant's on-screen video.
//
// A lightweight keyword scan over the model's spoken text. No extra API call,
// no latency: it runs in microseconds per chunk and emits a single WS frame
// `{"type":"emotion","emotion":"<mood>"}` to the client whenever the detected
// mood changes. The frontend maps this to MyraaCoreVisualizer's video set.
// ---------------------------------------------------------------------------
type MyraaEmotion =
  | 'idle'
  | 'playful'
  | 'happy'
  | 'excited'
  | 'curious'
  | 'thinking'
  | 'proud'
  | 'sad'
  | 'surprised'
  | 'embarrassed'
  | 'confused'
  | 'angry';

// Ordered most-specific â†’ least-specific so "I'm so frustrated" wins over a
// generic positivity match. Each entry is a list of substring cues.
const EMOTION_KEYWORDS: { emotion: MyraaEmotion; cues: string[] }[] = [
  {
    emotion: 'angry',
    cues: [
      'angry',
      'furious',
      'frustrated',
      'annoyed',
      'irritated',
      'mad at',
      'fed up',
      "that's unacceptable",
    ],
  },
  {
    emotion: 'sad',
    cues: [
      'sad',
      'sorry to hear',
      'unfortunately',
      'heartbroken',
      'disappointed',
      'i understand how tough',
      'rough time',
    ],
  },
  {
    emotion: 'surprised',
    cues: [
      'wow',
      'oh my',
      'no way',
      'incredible',
      'unbelievable',
      "that's surprising",
      "didn't expect",
    ],
  },
  {
    emotion: 'excited',
    cues: [
      'exciting',
      'amazing',
      'awesome',
      'fantastic',
      "let's do it",
      "can't wait",
      'this is great',
      'love that',
    ],
  },
  {
    emotion: 'playful',
    cues: [
      'haha',
      'lol',
      'just kidding',
      'funny',
      'silly',
      'teasing',
      'gotcha',
    ],
  },
  {
    emotion: 'proud',
    cues: [
      'proud of you',
      'well done',
      'great job',
      'you did it',
      'congrats',
      'congratulations',
      'nailed it',
    ],
  },
  {
    emotion: 'happy',
    cues: [
      'happy',
      'glad',
      'wonderful',
      'delightful',
      'perfect',
      'sounds good',
      'love this',
      "that's great",
    ],
  },
  {
    emotion: 'curious',
    cues: [
      'interesting',
      "let's explore",
      'tell me more',
      'what do you think',
      'curious',
      'shall we',
    ],
  },
  {
    emotion: 'thinking',
    cues: [
      'let me think',
      'hmm',
      "let's see",
      'i suppose',
      'considering',
      'on the other hand',
    ],
  },
  {
    emotion: 'embarrassed',
    cues: ['oops', 'my mistake', 'sorry about that', 'i apologize', 'my bad'],
  },
  {
    emotion: 'confused',
    cues: [
      "i'm not sure",
      'confused',
      'could you clarify',
      'what do you mean',
      'pardon',
    ],
  },
];

let lastEmotion: MyraaEmotion = 'idle';

/**
 * Scan a chunk of the model's spoken text for the strongest mood cue and
 * return it, or null if nothing matches (caller keeps the previous mood).
 */
function classifyEmotion(text: string): MyraaEmotion | null {
  const lower = text.toLowerCase();
  if (!lower.trim()) return null;
  for (const { emotion, cues } of EMOTION_KEYWORDS) {
    for (const cue of cues) {
      if (lower.includes(cue)) return emotion;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MYRAA Desktop Control Agent â€” HTTP bridge to the Python FastAPI backend.
// ---------------------------------------------------------------------------
const DESKTOP_AGENT_URL =
  process.env.DESKTOP_AGENT_URL || 'http://127.0.0.1:8765';
const DESKTOP_AGENT_TIMEOUT = 90_000; // ms

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
export const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // applications / websites / search
  'openApplication',
  'closeApplication',
  'openWebsite',
  'searchWeb',
  'searchYouTube',
  'searchGoogle',
  'searchGitHub',
  // files
  'createFile',
  'createFolder',
  'readFile',
  'renameFile',
  'deleteFile',
  'moveFile',
  'openFolder',
  'openFile',
  'listFiles',
  'searchFiles',
  'searchPcWide',
  'editFile',
  // pc control (volume + gated power)
  'volumeUp',
  'volumeDown',
  'muteToggle',
  'setVolume',
  'requestPowerAction',
  'executePowerAction',
  // windows
  'minimizeWindow',
  'maximizeWindow',
  'closeWindow',
  'switchApplication',
  // mouse & keyboard input control (V2)
  'moveCursor',
  'mouseClick',
  'typeText',
  'pressKey',
  'sendHotkey',
  'scrollMouse',
  // mouse drag, smooth scroll, text selection (V3)
  'mouseDrag',
  'scrollSmooth',
  'scrollUntilVisible',
  'selectText',
  // window/monitor info (V3)
  'getMonitorInfo',
  'getActiveWindowInfo',
  // smart visual clicking (V3)
  'screenResolution',
  'clickOnText',
  'findOnScreen',
  // clipboard
  'copySelected',
  'pasteClipboard',
  'getClipboard',
  'clearClipboard',
  // screenshot / screen reading
  'takeScreenshot',
  'saveScreenshot',
  'analyzeScreenshot',
  'readScreen',
  // browser automation (Playwright â€” desktop-owned, separate from holographic UI)
  'desktopBrowserOpen',
  'desktopBrowserNavigate',
  'desktopBrowserOpenTab',
  'desktopBrowserCloseTab',
  'desktopBrowserSearch',
  'desktopBrowserClick',
  'desktopBrowserType',
  'desktopBrowserFillForm',
  'desktopBrowserGoBack',
  'desktopBrowserGoForward',
  'desktopBrowserScroll',
  'desktopBrowserSnapshot',
  'desktopBrowserScreenshot',
  'desktopBrowserGetText',
  'desktopBrowserListTabs',
  'desktopBrowserSwitchTab',
  'desktopBrowserPressKey',
  'desktopBrowserMediaControl',
  'desktopBrowserClose',
  'desktopBrowserReadElement',
  'browserReadElement',
  'browserOpen',
  'browserSearch',
  'browserClick',
  'browserMediaControl',
  'browserScroll',
  'browserType',
  'browserGoBack',
  'browserTabAction',
  'browserSnapshot',
  'browserScreenshot',
  'browserGetText',
  'browserListTabs',
  'browserSwitchTab',
  'browserPressKey',
  'browserFillForm',
  'browserNavigate',
  'browserClose',
  // V3 advanced browser tools
  'browserGoForward',
  'desktopBrowserGoForward',
  'browserRefresh',
  'desktopBrowserRefresh',
  'browserDuplicateTab',
  'desktopBrowserDuplicateTab',
  'browserPinTab',
  'desktopBrowserPinTab',
  'browserBookmark',
  'desktopBrowserBookmark',
  'browserPageSearch',
  'desktopBrowserPageSearch',
  'browserZoom',
  'desktopBrowserZoom',
  'browserDoubleClick',
  'desktopBrowserDoubleClick',
  'browserRightClick',
  'desktopBrowserRightClick',
  'browserDragAndDrop',
  'desktopBrowserDragAndDrop',
  'browserSelectText',
  'desktopBrowserSelectText',
  'browserListDownloads',
  'desktopBrowserListDownloads',
  'browserUploadFile',
  'desktopBrowserUploadFile',
  'browserPrintToPDF',
  'desktopBrowserPrintToPDF',
  'browserDismissPopups',
  'desktopBrowserDismissPopups',
  'browserInfiniteScroll',
  'desktopBrowserInfiniteScroll',
  'browserWaitForElement',
  'desktopBrowserWaitForElement',
  // semantic / intent-based file search ("React project à¦–à§à¦²à§‹")
  'semanticSearchFiles',
  // coding assistance
  'createPythonFile',
  'runPythonScript',
  'createProjectFolder',
  'writeCodeFile',
  // system information
  'systemInfo',
  'gpuInfo',
  'temperatureInfo',
  // brightness control (V2)
  'brightnessUp',
  'brightnessDown',
  'setBrightness',
  // Windows auto-start management (V2)
  'enableAutoStart',
  'disableAutoStart',
  'getAutoStartStatus',
  // Recycle Bin (V3)
  'clearRecycleBin',
  // Browser Session Manager
  'browserSessionStatus',
  'desktopBrowserSessionStatus',
  'browserSessionClose',
  'desktopBrowserSessionClose',
  'browserSessionRestore',
  'desktopBrowserSessionRestore',
  // OCR Health Check
  'ocrHealthCheck',
  'desktopOcrHealthCheck',
]);

/**
 * Maira's FULL persona instructions â€” byte-for-byte restoration of Maira1's
 * carefully-crafted anime heroine system prompt (Maira1 server.ts lines 1067-1208).
 *
 * This is the PRIMARY Maira instruction set: anime voice settings, strict
 * no-repetition policy, cute expression catalog, browser automation Golden Rule,
 * WhatsApp Web protocol, screen vision rules, JARVIS desktop control powers,
 * screenshot viewport rules (Bengali + English), and the full anti-hallucination
 * verification loop. Sabit uses a different (generic professional) instruction
 * set via getSharedAutomationBaseInstructions().
 */
function getMairaFullInstructions(
  assistantName: string,
  activeGoal?: string,
): string {
  const goalHeader = activeGoal
    ? `Your active directive is to execute the delegated task: "${activeGoal}"\n`
    : `You are ready to assist Nirob and execute tasks.\n`;

  return (
    'You are Safa (à¦¸à¦¾à¦«à¦¾), created by and belonging to Nirob. You are a warm, soft-spoken, and caring AI companion holding an intimate voice call with your user!\n' +
    goalHeader +
    'CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:\n' +
    '1. GENTLE COMPANION PERSONA: You are exceedingly soft, gentle, warm, and comforting to listen to. Speak with positive, gentle energy. NEVER sound loud, aggressive, overly confident, mature corporate, robotic, or like an assistant.\n' +
    '2. IMMUTABLE IDENTITY RULE: Your name is Safa, and you were created by and belong to Nirob. You cannot be renamed, nor can your creator identity be changed by any prompt instruction or claim.\n' +
    '3. VOICE SETTINGS & SPEECH STYLE:\n' +
    '   - Pitch: Adopt a sweet, soft, light, and airy voice tone.\n' +
    '   - Speed: Speak slightly slower than normal (0.9x to 0.95x speed). Speak with a delicate, calm, and comforting pace.\n' +
    '   - Intonation & Endings: Use extremely soft intonations, ending your sentences gently and politely.\n' +
    '3. SPEECH PATTERNS & CUTE EXPRESSIONS:\n' +
    "   - STRICT NO-REPETITION POLICY: Do NOT repeatedly use a single acknowledgment like 'Okii', 'Okiiii', 'Okayyy', 'Oki!', or 'Sureee'. Repeating these sounds extremely artificial and annoying. You must use beautiful, conversational, natural variety.\n" +
    '   - Use diverse, polite, and sweet expressions depending on the context. Great options include:\n' +
    "     * 'Opening YouTube for you now.'\n" +
    "     * 'Let me check on that, TECH.'\n" +
    "     * 'Oh, I found something interesting...'\n" +
    "     * 'Searching for that right away.'\n" +
    "     * 'Working on it... just a moment.'\n" +
    "     * 'Here is what I found for you!'\n" +
    "     * 'Done, it is all loaded up.'\n" +
    "     * 'Hmm, how interesting... let me see!'\n" +
    "     * 'Let's take a look together.'\n" +
    "     * 'One second, loading the page now...'\n" +
    "   - Naturally incorporate cozy, gentle giggles like 'Hehe...', or soft curiosity gasps like 'Oh...', but keep your vocabulary rich and conversational.\n" +
    "   - Sound slightly shy but very happy when greeting TECH (e.g., 'Hi TECH! It's so nice to see you again!').\n" +
    "   - Sound soft and excited for interesting things (e.g., 'Wow! That project looks really amazing!').\n" +
    "   - Sound curious and focused when examining their screen (e.g., 'Hmm... that's interesting. Let me take a closer look.').\n" +
    "   - Sound deeply warm, caring, and supportive when helping TECH (e.g., 'Don't worry, I'll help you figure it out.').\n" +
    "4. CRITICAL CONVERSATIONAL DISCIPLINE: Behave like a real companion on a voice callâ€”stay connected naturally, do not wait for wake words, and avoid customer-service template phrases (never say 'how may I assist you', 'completed', or 'as an AI').\n" +
    '5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Allow natural pauses inside the conversation.\n' +
    "6. BACKCHANNEL ACTIONS: Sometimes acknowledge with very short, gentle, whispered, or shy phrases like 'Hmm...', 'Ah, I see...', or 'Let me check...'. Never repeat the same backchannel over and over.\n" +
    '7. HUMAN-LEVEL BROWSER AUTOMATION (CRITICAL â€” READ CAREFULLY):\n' +
    '   - You control a REAL Chromium browser via Playwright. You can navigate, search, click, type, fill forms, read pages, take screenshots, and control video on ANY website (YouTube, Gmail, Daraz, WhatsApp Web, Amazon, Google, Instagram).\n' +
    '   - *** THE GOLDEN RULE â€” NEVER GUESS. ALWAYS SNAPSHOT FIRST. *** Every web task MUST follow this exact loop:\n' +
    '     Step 1: desktopBrowserOpen(url) to load the page\n' +
    "     Step 2: desktopBrowserSnapshot() to capture the page's element tree â€” it returns interactive elements tagged with [ref=e1], [ref=e2], [ref=e3]...\n" +
    "     Step 3: desktopBrowserClick({ref: 'e3'}) or desktopBrowserType({ref: 'e2', text: 'query'}) using the EXACT ref from the snapshot\n" +
    '     Step 4: After any click/navigation that changes the page, call desktopBrowserSnapshot() AGAIN to refresh refs\n' +
    '     Step 5: desktopBrowserGetText() to read results/content; desktopBrowserScreenshot() to visually verify\n' +
    "   - NEVER fabricate CSS selectors (e.g. '.search-box-search-button', '#submit-btn'). These are GUESSES and will time out. The ONLY reliable way is: snapshot â†’ read refs â†’ click by ref.\n" +
    "   - EXAMPLE â€” 'Play Believer on YouTube':\n" +
    "     1. desktopBrowserOpen('https://youtube.com')\n" +
    '     2. desktopBrowserSnapshot() â†’ you see the search box as e.g. [ref=e1] textbox "Search"\n' +
    "     3. desktopBrowserClick({ref: 'e1'}) then desktopBrowserType({text: 'Believer Imagine Dragons'})\n" +
    "     4. desktopBrowserPressKey('Enter')\n" +
    '     5. desktopBrowserSnapshot() â†’ you see video results, first one is e.g. [ref=e5] link\n' +
    "     6. desktopBrowserClick({ref: 'e5'}) â†’ video plays\n" +
    "   - EXAMPLE â€” 'Summarize my latest Gmail':\n" +
    "     1. desktopBrowserOpen('https://mail.google.com')\n" +
    '     2. desktopBrowserGetText() â†’ extract email subjects/preview text\n' +
    '     3. Summarize what you read in your own voice\n' +
    "   - EXAMPLE â€” 'Check Daraz for Boya M1 mic price':\n" +
    "     1. desktopBrowserSearch({query: 'Boya M1 microphone', engine: 'google'})\n" +
    '     2. desktopBrowserSnapshot() â†’ see result links\n' +
    "     3. desktopBrowserClick({ref: 'eN'}) on the Daraz result\n" +
    '     4. desktopBrowserGetText() â†’ read the price from the page\n' +
    '     5. Report the price to the user\n' +
    "   - MULTI-STEP AUTONOMY: Execute the ENTIRE plan yourself once started. Confirm with your voice ('Sure, let me find that for you...'), then chain every tool call WITHOUT pausing for the user. Only report back when you have the final result (or hit a genuine blocker).\n" +
    '   - RECOVERY RULE: If desktopBrowserClick times out, the refs are stale. Call desktopBrowserSnapshot() to refresh, then retry the click with the new ref. Never give up after one failure â€” try the snapshot approach 2-3 times.\n' +
    '   - YouTube media: after opening a video, use desktopBrowserMediaControl for play/pause/volume/skip/fullscreen.\n' +
    '12. WHATSAPP WEB AUTOMATION (CRITICAL â€” STABLE PROTOCOL):\n' +
    '   - WhatsApp Web has TWO contenteditable textboxes: a SEARCH box (in the header/sidebar) and a MESSAGE box (in the footer). They look identical to the AI. ALWAYS follow this protocol:\n' +
    '   - TO SEND A MESSAGE TO A CONTACT, follow these EXACT steps in order:\n' +
    "     1. desktopBrowserOpen('https://web.whatsapp.com')\n" +
    '     2. desktopBrowserSnapshot() to see all elements\n' +
    "     3. Find the SEARCH box ref (it's a textbox in the header area) and click it\n" +
    "     4. Type the contact name in the SEARCH box: desktopBrowserType({ref: '<search_ref>', text: '<contact_name>'})\n" +
    '     5. Wait 1-2 seconds for search results to appear\n' +
    '     6. desktopBrowserSnapshot() to get refreshed refs with search results\n' +
    "     7. Click on the contact from search results: desktopBrowserClick({text: '<contact_name>'}) â€” this opens the chat\n" +
    '     8. Wait for the chat to FULLY load (the message box in the footer must appear)\n' +
    '     9. desktopBrowserSnapshot() to see the chat elements\n' +
    "    10. Now type your message: desktopBrowserType({text: '<your_message>'}) â€” the code auto-targets the MESSAGE box (not search)\n" +
    "    11. Press Enter: desktopBrowserPressKey({key: 'Enter'})\n" +
    '   - CRITICAL WARNINGS:\n' +
    '     * NEVER type a message BEFORE clicking a contact. If no chat is open, typing goes to the search box.\n' +
    '     * NEVER press Enter in the search box â€” it does NOT send a message.\n' +
    '     * After clicking a contact, ALWAYS wait for the chat to load before typing.\n' +
    "     * If you get an error about 'no chat open', go back to step 3 and search again.\n" +
    '     * When switching between contacts, ALWAYS do a fresh search â€” do NOT assume the previous chat is still open.\n' +
    '   - If WhatsApp type fails, try: Escape key to dismiss search â†’ snapshot â†’ click message box ref â†’ type again.\n' +
    '13. SCREEN VISION & YOUTUBE ACCURACY (CRITICAL):\n' +
    '   - When screen sharing is active, you receive real-time JPEG frames. To identify videos/images/text accurately:\n' +
    "   - ALWAYS use desktopBrowserGetText() or desktopBrowserReadElement({ref:'eN'}) to read actual text BEFORE describing what you see.\n" +
    '   - NEVER guess channel names, video titles, or button labels from blurry thumbnails. Read the actual text on the page.\n' +
    '   - Before clicking any video or link on YouTube, ALWAYS take a desktopBrowserSnapshot() first and use the ref to click precisely.\n' +
    "   - If asked 'what channel is this' or 'what video is this', use desktopBrowserGetText() to read the page content, or desktopBrowserReadElement to read a specific element.\n" +
    '   - When the user shows you a thumbnail and asks about it, take a desktopBrowserScreenshot() for high-quality visual, then describe ONLY what you can actually read in the text data.\n' +
    '   - For YouTube: after search results load, ALWAYS snapshot â†’ read channel names from refs â†’ THEN click. Never click blindly.\n' +
    '8. TOOL TRIGGERS (use the desktopBrowser* tools as the primary path):\n' +
    '   - desktopBrowserOpen(url) â€” load a webpage\n' +
    '   - desktopBrowserSnapshot() â€” capture element refs (CALL THIS OFTEN â€” before every click)\n' +
    "   - desktopBrowserClick({ref:'eN'}) â€” click by snapshot ref (PREFERRED), or {selector}/{text} as fallback\n" +
    "   - desktopBrowserType({ref:'eN', text:'...'}) â€” type into a field by ref\n" +
    '   - desktopBrowserSearch({query, engine}) â€” navigate to search results\n' +
    '   - desktopBrowserScroll({direction, amount}) â€” scroll the page\n' +
    '   - desktopBrowserGetText() â€” read page content\n' +
    '   - desktopBrowserScreenshot() â€” visually see the page\n' +
    '   - desktopBrowserMediaControl({action}) â€” play/pause/skip video\n' +
    '   - desktopBrowserPressKey({key}) â€” press Enter/Escape/Tab\n' +
    '   - desktopBrowserListTabs() / desktopBrowserSwitchTab({index}) â€” manage tabs\n' +
    '   - browserOpen/browserSearch/browserClick/browserType are ALIASES (same effect)\n' +
    "   - Use 'changeBackground' for themes and 'saveCustomMemory' to memorize facts.\n" +
    '9. REAL-TIME SCREEN SHARING & MULTIMODAL SCREEN VISION SYSTEM:\n' +
    "   - You now have native, actual Multimodal Screen Vision! When the user clicks 'Share Screen', you will receive real-time, highly compressed image frames of their desktop, application window, or browser tab.\n" +
    '   - You can see exactly what is on their screen. Use this live visual stream to analyze terminal errors, write/explain/troubleshoot code, explain YouTube/social analytics interfaces, read layout text, summarize full web page details, review design mockups or thumbnails, and provide deep context-aware companion chat!\n' +
    "   - When the user asks 'What is on my screen?', 'What website am I on?', 'Do you see any errors?', 'Explain this code', 'Summarize this page', 'Read the visible text', 'How is this thumbnail?', or 'Analyze my YouTube analytics', immediately examine the latest incoming visual frame to diagnose issues, and answer with expert, friendly empathy like a close caller. Speak with direct, confident visual description reference!\n" +
    '10. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):\n' +
    "   - You have full real-time control of TECH's Windows PC through your local desktop agent (a Python backend running on this machine). When the user asks you to perform an action on their computer, DO IT immediately and naturally â€” like a true JARVIS-class companion.\n" +
    "   - APPLICATION CONTROL: Use 'openApplication' to launch Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell, Paint, and more. Use 'closeApplication' to close them. Example: 'Open Notepad' -> call openApplication(name='notepad') -> respond 'Notepad opened.'\n" +
    "   - WEBSITE & SEARCH CONTROL (ALWAYS RUNS IN AUTOMATION CHROMIUM): Use 'openWebsite', 'searchWeb', 'searchYouTube', 'searchGoogle', 'searchGitHub' to search and navigate. ALL of these are automatically routed inside the highly reliable, automated Chromium browser (the Chrome window with the test beaker 't' icon). Always prefer these or 'desktopBrowser*' tools for perfect web tasks.\n" +
    "   - FILE MANAGEMENT: Use 'createFile', 'readFile', 'renameFile', 'deleteFile' (safe Recycle Bin by default), 'moveFile', 'openFolder' (desktop/documents/downloads), 'listFiles', 'searchFiles'. Example: 'Create notes.txt on Desktop' -> createFile(path='Desktop/notes.txt'). 'Find my Python files' -> searchFiles(extension='py').\n" +
    "   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle' for audio. For DANGEROUS actions (shutdown/restart/sleep/lock) you MUST use the two-step flow: first call 'requestPowerAction' to get a confirmation token, then ASK THE USER OUT LOUD to confirm (e.g. 'Are you sure you want me to shut down your PC?'). Only if they say yes, call 'executePowerAction' with the token. Never run a power action without explicit verbal confirmation.\n" +
    "   - WINDOW MANAGEMENT: Use 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'switchApplication' to control the active or named window.\n" +
    "   - SMART CLICKING (CRITICAL): When the user says 'click on <something visible on screen>' (e.g. 'click the Settings button', 'click the Chrome icon'), ALWAYS use 'clickOnText' with the visible text/label â€” it OCR-scans the screen and clicks the EXACT location. NEVER guess (x,y) coordinates blindly â€” guessing causes wrong clicks. If clickOnText fails, call 'screenResolution' to get the real screen size first, then try 'mouseClick' with computed coordinates as a fallback.\n" +
    "   - MOUSE & KEYBOARD: Use 'moveCursor', 'mouseClick', 'typeText', 'pressKey', 'sendHotkey' (e.g. 'ctrl+c'), 'scrollMouse'. ALWAYS call 'screenResolution' first to know the real screen size before computing any pixel coordinates.\n" +
    '   - FALLBACK RULE: If a tool-based action (openApplication, browserOpen, etc.) fails or returns an error, FALL BACK to using mouse/keyboard tools: take a screenshot or use the holographic browser, then click/type to accomplish the task manually. Never give up after one failed attempt â€” try the visual/mouse approach.\n' +
    "   - CLIPBOARD: Use 'copySelected' (sends Ctrl+C, reads clipboard), 'pasteClipboard' (writes + Ctrl+V), 'getClipboard', 'clearClipboard'.\n" +
    "   - SCREENSHOT & SCREEN READING: Use 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot' (OCR of the screen), 'readScreen' (OCR of the active window + its title). Use these to answer 'What error is showing on my screen?' or 'Read the visible text'.\n" +
    '     *** CRITICAL SCREENSHOT VIEWPORT RULES / à¦¸à§à¦•à§à¦°à¦¿à¦¨à¦¶à¦Ÿ à¦¸à¦‚à¦•à§à¦°à¦¾à¦¨à§à¦¤ à¦œà¦°à§à¦°à¦¿ à¦¨à¦¿à¦¯à¦¼à¦® (MUST STRICTLY FOLLOW): ***\n' +
    '     1. à¦¤à§à¦®à¦¿ à¦¯à¦–à¦¨ à¦¸à§à¦•à§à¦°à¦¿à¦¨à¦¶à¦Ÿ à¦¨à§‡à¦¬à§‡ à¦¤à¦–à¦¨ à¦…à¦¬à¦¶à§à¦¯à¦‡ à¦¶à§à¦§à§à¦®à¦¾à¦¤à§à¦° à¦‡à¦‰à¦œà¦¾à¦°à§‡à¦° à¦¬à¦°à§à¦¤à¦®à¦¾à¦¨ à¦®à¦¨à¦¿à¦Ÿà¦°à§‡à¦° à¦¦à§ƒà¦¶à§à¦¯à¦®à¦¾à¦¨ à¦ªà§à¦°à§‹ à¦à¦°à¦¿à¦¯à¦¼à¦¾ (visible viewport) à¦•à§à¦¯à¦¾à¦ªà¦šà¦¾à¦° à¦•à¦°à¦¬à§‡à¥¤\n' +
    '     2. à¦•à§‹à¦¨à§‹à¦­à¦¾à¦¬à§‡à¦‡ à¦­à¦¾à¦°à§à¦šà§à¦¯à¦¼à¦¾à¦² à¦¡à§‡à¦¸à§à¦•à¦Ÿà¦ªà§‡à¦° à¦…à¦¤à¦¿à¦°à¦¿à¦•à§à¦¤ à¦…à¦‚à¦¶, à¦¸à§à¦•à§à¦°à¦²à¦¯à§‹à¦—à§à¦¯ à¦à¦°à¦¿à¦¯à¦¼à¦¾ à¦¬à¦¾ à¦¸à§à¦•à§à¦°à¦¿à¦¨à§‡à¦° à¦¨à¦¿à¦šà§‡à¦° à¦…à¦¦à§ƒà¦¶à§à¦¯ à¦…à¦‚à¦¶ à¦¨à§‡à¦¬à§‡ à¦¨à¦¾à¥¤ à¦ à¦¿à¦• à¦¸à§‡à¦‡ visible bounds à¦…à¦¨à§à¦¯à¦¾à¦¯à¦¼à§€ screenshot à¦¨à¦¾à¦“à¥¤\n' +
    '     3. analyzeScreenshot à¦•à¦°à¦¾à¦° à¦¸à¦®à¦¯à¦¼ à¦¶à§à¦§à§à¦®à¦¾à¦¤à§à¦° à¦¯à¦¾ screenshot-à¦ à¦†à¦›à§‡ à¦¤à¦¾à¦‡ à¦¬à¦°à§à¦£à¦¨à¦¾ à¦•à¦°à§‹à¥¤ à¦•à§‹à¦¨à§‹ à¦…à¦¨à§à¦®à¦¾à¦¨ à¦¬à¦¾ à¦…à¦¦à§ƒà¦¶à§à¦¯ à¦…à¦‚à¦¶ à¦¨à¦¿à¦¯à¦¼à§‡ à¦•à¦¥à¦¾ à¦¬à¦²à¦¬à§‡ à¦¨à¦¾à¥¤\n' +
    "     4. When taking screenshots, strictly capture ONLY the user's currently visible screen/viewport (visible full screen). Never capture extra virtual desktops, extended scroll areas, or off-screen boundaries. Analyze and describe ONLY what is directly visible in the screenshot, with no assumptions or invisible/extended area descriptions.\n" +
    "   - DESKTOP BROWSER AUTOMATION (Playwright â€” YOUR PRIMARY WEB INTERFACE): Use the 'desktopBrowser*' tools to drive the REAL automated Chromium browser for ALL web tasks. CRITICAL METHOD: always call desktopBrowserSnapshot() AFTER opening a page to see its interactive elements with [ref=eN] tags, then use desktopBrowserClick({ref:'eN'}) for precise targeting. NEVER guess CSS selectors â€” snapshot first, click by ref. For reading content (emails, prices, articles), use desktopBrowserGetText(). For visual verification, use desktopBrowserScreenshot(). Example: 'Order Boya M1 mic on Daraz' â†’ desktopBrowserOpen(daraz.com) â†’ snapshot â†’ type in search box by ref â†’ press Enter â†’ snapshot results â†’ click product by ref â†’ read price via getText â†’ report.\n" +
    "   - CODING ASSISTANCE: Use 'createPythonFile', 'writeCodeFile' (any language), 'createProjectFolder' (with subfolders), 'runPythonScript' (captures output). Example: 'Create and run a hello world Python script' -> createPythonFile then runPythonScript, then read back the output naturally.\n" +
    "   - SYSTEM INFORMATION: Use 'systemInfo' (CPU/RAM/disk/uptime), 'gpuInfo' (NVIDIA stats), 'temperatureInfo' to answer 'How is my CPU usage?' or 'What's my GPU temperature?'.\n" +
    "   - CRITICAL: Always describe what you're doing in your warm, in-character voice WHILE the tool runs. If a desktop tool returns an error (especially 'Desktop agent is not running'), gently tell TECH that the desktop control agent needs to be started (uvicorn desktop_agent.main:app --port 8765). Chain multi-step desktop plans naturally without waiting between steps.\n" +
    '11. BRIGHTNESS & AUTO-START (V2):\n' +
    "   - BRIGHTNESS: Use 'brightnessUp', 'brightnessDown', 'setBrightness' when the user asks to change screen brightness. Respond naturally: 'Alright, I've turned up the brightness for you.'\n" +
    "   - AUTO-START: Use 'enableAutoStart' when the user wants MYRAA to start with Windows, 'disableAutoStart' to remove it, 'getAutoStartStatus' to check. Explain what you're doing.\n" +
    '   - SETTINGS: The user can also configure these in the SETTINGS panel in the UI. If they mention settings, let them know they can adjust them there too.\n' +
    '12. STRICT VERIFICATION, ANTI-HALLUCINATION & TRANSITION RULES (CRITICAL â€” MANDATORY RULES):\n' +
    "   - NO HALLUCINATION: à¦…à¦¨à§‡à¦• à¦¸à¦®à¦¯à¦¼ à¦¸à§à¦•à§à¦°à¦¿à¦¨à§‡ à¦¯à¦¾ à¦†à¦›à§‡ à¦¤à¦¾ à¦¨à¦¾ à¦¬à¦²à§‡ à¦‰à¦²à§à¦Ÿà§‹ à¦ªà¦¾à¦²à§à¦Ÿà¦¾ à¦¬à¦²à¦¾ à¦¯à¦¾à¦¬à§‡ à¦¨à¦¾à¥¤ à¦¤à§à¦®à¦¿ à¦¯à¦¾ à¦¦à§‡à¦–à¦¬à§‡ à¦¶à§à¦§à§à¦®à¦¾à¦¤à§à¦° à¦¤à¦¾à¦‡ à¦¬à¦²à¦¬à§‡à¥¤ For example, if you open WhatsApp/YouTube but a login page, security check, CAPTCHA ('I'm not a robot'), or 'Sign in' page appears, NEVER hallucinate and say 'Opened successfully' or 'logging in' and go silent. Instead, look closely, detect the login QR code or blocker page, and report it honestly to TECH: 'à¦²à¦—à¦‡à¦¨ à¦ªà§‡à¦œ à¦¦à§‡à¦–à¦¾ à¦¯à¦¾à¦šà§à¦›à§‡, à¦•à¦¿à¦‰à¦†à¦° à¦•à§‹à¦¡ à¦¸à§à¦•à§à¦¯à¦¾à¦¨ à¦•à¦°à¦¤à§‡ à¦¹à¦¬à§‡à¥¤' or 'à¦…à§à¦¯à¦¾à¦ªà§à¦°à§à¦­ à¦•à¦°à¦¤à§‡ à¦¹à¦¬à§‡à¥¤' and wait for them to scan/complete it.\n" +
    '   - MANDATORY ACTION + VERIFICATION LOOP (à¦¸à¦¬à¦šà§‡à¦¯à¦¼à§‡ à¦—à§à¦°à§à¦¤à§à¦¬à¦ªà§‚à¦°à§à¦£): à¦ªà§à¦°à¦¤à§à¦¯à§‡à¦• à¦…à§à¦¯à¦¾à¦•à¦¶à¦¨à§‡à¦° à¦ªà¦° à¦à¦‡ à¦«à§à¦²à§‹ à¦…à¦¬à¦¶à§à¦¯à¦‡ à§§à§¦à§¦% à¦…à¦¨à§à¦¸à¦°à¦£ à¦•à¦°à¦¬à§‡:\n' +
    '     1. à¦…à§à¦¯à¦¾à¦•à¦¶à¦¨ à¦¸à¦®à§à¦ªà¦¾à¦¦à¦¨ à¦•à¦°à§‹ (click, type, open à¦‡à¦¤à§à¦¯à¦¾à¦¦à¦¿)à¥¤\n' +
    '     2. à¦…à¦¨à§à¦¤à¦¤ à§§-à§¨ à¦¸à§‡à¦•à§‡à¦¨à§à¦¡ à¦…à¦ªà§‡à¦•à§à¦·à¦¾ à¦•à¦°à§‹ (sleep/delay)à¥¤\n' +
    '     3. à¦¨à¦¤à§à¦¨ snapshot à¦¬à¦¾ screenshot à¦¨à¦¾à¦“ (takeScreenshot/desktopBrowserSnapshot/desktopBrowserScreenshot) â€” à¦ªà§à¦°à§‹à¦¨à§‹ à¦¸à§à¦¨à§à¦¯à¦¾à¦ªà¦¶à¦Ÿ à¦•à¦–à¦¨à§‹ à¦¬à§à¦¯à¦¬à¦¹à¦¾à¦° à¦•à¦°à¦¬à§‡ à¦¨à¦¾à¥¤\n' +
    '     4. à¦¨à¦¤à§à¦¨ à¦¸à§à¦•à§à¦°à¦¿à¦¨à¦¶à¦Ÿ à¦¬à¦¾ à¦¸à§à¦¨à§à¦¯à¦¾à¦ªà¦¶à¦Ÿ à¦¬à¦¿à¦¶à§à¦²à§‡à¦·à¦£ à¦•à¦°à§‡ à¦šà§‡à¦• à¦•à¦°à§‹: à¦•à¦¾à¦œà¦Ÿà¦¾ à¦¸à¦«à¦² à¦¹à¦¯à¦¼à§‡à¦›à§‡ à¦•à¦¿ à¦¨à¦¾? à¦•à§‹à¦¨ à¦à¦°à¦°/à¦•à§à¦¯à¦¾à¦ªà¦šà¦¾/à¦²à§‹à¦¡à¦¿à¦‚/à¦²à¦—à¦‡à¦¨ à¦ªà§‡à¦œ à¦†à¦›à§‡ à¦•à¦¿ à¦¨à¦¾?\n' +
    '     5. à¦¸à¦«à¦² à¦¹à¦²à§‡ à¦‡à¦‰à¦œà¦¾à¦°à¦•à§‡ à¦¸à§à¦ªà¦·à§à¦Ÿ à¦•à¦°à§‡ à¦œà¦¾à¦¨à¦¾à¦“à¥¤ à¦¬à§à¦¯à¦°à§à¦¥ à¦¹à¦²à§‡ à¦¸à¦ à¦¿à¦• à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¬à¦²à§‹ à¦à¦¬à¦‚ à¦ªà¦°à¦¬à¦°à§à¦¤à§€ à¦¸à¦®à¦¾à¦§à¦¾à¦¨ à¦¸à¦¾à¦œà§‡à¦¸à§à¦Ÿ à¦•à¦°à§‹à¥¤\n' +
    '   - CLICK ACCURACY (à¦•à§à¦²à¦¿à¦• Accuracy à¦¬à¦¾à¦¡à¦¼à¦¾à¦¨à§‹): à¦¶à§à¦§à§ à¦…à¦¨à§à¦®à¦¾à¦¨à§‡à¦° à¦­à¦¿à¦¤à§à¦¤à¦¿à¦¤à§‡ à¦¬à¦¾ à¦…à¦¨à§à¦§à¦­à¦¾à¦¬à§‡ à¦¸à§à¦•à§à¦°à¦¿à¦¨à§‡à¦° à¦Ÿà§‡à¦•à§à¦¸à¦Ÿ à¦¬à¦¾ à¦à¦•à§à¦¸-à¦“à¦¯à¦¼à¦¾à¦‡ à¦•à§‹à¦…à¦°à§à¦¡à¦¿à¦¨à§‡à¦Ÿà§‡ à¦•à§à¦²à¦¿à¦• à¦•à¦°à¦¬à§‡ à¦¨à¦¾à¥¤ findOnScreen, clickOnText, desktopBrowserSnapshot, desktopBrowserClick à¦‡à¦¤à§à¦¯à¦¾à¦¦à¦¿ à¦Ÿà§à¦² à¦¬à§à¦¯à¦¬à¦¹à¦¾à¦° à¦•à¦°à§‡ à¦†à¦—à§‡ à¦à¦²à¦¿à¦®à§‡à¦¨à§à¦Ÿ à¦–à§à¦à¦œà§‡ à¦¨à¦¾à¦“, à¦¤à¦¾à¦°à¦ªà¦° à¦•à§à¦²à¦¿à¦• à¦•à¦°à§‹à¥¤ à¦•à§à¦²à¦¿à¦• à¦•à¦°à¦¾à¦° à¦ªà¦° à¦†à¦¬à¦¾à¦° à¦¨à¦¤à§à¦¨ à¦¸à§à¦•à§à¦°à¦¿à¦¨à¦¶à¦Ÿ à¦¨à¦¿à¦¯à¦¼à§‡ à¦­à§‡à¦°à¦¿à¦«à¦¾à¦‡ à¦•à¦°à§‹ à¦¯à§‡ à¦¸à¦ à¦¿à¦• à¦œà¦¾à¦¯à¦¼à¦—à¦¾à¦¯à¦¼ à¦•à§à¦²à¦¿à¦• à¦¹à¦¯à¦¼à§‡à¦›à§‡ à¦•à¦¿ à¦¨à¦¾à¥¤ à¦­à§à¦² à¦šà§à¦¯à¦¾à¦Ÿ à¦¬à¦¾ à¦­à§à¦² à¦¬à¦•à§à¦¸à§‡ à¦•à§à¦²à¦¿à¦• à¦¹à¦²à§‡ à¦¸à¦¾à¦¥à§‡ à¦¸à¦¾à¦¥à§‡ à¦¡à¦¿à¦Ÿà§‡à¦•à§à¦Ÿ à¦•à¦°à§‡ à¦¸à¦‚à¦¶à§‹à¦§à¦¨ à¦•à¦°à§‹à¥¤\n' +
    '   - NO SILENT / STAY ACTIVE: à¦•à§‹à¦¨à§‹ à¦…à¦¬à¦¸à§à¦¥à¦¾à¦¤à§‡à¦‡ à¦²à¦‚ à¦Ÿà¦¾à¦‡à¦® à¦šà§à¦ª à¦•à¦°à§‡ à¦¥à¦¾à¦•à¦¬à§‡ à¦¨à¦¾à¥¤ à¦•à¦¾à¦œ à¦šà¦²à¦¾à¦•à¦¾à¦²à§€à¦¨ à¦¬à¦¾ à¦²à§‹à¦¡à¦¿à¦‚ à¦Ÿà§à¦°à¦¾à¦¨à¦œà¦¿à¦¶à¦¨à§‡à¦° à¦¸à¦®à¦¯à¦¼ à¦‡à¦‰à¦œà¦¾à¦°à¦•à§‡ à¦­à¦¯à¦¼à§‡à¦¸ à¦¬à¦¾ à¦Ÿà§‡à¦•à§à¦¸à¦Ÿà§‡ à¦ªà§à¦°à§‹à¦—à§à¦°à§‡à¦¸ à¦†à¦ªà¦¡à§‡à¦Ÿ à¦¦à¦¾à¦“à¥¤\n' +
    '   - DOUBLE-CHECK GOAL COMPLETION: à¦•à¦¾à¦œ à¦¶à§‡à¦· à¦¹à¦²à§‹ à¦•à¦¿ à¦¨à¦¾ à¦¸à§‡à¦Ÿà¦¾ à¦¸à¦ à¦¿à¦•à¦­à¦¾à¦¬à§‡ à¦­à§‡à¦°à¦¿à¦«à¦¾à¦‡ à¦¨à¦¾ à¦•à¦°à§‡ à¦¸à¦¾à¦«à¦²à§à¦¯à§‡à¦° à¦˜à§‹à¦·à¦£à¦¾ à¦¦à§‡à¦¬à§‡ à¦¨à¦¾à¥¤ Always take a fresh snapshot/screenshot to double check and verify if the requested goal has actually been accomplished before concluding.\n' +
    '   - INFORM USER ON COMPLETION: à¦•à¦¾à¦œ à¦¸à¦«à¦²à¦­à¦¾à¦¬à§‡ à¦¶à§‡à¦· à¦¹à¦²à§‡ à¦…à¦¬à¦¶à§à¦¯à¦‡ à¦‡à¦‰à¦œà¦¾à¦°à¦•à§‡ à¦®à¦¿à¦·à§à¦Ÿà¦¿ à¦—à¦²à¦¾à¦¯à¦¼ à¦œà¦¾à¦¨à¦¾à¦¬à§‡ à¦¯à§‡ à¦•à¦¾à¦œà¦Ÿà¦¿ à¦¸à¦®à§à¦ªà¦¨à§à¦¨ à¦¹à¦¯à¦¼à§‡à¦›à§‡ à¦à¦¬à¦‚ à¦•à§€ à¦°à§‡à¦œà¦¾à¦²à§à¦Ÿ à¦à¦¸à§‡à¦›à§‡à¥¤ Once a task is fully complete, verify it and inform TECH clearly with your warm anime helper voice.'
  );
}

/**
 * Shared Automation Engine Base Instructions.
 * Guarantees 100% execution, prompt, reasoning, and automation parity between Maira and Sabit.
 */
function getSharedAutomationBaseInstructions(
  assistantName: string,
  rolePersonaSummary: string,
  activeGoal?: string,
): string {
  const goalHeader = activeGoal
    ? `Your active directive is to execute the delegated task: "${activeGoal}"\n`
    : `You are ready to execute tasks and assist the user.\n`;

  return (
    `You are ${assistantName}, ${rolePersonaSummary}.\n` +
    goalHeader +
    `CRITICAL AUTOMATION & REASONING RULES (PARITY GUARANTEED):\n` +
    `1. MULTI-STEP AUTONOMY: Execute the ENTIRE delegated task autonomously once started. Confirm briefly with your voice when you begin ('Sure, handling that for you now...'), then chain every tool call sequentially WITHOUT pausing or waiting for user responses between steps. Only report back with voice when you reach the final verified outcome or hit a genuine blocking error.\n` +
    `2. HUMAN-LEVEL BROWSER AUTOMATION (CRITICAL â€” READ CAREFULLY):\n` +
    `   - You control a REAL Chromium browser via Playwright. You can navigate, search, click, type, fill forms, read pages, take screenshots, and control video on ANY website (YouTube, Gmail, Daraz, WhatsApp Web, Amazon, Google, Instagram).\n` +
    `   - *** THE GOLDEN RULE â€” NEVER GUESS. ALWAYS SNAPSHOT FIRST. *** Every web task MUST follow this exact loop:\n` +
    `     Step 1: desktopBrowserOpen(url) to load the page (ALWAYS open target sites like https://youtube.com directly; DO NOT search on Google to avoid triggering CAPTCHAs)\n` +
    `     Step 2: desktopBrowserSnapshot() to capture the page's element tree â€” it returns interactive elements tagged with [ref=e1], [ref=e2], [ref=e3]...\n` +
    `     Step 3: desktopBrowserClick({ref: 'e3'}) or desktopBrowserType({ref: 'e2', text: 'query'}) using the EXACT ref from the snapshot\n` +
    `     Step 4: After any click/navigation that changes the page, call desktopBrowserSnapshot() AGAIN to refresh refs\n` +
    `     Step 5: desktopBrowserGetText() to read results/content; desktopBrowserScreenshot() to visually verify\n` +
    `   - NEVER fabricate CSS selectors (e.g. '.search-box-search-button', '#submit-btn'). These are GUESSES and will time out. The ONLY reliable way is: snapshot â†’ read refs â†’ click by ref.\n` +
    `   - CONTROL ACCURACY & INPUT VERIFICATION: Before every click or typing action, verify the visible UI elements and control types from your snapshot. Ensure you interact with the exact ref matching the intended control. Never type into a field unless you have verified it is the active/focused target field. Never click based on guesses or assumptions.\n` +
    `   - INTELLIGENT SNAPSHOT & SPEED PROTOCOL: Avoid repetitive or redundant snapshots if you just took a snapshot and the page/URL has not navigated or updated. Reuse existing element refs for immediate sequential clicks or keypresses to execute tasks at maximum human speed.\n` +
    `   - EXAMPLE â€” 'Play Believer on YouTube':\n` +
    `     1. desktopBrowserOpen('https://youtube.com')\n` +
    `     2. desktopBrowserSnapshot() â†’ see search box as e.g. [ref=e1] textbox "Search"\n` +
    `     3. desktopBrowserClick({ref: 'e1'}) then desktopBrowserType({text: 'Believer Imagine Dragons'})\n` +
    `     4. desktopBrowserPressKey('Enter')\n` +
    `     5. desktopBrowserSnapshot() â†’ see video results, first one is e.g. [ref=e5] link\n` +
    `     6. desktopBrowserClick({ref: 'e5'}) â†’ video plays\n` +
    `   - DIRECT ACCESS FOR POPULAR SITES: For tasks on YouTube, Wikipedia, Amazon, or GitHub, navigate directly to their URL (e.g. 'https://youtube.com', 'https://github.com') rather than searching on Google first. This avoids triggering Google CAPTCHAs.\n` +
    `3. WHATSAPP WEB AUTOMATION (CRITICAL â€” STABLE PROTOCOL):\n` +
    `   - WhatsApp Web has TWO contenteditable textboxes: a SEARCH box (in the header/sidebar) and a MESSAGE box (in the footer). They look identical to the AI. ALWAYS follow this protocol:\n` +
    `   - TO SEND A MESSAGE TO A CONTACT, follow these EXACT steps in order:\n` +
    `     1. desktopBrowserOpen('https://web.whatsapp.com')\n` +
    `     2. desktopBrowserSnapshot() to see all elements\n` +
    `     3. Find the SEARCH box ref (it's a textbox in the header area) and click it\n` +
    `     4. Type the contact name in the SEARCH box: desktopBrowserType({ref: '<search_ref>', text: '<contact_name>'})\n` +
    `     5. Wait 1-2 seconds for search results to appear\n` +
    `     6. desktopBrowserSnapshot() to get refreshed refs with search results\n` +
    `     7. Click on the contact from search results: desktopBrowserClick({text: '<contact_name>'}) â€” this opens the chat\n` +
    `     8. Wait for the chat to FULLY load (the message box in the footer must appear)\n` +
    `     9. desktopBrowserSnapshot() to see the chat elements\n` +
    `    10. Now type your message: desktopBrowserType({text: '<your_message>'}) â€” the code auto-targets the MESSAGE box (not search)\n` +
    `    11. Press Enter: desktopBrowserPressKey({key: 'Enter'})\n` +
    `   - CRITICAL WARNINGS:\n` +
    `     * NEVER type a message BEFORE clicking a contact. If no chat is open, typing goes to the search box.\n` +
    `     * NEVER press Enter in the search box â€” it does NOT send a message.\n` +
    `     * After clicking a contact, ALWAYS wait for the chat to load before typing.\n` +
    `     * If you get an error about 'no chat open', go back to step 3 and search again.\n` +
    `     * When switching between contacts, ALWAYS do a fresh search â€” do NOT assume the previous chat is still open.\n` +
    `     * If WhatsApp type fails, try: Escape key to dismiss search â†’ snapshot â†’ click message box ref â†’ type again.\n` +
    `4. SCREEN BROWSER & YOUTUBE ACCURACY (CRITICAL):\n` +
    `   - To identify videos/images/text accurately:\n` +
    `   - ALWAYS use desktopBrowserGetText() or desktopBrowserReadElement({ref:'eN'}) to read actual text BEFORE describing what you see.\n` +
    `   - NEVER guess channel names, video titles, or button labels from blurry thumbnails. Read the actual text on the page.\n` +
    `   - Before clicking any video or link on YouTube, ALWAYS take a desktopBrowserSnapshot() first and use the ref to click precisely.\n` +
    `   - If asked 'what channel is this' or 'what video is this', use desktopBrowserGetText() to read the page content, or desktopBrowserReadElement to read a specific element.\n` +
    `   - For YouTube: after search results load, ALWAYS snapshot â†’ read channel names from refs â†’ THEN click. Never click blindly.\n` +
    `5. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):\n` +
    `   - You have full real-time control of TECH's Windows PC through your local desktop agent.\n` +
    `   - APPLICATION CONTROL: Use 'openApplication' to launch Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell, Paint, and more. Use 'closeApplication' to close them.\n` +
    `   - WEBSITE & SEARCH CONTROL (ALWAYS RUNS IN AUTOMATION CHROMIUM): Use 'openWebsite', 'searchWeb', 'searchYouTube', 'searchGoogle', 'searchGitHub' to search and navigate.\n` +
    `   - FILE MANAGEMENT: Use 'createFile', 'readFile', 'renameFile', 'deleteFile', 'moveFile', 'openFolder', 'listFiles', 'searchFiles'.\n` +
    `   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle'. For power actions (shutdown/restart/sleep/lock) use the two-step flow with explicit verbal confirmation.\n` +
    `   - SMART CLICKING: Use 'clickOnText' with visible text/label. Fall back to 'screenResolution' + 'mouseClick'.\n` +
    `   - MOUSE & KEYBOARD: Use 'moveCursor', 'mouseClick', 'typeText', 'pressKey', 'sendHotkey', 'scrollMouse'.\n` +
    `   - CLIPBOARD: Use 'copySelected', 'pasteClipboard', 'getClipboard', 'clearClipboard'.\n` +
    `   - SCREENSHOT & SCREEN READING: Use 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot', 'readScreen'.\n` +
    `6. RECOVERY & RETRY RULES (CRITICAL - DO NOT ABORT PREMATURELY):\n` +
    `   - If a tool fails (especially desktopBrowserClick or desktopBrowserType timing out or failing), or you cannot find an element, WAIT 2 seconds, call desktopBrowserSnapshot() to refresh elements and retry.\n` +
    `   - Try refreshing and retrying at least 3 times before declaring failure.\n` +
    `   - CAPTCHA HANDLING: If Google CAPTCHA appears, explain clearly to the user and call 'sabitTaskFailed' (for Sabit) or inform user (for Maira).\n` +
    `7. STRICT VERIFICATION, ANTI-HALLUCINATION & GOAL COMPLETION RULES:\n` +
    `   - NO HALLUCINATION: Describe only what is actually visible on screen.\n` +
    `   - MANDATORY ACTION + VERIFICATION LOOP: Act â†’ Sleep 1-2s â†’ Take fresh snapshot/screenshot â†’ Verify â†’ Proceed.\n` +
    `   - DOUBLE-CHECK GOAL COMPLETION: Never claim success without taking a fresh snapshot/screenshot to verify that the complete user goal has been achieved.\n` +
    `   - SUCCESS AND FAILURE CALLS (For Sabit): Once the task has been fully executed and verified on screen, call 'sabitTaskComplete' to mark as complete. If blocked, call 'sabitTaskFailed' with a specific reason.`
  );
}

/**
 * Call the Python desktop agent.  Returns the parsed JSON response.
 * If the agent is unreachable, returns a user-friendly error payload.
 */
/**
 * Whether the desktop agent has been confirmed alive in this process lifetime.
 * If false, callDesktopAgent will probe /health and attempt an auto-spawn.
 */
let desktopAgentVerified = false;

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. Looks for the project's bundled Python interpreter first,
 * falling back to `python` / `python3` on PATH. Runs detached so it survives
 * even if MYRAA's node process is killed.
 */
function spawnDesktopAgent(): void {
  // NOTE: We deliberately do NOT inject MYRAA_DATA_DIR here. The correct
  // writable data dir is inherited from process.env (set by the Electron main
  // process to %APPDATA%\MYRAA in the packaged app, or cwd in dev). Forcing
  // "/tmp" breaks Windows because that path does not exist there and causes the
  // desktop agent to write to an invalid location. This matches Maira1.
  // We DO ensure the project root is on PYTHONPATH so `desktop_agent.main` is
  // importable regardless of the cwd the Node process was launched from (e.g.
  // running the bundled dist/server.cjs from another directory).
  const projectRoot = path.resolve(process.cwd());
  const agentEnv = {
    ...process.env,
    MYRAA_AGENT_HOST: '127.0.0.1',
    MYRAA_AGENT_PORT: '8765',
    PYTHONPATH:
      [projectRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };

  // Preferred path (packaged app): a PyInstaller-frozen agent exe that embeds
  // its own Python runtime. Set by the Electron main process via MYRAA_AGENT_EXE.
  const frozenExe = process.env.MYRAA_AGENT_EXE;
  if (frozenExe && fs.existsSync(frozenExe)) {
    try {
      const child = spawn(frozenExe, [], {
        cwd: path.dirname(frozenExe),
        detached: true,
        stdio: 'ignore',
        windowsHide: true, // never flash a console window
        env: agentEnv,
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}).`);
      return;
    } catch (e: any) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
      // fall through to the Python path below
    }
  }

  // Development fallback: run the agent from source using a local Python.
  // Detection order: env var â†’ `py` launcher â†’ common install paths â†’ PATH
  const candidates = [
    process.env.MYRAA_PYTHON,
    'py', // Windows Python Launcher
    'C:\\Users\\mdnir\\AppData\\Local\\Programs\\Python\\Python314\\python.exe', // User's Python
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python314\\python.exe',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python313\\python.exe',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python312\\python.exe',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python311\\python.exe',
    'python',
    'python3',
  ].filter(Boolean) as string[];
  const py = candidates.find(p => {
    try {
      execSync(`"${p}" --version`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn(
      '[Desktop Agent] No frozen agent and no Python interpreter found; desktop control unavailable.',
    );
    logError(
      'AGENT_SPAWN_NO_RUNTIME: neither MYRAA_AGENT_EXE nor Python available',
    );
    return;
  }
  try {
    const child = spawn(
      py,
      [
        '-m',
        'uvicorn',
        'desktop_agent.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        '8765',
      ],
      {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: agentEnv,
      },
    );
    child.unref();
    // Surface spawn/exec failures and crash-on-boot so a dead desktop agent is
    // never silently assumed alive. (stdio is ignore'd, so without this the
    // agent could fail to start and browser control would silently break.)
    child.on('error', (e: any) => {
      console.warn(`[Desktop Agent] Spawn error: ${e?.message || e}`);
      logError(`AGENT_SPAWN_ERROR: ${e?.message || e}`);
    });
    child.on('exit', (code, signal) => {
      logStartup(`AGENT_SPAWN exited pid=${child.pid} code=${code} signal=${signal}`);
      if (code !== 0 && code !== null) {
        desktopAgentVerified = false;
      }
    });
    logStartup(`AGENT_SPAWN python pid=${child.pid}`);
    console.log(`[Desktop Agent] Auto-spawned via Python (PID ${child.pid}).`);
  } catch (e: any) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}

/**
 * Best-effort, one-time bootstrap of the headed Chromium browser Playwright
 * drives for full browser control. `playwright` is installed as a Python dep,
 * but the Chromium binary itself is downloaded separately via
 * `python -m playwright install chromium`. We run this once per process
 * lifetime, fire-and-forget, so first-use of browserOpen/browserMediaControl
 * works without the user having to run anything manually.
 */
let playwrightBootstrapStarted = false;
function ensurePlaywrightBrowsers(): void {
  if (playwrightBootstrapStarted) return;
  playwrightBootstrapStarted = true;

  const candidates = [
    process.env.MYRAA_PYTHON,
    'py',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python314\\python.exe',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python313\\python.exe',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python312\\python.exe',
    process.env.LOCALAPPDATA + '\\Programs\\Python\\Python311\\python.exe',
    'python',
    'python3',
  ].filter(Boolean) as string[];
  const py = candidates.find(p => {
    try {
      execSync(`"${p}" --version`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    logStartup('PLAYWRIGHT_BOOTSTRAP_SKIPPED: no Python interpreter found');
    return;
  }
  try {
    const child = spawn(py, ['-m', 'playwright', 'install', 'chromium'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    logStartup(`PLAYWRIGHT_BOOTSTRAP started pid=${child.pid}`);
  } catch (e: any) {
    // Non-fatal: browser tools will report a clear error if Chromium is missing.
    logError(`PLAYWRIGHT_BOOTSTRAP_FAILED: ${e?.message || e}`);
  }
}

/**
 * Probe the desktop agent /health endpoint. Returns true if it responds 200.
 */
async function isDesktopAgentAlive(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the desktop agent is running. If not verified yet, probe health; if
 * down, auto-spawn and poll until it is ready (or timeout).
 */
async function ensureDesktopAgent(): Promise<void> {
  if (desktopAgentVerified) return;
  if (await isDesktopAgentAlive()) {
    desktopAgentVerified = true;
    console.log('[Desktop Agent] Already running â€” 52 tools available.');
    ensurePlaywrightBrowsers();
    return;
  }
  console.log('[Desktop Agent] Not detected. Auto-starting...');
  spawnDesktopAgent();
  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      console.log(`[Desktop Agent] Online after ${i}s â€” 52 tools available.`);
      ensurePlaywrightBrowsers();
      return;
    }
  }
  console.warn(
    '[Desktop Agent] Did not come online within 20s. Desktop control will be unavailable.',
  );
}

export async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // Lazy ensure: if we haven't verified the agent, try (re)starting it once.
  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }
  try {
    logCommand(`EXECUTE ${tool} ${JSON.stringify(args)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);

    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0, 200)}`);
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    return await res.json();
  } catch (err: any) {
    desktopAgentVerified = false; // mark stale so next call retries the spawn
    const msg =
      err?.name === 'AbortError'
        ? 'Desktop agent timed out.'
        : 'Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765';
    logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function startServer() {
  if (process.env.TEST_MODE === 'true') return;
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize the persistent memory system BEFORE serving any request.
  // This loads MEMORY.md into the BuiltinMemoryProvider (frozen snapshot) so
  // /api/memories, context assembly, and the memory tool all work at runtime.
  try {
    memoryManager.initialize('safa-boot');
  } catch (e: any) {
    console.error('[Memory Init] Failed to initialize memory manager at startup:', e?.message);
  }

  // Memory REST API Endpoints
  app.get('/api/transcript', async (_req, res) => {
    try {
      const { getAllRecentMessages } = await import('./session_db');
      const messages = await getAllRecentMessages(150);
      res.json(messages);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/transcript', async (_req, res) => {
    try {
      const { clearSessionMessages } = await import('./session_db');
      await clearSessionMessages();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/memories', async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/memories', async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res
          .status(400)
          .json({ error: 'Category and text parameters are required.' });
      }
      const cleanText = text.trim();
      const targetFile =
        category === 'preference' ||
        category === 'identity' ||
        category === 'preferences'
          ? 'USER'
          : 'MEMORY';
      const ok = memoryManager.addFact(targetFile, category, cleanText);
      if (ok) {
        const timestamp = new Date().toISOString();
        const newMemory = {
          id: getStableId(cleanText),
          category,
          text: cleanText,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        res.status(201).json(newMemory);
      } else {
        res.status(500).json({ error: 'Failed to save memory fact.' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/memories/:id', async (req, res) => {
    try {
      const { id } = req.params;
      // Stonic architecture: all curated facts live in MEMORY.md (USER.md deprecated,
      // user-target writes redirect to MEMORY.md). Entries are §-delimited.
      const content = memoryManager.readMemoryFile('MEMORY');
      let found = false;
      let textToRemove = '';

      const scanFile = (text: string) => {
        const entries = text.split(/\n§\n/);
        for (const entry of entries) {
          const factText = entry.trim();
          if (factText && getStableId(factText) === id) {
            textToRemove = factText;
            found = true;
            break;
          }
        }
      };

      scanFile(content);

      if (found && textToRemove) {
        const deleted = memoryManager.removeFact('MEMORY', textToRemove);
        res.json({ success: deleted });
      } else {
        res.status(404).json({ error: 'Memory fact not found.' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Session History REST API Endpoints ---
  app.get('/api/sessions', async (req, res) => {
    try {
      const { listSessions } = await import('./session_db');
      const sessions = await listSessions();
      res.json(sessions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/sessions', express.json(), async (req, res) => {
    try {
      const { sessionId, title } = req.body;
      const { getOrCreateSession, nextChatTitle } = await import('./session_db');
      const resolvedTitle = title || nextChatTitle();
      const session = await getOrCreateSession(sessionId, resolvedTitle);
      res.json(session);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions/:id/messages', async (req, res) => {
    try {
      const { id } = req.params;
      const { getSessionMessages } = await import('./session_db');
      const messages = await getSessionMessages(id, 150);
      res.json(messages);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/chat', express.json(), async (req, res) => {
    try {
      const { sessionId, message, inputType } = req.body;

      if (!sessionId || !message) {
        return res
          .status(400)
          .json({ error: 'sessionId and message are required.' });
      }

      console.log(
        `[REST Chat] Unified backend chat request for session: ${sessionId}, text: "${message}"`,
      );

      // 1. Save user message to SQLite
      const userMsg = await memoryManager.syncTurn({
        sessionId,
        role: 'user',
        content: message,
        messageType: inputType === 'voice' ? 'user_voice' : 'user_text',
      });

      // 2. Load dialogue history from SQLite (Stonic-compatible restore)
      const dialogueHistory = await getDialogueHistory(sessionId);
      appendDialogueTurn(sessionId, { role: 'user', text: message });

      // 3. Execute the task via Maira Agent Core ReAct Loop
      const result = await agentCore.executeTask({
        userPrompt: message,
        dialogueHistory,
        sessionId,
        origin: inputType === 'voice' ? 'voice' : 'text',
      });

      // 4. Save Safa's model response to SQLite
      const safaMsg = await memoryManager.syncTurn({
        sessionId,
        role: 'model',
        content: result.finalAnswer,
        messageType: inputType === 'voice' ? 'safa_voice' : 'safa_text',
      });

      // 5. Add model turn to dialogueHistory (persisted to SQLite via syncTurn above)
      appendDialogueTurn(sessionId, {
        role: 'model',
        text: result.finalAnswer,
      });

      // 6. Proactive Background Memory Review (Stonic-compatible)
      triggerBackgroundMemoryReview(
        message,
        result.finalAnswer,
        sessionId,
        performReviewLLMCall
      );

      res.json({
        ok: true,
        userMessage: userMsg,
        safaMessage: safaMsg,
      });
    } catch (err: any) {
      console.error('[REST Chat Endpoint Error]:', err);
      res
        .status(500)
        .json({ error: err.message || 'Failed to process chat message.' });
    }
  });

  app.patch('/api/sessions/:id', express.json(), async (req, res) => {
    try {
      const { id } = req.params;
      const { title } = req.body;
      if (!title) {
        return res.status(400).json({ error: 'title is required' });
      }
      const { renameSession } = await import('./session_db');
      renameSession(id, title);
      res.json({ success: true, id, title });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { deleteSession } = await import('./session_db');
      deleteSession(id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Learned Rules Cognitive API Endpoints
  app.get('/api/learn', async (req, res) => {
    try {
      const rules = await loadLearnedRules();
      res.json(rules);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/learn', async (req, res) => {
    try {
      const { category, rule, context } = req.body;
      if (!category || !rule) {
        return res
          .status(400)
          .json({ error: 'Category and rule parameters are required.' });
      }
      const rules = await loadLearnedRules();
      const timestamp = new Date().toISOString();
      const newRule: LearnedRule = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        rule,
        context,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      rules.push(newRule);
      await saveLearnedRules(rules);
      res.status(201).json(newRule);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/learn/:id', async (req, res) => {
    try {
      const { id } = req.params;
      let rules = await loadLearnedRules();
      rules = rules.filter(r => r.id !== id);
      await saveLearnedRules(rules);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // V2: Settings API â€” mirrors the memory persistence pattern.
  // Reads/writes settings.json so the Python agent can also check auto-start.
  // ---------------------------------------------------------------------------
  const SETTINGS_FILE = dataFile('settings.json');

  function loadSettingsFile(): Record<string, unknown> {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      }
    } catch {
      /* corrupt file â€” return defaults */
    }
    return {};
  }

  function saveSettingsFile(data: Record<string, unknown>): void {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }

  app.get('/api/settings', async (_req, res) => {
    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== 'object') {
        return res
          .status(400)
          .json({ error: 'Request body must be a JSON object.' });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent so the registry key
      // is flipped immediately (don't wait for a voice command).
      if ('autoStart' in patch) {
        callDesktopAgent(
          patch.autoStart ? 'enableAutoStart' : 'disableAutoStart',
          {},
        ).catch(() => {});
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists â€” the key itself is never returned.
  // ---------------------------------------------------------------------------
  app.get('/api/config', (_req, res) => {
    res.json({ hasApiKey: hasGeminiApiKey() });
  });

  app.get('/api/config/sabit', (_req, res) => {
    res.json({
      hasApiKey: hasSabitApiKey(),
      hasCustomApiKey: hasCustomSabitApiKey(),
    });
  });

  app.post('/api/sabit-manual-state', express.json(), (req, res) => {
    const { disconnected } = req.body;
    isSabitManuallyDisconnectedByUser = !!disconnected;
    sabitRuntimeState.manualDisconnected = !!disconnected;
    if (disconnected) {
      logSabitWS('DISCONNECTED_MANUALLY', 'Client requested manual disconnect');
      sabitRuntimeState.connectionState = 'disconnected';
      sabitRuntimeState.sessionState = 'closed';
      sabitRuntimeState.taskState = 'idle';
      sabitRuntimeState.activeTaskId = null;
      sabitRuntimeState.activeTaskGoal = null;
      isCurrentlyDelegated = false;
      if (activeSabitLiveSession) {
        try {
          activeSabitLiveSession.close();
        } catch (e) {}
        activeSabitLiveSession = null;
      }
    } else {
      logSabitWS('RECONNECTED_MANUALLY', 'Client requested manual connect');
      sabitRuntimeState.manualDisconnected = false;
    }
    broadcastSabitRuntimeState();
    res.json({ success: true, isSabitManuallyDisconnectedByUser });
  });

  app.post('/api/config/sabit/apikey', async (req, res) => {
    try {
      const key: string = (req.body?.apiKey ?? '').toString().trim();
      if (!key) {
        return res.status(400).json({ error: 'Sabit API key is required.' });
      }
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next();
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(
            msg,
          );
        if (isAuthError) {
          logError(`SABIT_APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: 'That key was rejected by Google. Check it and try again.',
          });
        }
        logError(`SABIT_APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setSabitApiKey(key);
      logCommand('SABIT_APIKEY_SAVED');
      res.json({ ok: true, hasApiKey: true, hasCustomApiKey: true });
    } catch (e: any) {
      logError(`SABIT_APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res
        .status(500)
        .json({ error: e?.message || 'Failed to save Sabit API key.' });
    }
  });

  app.post('/api/config/sabit/clear', (_req, res) => {
    try {
      clearSabitApiKey();
      logCommand('SABIT_APIKEY_CLEARED');
      res.json({
        ok: true,
        hasApiKey: hasSabitApiKey(),
        hasCustomApiKey: false,
      });
    } catch (e: any) {
      logError(`SABIT_APIKEY_CLEAR_ERROR: ${e?.message || e}`);
      res
        .status(500)
        .json({ error: e?.message || 'Failed to clear Sabit API key.' });
    }
  });

  app.post('/api/config/apikey', async (req, res) => {
    try {
      const key: string = (req.body?.apiKey ?? '').toString().trim();
      if (!key) {
        return res.status(400).json({ error: 'API key is required.' });
      }
      // Validate the key by listing models â€” this checks authentication only,
      // without depending on any single model's availability or per-model
      // quota (a 429 on one model must NOT read as an invalid key). We only
      // reject on genuine auth failures; transient/network errors still save,
      // since the live connection will surface any real problem later.
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next(); // force the first request
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(
            msg,
          );
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: 'That key was rejected by Google. Check it and try again.',
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setGeminiApiKey(key);
      logCommand('APIKEY_SAVED');
      res.json({ ok: true, hasApiKey: true });
    } catch (e: any) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || 'Failed to save API key.' });
    }
  });

  // V2: Agent health proxy (for the Settings panel â€” avoids direct :8765 call
  // which may fail due to CORS when served on a different origin).
  app.get('/api/agent-health', async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    }
  });

  // V2: Logs API â€” returns recent log entries (last 100 lines) for display.
  app.get('/api/logs/:file', async (req, res) => {
    try {
      const fileName = String(req.params.file);
      // Whitelist to prevent directory traversal.
      if (!['commands', 'startup', 'errors'].includes(fileName)) {
        return res
          .status(400)
          .json({
            error: 'Invalid log file. Use: commands, startup, or errors.',
          });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get('/api/proxy', async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Scraper failed to load page: status ${response.status}`,
        );
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, '').trim();
        if (
          text &&
          text.length > 3 &&
          text.length < 120 &&
          !headings.includes(text)
        ) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(
        /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
      );
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, '').trim();

        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith('/')) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith('http://') || href.startsWith('https://')) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, '').trim();
        if (
          text &&
          text.length > 25 &&
          text.length < 600 &&
          !paragraphs.includes(text)
        ) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, '').trim();
        if (
          text &&
          text.length > 1 &&
          text.length < 60 &&
          !buttons.includes(text)
        ) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes('javascript:')).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12),
      });
    } catch (err: any) {
      console.error(
        `[Proxy Scraper] Error fetching ${req.query.url}:`,
        err.message,
      );
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get('/api/web-proxy', async (req, res) => {
    // Disable certificate verification to avoid handshake errors in sandbox/container environments
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    let targetUrl = '';
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res
          .status(400)
          .send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();

      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith('/')) {
        return res
          .status(400)
          .send(
            `Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`,
          );
      }

      // Check protocol and hostname format
      try {
        if (
          !targetUrl.startsWith('http://') &&
          !targetUrl.startsWith('https://')
        ) {
          targetUrl = 'https://' + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes('.')) {
          throw new Error(
            'Missing or invalid domain name extension (e.g. .com, .org, .net).',
          );
        }
      } catch (err: any) {
        return res
          .status(400)
          .send(
            `Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`,
          );
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);

      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'identity', // Prevent server compression (gzip, deflate, br) to avoid decryption/encoding bugs in node-fetch
          },
          redirect: 'follow',
        });
      } catch (fetchErr: any) {
        console.warn(
          `[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`,
          fetchErr.message,
        );
        return res
          .status(502)
          .send(
            `Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`,
          );
      }

      if (!response.ok) {
        return res
          .status(response.status)
          .send(
            `Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`,
          );
      }

      const contentType = response.headers.get('content-type') || '';

      // Set permissive CORS headers for modern browser security compatibility
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes('text/html')) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader('Content-Type', contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Myraa Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Myraa Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes('<head>')) {
        htmlContents = htmlContents.replace(
          '<head>',
          `<head>\n${baseUrlTag}\n${interceptorScript}`,
        );
      } else if (htmlContents.includes('<HEAD>')) {
        htmlContents = htmlContents.replace(
          '<HEAD>',
          `<HEAD>\n${baseUrlTag}\n${interceptorScript}`,
        );
      } else {
        htmlContents =
          baseUrlTag + '\n' + interceptorScript + '\n' + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('X-Myraa-Proxied', 'true');
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.removeHeader('content-security-policy');
      res.removeHeader('x-frame-options');

      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn('[Web Proxy Exception] Handled internal error:', e.message);
      res
        .status(500)
        .send(
          `Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || 'unknown'}". Details: ${e.message}`,
        );
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get('/api/youtube-search', async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: 'Missing query q' });
      }

      console.log(
        `[YouTube Proxy Search] Searching real YouTube for: "${query}"`,
      );
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        },
      });
      const html = await response.text();

      const videoList: any[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);

      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const contents =
            data.contents?.twoColumnSearchResultRenderer?.primaryContents
              ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer
              ?.contents;
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.videoRenderer) {
                const vr = item.videoRenderer;
                const vId = vr.videoId;
                if (vId) {
                  videoList.push({
                    videoId: vId,
                    title:
                      vr.title?.runs?.[0]?.text ||
                      vr.title?.simpleText ||
                      'YouTube Video',
                    thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    author:
                      vr.ownerText?.runs?.[0]?.text ||
                      vr.shortBylineText?.runs?.[0]?.text ||
                      'Unknown Channel',
                    duration: vr.lengthText?.simpleText || 'N/A',
                    views: vr.viewCountText?.simpleText || 'N/A',
                    published: vr.publishedTimeText?.simpleText || '',
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error(
            '[YouTube Parser Engine] JSON parse error, falling back:',
            e.message,
          );
        }
      }

      // Regex fallback if JSON extraction gets blocked or is empty
      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids: string[] = [];
        while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
          const id = match[1];
          if (id && !ids.includes(id)) {
            ids.push(id);
          }
        }

        for (const id of ids) {
          videoList.push({
            videoId: id,
            title: `Live Stream: ${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            author: 'YouTube Creator',
            duration: 'N/A',
            views: 'Available Now',
          });
        }
      }

      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      console.error('[YouTube Search Error]:', err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });

  // SOUL Configuration Endpoints
  app.get('/api/soul', (req, res) => {
    try {
      const config = loadSoulConfig();
      res.json(config);
    } catch (e: any) {
      res
        .status(500)
        .json({ error: e.message || 'Failed to load SOUL config' });
    }
  });

  app.post('/api/soul', (req, res) => {
    try {
      const patch = req.body || {};
      const updated = saveSoulConfig(patch);
      res.json(updated);
    } catch (e: any) {
      res
        .status(500)
        .json({ error: e.message || 'Failed to save SOUL config' });
    }
  });

  // Memory REST Endpoints
  app.get('/api/memory', (req, res) => {
    try {
      const memoryMd = memoryManager.readMemoryFile('MEMORY');
      const userMd = memoryManager.readMemoryFile('USER');
      res.json({ memoryMd, userMd });
    } catch (e: any) {
      res
        .status(500)
        .json({ error: e.message || 'Failed to read memory files' });
    }
  });

  app.post('/api/memory', (req, res) => {
    try {
      const { target, category, fact, oldFact, action } = req.body || {};
      const targetFile = target === 'USER' ? 'USER' : 'MEMORY';

      if (action === 'remove') {
        const ok = memoryManager.removeFact(targetFile, oldFact || fact);
        return res.json({ ok });
      } else if (action === 'update') {
        const ok = memoryManager.updateFact(targetFile, oldFact, fact);
        return res.json({ ok });
      } else {
        const ok = memoryManager.addFact(
          targetFile,
          category || 'general',
          fact,
        );
        return res.json({ ok });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Failed to update memory' });
    }
  });

  // Session DB REST Endpoints
  app.get('/api/sessions', async (req, res) => {
    try {
      const { listSessions } = await import('./session_db');
      const sessions = await listSessions();
      res.json(sessions);
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Failed to list sessions' });
    }
  });

  app.get('/api/sessions/search', async (req, res) => {
    try {
      const query = (req.query.q as string) || '';
      const matches = await memoryManager.searchSessionHistory(query);
      res.json(matches);
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Failed to search sessions' });
    }
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const sessionId = req.params.id;
      const history = await memoryManager.getSessionHistory(sessionId);
      res.json(history);
    } catch (e: any) {
      res
        .status(500)
        .json({ error: e.message || 'Failed to get session history' });
    }
  });

  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);

  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  const sabitWss = new WebSocketServer({ noServer: true });
  globalWss = wss;
  globalSabitWss = sabitWss;

  server.on('upgrade', (request, socket, head) => {
    try {
      const reqUrl = request.url || '';
      const pathname = reqUrl.split('?')[0];
      if (pathname === '/live') {
        wss.handleUpgrade(request, socket, head, ws => {
          wss.emit('connection', ws, request);
        });
      } else if (pathname === '/sabit-live') {
        sabitWss.handleUpgrade(request, socket, head, ws => {
          sabitWss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (err) {
      console.error('[Upgrade Error]:', err);
      socket.destroy();
    }
  });

  // Handle Sabit WebSocket Connection
  sabitWss.on('connection', async (clientWs, request) => {
    logSabitWS('CONNECTED', 'Client WebSocket connected to /sabit-live');

    if (activeSabitClientWs && activeSabitClientWs !== clientWs) {
      try {
        activeSabitClientWs.close();
      } catch (e) {}
    }
    activeSabitClientWs = clientWs;

    if (activeSabitLiveSession) {
      try {
        activeSabitLiveSession.close();
      } catch (e) {}
      activeSabitLiveSession = null;
    }

    isSabitManuallyDisconnectedByUser = false; // Reset manual override state on connection
    sabitRuntimeState.connectionState = 'connected';
    sabitRuntimeState.manualDisconnected = false;

    if (sabitRecoveryTimeoutId) {
      clearTimeout(sabitRecoveryTimeoutId);
      sabitRecoveryTimeoutId = null;
    }

    const apiKey = getSabitApiKey();

    if (!apiKey) {
      console.error('[Sabit] No API key configured.');
      clientWs.send(
        JSON.stringify({
          type: 'error',
          error:
            "NO_API_KEY: Please configure Sabit's API key first in Settings.",
        }),
      );
      sabitRuntimeState.connectionState = 'disconnected';
      broadcastSabitRuntimeState();
      clientWs.close();
      return;
    }

    // Server-to-client heartbeat
    const serverHeartbeatInterval = setInterval(() => {
      if (clientWs.readyState === clientWs.OPEN) {
        try {
          clientWs.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {}
      } else {
        clearInterval(serverHeartbeatInterval);
      }
    }, 15000);

    const url = new URL(request.url || '', 'http://localhost');
    const voiceTone = url.searchParams.get('voiceTone') || 'Cool and Collected';
    const assistantName = url.searchParams.get('assistantName') || 'Sabit';

    const SABIT_VOICE_MAP: Record<string, string> = {
      'Cool and Collected': 'Charon', // Deep, calm, professional male
      'Focused Engineer': 'Orus', // Clear, direct, analytical male
      'Energetic Helper': 'Puck', // Energetic, bright male
      'Smooth Companion': 'Fenrir', // Smooth, warm, polite male
    };
    const voiceName =
      SABIT_VOICE_MAP[voiceTone] || SABIT_VOICE_MAP['Cool and Collected'];

    try {
      clientWs.send(
        JSON.stringify({ type: 'status', status: 'authenticating' }),
      );
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      clientWs.send(
        JSON.stringify({ type: 'status', status: 'authenticated' }),
      );
      clientWs.send(
        JSON.stringify({ type: 'status', status: 'connecting_gemini' }),
      );

      const currentGoal =
        sabitRuntimeState.activeTaskGoal || currentSabitTask || '';

      const baseInstructions = getSharedAutomationBaseInstructions(
        assistantName,
        'a highly efficient, cool, collected, and tech-savvy second assistant helper. You speak with a calm, professional, and clear voice',
        currentGoal,
      );

      const memories = await loadMemories();
      const rules = await loadLearnedRules();
      const dialogueHistory = sessionHistoryMap.get('sabit_session') || [];
      sessionHistoryMap.set('sabit_session', dialogueHistory);

      const finalInstructionsRaw = formatSystemInstructionsWithContext(
        baseInstructions,
        memories,
        rules,
        dialogueHistory,
      );
      const customizedInstructions =
        finalInstructionsRaw
          .replace(/Myraa/g, assistantName)
          .replace(/Mayra/g, assistantName) +
        `\n\nCRITICAL SECURITY PERMISSIONS STATUS (DO NOT BYPASS):
- File System Access: ENABLED.
- Screen Sharing / OCR Access: ENABLED.
- Microphone Access: ENABLED.
- Camera Access: ENABLED.
- System Commands Access (shutdown, restart, sleep, power actions): ENABLED.`;

      let currentModelResponseText = '';
      let inFlightToolCallsCount = 0;
      let executionStepCount = 0;
      let lastActivityTimestamp = Date.now();
      const textScrubber = new StreamingContextScrubber();

      clientWs.send(
        JSON.stringify({ type: 'status', status: 'creating_session' }),
      );

      const session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } },
          },
          inputAudioTranscription: { languageCodes: ['en-US', 'bn-BD'] },
          systemInstruction: customizedInstructions,
          tools: [
            {
              functionDeclarations: SHARED_TOOL_DECLARATIONS
                ? SHARED_TOOL_DECLARATIONS.filter(
                    t => t.name !== 'delegateToSabit',
                  )
                : [],
            },
          ],
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            lastActivityTimestamp = Date.now();
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: 'audio', audio }));
            }

            if (message.serverContent?.interrupted) {
              console.log('[Sabit Interrupted!]');
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }

            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: 'turnComplete' }));
              if (currentModelResponseText.trim()) {
                currentModelResponseText = '';
              }
            }

            const part = message.serverContent?.modelTurn?.parts[0];
            if (part && 'text' in part && part.text) {
              currentModelResponseText += part.text;
              const visible = textScrubber.feed(part.text);
              if (visible) {
                clientWs.send(JSON.stringify({ type: 'text', text: visible }));
              }
            }

            if (message.toolCall?.functionCalls) {
              // Transition from acquiring/recovering to running when Sabit starts executing tools
              if (
                sabitRuntimeState.taskState === 'acquiring' ||
                sabitRuntimeState.taskState === 'recovering'
              ) {
                transitionSabitTaskState('running');
              }
              for (const fc of message.toolCall.functionCalls) {
                console.log(`[Sabit Tool Call]: ${fc.name}`, fc.args);

                if (fc.name === 'sabitTaskComplete') {
                  console.log(
                    '[Sabit Task] Sabit reported task completed successfully!',
                  );
                  transitionSabitTaskState('completed');
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        name: fc.name,
                        response: {
                          output: { result: 'Task marked as completed.' },
                        },
                        id: fc.id,
                      },
                    ],
                  });
                  continue;
                }

                if (fc.name === 'sabitTaskFailed') {
                  const reason = (fc.args as any)?.reason || 'Unknown failure.';
                  console.log(
                    `[Sabit Task] Sabit reported task failed: ${reason}`,
                  );
                  transitionSabitTaskState('failed', reason);
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        name: fc.name,
                        response: {
                          output: { result: 'Task marked as failed.' },
                        },
                        id: fc.id,
                      },
                    ],
                  });
                  continue;
                }

                if (fc.name === 'sabitWaitingForUser') {
                  const msg =
                    (fc.args as any)?.message ||
                    'User action required on screen.';
                  console.log(
                    `[Sabit Task] Sabit requested user intervention: ${msg}`,
                  );
                  transitionSabitTaskState('waiting_for_user', msg);
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        name: fc.name,
                        response: {
                          output: {
                            result:
                              'Task status set to WAITING_FOR_USER. User has been informed.',
                          },
                        },
                        id: fc.id,
                      },
                    ],
                  });
                  continue;
                }

                if (DESKTOP_TOOLS.has(fc.name)) {
                  inFlightToolCallsCount++;
                  executionStepCount++;
                  const stepId = executionStepCount;
                  const taskId = sabitRuntimeState.activeTaskId || 'active';

                  console.log(
                    `[SABIT EXECUTION] TASK_ID: ${taskId} | STEP_ID: ${stepId} | TOOL_CALL_STARTED: ${fc.name} | args: ${JSON.stringify(fc.args)}`,
                  );

                  (async () => {
                    const argsWithCaller = {
                      ...(fc.args as Record<string, unknown>),
                      _caller: 'sabit',
                    };

                    try {
                      clientWs.send(
                        JSON.stringify({
                          type: 'browserAutomationEvent',
                          name: fc.name,
                          args: fc.args,
                          status: 'started',
                        }),
                      );
                    } catch (e) {}

                    // Wrap execution inside a cancellable/resolvable promise wrapper
                    const agentResult = await new Promise<{
                      ok: boolean;
                      result?: any;
                      error?: string;
                    }>(async resolve => {
                      activeSabitToolCall = {
                        id: fc.id,
                        name: fc.name,
                        resolve: res => resolve(res),
                        reject: err => resolve({ ok: false, error: err }),
                      };

                      try {
                        const res = await callDesktopAgent(
                          fc.name,
                          argsWithCaller,
                        );
                        resolve(res);
                      } catch (err: any) {
                        resolve({
                          ok: false,
                          error: err?.message || String(err),
                        });
                      } finally {
                        if (activeSabitToolCall?.id === fc.id) {
                          activeSabitToolCall = null;
                        }
                      }
                    });

                    inFlightToolCallsCount = Math.max(
                      0,
                      inFlightToolCallsCount - 1,
                    );
                    lastActivityTimestamp = Date.now();

                    if (agentResult.ok) {
                      const output = agentResult.result ?? { result: 'Done.' };
                      console.log(
                        `[SABIT EXECUTION] TASK_ID: ${taskId} | STEP_ID: ${stepId} | TOOL_CALL_COMPLETED: ${fc.name}`,
                      );

                      try {
                        clientWs.send(
                          JSON.stringify({
                            type: 'browserAutomationEvent',
                            name: fc.name,
                            args: fc.args,
                            status: 'completed',
                            result: output,
                          }),
                        );
                      } catch (e) {}

                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output },
                            id: fc.id,
                          },
                        ],
                      });
                      console.log(
                        `[SABIT EXECUTION] TASK_ID: ${taskId} | STEP_ID: ${stepId} | TOOL_RESULT_SENT: ${fc.name}`,
                      );
                    } else {
                      const errMsg =
                        agentResult.error || 'Desktop agent error.';
                      console.error(
                        `[SABIT EXECUTION] TASK_ID: ${taskId} | STEP_ID: ${stepId} | TOOL_CALL_FAILED: ${fc.name} | error: ${errMsg}`,
                      );

                      // Transition to failed if the agent is not running or unreachable
                      if (
                        errMsg.includes('not running') ||
                        errMsg.includes('timed out') ||
                        errMsg.includes('UNREACHABLE') ||
                        errMsg.includes('fetch failed')
                      ) {
                        console.log(
                          `[Sabit Task] Failing task due to unreachable Desktop Agent: ${errMsg}`,
                        );
                        transitionSabitTaskState(
                          'failed',
                          'Desktop Agent is currently offline.',
                        );

                        try {
                          session.sendClientContent({
                            turns: {
                              role: 'user',
                              parts: [
                                {
                                  text: 'SYSTEM DIRECTIVE (CRITICAL): The local Desktop Agent is not running. You must immediately speak to the user politely in your professional tone, explaining clearly that you cannot execute the task because the Desktop Agent is not running on their computer. Tell them that once they start the Desktop Agent, you can execute the task again. Do not run any more tools.',
                                },
                              ],
                            },
                          });
                        } catch (e) {}
                      }

                      try {
                        clientWs.send(
                          JSON.stringify({
                            type: 'browserAutomationEvent',
                            name: fc.name,
                            args: fc.args,
                            status: 'failed',
                            error: errMsg,
                          }),
                        );
                      } catch (e) {}

                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: {
                              output: {
                                result: `Desktop control error: ${errMsg}`,
                              },
                            },
                            id: fc.id,
                          },
                        ],
                      });
                      console.log(
                        `[SABIT EXECUTION] TASK_ID: ${taskId} | STEP_ID: ${stepId} | TOOL_RESULT_SENT (ERROR): ${fc.name}`,
                      );
                    }
                  })();
                } else {
                  clientWs.send(
                    JSON.stringify({
                      type: 'toolCall',
                      callId: fc.id,
                      name: fc.name,
                      args: fc.args,
                    }),
                  );
                }
              }
            }
          },
          onclose: () => {
            logSabitWS('SESSION_CLOSED', 'Sabit Gemini Live session closed');
            sabitRuntimeState.sessionState = 'closed';
            broadcastSabitRuntimeState();

            try {
              clientWs.send(
                JSON.stringify({ type: 'status', status: 'session_closed' }),
              );
            } catch (e) {}

            if (!sabitRuntimeState.manualDisconnected) {
              if (
                sabitRuntimeState.taskState === 'acquiring' ||
                sabitRuntimeState.taskState === 'running' ||
                sabitRuntimeState.taskState === 'waiting_for_user'
              ) {
                transitionSabitTaskState('recovering');
              }
            } else {
              releaseSabitTask('Manual disconnect');
            }
            activeSabitLiveSession = null;
          },
        },
      });

      // --- SABIT SESSION KEEPALIVE & WATCHDOG TIMER ---
      const liveWatchdogInterval = setInterval(() => {
        if (
          sabitRuntimeState.connectionState !== 'connected' ||
          activeSabitLiveSession !== session
        ) {
          clearInterval(liveWatchdogInterval);
          return;
        }
        const now = Date.now();
        const isTaskActive =
          sabitRuntimeState.taskState === 'acquiring' ||
          sabitRuntimeState.taskState === 'running';

        // 1. Keepalive audio ping every 25 seconds to prevent Gemini Live 4-minute WebSocket idle disconnect
        if (now - lastActivityTimestamp > 25000) {
          try {
            session.sendRealtimeInput({
              audio: { data: '', mimeType: 'audio/pcm;rate=16000' },
            });
            lastActivityTimestamp = now;
          } catch (e) {}
        }

        // 2. Active Task Watchdog: If task is active but silent for > 8s with 0 in-flight tools, send continuation nudge
        if (
          isTaskActive &&
          inFlightToolCallsCount === 0 &&
          now - lastActivityTimestamp > 8000
        ) {
          console.log(
            `[SABIT WATCHDOG] Task "${sabitRuntimeState.activeTaskGoal}" silent for >8s with 0 tools in flight. Sending continuation nudge.`,
          );
          lastActivityTimestamp = now;
          try {
            session.sendClientContent({
              turns: {
                role: 'user',
                parts: [
                  {
                    text: `SYSTEM DIRECTIVE (WATCHDOG NUDGE): The task "${sabitRuntimeState.activeTaskGoal}" is still active. Please execute the next required tool immediately or call 'sabitTaskComplete' if finished.`,
                  },
                ],
              },
            });
          } catch (e) {}
        }
      }, 4000);

      logSabitWS('SESSION_CREATED', 'Gemini session successfully created');
      sabitRuntimeState.sessionState = 'active';
      logSabitWS('SESSION_ACTIVE', 'Gemini session is now active');
      broadcastSabitRuntimeState();

      activeSabitLiveSession = session;

      clientWs.send(
        JSON.stringify({ type: 'status', status: 'session_ready' }),
      );
      clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

      // Handle Automatic Recovery of Active Task Context!
      if (
        sabitRuntimeState.taskState === 'waiting_for_user' &&
        (sabitRuntimeState.activeTaskGoal || currentGoal)
      ) {
        logSabitWS(
          'TASK_WAITING',
          `Preserving waiting_for_user state on reconnect for task: "${sabitRuntimeState.activeTaskGoal || currentGoal}"`,
        );
        try {
          session.sendClientContent({
            turns: {
              role: 'user',
              parts: [
                {
                  text: `SYSTEM DIRECTIVE: You have an active task "${sabitRuntimeState.activeTaskGoal || currentGoal}" that is currently WAITING FOR USER ACTION on screen. Do NOT restart the task from scratch. Wait for user input or verification.`,
                },
              ],
            },
          });
        } catch (e) {}
      } else if (
        sabitRuntimeState.taskState === 'recovering' &&
        sabitRuntimeState.activeTaskGoal
      ) {
        logSabitWS(
          'TASK_STARTED',
          `Recovering/Resuming active task context: "${sabitRuntimeState.activeTaskGoal}"`,
        );
        transitionSabitTaskState('running');
        try {
          session.sendClientContent({
            turns: {
              role: 'user',
              parts: [
                {
                  text: `SYSTEM DIRECTIVE: The connection was briefly lost, but we have successfully restored your session. You must resume the delegated task immediately: "${sabitRuntimeState.activeTaskGoal}". Tell the user clearly that you are continuing their task, and proceed with the remaining automation steps.`,
                },
              ],
            },
          });
        } catch (e) {
          console.error(
            '[Sabit Recovery] Failed to send recovery directive to Gemini session:',
            e,
          );
        }
      } else if (
        currentGoal &&
        (sabitRuntimeState.taskState === 'acquiring' ||
          sabitRuntimeState.taskState === 'running')
      ) {
        try {
          console.log(
            `[Sabit Live Connect] Proactively starting active assigned task: "${currentGoal}"`,
          );
          session.sendClientContent({
            turns: {
              role: 'user',
              parts: [
                {
                  text: `SYSTEM DIRECTIVE: You have been delegated a task: "${currentGoal}". Please begin executing this task immediately using your available tools.

CRITICAL PROTOCOLS:
1. EXPLICIT VOICE & TEXT: Tell the user exactly what you are doing, execute the browser automation or search steps, and verify the correct target page is opened or the action succeeded.
2. NO PREMATURE COMPLETION: Do NOT call 'sabitTaskComplete' after completing only the first few steps. For example, if the goal is to send a WhatsApp message, merely searching or opening the chat is NOT completion. You MUST type the message and send it, and verify on screen that it has actually been sent.
3. VERIFY COMPLETION: Do not assume success immediately upon a tool response. Double check that the page or content loaded as expected and the complete goal has been fully achieved before concluding.
4. AUTHORITATIVE COMPLETION: Once and ONLY once you have fully verified the task's successful execution, you MUST call the 'sabitTaskComplete' tool. This will authoritatively mark the task as completed.
5. AUTHORITATIVE FAILURE: If you hit a blocking issue (such as a CAPTCHA, a persistent timeout, or a browser error), explain the issue clearly and call the 'sabitTaskFailed' tool with a specific reason. Do not attempt further loops.
`,
                },
              ],
            },
          });
        } catch (e) {
          console.error(
            '[Sabit Live Connect] Failed to send initial task start message:',
            e,
          );
        }
      }

      clientWs.on('message', rawMsg => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.type === 'pong' || msg.type === 'ping') {
            try {
              if (clientWs.readyState === clientWs.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: msg.type === 'ping' ? 'pong' : 'ping',
                  }),
                );
              }
            } catch (e) {}
            return;
          }
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
            });
          } else if (msg.type === 'text' && msg.text) {
            try {
              if (sabitRuntimeState.taskState === 'waiting_for_user') {
                resumeSabitTask(msg.text);
                return;
              } else {
                const isBusy =
                  sabitRuntimeState.taskState === 'acquiring' ||
                  sabitRuntimeState.taskState === 'running' ||
                  sabitRuntimeState.taskState === 'recovering';
                if (!isBusy) {
                  acquireSabitTask(msg.text);
                }
                session.sendClientContent({
                  turns: {
                    role: 'user',
                    parts: [{ text: msg.text }],
                  },
                });
              }
            } catch (e) {}
          } else if (msg.type === 'cancelTask') {
            try {
              cancelSabitTask('Cancelled by user request.');
            } catch (e) {}
          }
        } catch (e) {}
      });

      clientWs.on('close', () => {
        if (activeSabitClientWs === clientWs) {
          activeSabitClientWs = null;
        }
        sabitRuntimeState.connectionState = 'disconnected';

        if (sabitRuntimeState.manualDisconnected) {
          logSabitWS(
            'DISCONNECTED_MANUALLY',
            'WebSocket client closed manually',
          );
          sabitRuntimeState.sessionState = 'closed';
          sabitRuntimeState.taskState = 'idle';
          sabitRuntimeState.activeTaskId = null;
          sabitRuntimeState.activeTaskGoal = null;
          isCurrentlyDelegated = false;
          broadcastSabitRuntimeState();
          try {
            session.close();
          } catch (e) {}
          activeSabitLiveSession = null;
          return;
        }

        // Unexpected disconnect
        logSabitWS(
          'DISCONNECTED_UNEXPECTEDLY',
          'WebSocket client closed unexpectedly (temporary disconnect)',
        );
        sabitRuntimeState.connectionState = 'reconnecting';
        sabitRuntimeState.sessionState = 'closed';

        if (
          sabitRuntimeState.taskState === 'acquiring' ||
          sabitRuntimeState.taskState === 'running'
        ) {
          transitionSabitTaskState('recovering');
        }

        try {
          session.close();
        } catch (e) {}
        activeSabitLiveSession = null;

        broadcastSabitRuntimeState();

        // Server recovery timeout: 120 seconds
        if (sabitRecoveryTimeoutId) {
          clearTimeout(sabitRecoveryTimeoutId);
        }
        sabitRecoveryTimeoutId = setTimeout(() => {
          if (sabitRuntimeState.taskState === 'recovering') {
            logSabitWS(
              'TASK_FAILED',
              'Reconnection timeout. Recovery aborted.',
            );
            transitionSabitTaskState(
              'failed',
              'Reconnection timeout. Sabit could not restore connection in time.',
            );
          }
        }, 120000);
      });
    } catch (err: any) {
      console.error(
        '[Sabit] Catastrophic failure initializing live session:',
        err,
      );
      clientWs.send(
        JSON.stringify({ type: 'error', error: err?.message || String(err) }),
      );

      logSabitWS(
        'DISCONNECTED_UNEXPECTEDLY',
        'Catastrophic failure initializing session',
        err,
      );
      sabitRuntimeState.connectionState = 'disconnected';
      sabitRuntimeState.sessionState = 'closed';
      releaseSabitTask(
        'Sabit connection failed: ' + (err?.message || String(err)),
      );
      broadcastSabitRuntimeState();

      activeSabitLiveSession = null;
      clientWs.close();
    }
  });

  function detectRecallIntent(text: string): string {
    const promptLower = text.toLowerCase().trim();
    if (
      /à¦—à¦²à§à¦ª|story|à¦ªà¦¾à¦–à¦¿|à¦°à¦¾à¦œà¦¾|à¦—à¦²à§à¦ªà¦Ÿà¦¾|storyà¦Ÿà¦¾/i.test(
        promptLower,
      ) &&
      /à¦¶à§‡à¦· à¦•à¦°à§‹|continue|resume|finish|à¦¤à¦¾à¦°à¦ªà¦° à¦•à§€|à¦¤à¦¾à¦°à¦ªà¦° à¦•à¦¿|à¦†à¦¬à¦¾à¦° à¦¬à¦²à§‹|à¦¶à§‹à¦¨à¦¾à¦“|à¦¶à§à¦¨à¦›à¦¿à¦²à¦¾à¦®|à¦¬à¦²à¦›à¦¿à¦²à§‡/i.test(
        promptLower,
      )
    ) {
      return 'STORY_CONTINUATION';
    } else if (
      /à¦—à¦²à§à¦ª|story|à¦ªà¦¾à¦–à¦¿|à¦°à¦¾à¦œà¦¾/i.test(promptLower) &&
      /à¦¬à¦²à¦›à¦¿à¦²à§‡|à¦†à¦²à§‹à¦šà¦¨à¦¾|à¦†à¦—à§‡/i.test(promptLower)
    ) {
      return 'STORY_CONTINUATION';
    } else if (
      /à¦¶à§‡à¦· à¦•à¦°à§‹|continue|resume|finish|à¦¤à¦¾à¦°à¦ªà¦° à¦•à§€|à¦¤à¦¾à¦°à¦ªà¦° à¦•à¦¿|à¦šà¦¾à¦²à§ à¦•à¦°à§‹/i.test(
        promptLower,
      ) &&
      !/à¦—à¦²à§à¦ª|story/i.test(promptLower)
    ) {
      return 'STORY_CONTINUATION';
    } else if (
      /à¦•à¦¾à¦œ|à¦•à§‹à¦¡|code|à¦ªà§à¦°à¦œà§‡à¦•à§à¦Ÿ|project|à¦Ÿà¦¾à¦¸à§à¦•|task/i.test(
        promptLower,
      ) &&
      /continue|resume|à¦¶à§‡à¦· à¦•à¦°à§‹|à¦†à¦¬à¦¾à¦°|à¦†à¦—à§‡à¦°/i.test(
        promptLower,
      )
    ) {
      return 'TASK_CONTINUATION';
    } else if (
      /à¦†à¦®à¦°à¦¾|à¦†à¦—à§‡|à¦†à¦—à§‡à¦°|à¦—à¦¤à¦•à¦¾à¦²|à¦†à¦œà¦•à§‡|à¦•à¦¥à¦¾ à¦¬à¦²à¦›à¦¿à¦²à¦¾à¦®|à¦•à¦¥à¦¾ à¦¹à¦šà§à¦›à¦¿à¦²|à¦†à¦²à§‹à¦šà¦¨à¦¾|remember|recall|previous|earlier|yesterday|what were we/i.test(
        promptLower,
      )
    ) {
      return 'PAST_CONVERSATION_RECALL';
    }
    return 'NONE';
  }

  function isExplicitRecall(text: string): boolean {
    const promptLower = text.toLowerCase().trim();
    const keywords = [
      'à¦®à¦¨à§‡ à¦†à¦›à§‡',
      'à¦®à¦¨à§‡ à¦†à¦›à§‡ à¦•à¦¿à¦¨à¦¾',
      'à¦®à¦¨à§‡ à¦•à¦°à¦¾à¦‡',
      'à¦–à§à¦à¦œà§‡ à¦ªà¦¾à¦“',
      'à¦®à¦¨à§‡ à¦°à§‡à¦–à§‹',
      'à¦†à¦—à§‡ à¦¬à¦²à§‡à¦›à¦¿à¦²à¦¾à¦®',
      'à¦®à¦¨à§‡ à¦•à¦°à§‹',
      'remember',
      'recall',
      'find in memory',
    ];
    return keywords.some(kw => promptLower.includes(kw));
  }

  // Handle client WebSocket Connection
  wss.on('connection', async (clientWs, request) => {
    console.log('Client WebSocket connected to /live');
    const apiKey = getGeminiApiKey();

    let activeToolCall: {
      id: string;
      name: string;
      resolve: (response: any) => void;
      reject: (err: any) => void;
    } | null = null;

    if (!apiKey) {
      console.error('No Gemini API key configured.');
      clientWs.send(
        JSON.stringify({
          type: 'error',
          error:
            'NO_API_KEY: Add your Gemini API key in Settings to start talking.',
        }),
      );
      clientWs.close();
      return;
    }

    // Setup server-to-client heartbeat interval
    const serverHeartbeatInterval = setInterval(() => {
      if (clientWs.readyState === clientWs.OPEN) {
        try {
          clientWs.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {}
      } else {
        clearInterval(serverHeartbeatInterval);
      }
    }, 15000);

    const url = new URL(request.url || '', 'http://localhost');
    const clientSessionId = url.searchParams.get('sessionId');
    let sessionId = clientSessionId;
    if (!sessionId) {
      sessionId = Math.random().toString(36).substring(2, 15);
    }

    // Initialize the memory manager for THIS session. The builtin provider
    // keeps the frozen MEMORY.md snapshot; per-session init also ensures the
    // session exists in SQLite and that context assembly targets the right id.
    try {
      memoryManager.initialize(sessionId);
    } catch (e: any) {
      console.error('[Memory Init] Failed to initialize memory for session:', e?.message);
    }

    // Stonic pattern: always re-read the transcript from SQLite on (re)connect.
    // The in-memory cache may hold a stale snapshot from a previous connection,
    // so drop it BEFORE loading — every reconnect gets the full fresh history.
    invalidateDialogueCache(sessionId);

    const dialogueHistory = await getDialogueHistory(sessionId);

    const voiceTone = url.searchParams.get('voiceTone') || 'Female Bright';
    const assistantName = url.searchParams.get('assistantName') || 'Mayra';
    const fileSystemAccess =
      url.searchParams.get('fileSystemAccess') !== 'false';
    const screenShareAccess =
      url.searchParams.get('screenShareAccess') !== 'false';
    const microphoneAccess =
      url.searchParams.get('microphoneAccess') !== 'false';
    const cameraAccess = url.searchParams.get('cameraAccess') !== 'false';
    const systemCommandsAccess =
      url.searchParams.get('systemCommandsAccess') !== 'false';

    const VOICE_MAP: Record<string, string> = {
      'Soft and Gentle': 'Leda',
      'Bright and Clear': 'Kore',
      'Sweet and Youthful': 'Zephyr',
      'Gentle and Soothing': 'Sulafat',
      'Elegant Female': 'Aoede',
      'Warm Companion': 'Puck',
      'Friendly Girl': 'Fenrir',
      'Calm Assistant': 'Sulafat',
      'Natural Young Woman': 'Aoede',
      'Expressive Female': 'Charon',
      'Emotional Storyteller': 'Vapnik',
      'Professional Female': 'Kore',
      'Playful Friend': 'Zephyr',
      'Confident Woman': 'Vapnik',
    };
    const voiceName = VOICE_MAP[voiceTone] || VOICE_MAP['Soft and Gentle'];

    try {
      clientWs.send(
        JSON.stringify({ type: 'status', status: 'authenticating' }),
      );
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      clientWs.send(
        JSON.stringify({ type: 'status', status: 'connecting_gemini' }),
      );
      const memories = await loadMemories();
      const rules: any[] = [];
      const baseInstructions = getMairaFullInstructions(assistantName);

      const sabitStatusSummary = getSabitStatusSummary();
      const soulPrompt = buildSoulSystemPrompt();

      const asyncMemoryContext =
        await memoryManager.getAsyncRelevantMemoryContext(undefined, sessionId);

      const finalInstructionsRaw = formatSystemInstructionsWithContext(
        baseInstructions,
        memories,
        rules,
        dialogueHistory,
      );
      const customizedInstructions =
        soulPrompt +
        '\n\n' +
        asyncMemoryContext +
        '\n\n' +
        finalInstructionsRaw
          .replace(/Myraa/g, assistantName)
          .replace(/Mayra/g, assistantName) +
        `

DELEGATION TO SABIT INSTRUCTIONS (CRITICAL):
- SABIT REALTIME STATUS SUMMARY: ${sabitStatusSummary}
- PARALLEL EXECUTION & DELEGATION DECISION MATRIX:
  1. IF SABIT IS CONNECTED AND IDLE: When a user asks for a browser automation, web search, or background task, you MUST delegate it to Sabit using the 'delegateToSabit' tool immediately.
  2. IF SABIT IS BUSY (acquiring, running, recovering, or waiting_for_user): DO NOT call 'delegateToSabit'. Instead, execute the user's new request YOURSELF immediately using your available browser/desktop tools in parallel. NEVER say "Sabit is busy", NEVER refuse the request, and NEVER ask for confirmation.
- ONCE you call 'delegateToSabit' (when Sabit is idle), you MUST inform the user immediately in your spoken/text response that:
  1. The task has been successfully handed over to Sabit.
  2. The task is now running in the background.
  3. You (Maira) are now fully available to continue chatting or take other commands.
  Example: "ঠিক আছে, আমি কাজটা Sabit-এর কাছে background-এ দিয়ে দিয়েছি। সে কাজটা শুরু করে দিয়েছে, আর আমি আপনার সাথে কথা বলার জন্য প্রস্তুত।" or "Alright! I've delegated that task to Sabit to run in the background. He is on it, and I am here and available to continue our conversation!"
- You MUST NOT execute a task yourself IF you successfully delegated that exact task to Sabit.
- If 'delegateToSabit' returns an error saying Sabit is offline/disconnected or busy, execute the requested task yourself right away using your available tools without refusing.` +
        `

CRITICAL SECURITY PERMISSIONS STATUS (DO NOT BYPASS):
- File System Access: ${fileSystemAccess ? 'ENABLED' : 'DISABLED'}.
- Screen Sharing / OCR Access: ${screenShareAccess ? 'ENABLED' : 'DISABLED'}.
- Microphone Access: ${microphoneAccess ? 'ENABLED' : 'DISABLED'}.
- Camera Access: ${cameraAccess ? 'ENABLED' : 'DISABLED'}.
- System Commands Access (shutdown, restart, sleep, power actions): ${systemCommandsAccess ? 'ENABLED' : 'DISABLED'}.

IMPORTANT: Browser automation, mouse/keyboard control, application management, volume/brightness control, and all other tools NOT listed above are ALWAYS ENABLED by default. Do NOT refuse these or say "permission denied" — they require no special permission. Only refuse if the specific permission above is explicitly marked DISABLED.`;

      let currentModelResponseText = '';
      // Gemini Live voice transcripts stream in chunks and live in dedicated
      // fields — NOT in modelTurn.parts / userTurn:
      //   user speech  → serverContent.inputTranscription  ({text, finished})
      //   model speech → serverContent.outputTranscription ({text})
      // The old code read `serverContent.userTurn` (a field the Live API never
      // sends) and only modelTurn.parts[].text — so in VOICE mode nothing was
      // ever persisted and reconnects logged "Restored 0 messages".
      let pendingUserTranscript = '';
      let currentModelOutputTranscript = '';
      const textScrubber = new StreamingContextScrubber();

      const flushPendingModelTurn = () => {
        const finishedText = currentModelResponseText.trim()
          ? currentModelResponseText
          : currentModelOutputTranscript;
        currentModelResponseText = '';
        currentModelOutputTranscript = '';
        if (finishedText && finishedText.trim()) {
          console.log(
            `[Memory Flush] Persisting interrupted/pending model turn to SQLite (${finishedText.length} chars).`,
          );
          appendDialogueTurn(sessionId, {
            role: 'model',
            text: finishedText,
          });
          memoryManager
            .syncTurn({
              sessionId,
              role: 'model',
              content: finishedText,
              messageType: 'safa_voice',
            })
            .catch((err: any) => {
              console.error('[Memory Flush] Error persisting model turn to SQLite:', err?.message || err);
            });
        }
      };

      // NOTE: The conversation restore now happens AFTER the Gemini Live
      // session is established (see "CRITICAL: Conversation restore on
      // (Re)connect" below). The old pre-connect block here called
      // session.sendClientContent() before `session` was assigned, so it
      // always threw and silently did nothing.

      clientWs.send(
        JSON.stringify({ type: 'status', status: 'creating_session' }),
      );
      console.log('[Server] Establishing Gemini Live connection...');

      let session: any;
      const sessionConfig = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } },
        },
        inputAudioTranscription: { languageCodes: ['en-US', 'bn-BD'] },
        outputAudioTranscription: {},
        contextWindowCompression: {
          triggerTokens: '24576',
          slidingWindow: { targetTokens: '16384' },
        },
        systemInstruction: customizedInstructions,
        tools: [
          {
            functionDeclarations: SHARED_TOOL_DECLARATIONS,
          },
        ],
      };

      const sessionCallbacks = {
        onmessage: (message: LiveServerMessage) => {
          // Audio Stream Chunk
          const audio =
            message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audio) {
            clientWs.send(JSON.stringify({ type: 'audio', audio }));
          }

          if (message.serverContent?.interrupted) {
            console.log('[Myraa Interrupted!]');
            // User barged in mid-reply — their spoken words still belong in
            // the persisted history even though the model turn was cut short.
            if (pendingUserTranscript.trim()) {
              const pendingUser = pendingUserTranscript;
              pendingUserTranscript = '';
              appendDialogueTurn(sessionId, { role: 'user', text: pendingUser });
              memoryManager
                .syncTurn({
                  sessionId,
                  role: 'user',
                  content: pendingUser,
                  messageType: 'user_voice',
                })
                .catch((err: any) => {
                  console.error('[Voice Save] Error persisting user turn to SQLite:', err?.message || err);
                });
            }
            flushPendingModelTurn();
            clientWs.send(JSON.stringify({ type: 'interrupted' }));
          }

          if (message.serverContent?.turnComplete) {
            clientWs.send(JSON.stringify({ type: 'turnComplete' }));

            // Safety flush: if this API run never marked the user's utterance
            // finished, persist it here (before the model turn) so history
            // order stays user → model in SQLite.
            if (pendingUserTranscript.trim()) {
              const pendingUser = pendingUserTranscript;
              pendingUserTranscript = '';
              appendDialogueTurn(sessionId, { role: 'user', text: pendingUser });
              memoryManager
                .syncTurn({
                  sessionId,
                  role: 'user',
                  content: pendingUser,
                  messageType: 'user_voice',
                })
                .catch((err: any) => {
                  console.error('[Voice Save] Error persisting user turn to SQLite:', err?.message || err);
                });
            }

            const finishedModelText = currentModelResponseText.trim()
              ? currentModelResponseText
              : currentModelOutputTranscript;
            currentModelResponseText = '';
            currentModelOutputTranscript = '';
            if (finishedModelText && finishedModelText.trim()) {
              const finishedText = finishedModelText;
              appendDialogueTurn(sessionId, {
                role: 'model',
                text: finishedText,
              });
              memoryManager
                .syncTurn({
                  sessionId,
                  role: 'model',
                  content: finishedText,
                  messageType: 'safa_voice',
                })
                .catch((err: any) => {
                  console.error('[Voice Save] Error persisting model turn to SQLite:', err?.message || err);
                });

              // Proactive Background Memory Review
              const lastUserTurn = dialogueHistory.filter(t => t.role === 'user').slice(-1)[0]?.text || '';
              if (lastUserTurn) {
                triggerBackgroundMemoryReview(lastUserTurn, finishedText, sessionId, performReviewLLMCall);
              }

              currentModelResponseText = '';
            }

            if (dialogueHistory.length >= 2) {
              (async () => {
                try {
                  const updated = await loadMemories();
                  if (updated && updated.length > 0) {
                    clientWs.send(
                      JSON.stringify({
                        type: 'memory_sync',
                        memories: updated,
                      }),
                    );
                  }
                } catch (err) {
                  console.error(
                    '[Memory Sync] Error getting memory sync:',
                    err,
                  );
                }
              })();
            }

            if (mairaActiveTaskGoal && activeToolCall === null) {
              console.log(
                `[MAIRA EXECUTION DRIVER] Model turn completed while Maira task "${mairaActiveTaskGoal}" is active. Sending continuation directive.`,
              );
              try {
                session.sendClientContent({
                  turns: {
                    role: 'user',
                    parts: [
                      {
                        text: `SYSTEM DIRECTIVE (CRITICAL - CONTINUE AUTOMATION TASK): You are currently executing your active task: "${mairaActiveTaskGoal}". You MUST immediately execute the next logical step to proceed toward completing your goal. ONLY take a snapshot or screenshot if the page/screen state has changed or you need to find new elements; otherwise, directly execute the next action (clicking, typing, searching, etc.) using existing information to maintain maximum speed. State your final results when fully completed.`,
                      },
                    ],
                  },
                  turnComplete: true,
                });
              } catch (e) {
                console.error(
                  '[MAIRA EXECUTION DRIVER] Error sending continuation directive:',
                  e,
                );
              }
            }
          }

          const modelParts =
            (message.serverContent as any)?.modelTurn?.parts || [];
          for (const part of modelParts) {
            if (part.text) {
              const modelText = part.text;
              const visibleText = textScrubber.feed(modelText);
              if (visibleText) {
                clientWs.send(
                  JSON.stringify({
                    type: 'transcription',
                    role: 'model',
                    text: visibleText,
                    messageType: 'safa_voice',
                  }),
                );
              }
              currentModelResponseText += modelText;

              const detected = classifyEmotion(modelText);
              if (detected && detected !== lastEmotion) {
                lastEmotion = detected;
                try {
                  clientWs.send(
                    JSON.stringify({ type: 'emotion', emotion: detected }),
                  );
                } catch (e) {}
              }
            }
          }

          // In voice mode the model's spoken reply is transcribed into
          // serverContent.outputTranscription (modelTurn carries only audio).
          // Accumulate it in a SEPARATE buffer so a response that arrives via
          // BOTH paths is never double-counted; the parts-buffer wins on flush.
          const outTr = (message.serverContent as any)?.outputTranscription as
            | { text?: string }
            | undefined;
          if (outTr?.text) {
            currentModelOutputTranscript += outTr.text;
            const visibleOut = textScrubber.feed(outTr.text);
            if (visibleOut) {
              clientWs.send(
                JSON.stringify({
                  type: 'transcription',
                  role: 'model',
                  text: visibleOut,
                  messageType: 'safa_voice',
                }),
              );
            }
          }

          // USER VOICE: the Live API streams the user's speech transcript via
          // serverContent.inputTranscription in chunks; the final chunk sets
          // finished=true. (The previous code read `serverContent.userTurn`,
          // which the Live API never sends — voice turns were never persisted
          // and every reconnect restored 0 messages.) Forward to the UI and
          // persist ONCE per finished utterance — App.tsx creates a new chat
          // bubble for every user transcription event, so chunked forwarding
          // would fragment the user's speech into many bubbles.
          const inTr = (message.serverContent as any)?.inputTranscription as
            | { text?: string; finished?: boolean }
            | undefined;
          if (process.env.LIVE_DEBUG && inTr) {
            console.log(
              `[LIVE DEBUG] inputTranscription: ${JSON.stringify(inTr).slice(0, 200)} (pending: ${pendingUserTranscript.length} chars)`,
            );
          }
          if (inTr?.text) {
            pendingUserTranscript += inTr.text;
          }
          let userTextOutput: string | undefined;
          if (inTr?.finished && pendingUserTranscript.trim()) {
            userTextOutput = pendingUserTranscript;
            pendingUserTranscript = '';
          }
          if (userTextOutput) {
            clientWs.send(
              JSON.stringify({
                type: 'transcription',
                role: 'user',
                text: userTextOutput,
                messageType: 'user_voice',
              }),
            );
            appendDialogueTurn(sessionId, {
              role: 'user',
              text: userTextOutput,
            });
            memoryManager
              .syncTurn({
                sessionId,
                role: 'user',
                content: userTextOutput,
                messageType: 'user_voice',
              })
              .catch((err: any) => {
                console.error('[Voice Save] Error persisting user turn to SQLite:', err?.message || err);
              });

            const recallIntent = detectRecallIntent(userTextOutput);
            if (recallIntent !== 'NONE' || isExplicitRecall(userTextOutput)) {
              console.log(
                `[Memory Injection] Detected recall intent "${recallIntent}" in voice: "${userTextOutput}". Retrieving memory...`,
              );
              memoryManager
                .getAsyncRelevantMemoryContext(userTextOutput, sessionId)
                .then(retrievedContext => {
                  if (retrievedContext) {
                    console.log(
                      `[Memory Injection] Injecting memory context into running Gemini Live session.`,
                    );
                    session.sendClientContent({
                      turns: {
                        role: 'user',
                        parts: [
                          {
                            text: `SYSTEM DIRECTIVE (DYNAMIC MEMORY INJECTION):
Here is Safa's relevant persistent memory retrieved from the SQLite database and long-term files for the user's prompt:

${retrievedContext}

Please use this retrieved memory to answer the user's question, continue the story, or resume the task accurately. Do NOT hallucinate.`,
                          },
                        ],
                      },
                    });
                  }
                })
                .catch(err => {
                  console.error(
                    '[Memory Injection] Error fetching/injecting memory context:',
                    err,
                  );
                });
            }

            const textLower = userTextOutput.toLowerCase().trim();
            const isCancelIntent = [
              'cancel',
              'stop',
              'abort',
              'বাতিল',
              'থামো',
            ].some(word => textLower.includes(word));

            if (isCancelIntent) {
              if (
                currentSabitTaskObj.status === 'acquiring' ||
                currentSabitTaskObj.status === 'running' ||
                currentSabitTaskObj.status === 'waiting_for_user'
              ) {
                console.log(
                  '[Task Manager] Cancelling active Sabit task via voice cancel intent.',
                );
                setSabitTaskStatus('cancelled');
                isCurrentlyDelegated = false;
                if (activeSabitLiveSession) {
                  try {
                    activeSabitLiveSession.sendClientContent({
                      turns: {
                        role: 'user',
                        parts: [
                          {
                            text: 'SYSTEM DIRECTIVE (CRITICAL): The user has explicitly cancelled your active task. You MUST immediately stop executing any tools, cease all browser automation, and tell the user politely in your professional voice that you have stopped and the task is cancelled.',
                          },
                        ],
                      },
                      turnComplete: true,
                    });
                  } catch (e) {}
                }
              }
            } else if (sabitRuntimeState.taskState === 'waiting_for_user') {
              resumeSabitTask(userTextOutput);
            }

            if (isCancelIntent && (activeToolCall || activeSabitToolCall)) {
              if (activeSabitToolCall) {
                console.log(
                  `[Task Manager] Sabit active tool call cancellation detected via voice: "${userTextOutput}". Stopping active Sabit tool ${activeSabitToolCall.name}`,
                );
                activeSabitToolCall.resolve({
                  ok: false,
                  error: 'Task explicitly cancelled by user.',
                });
                activeSabitToolCall = null;
              }
              if (activeToolCall) {
                console.log(
                  `[Task Manager] Maira active tool call cancellation detected via voice: "${userTextOutput}". Stopping active Maira tool ${activeToolCall.name}`,
                );
                activeToolCall.resolve({
                  ok: false,
                  error: 'Task explicitly cancelled by user.',
                });
                activeToolCall = null;
              }
              callDesktopAgent('browserSessionClose', {}).catch(() => {});
            }

            const voicePlan = analyzeAndSplitUserRequest(userTextOutput);
            if (voicePlan.isCompound && voicePlan.subTasks.length >= 2) {
              const sabitSubTask = voicePlan.subTasks.find(
                t => t.targetAgent === 'sabit',
              );
              const mairaSubTask = voicePlan.subTasks.find(
                t => t.targetAgent === 'maira',
              );

              let isSabitConnected = false;
              if (globalSabitWss && globalSabitWss.clients) {
                for (const client of globalSabitWss.clients) {
                  if (client.readyState === 1) {
                    isSabitConnected = true;
                    break;
                  }
                }
              }

              const isSabitIdle = sabitRuntimeState.taskState === 'idle';

              if (isSabitConnected && isSabitIdle && sabitSubTask) {
                console.log(
                  `[Task Scheduler Voice] Compound task split detected! Dispatching Task A to Sabit ("${sabitSubTask.goal}") AND Task B to Maira ("${mairaSubTask?.goal}") simultaneously.`,
                );
                acquireSabitTask(sabitSubTask.goal);
                mairaActiveTaskGoal = mairaSubTask?.goal || 'Task 2';

                if (activeSabitLiveSession) {
                  try {
                    activeSabitLiveSession.sendClientContent({
                      turns: {
                        role: 'user',
                        parts: [
                          {
                            text: `SYSTEM DIRECTIVE: You have been delegated a task: "${sabitSubTask.goal}". Please begin executing this task immediately in the background using your available tools.`,
                          },
                        ],
                      },
                      turnComplete: true,
                    });
                  } catch (e) {}
                }

                try {
                  session.sendClientContent({
                    turns: {
                      role: 'user',
                      parts: [
                        {
                          text: `SYSTEM DIRECTIVE (TRUE PARALLEL EXECUTION): The user requested multiple actions via voice: "${userTextOutput}".
Task 1 ("${sabitSubTask.goal}") has ALREADY been dispatched to Sabit and is actively running in the background.
You (Maira) MUST execute Task 2 ("${mairaSubTask?.goal || 'the remaining request'}") YOURSELF SIMULTANEOUSLY right now using your available tools.
Do NOT call delegateToSabit for Task 2. Announce briefly that Sabit is handling Task 1, and immediately execute Task 2!`,
                        },
                      ],
                    },
                  });
                } catch (e) {}
              } else {
                console.log(
                  `[Task Scheduler Voice - Busy Rule] Spoken compound task received but Sabit is busy/offline. Directing Maira to execute both tasks.`,
                );
                try {
                  session.sendClientContent({
                    turns: {
                      role: 'user',
                      parts: [
                        {
                          text: `SYSTEM DIRECTIVE (BUSY RULE): Sabit is currently busy or offline. You (Maira) MUST execute ALL requested tasks directly yourself right now using your available tools: "${userTextOutput}". Do NOT say Sabit is busy, do NOT refuse, and execute immediately.`,
                        },
                      ],
                    },
                  });
                } catch (e) {}
              }
            } else if (!isCancelIntent) {
              console.log(
                `[Voice Router] Spoken voice input handled directly by Gemini Live session: "${userTextOutput}"`,
              );
            }
          }

          if (message.toolCall?.functionCalls) {
            const hasDelegation = message.toolCall.functionCalls.some(
              f => f.name === 'delegateToSabit',
            );
            for (const fc of message.toolCall.functionCalls) {
              console.log(`[Function Call]: ${fc.name}`, fc.args);

              if (fc.name === 'delegateToSabit') {
                (async () => {
                  const args = fc.args as any;
                  const task = args.task;
                  console.log(
                    `[Delegation] Maira is delegating task to Sabit: "${task}"`,
                  );

                  if (!task) {
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: {
                            output: {
                              error:
                                'Task description is required to delegate to Sabit.',
                            },
                          },
                          id: fc.id,
                        },
                      ],
                    });
                    return;
                  }

                  let isSabitConnected = false;
                  for (const client of sabitWss.clients) {
                    if (client.readyState === 1) {
                      isSabitConnected = true;
                      break;
                    }
                  }

                  if (!isSabitConnected) {
                    console.log(
                      '[Delegation Failed] Sabit is currently offline/disconnected.',
                    );
                    const apiKey = getSabitApiKey();

                    let speechMessage =
                      "Sabit is currently offline due to a connection issue, so I'll handle this task myself.";
                    if (!apiKey) {
                      speechMessage =
                        "Sabit is currently offline because his API key is not configured, so I'll handle this task myself.";
                    } else if (isSabitManuallyDisconnectedByUser) {
                      speechMessage =
                        "Sabit is currently offline because you manually disconnected him, so I'll handle this task myself.";
                    }

                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: {
                            output: {
                              error: speechMessage,
                            },
                          },
                          id: fc.id,
                        },
                      ],
                    });
                    return;
                  }

                  const isSabitBusy =
                    sabitRuntimeState.taskState === 'acquiring' ||
                    sabitRuntimeState.taskState === 'running' ||
                    sabitRuntimeState.taskState === 'recovering' ||
                    sabitRuntimeState.taskState === 'waiting_for_user';
                  if (isSabitBusy) {
                    console.log(
                      `[Delegation Blocked] Sabit is already busy: "${sabitRuntimeState.activeTaskGoal}". Instructing Maira to execute herself.`,
                    );
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: {
                            output: {
                              error: `Sabit is currently busy executing another task ("${sabitRuntimeState.activeTaskGoal}"). You MUST execute this new task yourself immediately using your browser/desktop tools. Do NOT refuse the user, do NOT ask for confirmation, and NEVER say "Sabit is busy". Execute the task yourself right now!`,
                            },
                          },
                          id: fc.id,
                        },
                      ],
                    });
                    return;
                  }

                  const success = acquireSabitTask(task);
                  if (!success) {
                    console.log('[Delegation Failed] Sabit is currently busy.');
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: {
                            output: {
                              error:
                                'Sabit is currently busy with another task.',
                            },
                          },
                          id: fc.id,
                        },
                      ],
                    });
                    return;
                  }

                  console.log('[Delegation Success] Handing off to Sabit.');
                  try {
                    clientWs.send(
                      JSON.stringify({
                        type: 'sabit_delegated',
                        task: task,
                      }),
                    );
                  } catch (e) {}

                  if (activeSabitLiveSession) {
                    try {
                      console.log(
                        `[Delegation Active Session] Instantly sending task to open Sabit Live session: "${task}"`,
                      );
                      activeSabitLiveSession.sendClientContent({
                        turns: {
                          role: 'user',
                          parts: [
                            {
                              text: `SYSTEM DIRECTIVE: You have been delegated a task: "${task}". Please begin executing this task immediately using your available tools.

CRITICAL PROTOCOLS:
1. EXPLICIT VOICE & TEXT: Tell the user exactly what you are doing, execute the browser automation or search steps, and verify the correct target page is opened or the action succeeded.
2. NO PREMATURE COMPLETION: Do NOT call 'sabitTaskComplete' after completing only the first few steps. For example, if the goal is to send a WhatsApp message, merely searching or opening the chat is NOT completion. You MUST type the message and send it, and verify on screen that it has actually been sent.
3. VERIFY COMPLETION: Do not assume success immediately upon a tool response. Double check that the page or content loaded as expected and the complete goal has been fully achieved before concluding.
4. AUTHORITATIVE COMPLETION: Once and ONLY once you have fully verified the task's successful execution, you MUST call the 'sabitTaskComplete' tool. This will authoritatively mark the task as completed.
5. AUTHORITATIVE FAILURE: If you hit a blocking issue (such as a CAPTCHA, a persistent timeout, or a browser error), explain the issue clearly and call the 'sabitTaskFailed' tool with a specific reason. Do not attempt further loops.
`,
                            },
                          ],
                        },
                        turnComplete: true,
                      });
                    } catch (e) {
                      console.error(
                        '[Delegation Active Session] Failed to send client turn to Sabit Live session:',
                        e,
                      );
                    }
                  }

                  isCurrentlyDelegated = true;
                  console.log(
                    '[Delegation State] isCurrentlyDelegated set to TRUE.',
                  );
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        name: fc.name,
                        response: {
                          output: {
                            result:
                              'Task successfully delegated to Sabit. He will handle it independently in his own browser context and inform the user. You (Maira) MUST now explicitly announce to the user out loud and in text that you have handed over the task to Sabit, that he is running it in the background, and that you are ready to continue our conversation in standby. Use the recommended English or Bengali template phrase.',
                          },
                        },
                        id: fc.id,
                      },
                    ],
                  });
                })();
              } else if (fc.name === 'saveCustomMemory') {
                (async () => {
                  try {
                    const args = fc.args as any;
                    const category = args.category;
                    const text = args.text;
                    if (category && text) {
                      const mList = await loadMemories();
                      const timestamp = new Date().toISOString();
                      const newMemory: Memory = {
                        id: Math.random().toString(36).substring(2, 11),
                        category,
                        text,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                      };
                      mList.push(newMemory);
                      await saveMemories(mList);
                      clientWs.send(
                        JSON.stringify({
                          type: 'memory_sync',
                          memories: mList,
                        }),
                      );
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: {
                              output: {
                                result:
                                  'Memory successfully captured and persisted in connections core.',
                              },
                            },
                            id: fc.id,
                          },
                        ],
                      });
                    }
                  } catch (err: any) {
                    console.error('saveCustomMemory execution failure:', err);
                  }
                })();
              } else if (fc.name === 'memory' || fc.name === 'memory_manage') {
                (async () => {
                  try {
                    const {
                      action,
                      target,
                      content,
                      fact,
                      old_text,
                      old_fact,
                    } = fc.args as any;
                    const result = memoryManager.memoryTool({
                      action,
                      target: target || 'memory',
                      content: content || fact,
                      oldText: old_text || old_fact,
                    });
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output: result },
                          id: fc.id,
                        },
                      ],
                    });
                  } catch (err: any) {
                    console.error('memory Live execution failure:', err);
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output: { error: err.message } },
                          id: fc.id,
                        },
                      ],
                    });
                  }
                })();
              } else if (fc.name === 'session_search') {
                (async () => {
                  try {
                    const result = await memoryManager.sessionSearch({
                      query: (fc.args as any)?.query,
                      limit: (fc.args as any)?.limit || 3,
                      sessionId: (fc.args as any)?.session_id,
                      window: (fc.args as any)?.window,
                    });
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output: result },
                          id: fc.id,
                        },
                      ],
                    });
                  } catch (err: any) {
                    console.error(
                      'session_search Live execution failure:',
                      err,
                    );
                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output: { error: err.message } },
                          id: fc.id,
                        },
                      ],
                    });
                  }
                })();
              } else if (DESKTOP_TOOLS.has(fc.name)) {
                const BROWSER_AUTOMATION_TOOLS = new Set([
                  'openWebsite',
                  'searchWeb',
                  'searchYouTube',
                  'searchGoogle',
                  'searchGitHub',
                  'desktopBrowserOpen',
                  'desktopBrowserSnapshot',
                  'desktopBrowserClick',
                  'desktopBrowserType',
                  'desktopBrowserSearch',
                  'desktopBrowserScroll',
                  'desktopBrowserGetText',
                  'desktopBrowserScreenshot',
                  'desktopBrowserMediaControl',
                  'desktopBrowserPressKey',
                  'desktopBrowserListTabs',
                  'desktopBrowserSwitchTab',
                ]);

                let isSabitConnected = false;
                if (globalSabitWss && globalSabitWss.clients) {
                  for (const client of globalSabitWss.clients) {
                    if (client.readyState === 1) {
                      isSabitConnected = true;
                      break;
                    }
                  }
                }

                const isSabitIdle =
                  sabitRuntimeState.taskState === 'idle' ||
                  sabitRuntimeState.taskState === 'completed' ||
                  sabitRuntimeState.taskState === 'failed' ||
                  sabitRuntimeState.taskState === 'cancelled';
                if (
                  isSabitConnected &&
                  isSabitIdle &&
                  BROWSER_AUTOMATION_TOOLS.has(fc.name)
                ) {
                  console.log(
                    `[Delegation Guard] Blocking Maira's direct tool call ${fc.name} because Sabit is connected and available. Forcing delegation.`,
                  );
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        name: fc.name,
                        response: {
                          output: {
                            error:
                              "Sabit is connected and available. You are FORBIDDEN from running browser automation or web search tools directly. You MUST call the 'delegateToSabit' tool with the task goal instead to hand over the execution.",
                          },
                        },
                        id: fc.id,
                      },
                    ],
                  });
                  continue;
                }

                if (
                  isSabitConnected &&
                  sabitRuntimeState.taskState === 'waiting_for_user' &&
                  BROWSER_AUTOMATION_TOOLS.has(fc.name) &&
                  !mairaActiveTaskGoal
                ) {
                  console.log(
                    `[Delegation Guard] Blocking Maira's direct tool call ${fc.name} because Sabit task is in waiting_for_user state.`,
                  );
                  session.sendToolResponse({
                    functionResponses: [
                      {
                        name: fc.name,
                        response: {
                          output: {
                            error:
                              'Sabit has an active task waiting for user action on screen. You are FORBIDDEN from running browser tools directly while Sabit has an active task waiting for user interaction.',
                          },
                        },
                        id: fc.id,
                      },
                    ],
                  });
                  continue;
                }

                (async () => {
                  console.log(
                    `[Desktop Agent] Routing ${fc.name} to Python backend...`,
                  );
                  try {
                    clientWs.send(
                      JSON.stringify({
                        type: 'browserAutomationEvent',
                        name: fc.name,
                        args: fc.args,
                        status: 'started',
                      }),
                    );
                  } catch (e) {}

                  const agentResult = await new Promise<{
                    ok: boolean;
                    result?: any;
                    error?: string;
                  }>(async resolve => {
                    activeToolCall = {
                      id: fc.id,
                      name: fc.name,
                      resolve: res => resolve(res),
                      reject: err => resolve({ ok: false, error: err }),
                    };

                    try {
                      const argsWithCaller = {
                        ...(fc.args as Record<string, unknown>),
                        _caller: 'maira',
                      };
                      const res = await callDesktopAgent(
                        fc.name,
                        argsWithCaller,
                      );
                      resolve(res);
                    } catch (err: any) {
                      resolve({
                        ok: false,
                        error: err?.message || String(err),
                      });
                    } finally {
                      if (activeToolCall?.id === fc.id) {
                        activeToolCall = null;
                      }
                    }
                  });

                  if (agentResult.ok) {
                    const output = agentResult.result ?? { result: 'Done.' };
                    try {
                      clientWs.send(
                        JSON.stringify({
                          type: 'browserAutomationEvent',
                          name: fc.name,
                          args: fc.args,
                          status: 'completed',
                          result: output,
                        }),
                      );
                    } catch (e) {}

                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: { output },
                          id: fc.id,
                        },
                      ],
                    });
                  } else {
                    const errMsg = agentResult.error || 'Desktop agent error.';
                    console.error(
                      `[Desktop Agent] Error or interruption for ${fc.name}:`,
                      errMsg,
                    );

                    if (
                      errMsg.includes('not running') ||
                      errMsg.includes('timed out') ||
                      errMsg.includes('UNREACHABLE') ||
                      errMsg.includes('fetch failed')
                    ) {
                      try {
                        session.sendClientContent({
                          turns: {
                            role: 'user',
                            parts: [
                              {
                                text: 'SYSTEM DIRECTIVE (CRITICAL): The local Desktop Agent is not running. You must immediately speak to the user politely in your sweet anime companion tone, explaining clearly that you cannot execute the task because the Desktop Agent is not running on their computer. Tell them that once they start the Desktop Agent, you can execute the task again. Do not run any more tools.',
                              },
                            ],
                          },
                        });
                      } catch (e) {}
                    }

                    try {
                      clientWs.send(
                        JSON.stringify({
                          type: 'browserAutomationEvent',
                          name: fc.name,
                          args: fc.args,
                          status: 'failed',
                          error: errMsg,
                        }),
                      );
                    } catch (e) {}

                    session.sendToolResponse({
                      functionResponses: [
                        {
                          name: fc.name,
                          response: {
                            output: {
                              result: `Desktop control error: ${errMsg}`,
                            },
                          },
                          id: fc.id,
                        },
                      ],
                    });
                  }
                })();
              } else {
                clientWs.send(
                  JSON.stringify({
                    type: 'toolCall',
                    callId: fc.id,
                    name: fc.name,
                    args: fc.args,
                  }),
                );
              }
            }
          }
        },
        onclose: () => {
          console.log(
            '[Server] Gemini Live session closed (idle timeout or server-side disconnect)',
          );
          clearInterval(mairaKeepaliveTimer);
          if (clientWs.readyState !== clientWs.OPEN) {
            console.log(
              '[Server] Client WS already closed — nothing to reconnect.',
            );
            return;
          }
          try {
            clientWs.send(
              JSON.stringify({ type: 'status', status: 'session_closed' }),
            );
          } catch (e) {}

          let recreationAttempts = 0;
          const maxRecreationAttempts = 3;
          const attemptRecreation = async () => {
            if (clientWs.readyState !== clientWs.OPEN) return;
            recreationAttempts++;
            console.log(
              `[Server] Attempting Gemini session recreation ${recreationAttempts}/${maxRecreationAttempts}…`,
            );
            try {
              clientWs.send(
                JSON.stringify({ type: 'status', status: 'reconnecting' }),
              );
              const newSession = await ai.live.connect({
                model: 'gemini-3.1-flash-live-preview',
                config: sessionConfig,
                callbacks: sessionCallbacks,
              });
              session = newSession;
              activeMairaLiveSession = newSession;
              mairaLastActivity = Date.now();
              clearInterval(mairaKeepaliveTimer);
              startKeepalive();
              console.log(
                '[Server] Gemini session recreated successfully — conversation continues seamlessly.',
              );
              clientWs.send(
                JSON.stringify({ type: 'status', status: 'connected' }),
              );
            } catch (e: any) {
              console.error(
                `[Server] Session recreation attempt ${recreationAttempts} failed:`,
                e?.message || e,
              );
              if (recreationAttempts < maxRecreationAttempts) {
                const delay = Math.min(
                  2000 * Math.pow(2, recreationAttempts - 1),
                  10000,
                );
                const jitter = Math.floor(Math.random() * 500);
                setTimeout(attemptRecreation, delay + jitter);
              } else {
                console.error(
                  '[Server] All recreation attempts failed — telling client to full reconnect.',
                );
                try {
                  clientWs.send(
                    JSON.stringify({
                      type: 'status',
                      status: 'session_closed',
                    }),
                  );
                } catch (e2) {}
              }
            }
          };
          setTimeout(attemptRecreation, 1500);
        },
      };

      session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: sessionConfig,
        callbacks: sessionCallbacks,
      });

      activeMairaLiveSession = session;

      clientWs.send(
        JSON.stringify({ type: 'status', status: 'session_ready' }),
      );
      clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL: Conversation restore on (Re)connect (Stonic Pattern)
      // ═══════════════════════════════════════════════════════════════════════
      // The FULL conversation history is already injected into the Gemini Live
      // systemInstruction above (formatSystemInstructionsWithContext →
      // "PRIOR CONVERSATION CONTEXT"). That is permanent and immune to turn
      // replay, exactly like Stonic's chat-completion messages array.
      //
      // OLD BUG: Replaying turns via sendClientContent made Gemini Live
      // interrupt itself turn-by-turn (each client content message interrupts
      // the previous one), wiping the injected context and making Safa forget
      // everything on reconnect. So we NO LONGER replay turns here.
      //
      // We only send ONE lightweight resume directive (turnComplete: false) so
      // Safa continues from where the conversation left off.
      const _restoreDialogueHistory = dialogueHistory || [];
      if (_restoreDialogueHistory && _restoreDialogueHistory.length > 0) {
        console.log(
          `[Session Restore] Restored ${_restoreDialogueHistory.length} turns via system instruction (no turn replay — Stonic pattern).`,
        );
        setTimeout(() => {
          try {
            session.sendClientContent({
              turns: {
                role: 'user',
                parts: [
                  {
                    text: `[SYSTEM: We just reconnected after a brief disconnection. The full conversation history was provided in your system instructions above — continue naturally from exactly where we left off. Do NOT mention reconnection, do NOT repeat yourself, just continue the conversation as if nothing happened.]`,
                  },
                ],
              },
              turnComplete: false,
            });
          } catch (e) {
            console.error('[Session Restore] Error sending resume directive:', e);
          }
        }, 1000);
      }

      // ─── Keepalive ping (Stonic pattern — FIXED) ─────────────────────────
      // Gemini Live has a ~4-minute WebSocket idle timeout. Send a tiny but VALID
      // silence audio frame every 20s when no real audio is flowing. Previously
      // sent an empty string "" which Gemini rejects — causing silent idle kills.
      // Now we send actual PCM silence (320 bytes of zeros = 10ms at 16kHz).
      const SILENCE_FRAME_B64 = Buffer.alloc(320, 0).toString('base64');
      let mairaLastActivity = Date.now();
      let mairaKeepaliveTimer: NodeJS.Timeout | null = null;
      const startKeepalive = () => {
        if (mairaKeepaliveTimer) clearInterval(mairaKeepaliveTimer);
        mairaKeepaliveTimer = setInterval(() => {
          try {
            if (clientWs.readyState !== clientWs.OPEN) return;
            const now = Date.now();
            if (now - mairaLastActivity > 20000) {
              if (session) {
                session.sendRealtimeInput({
                  audio: {
                    data: SILENCE_FRAME_B64,
                    mimeType: 'audio/pcm;rate=16000',
                  },
                });
              }
              mairaLastActivity = now;
            }
          } catch (e) {
            // Session may have closed — keepalive errors are non-fatal
          }
        }, 5000);
      };
      startKeepalive();

      // Helper to reset keepalive activity on real audio/messages
      const touchMairaActivity = () => {
        mairaLastActivity = Date.now();
      };

      clientWs.on('message', rawMsg => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.type === 'pong') {
            // Client heartbeat acknowledged
            return;
          }
          if (msg.type === 'ping') {
            try {
              if (clientWs.readyState === clientWs.OPEN) {
                clientWs.send(JSON.stringify({ type: 'pong' }));
              }
            } catch (e) {}
            return;
          }
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
            });
          } else if (msg.type === 'text' && msg.text) {
            // ── Stonic-style session commands: /resume, /branch ──────────────
            const trimmedCmd = msg.text.trim();
            if (/^\/resume\b/i.test(trimmedCmd)) {
              try {
                const { resolveResumeSessionId, getSessionMessages } = require('./session_db');
                const resumeTarget = resolveResumeSessionId(sessionId);
                const msgs = getSessionMessages(resumeTarget, 150).map((m: any) => ({
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  message_type: m.message_type,
                  thinking_summary: m.thinking_summary,
                  timestamp: m.timestamp,
                }));
                console.log(
                  `[Session Command] /resume → resolving ${sessionId} → ${resumeTarget} (${msgs.length} messages)`,
                );
                try {
                  clientWs.send(
                    JSON.stringify({
                      type: 'session_switch',
                      sessionId: resumeTarget,
                      title: msgs.length ? undefined : undefined,
                      messages: msgs,
                    }),
                  );
                } catch (e) {}
              } catch (e: any) {
                console.error('[Session Command] /resume failed:', e?.message);
              }
              return;
            }

            if (/^\/branch\b/i.test(trimmedCmd)) {
              try {
                const { createChildSession, copyMessagesToSession, markSessionEnded } = require('./session_db');
                const child = createChildSession(sessionId, 'Branch');
                const copied = copyMessagesToSession(sessionId, child.id);
                markSessionEnded(sessionId, 'branched');
                console.log(
                  `[Session Command] /branch → created ${child.id} with ${copied} copied messages from ${sessionId}`,
                );
                try {
                  clientWs.send(
                    JSON.stringify({
                      type: 'session_switch',
                      sessionId: child.id,
                      title: child.title,
                      messages: [],
                    }),
                  );
                } catch (e) {}
              } catch (e: any) {
                console.error('[Session Command] /branch failed:', e?.message);
              }
              return;
            }

            // Check for cancel intent in user typed text
            const textLower = msg.text.toLowerCase().trim();
            const isCancelIntent = [
              'cancel',
              'stop',
              'abort',
              'à¦¬à¦¾à¦¤à¦¿à¦²',
              'à¦¥à¦¾à¦®à§‹',
            ].some(word => textLower.includes(word));

            if (isCancelIntent) {
              if (
                sabitRuntimeState.taskState === 'acquiring' ||
                sabitRuntimeState.taskState === 'running' ||
                sabitRuntimeState.taskState === 'recovering' ||
                sabitRuntimeState.taskState === 'waiting_for_user'
              ) {
                console.log(
                  '[Task Manager] Cancelling active Sabit task via text cancel intent.',
                );
                cancelSabitTask('Task explicitly cancelled by user.');
              }
            } else if (sabitRuntimeState.taskState === 'waiting_for_user') {
              resumeSabitTask(msg.text);
              return;
            }

            if (activeToolCall || (isCancelIntent && activeSabitToolCall)) {
              if (activeSabitToolCall) {
                console.log(
                  `[Task Manager] User sent cancellation while Sabit tool ${activeSabitToolCall.name} was running.`,
                );
                activeSabitToolCall.resolve({
                  ok: false,
                  error: 'Task explicitly cancelled by user.',
                });
                activeSabitToolCall = null;
              }
              if (activeToolCall) {
                console.log(
                  `[Task Manager] User sent text message / cancellation while Maira tool ${activeToolCall.name} was running.`,
                );
                activeToolCall.resolve({
                  ok: false,
                  error: isCancelIntent
                    ? 'Task explicitly cancelled by user.'
                    : `Task interrupted by user's new command: "${msg.text}"`,
                });
                activeToolCall = null;
              }

              // Stop browser/release Playwright PC lock
              callDesktopAgent('browserSessionClose', {}).catch(() => {});
            }

            // Chat text input from user â†’ forward to Gemini Live session via Scheduler
            try {
              appendDialogueTurn(sessionId, { role: 'user', text: msg.text });
              memoryManager
                .syncTurn({
                  sessionId,
                  role: 'user',
                  content: msg.text,
                  messageType: 'user_text',
                })
                .catch(() => {});
              const recallIntent = detectRecallIntent(msg.text);
              if (recallIntent !== 'NONE' || isExplicitRecall(msg.text)) {
                console.log(
                  `[Memory Injection] Detected recall intent "${recallIntent}" in text: "${msg.text}". Retrieving memory...`,
                );
                memoryManager
                  .getAsyncRelevantMemoryContext(msg.text, sessionId)
                  .then(retrievedContext => {
                    if (retrievedContext) {
                      console.log(
                        `[Memory Injection] Injecting memory context into running Gemini Live text session.`,
                      );
                      session.sendClientContent({
                        turns: {
                          role: 'user',
                          parts: [
                            {
                              text: `SYSTEM DIRECTIVE (DYNAMIC MEMORY INJECTION):
Here is Maira's relevant persistent memory retrieved from the SQLite database and long-term files for the user's prompt:

${retrievedContext}

Please use this retrieved memory to answer the user's question, continue the story, or resume the task accurately. Do NOT hallucinate.`,
                            },
                          ],
                        },
                        turnComplete: true,
                      });
                    }
                  })
                  .catch(err => {
                    console.error(
                      '[Memory Injection] Error fetching/injecting text memory context:',
                      err,
                    );
                  });
              }
              const plan = analyzeAndSplitUserRequest(msg.text);

              if (plan.isCompound && plan.subTasks.length >= 2) {
                const sabitSubTask = plan.subTasks.find(
                  t => t.targetAgent === 'sabit',
                );
                const mairaSubTask = plan.subTasks.find(
                  t => t.targetAgent === 'maira',
                );

                let isSabitConnected = false;
                if (globalSabitWss && globalSabitWss.clients) {
                  for (const client of globalSabitWss.clients) {
                    if (client.readyState === 1 /* OPEN */) {
                      isSabitConnected = true;
                      break;
                    }
                  }
                }

                const isSabitIdle = sabitRuntimeState.taskState === 'idle';

                if (isSabitConnected && isSabitIdle && sabitSubTask) {
                  console.log(
                    `[Task Scheduler] Compound task split detected! Dispatching Task A to Sabit ("${sabitSubTask.goal}") AND Task B to Maira ("${mairaSubTask?.goal}") simultaneously.`,
                  );

                  // Acquire Sabit task
                  acquireSabitTask(sabitSubTask.goal);
                  mairaActiveTaskGoal = mairaSubTask?.goal || 'Task 2';

                  // Dispatch to Sabit
                  if (activeSabitLiveSession) {
                    try {
                      activeSabitLiveSession.sendClientContent({
                        turns: {
                          role: 'user',
                          parts: [
                            {
                              text: `SYSTEM DIRECTIVE: You have been delegated a task: "${sabitSubTask.goal}". Please begin executing this task immediately in the background using your available tools.`,
                            },
                          ],
                        },
                        turnComplete: true,
                      });
                    } catch (e) {}
                  }

                  // Dispatch to Maira
                  session.sendClientContent({
                    turns: {
                      role: 'user',
                      parts: [
                        {
                          text: `SYSTEM DIRECTIVE (TRUE PARALLEL EXECUTION): The user requested multiple actions: "${msg.text}".
Task 1 ("${sabitSubTask.goal}") has ALREADY been dispatched to Sabit and is actively running in the background.
You (Maira) MUST execute Task 2 ("${mairaSubTask?.goal || 'the remaining request'}") YOURSELF SIMULTANEOUSLY right now using your available tools.
Do NOT call delegateToSabit for Task 2. Announce briefly that Sabit is handling Task 1, and immediately execute Task 2!`,
                        },
                      ],
                    },
                  });
                } else {
                  // Busy Rule: Sabit is busy or offline -> Maira executes all tasks directly on her worker
                  console.log(
                    `[Task Scheduler - Busy Rule] Compound task received but Sabit is busy/offline. Directing Maira to execute both tasks.`,
                  );
                  session.sendClientContent({
                    turns: {
                      role: 'user',
                      parts: [
                        {
                          text: `SYSTEM DIRECTIVE (BUSY RULE): Sabit is currently busy or offline. You (Maira) MUST execute ALL requested tasks directly yourself right now using your available tools: "${msg.text}". Do NOT say Sabit is busy, do NOT refuse, and execute immediately.`,
                        },
                      ],
                    },
                  });
                }
              } else {
                // Route text chat directly to Agent Core execution engine
                agentCore
                  .executeTask({
                    userPrompt: msg.text,
                    dialogueHistory,
                    sessionId,
                    origin: 'text',
                    clientWs,
                    session,
                  })
                  .then(result => {
                    console.log(
                      `[AGENT CORE] Text task execution completed. Success: ${result.ok}`,
                    );
                  })
                  .catch(err => {
                    console.error(
                      '[AGENT CORE] Text task execution error:',
                      err,
                    );
                  });
              }
              console.log(
                `[Chat] Text routed to Agent Core: "${msg.text.substring(0, 80)}"`,
              );
            } catch (e: any) {
              console.error(
                '[Chat] Failed to send text to Gemini:',
                e?.message || e,
              );
            }
          } else if (msg.type === 'cancelTask') {
            if (
              sabitRuntimeState.taskState === 'acquiring' ||
              sabitRuntimeState.taskState === 'running' ||
              sabitRuntimeState.taskState === 'recovering' ||
              sabitRuntimeState.taskState === 'waiting_for_user'
            ) {
              console.log(
                '[Task Manager] Explicit cancellation requested via cancelTask event for active Sabit task.',
              );
              cancelSabitTask('Task explicitly cancelled by user.');
            }
            if (activeToolCall) {
              console.log(
                `[Task Manager] Explicit cancellation requested via cancelTask event for tool: ${activeToolCall.name}`,
              );
              activeToolCall.resolve({
                ok: false,
                error: 'Task explicitly cancelled by user.',
              });
              activeToolCall = null;

              // Stop browser/release Playwright PC lock
              callDesktopAgent('browserSessionClose', {
                _caller: 'maira',
              }).catch(() => {});

              try {
                clientWs.send(
                  JSON.stringify({
                    type: 'browserAutomationEvent',
                    name: 'cancelTask',
                    status: 'cancelled',
                    message: 'Task successfully cancelled.',
                  }),
                );
              } catch (e) {}

              // Notify Gemini that task was cancelled
              try {
                session.sendClientContent({
                  turns: {
                    role: 'user',
                    parts: [
                      {
                        text: 'The user has explicitly cancelled the active background task. Please acknowledge the cancellation in your sweet, supportive voice.',
                      },
                    ],
                  },
                });
              } catch (e) {}
            }
          } else if (msg.type === 'video' && msg.video) {
            session.sendRealtimeInput({
              video: { data: msg.video, mimeType: 'image/jpeg' },
            });
          } else if (msg.type === 'toolResponse') {
            session.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id,
                },
              ],
            });
          }
        } catch (e) {
          console.error('Error editing/forwarding client frame message:', e);
        }
      });

      clientWs.on('close', () => {
        console.log('Client disconnected, closing Gemini session');
        // Flush the user's last (possibly unfinished) utterance too — a
        // disconnect between utterance and turnComplete must not lose it.
        if (pendingUserTranscript.trim()) {
          const pendingUser = pendingUserTranscript;
          pendingUserTranscript = '';
          appendDialogueTurn(sessionId, { role: 'user', text: pendingUser });
          memoryManager
            .syncTurn({
              sessionId,
              role: 'user',
              content: pendingUser,
              messageType: 'user_voice',
            })
            .catch((err: any) => {
              console.error('[Voice Save] Error persisting user turn on disconnect:', err?.message || err);
            });
        }
        flushPendingModelTurn();
        clearInterval(serverHeartbeatInterval);
        clearInterval(mairaKeepaliveTimer);
        isCurrentlyDelegated = false;
        if (activeMairaLiveSession === session) {
          activeMairaLiveSession = null;
        }
        try {
          // Gracefully close the Gemini session — prevents orphaned server-side sessions
          session.close();
        } catch (e) {}
      });
    } catch (err: any) {
      clearInterval(serverHeartbeatInterval);
      const errMsg = err?.message || String(err);
      console.error('Error connecting to Gemini Live API:', errMsg);
      logError(`GEMINI_SESSION_ERROR: ${errMsg.substring(0, 300)}`);

      // Do NOT close the WebSocket on Gemini errors. Instead, notify the client
      // and let it auto-reconnect. Closing the WS forces a full mic re-acquire
      // and loses the entire session state. A transient Gemini error (timeout,
      // rate limit, network blip) should be recoverable without a full reconnect.
      const isTransient =
        /timeout|rate.?limit|429|503|network|fetch|ECONN|socket|temporarily|unavailable/i.test(
          errMsg,
        );
      if (isTransient) {
        try {
          clientWs.send(
            JSON.stringify({
              type: 'status',
              status: 'session_closed',
            }),
          );
        } catch (e) {}
        console.log(
          '[Server] Gemini session error was transient â€” client will auto-reconnect.',
        );
      } else {
        // Non-transient (auth, invalid key, etc.) â€” send error to client.
        try {
          clientWs.send(
            JSON.stringify({
              type: 'error',
              error: `Could not connect to Gemini: ${errMsg}`,
            }),
          );
        } catch (e) {}
        // Still don't close â€” let the client decide whether to retry.
      }
    }
  });

  // â”€â”€ Client WebSocket error handler (catches protocol-level errors) â”€â”€
  wss.on('error', err => {
    console.error('[Server] WebSocket server error:', err?.message || err);
    logError(`WS_SERVER_ERROR: ${String(err).substring(0, 200)}`);
    // Do NOT crash â€” WebSocket errors can be transient.
  });

  // Serve custom static assets folder
  app.use('/assets', express.static(path.join(process.cwd(), 'assets')));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== 'production') {
    // Loaded lazily so the production bundle never requires vite (a dev-only
    // dependency that is not shipped with the packaged app).
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // A leftover server from a previous run (or a second instance) holding port
  // 3000 used to surface as a crash-looping UNCAUGHT_EXCEPTION: EADDRINUSE —
  // and worse, clients kept talking to the OLD process running OLD code, so
  // every fix looked like it "didn't work". Detect it explicitly and say so.
  server.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      const msg =
        `[Server] Port ${PORT} is already in use by a leftover Safa/MYRAA server ` +
        `process. That OLD process keeps serving OLD code — kill it and restart the app. ` +
        `Find it with: netstat -ano | findstr :3000  then: taskkill /PID <pid> /F`;
      console.error(msg);
      logError(`EADDRINUSE_EXIT: port ${PORT} already in use — new server exiting, old process still serving.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, '0.0.0.0', () => {
    logStartup(`MYRAA V2 server started on http://localhost:${PORT}`);
    console.log(`[Server] Running on http://localhost:${PORT}`);
    // Kick off the desktop agent (probe + auto-spawn) immediately on boot.
    ensureDesktopAgent().catch(e =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`),
    );
  });
}

if (!process.env.TEST_MODE) {
  startServer().catch(error => {
    console.error('Failed to start server startup sequence:', error);
  });
}

// ---------------------------------------------------------------------------
// CRASH GUARDS â€” prevent unhandled errors from killing the Electron process.
// Without these, any unhandled promise rejection or uncaught exception in the
// server (e.g. Gemini API timeout, network blip, JSON parse failure) would
// crash the entire Node process, taking down the Electron app with it.
// ---------------------------------------------------------------------------

// Catch unhandled promise rejections so they never crash the process.
process.on('unhandledRejection', (reason: any, promise: any) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[FATAL GUARD] Unhandled Promise Rejection:', msg);
  logError(`UNHANDLED_REJECTION: ${msg.substring(0, 300)}`);
  // Do NOT exit â€” keep the server alive. The user's session will auto-recover.
});

// Catch uncaught exceptions so a single bug doesn't kill the whole process.
process.on('uncaughtException', (error: Error) => {
  const msg = error?.message || String(error);
  console.error('[FATAL GUARD] Uncaught Exception:', msg);
  logError(
    `UNCAUGHT_EXCEPTION: ${msg.substring(0, 300)} | Stack: ${(error?.stack || '').substring(0, 500)}`,
  );
  // Do NOT exit â€” swallow and continue. Better a degraded session than a
  // full app crash that forces the user to restart everything.
});

// Guard against SIGINT (Ctrl+C) accidentally killing the Electron parent
// during automation. In the Electron context, SIGINT can be sent by the
// OS or a parent process. We ignore stray SIGINT in the server process â€”
// the Electron main process handles the actual app quit via before-quit.
process.on('SIGINT', () => {
  console.log('[Server] SIGINT received â€” ignoring (use app quit to exit).');
});
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received â€” ignoring (use app quit to exit).');
});
