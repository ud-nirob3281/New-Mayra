import { GoogleGenAI, Type } from "@google/genai";
import { getSabitApiKey, getGeminiApiKey } from "./server_paths";
import { loadMemories, loadLearnedRules } from "./server_memory";

export interface SabitTask {
  id: string;
  title: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_user";
  progress: number;
  currentStep: string;
  activeTool?: string;
  application?: string;
  userInstruction: string;
  requiredContext?: string;
  logs: string[];
  waitingQuestion?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  cancelRequested?: boolean;
}

export interface SabitChatMessage {
  id: string;
  role: "user" | "sabit";
  text: string;
  timestamp: string;
  taskId?: string;
}

// In-memory state
const sabitTasks: SabitTask[] = [];
const sabitChatMessages: SabitChatMessage[] = [
  {
    id: "init_1",
    role: "sabit",
    text: "আমি SABIT, Safa-এর Assistant। বলুন, কীভাবে সাহায্য করতে পারি?",
    timestamp: new Date().toISOString()
  }
];

export interface ActiveBrowserContext {
  lastTaskId?: string;
  activeApp?: string;
  activeUrl?: string;
  activeTabTitle?: string;
  lastAction?: string;
  updatedAt: string;
}

export let activeBrowserContext: ActiveBrowserContext = {
  updatedAt: new Date().toISOString()
};

export function updateActiveBrowserContext(update: Partial<ActiveBrowserContext>) {
  activeBrowserContext = {
    ...activeBrowserContext,
    ...update,
    updatedAt: new Date().toISOString()
  };
}

export function formatGeminiErrorMessage(err: any): string {
  const msg = String(err?.message || err || "");
  if (/high demand|spikes in demand|unavailable|503|resource_exhausted|overloaded|rate limit/i.test(msg)) {
    return "গুগল সার্ভারে বর্তমানে অতিরিক্ত ট্রাফিকের (High Demand) কারণে সাড়া পেতে দেরি হচ্ছে। অনুগ্রহ করে ২-১ সেকেন্ড পর আবার চেষ্টা করুন।";
  }
  if (/API key|unauthorized|invalid_api_key|401|403/i.test(msg)) {
    return "Gemini API Key সঠিক নয় বা পারমিশন নেই। অনুগ্রহ করে Settings থেকে সঠিক API Key চেক করুন।";
  }
  if (/NOT_FOUND|not found/i.test(msg)) {
    return "মডেল কানেকশনে সাময়িক সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।";
  }
  return msg || "সাময়িক কারিগরি ত্রুটি ঘটেছে। অনুগ্রহ করে আবার চেষ্টা করুন।";
}

/**
 * Executes generateContent using fast fallback models (gemini-2.5-flash, gemini-3.5-flash, gemini-2.0-flash, gemini-1.5-flash)
 * to seamlessly handle transient 503 high-demand errors on any single model.
 */
async function callGeminiWithFallback(
  ai: GoogleGenAI,
  req: { contents: any; config: any; model?: string }
): Promise<any> {
  const candidateModels = [
    req.model,
    process.env.SABIT_MODEL,
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ];

  // Remove duplicates and empty values while preserving order
  const modelsToTry = candidateModels.filter((m, i, self) => Boolean(m) && self.indexOf(m) === i) as string[];
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    try {
      const res = await ai.models.generateContent({
        model: modelName,
        contents: req.contents,
        config: req.config
      });
      if (res) return res;
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err);
      console.warn(`[SABIT AI Call] Model ${modelName} failed: ${msg.slice(0, 100)}`);
      // Try next candidate model in list immediately
      continue;
    }
  }

  const friendlyMessage = formatGeminiErrorMessage(lastError);
  throw new Error(friendlyMessage);
}

type BroadcastFn = (msg: any) => void;
let broadcaster: BroadcastFn | null = null;
type CallDesktopAgentFn = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
let desktopAgentCaller: CallDesktopAgentFn | null = null;

export function initSabitEngine(
  broadcast: BroadcastFn,
  callAgent: CallDesktopAgentFn
) {
  broadcaster = broadcast;
  desktopAgentCaller = callAgent;
}

function notifyClients(event: any) {
  if (broadcaster) {
    try {
      broadcaster(event);
    } catch {}
  }
}

export function getSabitTasks(): SabitTask[] {
  return sabitTasks;
}

export function getSabitChatMessages(): SabitChatMessage[] {
  return sabitChatMessages;
}

export function clearSabitChatHistory(): void {
  sabitChatMessages.length = 0;
  sabitChatMessages.push({
    id: Math.random().toString(36).substring(2, 11),
    role: "sabit",
    text: "আমি SABIT, Safa-এর Assistant। চ্যাট হিস্ট্রি ক্লিয়ার করা হয়েছে।",
    timestamp: new Date().toISOString()
  });
  notifyClients({ type: "sabit_history_cleared", messages: sabitChatMessages });
}

export function addSabitChatMessage(role: "user" | "sabit", text: string, taskId?: string): SabitChatMessage {
  const msg: SabitChatMessage = {
    id: Math.random().toString(36).substring(2, 11),
    role,
    text,
    timestamp: new Date().toISOString(),
    taskId
  };
  sabitChatMessages.push(msg);
  notifyClients({ type: "sabit_chat_message", message: msg });
  return msg;
}

/**
 * Creates and starts a new SABIT background task.
 */
export async function createSabitTask(params: {
  title: string;
  type?: string;
  userInstruction: string;
  requiredContext?: string;
}): Promise<SabitTask> {
  const taskId = "sabit_task_" + Math.random().toString(36).substring(2, 11);
  const task: SabitTask = {
    id: taskId,
    title: params.title || "Background Task",
    type: params.type || "general",
    status: "pending",
    progress: 5,
    currentStep: "Initializing SABIT background executor...",
    userInstruction: params.userInstruction,
    requiredContext: params.requiredContext,
    logs: [`[${new Date().toLocaleTimeString()}] Task registered by Maira`],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  sabitTasks.unshift(task);
  // Keep last 30 tasks
  if (sabitTasks.length > 30) sabitTasks.pop();

  notifyClients({ type: "sabit_task_created", task });

  addSabitChatMessage(
    "sabit",
    `নতুন টাস্ক গ্রহণ করেছি: "${task.title}"। ব্যাকগ্রাউন্ডে কাজ চলছে...`,
    task.id
  );

  // Execute asynchronously so Maira is NEVER blocked
  setTimeout(() => {
    runSabitTaskExecution(task).catch(err => {
      console.error(`[SABIT Engine] Unhandled error in task ${task.id}:`, err);
    });
  }, 50);

  return task;
}

/**
 * Cancels a running SABIT task.
 */
export function cancelSabitTask(taskId?: string): boolean {
  let targetTask: SabitTask | undefined;
  if (taskId) {
    targetTask = sabitTasks.find(t => t.id === taskId);
  } else {
    targetTask = sabitTasks.find(t => t.status === "running" || t.status === "pending");
  }

  if (targetTask) {
    targetTask.cancelRequested = true;
    targetTask.status = "cancelled";
    targetTask.currentStep = "Cancelled by user instruction";
    targetTask.updatedAt = new Date().toISOString();
    targetTask.logs.push(`[${new Date().toLocaleTimeString()}] Task cancelled by user.`);
    notifyClients({ type: "sabit_task_updated", task: targetTask });

    addSabitChatMessage("sabit", `টাস্ক "${targetTask.title}" বাতিল করা হয়েছে।`, targetTask.id);
    return true;
  }
  return false;
}

/**
 * Provides user input to a waiting SABIT task.
 */
export function provideSabitUserInput(taskId: string, answer: string): void {
  const task = sabitTasks.find(t => t.id === taskId);
  if (task && task.status === "waiting_for_user") {
    task.status = "running";
    task.waitingQuestion = undefined;
    task.logs.push(`[${new Date().toLocaleTimeString()}] User provided input: ${answer}`);
    notifyClients({ type: "sabit_task_updated", task });
  }
}

/**
 * Fast-path local rule executor for common desktop actions.
 * Completely eliminates Gemini API calls & quota usage for deterministic tasks!
 */
async function tryFastPathExecution(task: SabitTask): Promise<boolean> {
  if (!desktopAgentCaller) return false;

  const rawInstruction = (task.userInstruction || task.title || "").trim();
  const lower = rawInstruction.toLowerCase();

  try {
    // 1. Launch Application
    const appMatch = lower.match(/(?:open|launch|start|run|খুলো|চালু|ওপেন)\s+(notepad|chrome|calculator|calc|cmd|powershell|vs\s*code|vscode|paint|explorer)/i);
    if (appMatch) {
      const appName = appMatch[1].replace(/\s+/g, "");
      task.logs.push(`[Fast-Path] Direct execution: openApplication(${appName})`);
      task.currentStep = `Opening ${appName}...`;
      task.activeTool = "openApplication";
      task.application = appName;
      notifyClients({ type: "sabit_task_updated", task });

      const res = await desktopAgentCaller("openApplication", { name: appName });
      if (res.ok) {
        updateActiveBrowserContext({
          lastTaskId: task.id,
          activeApp: appName,
          lastAction: `Opened ${appName}`
        });
      }
      task.status = res.ok ? "completed" : "failed";
      task.progress = 100;
      task.currentStep = res.ok ? "Completed" : `Error: ${res.error}`;
      task.result = res.ok ? `${appName} successfully launched.` : res.error;
      task.updatedAt = new Date().toISOString();
      notifyClients({ type: "sabit_task_updated", task });

      addSabitChatMessage("sabit", res.ok ? `${appName} সফলভাবে চালুর নির্দেশ দেওয়া হয়েছে।` : `ব্যর্থ হয়েছে: ${res.error}`, task.id);
      return true;
    }

    // 2. Take Screenshot
    if (/take\s*screenshot|capture\s*screen|স্ক্রিনশট|ছবি\s*তোলো/i.test(lower)) {
      task.logs.push(`[Fast-Path] Direct execution: takeScreenshot`);
      task.currentStep = "Taking screenshot...";
      task.activeTool = "takeScreenshot";
      notifyClients({ type: "sabit_task_updated", task });

      const res = await desktopAgentCaller("takeScreenshot", {});
      task.status = res.ok ? "completed" : "failed";
      task.progress = 100;
      task.currentStep = res.ok ? "Completed" : `Error: ${res.error}`;
      task.result = res.ok ? "Screenshot captured successfully." : res.error;
      task.updatedAt = new Date().toISOString();
      notifyClients({ type: "sabit_task_updated", task });

      addSabitChatMessage("sabit", res.ok ? "স্ক্রিনশট নেওয়া সম্পন্ন হয়েছে।" : `ব্যর্থ হয়েছে: ${res.error}`, task.id);
      return true;
    }

    // 3. Open Website / URL
    const urlMatch = lower.match(/(?:open|browse|go to|খুলো|ভিজিট)\s+(https?:\/\/[^\s]+|youtube\.com|google\.com|facebook\.com|github\.com|gmail\.com)/i);
    if (urlMatch) {
      let targetUrl = urlMatch[1];
      if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

      task.logs.push(`[Fast-Path] Direct execution: desktopBrowserOpen(${targetUrl})`);
      task.currentStep = `Navigating to ${targetUrl}...`;
      task.activeTool = "desktopBrowserOpen";
      task.application = "Automated Browser";
      notifyClients({ type: "sabit_task_updated", task });

      const res = await desktopAgentCaller("desktopBrowserOpen", { url: targetUrl });
      if (res.ok) {
        updateActiveBrowserContext({
          lastTaskId: task.id,
          activeApp: targetUrl.includes("youtube.com") ? "YouTube" : "Automated Browser",
          activeUrl: targetUrl,
          lastAction: `Navigated to ${targetUrl}`
        });
      }
      task.status = res.ok ? "completed" : "failed";
      task.progress = 100;
      task.currentStep = res.ok ? "Completed" : `Error: ${res.error}`;
      task.result = res.ok ? `Navigated to ${targetUrl}` : res.error;
      task.updatedAt = new Date().toISOString();
      notifyClients({ type: "sabit_task_updated", task });

      addSabitChatMessage("sabit", res.ok ? `ব্রাউজারে ${targetUrl} ওপেন করা হয়েছে।` : `ব্যর্থ হয়েছে: ${res.error}`, task.id);
      return true;
    }

    // 4. Search Web
    const searchMatch = lower.match(/(?:search|find|সার্চ|খুঁজো)\s+(?:for\s+)?(.+?)(?:\s+on\s+(google|youtube))?$/i);
    if (searchMatch && searchMatch[1]) {
      const query = searchMatch[1].trim();
      let engine = searchMatch[2]?.toLowerCase();
      if (!engine && (activeBrowserContext.activeApp === "YouTube" || activeBrowserContext.activeUrl?.includes("youtube"))) {
        engine = "youtube";
      } else if (!engine) {
        engine = "google";
      }

      task.logs.push(`[Fast-Path] Direct execution: desktopBrowserSearch(${query})`);
      task.currentStep = `Searching ${engine} for: ${query}...`;
      task.activeTool = "desktopBrowserSearch";
      task.application = "Automated Browser";
      notifyClients({ type: "sabit_task_updated", task });

      const res = await desktopAgentCaller("desktopBrowserSearch", { query, engine });
      if (res.ok) {
        const finalUrl = engine === "youtube"
          ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
          : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        updateActiveBrowserContext({
          lastTaskId: task.id,
          activeApp: engine === "youtube" ? "YouTube" : "Automated Browser",
          activeUrl: finalUrl,
          lastAction: `Searched ${engine} for ${query}`
        });
      }
      task.status = res.ok ? "completed" : "failed";
      task.progress = 100;
      task.currentStep = res.ok ? "Completed" : `Error: ${res.error}`;
      task.result = res.ok ? `Search completed for: ${query}` : res.error;
      task.updatedAt = new Date().toISOString();
      notifyClients({ type: "sabit_task_updated", task });

      addSabitChatMessage("sabit", res.ok ? `"${query}" এর জন্য ${engine}-এ সার্চ করা হয়েছে।` : `ব্যর্থ হয়েছে: ${res.error}`, task.id);
      return true;
    }

  } catch (err) {
    console.warn("[Fast-Path] Fallback to AI loop due to error:", err);
  }

  return false;
}

/**
 * Executes a SABIT task asynchronously step-by-step using Gemini API & Desktop Tools.
 * Modeled after Maira's ultra-efficient API architecture.
 */
async function runSabitTaskExecution(task: SabitTask): Promise<void> {
  const apiKey = getSabitApiKey() || getGeminiApiKey();
  if (!apiKey) {
    task.status = "failed";
    task.error = "NO_API_KEY: SABIT API key is missing. Add it in Settings.";
    task.currentStep = "Failed: Missing API Key";
    task.logs.push(`[${new Date().toLocaleTimeString()}] ${task.error}`);
    notifyClients({ type: "sabit_task_updated", task });
    addSabitChatMessage("sabit", `ক্ষমা করবেন, API Key পাওয়া যায়নি। সেটিংস থেকে API Key যুক্ত করুন।`, task.id);
    return;
  }

  if (task.cancelRequested) return;

  task.status = "running";
  task.progress = 15;
  task.currentStep = "Evaluating task execution plan...";
  task.logs.push(`[${new Date().toLocaleTimeString()}] Starting background execution...`);
  notifyClients({ type: "sabit_task_updated", task });

  // STEP 1: Fast-Path Execution check (0 API calls!)
  const handledByFastPath = await tryFastPathExecution(task);
  if (handledByFastPath) {
    return;
  }

  // STEP 2: AI Execution Loop with Maira-like Token Efficiency
  try {
    const ai = new GoogleGenAI({ apiKey });

    const contextInfo = activeBrowserContext.activeUrl
      ? `\nACTIVE RESOURCE CONTEXT: Currently inside "${activeBrowserContext.activeApp || 'Browser'}" at URL "${activeBrowserContext.activeUrl}". REUSE this existing tab/window context for follow-up instructions instead of opening new tabs/sites!`
      : "";

    // Ultra-concise System Instruction to minimize input tokens
    const systemInstruction =
      "You are SABIT, Safa's Sub-Assistant.\n" +
      "IDENTITY: 'আমি SABIT, Safa-এর Assistant।'\n" +
      "GOAL: Execute user instructions using tools concise and direct." + contextInfo + "\n" +
      "RULES: Do NOT repeat steps. Return 1 tool call per step. Output max 1 sentence response.";

    // Compact Tool Declarations matching Maira's schema
    const tools = [
      {
        functionDeclarations: [
          {
            name: "desktopBrowserOpen",
            description: "Opens a URL in browser.",
            parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ["url"] }
          },
          {
            name: "desktopBrowserSnapshot",
            description: "Captures interactive DOM elements with ref IDs.",
            parameters: { type: Type.OBJECT, properties: {} }
          },
          {
            name: "desktopBrowserClick",
            description: "Clicks an element by ref or text or selector.",
            parameters: { type: Type.OBJECT, properties: { ref: { type: Type.STRING }, text: { type: Type.STRING } } }
          },
          {
            name: "desktopBrowserType",
            description: "Types text into a field by ref.",
            parameters: { type: Type.OBJECT, properties: { ref: { type: Type.STRING }, text: { type: Type.STRING } }, required: ["text"] }
          },
          {
            name: "desktopBrowserPressKey",
            description: "Presses keyboard key like Enter, Tab, Escape.",
            parameters: { type: Type.OBJECT, properties: { key: { type: Type.STRING } }, required: ["key"] }
          },
          {
            name: "desktopBrowserSearch",
            description: "Searches web via Google or YouTube.",
            parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, engine: { type: Type.STRING } }, required: ["query"] }
          },
          {
            name: "searchYouTube",
            description: "Searches and opens video on YouTube.",
            parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ["query"] }
          },
          {
            name: "searchGoogle",
            description: "Searches Google web.",
            parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ["query"] }
          },
          {
            name: "openWebsite",
            description: "Opens a website URL in browser.",
            parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING } }, required: ["url"] }
          },
          {
            name: "desktopBrowserGetText",
            description: "Reads text on web page.",
            parameters: { type: Type.OBJECT, properties: {} }
          },
          {
            name: "openApplication",
            description: "Launches local app (Notepad, Chrome, Calc, CMD).",
            parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ["name"] }
          },
          {
            name: "createFile",
            description: "Creates or writes content to a file.",
            parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING }, content: { type: Type.STRING } }, required: ["path"] }
          },
          {
            name: "runPythonScript",
            description: "Runs a Python script.",
            parameters: { type: Type.OBJECT, properties: { scriptPath: { type: Type.STRING } }, required: ["scriptPath"] }
          },
          {
            name: "takeScreenshot",
            description: "Takes screenshot of screen.",
            parameters: { type: Type.OBJECT, properties: {} }
          }
        ]
      }
    ];

    // Standard Gemini Flash Model with Fallback
    const preferredModel = process.env.SABIT_MODEL || "gemini-3.5-flash";
    const userPrompt = `TASK: ${task.title}\nINSTRUCTION: ${task.userInstruction}`;

    let contents: any[] = [{ role: "user", parts: [{ text: userPrompt }] }];
    let maxSteps = 6;
    let stepCount = 0;

    while (stepCount < maxSteps) {
      if (task.cancelRequested) {
        task.status = "cancelled";
        notifyClients({ type: "sabit_task_updated", task });
        return;
      }

      stepCount++;
      task.progress = Math.min(90, 25 + stepCount * 15);
      task.currentStep = `Step ${stepCount}...`;
      task.updatedAt = new Date().toISOString();
      notifyClients({ type: "sabit_task_updated", task });

      console.log(`[SABIT API Usage] Task ${task.id} -> Step ${stepCount}`);

      const response = await callGeminiWithFallback(ai, {
        model: preferredModel,
        contents,
        config: {
          systemInstruction,
          tools,
          maxOutputTokens: 250
        }
      });

      const candidate = response.candidates?.[0];
      if (!candidate) break;

      const functionCalls = candidate.content?.parts?.filter(p => p.functionCall)?.map(p => p.functionCall!);

      if (functionCalls && functionCalls.length > 0) {
        const functionResponseParts: any[] = [];

        for (const fc of functionCalls) {
          if (task.cancelRequested) {
            task.status = "cancelled";
            notifyClients({ type: "sabit_task_updated", task });
            return;
          }

          task.activeTool = fc.name;
          task.application = getApplicationForTool(fc.name, fc.args);
          task.currentStep = `Executing ${fc.name}...`;
          task.logs.push(`[${new Date().toLocaleTimeString()}] Executing ${fc.name}...`);
          notifyClients({ type: "sabit_task_updated", task });

          let rawToolResult: any = { ok: true, result: "Executed" };
          if (desktopAgentCaller) {
            try {
              rawToolResult = await desktopAgentCaller(fc.name, (fc.args as any) || {});
              if (rawToolResult.ok) {
                if (fc.name === "desktopBrowserOpen" && (fc.args as any)?.url) {
                  const u = String((fc.args as any).url);
                  updateActiveBrowserContext({
                    lastTaskId: task.id,
                    activeApp: u.includes("youtube.com") ? "YouTube" : "Automated Browser",
                    activeUrl: u,
                    lastAction: `Opened ${u}`
                  });
                } else if (fc.name === "desktopBrowserSearch" && (fc.args as any)?.query) {
                  const eng = String((fc.args as any)?.engine || "google").toLowerCase();
                  const q = String((fc.args as any).query);
                  const u = eng === "youtube" ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
                  updateActiveBrowserContext({
                    lastTaskId: task.id,
                    activeApp: eng === "youtube" ? "YouTube" : "Automated Browser",
                    activeUrl: u,
                    lastAction: `Searched ${eng} for ${q}`
                  });
                } else if (fc.name === "openApplication" && (fc.args as any)?.name) {
                  updateActiveBrowserContext({
                    lastTaskId: task.id,
                    activeApp: String((fc.args as any).name),
                    lastAction: `Opened ${((fc.args as any).name)}`
                  });
                }
              }
            } catch (err: any) {
              rawToolResult = { ok: false, error: err?.message || String(err) };
            }
          }

          const sanitizedResult = sanitizeToolResultForContext(fc.name, rawToolResult);
          task.logs.push(`[${new Date().toLocaleTimeString()}] ${fc.name} -> ${rawToolResult.ok ? "Success" : "Error: " + (rawToolResult.error || "Failed")}`);

          functionResponseParts.push({
            functionResponse: {
              name: fc.name,
              response: sanitizedResult
            }
          });
        }

        // MAIRA TOKEN EFFICIENCY PATTERN: Keep history minimal (Original User Prompt + Latest Tool Call & Result)
        contents = [
          { role: "user", parts: [{ text: userPrompt }] },
          candidate.content,
          { role: "user", parts: functionResponseParts }
        ];

      } else {
        // Task complete text response
        const textResult = response.text || "Task completed successfully.";
        task.status = "completed";
        task.progress = 100;
        task.currentStep = "Completed";
        task.result = textResult;
        task.logs.push(`[${new Date().toLocaleTimeString()}] Completed: ${textResult}`);
        task.updatedAt = new Date().toISOString();
        notifyClients({ type: "sabit_task_updated", task });

        addSabitChatMessage("sabit", `কাজটি সম্পন্ন হয়েছে।\n\n${textResult}`, task.id);
        notifyClients({
          type: "sabit_task_completed_announcement",
          taskId: task.id,
          title: task.title,
          announcement: "কাজটি সম্পন্ন হয়েছে।"
        });
        return;
      }
    }

    // Auto-complete at max steps
    task.status = "completed";
    task.progress = 100;
    task.currentStep = "Completed";
    task.logs.push(`[${new Date().toLocaleTimeString()}] Execution completed.`);
    task.updatedAt = new Date().toISOString();
    notifyClients({ type: "sabit_task_updated", task });

    addSabitChatMessage("sabit", `কাজটি সম্পন্ন হয়েছে।`, task.id);
    notifyClients({
      type: "sabit_task_completed_announcement",
      taskId: task.id,
      title: task.title,
      announcement: "কাজটি সম্পন্ন হয়েছে।"
    });

  } catch (err: any) {
    console.error(`[SABIT Execution Error]:`, err);
    task.status = "failed";
    const formattedError = formatGeminiErrorMessage(err);
    task.error = formattedError;
    task.currentStep = `Error: ${formattedError}`;
    task.logs.push(`[${new Date().toLocaleTimeString()}] Failed: ${formattedError}`);
    task.updatedAt = new Date().toISOString();
    notifyClients({ type: "sabit_task_updated", task });

    addSabitChatMessage("sabit", `টাস্ক পালনে সমস্যা হয়েছে: ${formattedError}`, task.id);
  }
}

/**
* Sanitizes tool responses to prevent massive DOM trees or raw logs from consuming token quota.
*/
function sanitizeToolResultForContext(toolName: string, rawResult: any): any {
if (!rawResult) return { ok: true, note: "Executed" };
if (typeof rawResult !== "object") {
  const str = String(rawResult);
  return { ok: true, result: str.length > 800 ? str.slice(0, 800) + "..." : str };
}

const sanitized = { ...rawResult };

if (sanitized.snapshot && typeof sanitized.snapshot === "string") {
  sanitized.snapshot = sanitized.snapshot.slice(0, 1000) + " [Truncated for token quota]";
}
if (sanitized.html && typeof sanitized.html === "string") {
  sanitized.html = sanitized.html.slice(0, 400) + " [Truncated]";
}
if (sanitized.text && typeof sanitized.text === "string" && sanitized.text.length > 800) {
  sanitized.text = sanitized.text.slice(0, 800) + " [Truncated]";
}
if (sanitized.content && typeof sanitized.content === "string" && sanitized.content.length > 800) {
  sanitized.content = sanitized.content.slice(0, 800) + " [Truncated]";
}
if (sanitized.screenshot) {
  delete sanitized.screenshot;
  sanitized.screenshotCaptured = true;
}

return sanitized;
}

function getApplicationForTool(toolName: string, args: any): string {
  if (toolName.startsWith("desktopBrowser") || toolName.startsWith("browser") || toolName === "openWebsite" || toolName === "searchYouTube" || toolName === "searchGoogle") return "Automated Browser";
  if (toolName === "openApplication") return args?.name || "Application";
  if (toolName.includes("File") || toolName.includes("Folder")) return "File System";
  if (toolName === "runPythonScript") return "Python";
  return "System Tool";
}

/**
* Handle direct text chat query to SABIT in SABIT UI.
* Enables direct task creation for manual user commands!
*/
export async function handleSabitDirectChat(userMessage: string): Promise<string> {
addSabitChatMessage("user", userMessage);

const cleanMsg = userMessage.trim();
const lowerMsg = cleanMsg.toLowerCase();

// Identity Check
if (
  lowerMsg === "তুমি কে?" ||
  lowerMsg === "tummi ke?" ||
  lowerMsg === "tummi ke" ||
  lowerMsg === "who are you?" ||
  lowerMsg === "who are you" ||
  lowerMsg === "who r u" ||
  lowerMsg.includes("who are you") ||
  lowerMsg.includes("তুমি কে")
) {
  const isEnglish = /who|you|what/i.test(lowerMsg);
  const answer = isEnglish ? "I am SABIT, Safa's Assistant." : "আমি SABIT, Safa-এর Assistant।";
  addSabitChatMessage("sabit", answer);
  return answer;
}

// Actionable Intent Detection for Manual Task Execution
const isActionableTask =
  /open|browse|search|play|run|create|launch|start|find|go to|check|অফেন|ব্রাউজ|সার্চ|প্লে|চালাও|খুলো|তৈরি/i.test(lowerMsg);

if (isActionableTask) {
  // Automatically convert direct user command into a SABIT Background Task!
  const task = await createSabitTask({
    title: cleanMsg.length > 30 ? cleanMsg.slice(0, 30) + "..." : cleanMsg,
    type: "manual_command",
    userInstruction: cleanMsg
  });

  const reply = `আমি আপনার নির্দেশটি টাস্ক হিসেবে গ্রহণ করেছি: "${cleanMsg}"। ব্যাকগ্রাউন্ডে কাজ চলছে...`;
  return reply;
}

const apiKey = getSabitApiKey() || getGeminiApiKey();
if (!apiKey) {
  const err = "SABIT API Key পাওয়া যায়নি। Settings এ SABIT API Key যোগ করুন।";
  addSabitChatMessage("sabit", err);
  return err;
}

try {
  const ai = new GoogleGenAI({ apiKey });
  const response = await callGeminiWithFallback(ai, {
    model: process.env.SABIT_MODEL || "gemini-3.5-flash",
    contents: userMessage,
    config: {
      systemInstruction:
        "You are SABIT, Safa's Assistant. Respond politely, helpfully, and concisely in Bengali or English. If asked 'Who are you?' or 'তুমি কে?', answer strictly: 'I am SABIT, Safa's Assistant.' or 'আমি SABIT, Safa-এর Assistant।'. NEVER mention Maira in identity responses.",
      maxOutputTokens: 150
    }
  });

  const reply = response.text || "আমি SABIT, Safa-এর Assistant। কীভাবে সাহায্য করতে পারি?";
  addSabitChatMessage("sabit", reply);
  return reply;
} catch (e: any) {
  const formattedMsg = formatGeminiErrorMessage(e);
  const reply = formattedMsg.startsWith("গুগল") || formattedMsg.startsWith("Gemini") || formattedMsg.startsWith("মডেল") ? formattedMsg : `সাময়িক কোনো ত্রুটি ঘটেছে: ${formattedMsg}`;
  addSabitChatMessage("sabit", reply);
  return reply;
}
}
