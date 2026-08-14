/**
 * server_scheduler.ts
 * Production-grade Server-Side Task Scheduler & Intent Analyzer for MYRAA dual-agent system.
 * 
 * Provides:
 * 1. Intent Analysis & Task Splitting (parsing compound user requests into independent subtasks).
 * 2. Execution Scheduling & Dispatching (simultaneous parallel dispatch to Maira & Sabit).
 * 3. Busy Rule Enforcement (zero-wait, zero-refusal automatic fallback to Maira worker).
 * 4. Result Collection & Notification.
 */

export interface SubTask {
  id: string;
  goal: string;
  targetAgent: "sabit" | "maira";
  type: "browser_automation" | "desktop_control" | "chat_query";
}

export interface TaskPlan {
  isCompound: boolean;
  subTasks: SubTask[];
  originalPrompt: string;
}

/**
 * Parses user request string and determines if it contains multiple independent subtasks.
 */
export function analyzeAndSplitUserRequest(requestText: string): TaskPlan {
  const text = requestText.trim();
  if (!text) {
    return { isCompound: false, subTasks: [], originalPrompt: text };
  }

  // Regex patterns indicating compound tasks or task separation
  // English: "and", "meanwhile", "also", "then", "plus", "at the same time", "along with"
  // Bengali: "আর", "এদিকে", "পাশাপাশি", "তাছাড়া", "একই সাথে", "সেই সাথে", "আর একটা কাজ"
  const agentTargetingPattern = /(?:tell sabit to|ask sabit to|sabit ke bolo|sabit-ke bolo|সাবিটকে বলো|সাবিট কে বলো)\s+([^.\n;,]+)/i;
  
  const compoundSeparators = [
    /\s+meanwhile\s+/i,
    /\s+at the same time\s+/i,
    /\s+in the background\s+/i,
    /\s+পাশাপাশি\s+/i,
    /\s+এদিকে\s+/i,
    /\s+একই সাথে\s+/i,
    /\s+সেই সাথে\s+/i,
    /\s+তাছাড়া\s+/i,
    /\s+and meanwhile\s+/i,
  ];

  let isCompound = false;
  let partA = "";
  let partB = "";

  // Check explicit explicit separator split
  for (const sep of compoundSeparators) {
    if (sep.test(text)) {
      const parts = text.split(sep);
      if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        partA = parts[0].trim();
        partB = parts.slice(1).join(" ").trim();
        isCompound = true;
        break;
      }
    }
  }

  // Check "tell Sabit to X ... and Y" or "do X and do Y"
  if (!isCompound) {
    const match = text.match(agentTargetingPattern);
    if (match) {
      const sabitTaskStr = match[1].trim();
      const remainder = text.replace(match[0], "").trim();

      // Clean remainder from leading conjunctions
      const cleanRemainder = remainder
        .replace(/^(and|meanwhile|also|then|plus|আর|এদিকে|পাশাপাশি|তাছাড়া|,|\.)\s+/i, "")
        .trim();

      if (sabitTaskStr && cleanRemainder && cleanRemainder.length > 3) {
        partA = sabitTaskStr;
        partB = cleanRemainder;
        isCompound = true;
      }
    }
  }

  // Fallback compound detection on sentence boundary or " and " with action verbs
  if (!isCompound) {
    const andSplit = text.split(/\s+(?:and|also|আর|তাছাড়া)\s+/i);
    if (andSplit.length === 2 && andSplit[0].trim().length > 5 && andSplit[1].trim().length > 5) {
      const vPattern = /(?:play|open|search|find|create|run|go to|show|চালাও|খুলো|খুলুন|সার্চ করো|তৈরি করো|দেখাও|অর্ডার)/i;
      if (vPattern.test(andSplit[0]) && vPattern.test(andSplit[1])) {
        partA = andSplit[0].trim();
        partB = andSplit[1].trim();
        isCompound = true;
      }
    }
  }

  if (isCompound && partA && partB) {
    // Classify partA and partB
    const isABrowser = /(?:youtube|google|search|website|chrome|web|daraz|github|play|music|video|গান|ভিডিও|সার্চ)/i.test(partA);
    const isBBrowser = /(?:youtube|google|search|website|chrome|web|daraz|github|play|music|video|গান|ভিডিও|সার্চ)/i.test(partB);

    let sabitTaskGoal = partA;
    let mairaTaskGoal = partB;

    if (!isABrowser && isBBrowser) {
      sabitTaskGoal = partB;
      mairaTaskGoal = partA;
    }

    return {
      isCompound: true,
      subTasks: [
        {
          id: `task_sabit_${Date.now()}_1`,
          goal: sabitTaskGoal,
          targetAgent: "sabit",
          type: "browser_automation"
        },
        {
          id: `task_maira_${Date.now()}_2`,
          goal: mairaTaskGoal,
          targetAgent: "maira",
          type: "desktop_control"
        }
      ],
      originalPrompt: text
    };
  }

  // Single task fallback
  return {
    isCompound: false,
    subTasks: [
      {
        id: `task_single_${Date.now()}`,
        goal: text,
        targetAgent: "sabit",
        type: "browser_automation"
      }
    ],
    originalPrompt: text
  };
}

/**
 * Result Collector: Tracks runtime task execution status across workers.
 */
export class ResultCollector {
  private static taskStatuses = new Map<string, { goal: string; agent: string; status: string; result?: any; error?: string }>();

  static recordTaskStart(id: string, goal: string, agent: "sabit" | "maira") {
    this.taskStatuses.set(id, { goal, agent, status: "running" });
    console.log(`[ResultCollector] Task ${id} started for ${agent}: "${goal}"`);
  }

  static recordTaskComplete(id: string, result?: any) {
    const task = this.taskStatuses.get(id);
    if (task) {
      task.status = "completed";
      task.result = result;
      console.log(`[ResultCollector] Task ${id} completed for ${task.agent}: "${task.goal}"`);
    }
  }

  static recordTaskFailed(id: string, error: string) {
    const task = this.taskStatuses.get(id);
    if (task) {
      task.status = "failed";
      task.error = error;
      console.log(`[ResultCollector] Task ${id} failed for ${task.agent}: "${task.goal}" - ${error}`);
    }
  }

  static getTaskStatus(id: string) {
    return this.taskStatuses.get(id);
  }
}
