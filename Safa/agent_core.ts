import { GoogleGenAI } from "@google/genai";
import { SHARED_TOOL_DECLARATIONS } from "./server_tools";
import { buildSoulSystemPrompt } from "./soul";
import { memoryManager } from "./memory_manager";
import { compressDialogueHistory } from "./hermes-agent/context/context_compressor";
import { analyzeAndSplitUserRequest } from "./server_scheduler";
import {
  DATA_DIR,
  getGeminiApiKey,
  getSabitApiKey
} from "./server_paths";
import {
  callDesktopAgent,
  DESKTOP_TOOLS,
  getSabitStatusSummary,
  sabitRuntimeState,
  acquireSabitTask,
  activeMairaLiveSession,
  activeSabitLiveSession
} from "./server";

export interface ReActStep {
  stepNumber: number;
  thought?: string;
  toolCall?: {
    name: string;
    args: any;
  };
  toolResult?: any;
}

export interface TaskExecutionResult {
  ok: boolean;
  finalAnswer: string;
  steps: ReActStep[];
  error?: string;
}

export class MairaAgentCore {
  private maxReActSteps: number = 10;

  /**
   * Primary ReAct Loop & Execution Engine for Safa.
   * Handles user requests (Text or Voice-triggered tasks), performs reasoning,
   * enforces tool guards, executes tools via Desktop Agent / Memory Manager / internal modules,
   * feeds tool results back into the loop, and produces the final answer.
   */
  async executeTask(params: {
    userPrompt: string;
    dialogueHistory?: { role: string; text: string }[];
    sessionId?: string;
    origin: "text" | "voice";
    clientWs?: any;
    session?: any;
  }): Promise<TaskExecutionResult> {
    const { userPrompt, dialogueHistory = [], sessionId = "default_session", origin, clientWs, session } = params;
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      return {
        ok: false,
        finalAnswer: "API key is missing. Please set your Gemini API key in Settings.",
        steps: [],
        error: "NO_API_KEY"
      };
    }

    console.log(`[AGENT CORE] Executing task (${origin}): "${userPrompt}"`);

    // 1. Context Assembly & Budget Compression Check
    const soulSystemPrompt = buildSoulSystemPrompt();
    const memoryContext = await memoryManager.getAsyncRelevantMemoryContext(userPrompt, sessionId);
    const sabitSummary = getSabitStatusSummary();

    const { compressedHistory } = await compressDialogueHistory(
      dialogueHistory.map(d => ({ role: d.role as any, text: d.text })),
      {
        onPreCompress: (olderTurns) =>
          memoryManager.onPreCompress(olderTurns as Array<Record<string, any>>),
      }
    );

    const systemInstruction = `${soulSystemPrompt}

${memoryContext}
${sabitSummary}

CRITICAL REACT EXECUTION RULES:
1. REASONING & ACTING (ReAct): Think step-by-step. When a user asks you to perform an action, analyze what tools are required.
2. TOOL GUARD & DELEGATION:
   - If Sabit is connected and idle, and the task involves browser automation or web search, call 'delegateToSabit' to hand over the task.
   - If Sabit is busy or offline, or if the user requests direct desktop actions (files, system control, applications, window management), execute the appropriate tool directly using your tools.
3. MEMORY MANAGEMENT:
   - You have access to 'memory' (to add, read, replace, or remove compact durable facts in MEMORY.md) and 'session_search' (to search past conversation history).
   - Do not save task progress or completed-work logs to memory; use session_search for previous transcripts.
4. SINGLE STEP EXECUTION: Call tools one step at a time, inspect the tool output, and then decide the next action until the task is complete.
5. NO HALLUCINATION: Always rely on tool results rather than assuming outcomes.
6. CONCISE & POLITE RESPONSE: State your final answer clearly when the task is finished.`;

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });

    // 3. Build conversation contents for ReAct loop using compressed history
    const contents: any[] = [];
    for (const item of compressedHistory) {
      if (item.role === "system") continue; // system prompt passed via config
      contents.push({
        role: item.role === "model" ? "model" : "user",
        parts: [{ text: item.text }]
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: userPrompt }]
    });

    const steps: ReActStep[] = [];
    let stepCount = 0;
    let finalAnswer = "";

    // 4. ReAct Execution Loop
    while (stepCount < this.maxReActSteps) {
      stepCount++;
      console.log(`[AGENT CORE] ReAct Step ${stepCount}/${this.maxReActSteps}`);

      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: SHARED_TOOL_DECLARATIONS as any }]
          }
        });

        const candidate = response.candidates?.[0];
        const textContent = response.text || "";
        const functionCalls = response.functionCalls;

        // Record thought / text chunk
        if (textContent && functionCalls && functionCalls.length > 0) {
          console.log(`[AGENT CORE] Step ${stepCount} Thought/Text: "${textContent.trim()}"`);
          try {
            await memoryManager.saveSessionTurn({
              sessionId,
              role: "system",
              content: textContent,
              messageType: "safa_thinking",
              thinkingSummary: textContent
            });
          } catch (e) {}

          if (clientWs && origin === "text") {
            try {
              clientWs.send(
                JSON.stringify({
                  type: "transcription",
                  role: "model",
                  text: textContent,
                  messageType: "safa_thinking"
                })
              );
            } catch (e) {}
          }
        }

        // If no function call, we reached final response or conversation answer
        if (!functionCalls || functionCalls.length === 0) {
          finalAnswer = textContent;
          steps.push({
            stepNumber: stepCount,
            thought: textContent
          });

          // Save model final answer in SQLite Session DB (only for text chat, voice is handled by live session callbacks)
          if (origin !== "voice") {
            try {
              await memoryManager.syncTurn({
                sessionId,
                role: "model",
                content: finalAnswer,
                messageType: "safa_text"
              });
            } catch (e) {}
          }

          // Output final answer
          if (origin === "voice" && session && finalAnswer) {
            try {
              console.log(`[AGENT CORE] Sending final voice answer to Gemini Live session: "${finalAnswer.substring(0, 60)}..."`);
              session.sendClientContent({
                turns: {
                  role: "user",
                  parts: [
                    {
                      text: `SYSTEM DIRECTIVE (AGENT CORE RESULT): State the following result clearly and concisely to the user in voice: "${finalAnswer}"`
                    }
                  ]
                },
                turnComplete: true
              });
            } catch (e) {
              console.error("[AGENT CORE] Failed to send final answer to Live Session:", e);
            }
          } else if (origin === "text" && clientWs && finalAnswer) {
            try {
              clientWs.send(
                JSON.stringify({
                  type: "transcription",
                  role: "model",
                  text: finalAnswer,
                  messageType: "safa_text"
                })
              );
              clientWs.send(JSON.stringify({ type: "turnComplete" }));
            } catch (e) {}
          }

          break;
        }

        // Process function calls (tools)
        for (const fc of functionCalls) {
          console.log(`[AGENT CORE] Step ${stepCount} Tool Call: ${fc.name}`, fc.args);
          const currentStep: ReActStep = {
            stepNumber: stepCount,
            thought: textContent,
            toolCall: { name: fc.name, args: fc.args }
          };

          try {
            await memoryManager.syncMemory({
              sessionId,
              role: "system",
              content: `Tool Call: ${fc.name}(${JSON.stringify(fc.args || {})})`,
              messageType: "tool_call",
              toolCalls: JSON.stringify([{ name: fc.name, args: fc.args }])
            });
          } catch (e) {}

          if (clientWs) {
            try {
              clientWs.send(
                JSON.stringify({
                  type: "browserAutomationEvent",
                  name: fc.name,
                  args: fc.args,
                  status: "started"
                })
              );
            } catch (e) {}
          }

          // Tool Guard & Execution
          let toolResultOutput: any;

          if (fc.name === "memory" || fc.name === "memory_manage") {
            try {
              const { action, target, content, fact, old_text, old_fact } = fc.args as any;
              const result = memoryManager.memoryTool({
                action,
                target: target || "memory",
                content: content || fact,
                oldText: old_text || old_fact,
              });
              toolResultOutput = result;
            } catch (err: any) {
              toolResultOutput = { error: `Memory operation error: ${err.message}` };
            }
          } else if (fc.name === "session_search") {
            try {
              // Stonic session_search tool: scroll (session_id), browse (no query), discovery (query)
              toolResultOutput = await memoryManager.sessionSearch({
                query: (fc.args as any)?.query,
                limit: (fc.args as any)?.limit || 3,
                sessionId: (fc.args as any)?.session_id,
                window: (fc.args as any)?.window,
              });
            } catch (err: any) {
              toolResultOutput = { error: `Session search error: ${err.message}` };
            }
          } else if (fc.name === "delegateToSabit") {
            const taskGoal = (fc.args as any)?.task;
            if (!taskGoal) {
              toolResultOutput = { error: "Task description is required to delegate to Sabit." };
            } else if (sabitRuntimeState.taskState !== "idle") {
              toolResultOutput = {
                error: `Sabit is currently busy ("${sabitRuntimeState.activeTaskGoal}"). Execute the task directly yourself using your desktop/browser tools.`
              };
            } else {
              const success = acquireSabitTask(taskGoal);
              if (success) {
                if (activeSabitLiveSession) {
                  try {
                    activeSabitLiveSession.sendClientContent({
                      turns: {
                        role: "user",
                        parts: [
                          {
                            text: `SYSTEM DIRECTIVE: You have been delegated a task: "${taskGoal}". Please execute it immediately using your tools.`
                          }
                        ]
                      },
                      turnComplete: true
                    });
                  } catch (e) {}
                }
                toolResultOutput = {
                  result: `Task successfully delegated to Sabit ("${taskGoal}"). Sabit is handling it in the background.`
                };
              } else {
                toolResultOutput = { error: "Failed to acquire Sabit task. Execute the task yourself." };
              }
            }
          } else if (fc.name === "saveCustomMemory") {
            try {
              const { category, text } = fc.args as any;
              if (category && text) {
                memoryManager.addFact("MEMORY", category, text);
                toolResultOutput = { result: "Memory saved successfully to MEMORY.md." };
              } else {
                toolResultOutput = { error: "Category and text are required." };
              }
            } catch (err: any) {
              toolResultOutput = { error: `Failed to save memory: ${err.message}` };
            }
          } else if (DESKTOP_TOOLS.has(fc.name)) {
            // Execute via Desktop Agent
            const res = await callDesktopAgent(fc.name, {
              ...(fc.args as Record<string, unknown>),
              _caller: "maira"
            });
            if (res.ok) {
              toolResultOutput = res.result ?? { result: "Operation completed successfully." };
            } else {
              toolResultOutput = { error: res.error || "Desktop agent tool execution failed." };
            }
          } else {
            toolResultOutput = { result: `Tool ${fc.name} acknowledged.` };
          }

          currentStep.toolResult = toolResultOutput;
          steps.push(currentStep);

          try {
            await memoryManager.syncMemory({
              sessionId,
              role: "system",
              content: `Tool Result (${fc.name}): ${JSON.stringify(toolResultOutput)}`,
              messageType: "tool_result",
              toolResults: JSON.stringify(toolResultOutput)
            });
          } catch (e) {}

          if (clientWs) {
            try {
              clientWs.send(
                JSON.stringify({
                  type: "browserAutomationEvent",
                  name: fc.name,
                  args: fc.args,
                  status: toolResultOutput.error ? "failed" : "completed",
                  result: toolResultOutput
                })
              );
            } catch (e) {}
          }

          // Append model turn with tool call and user turn with function response to contents
          contents.push(candidate?.content || {
            role: "model",
            parts: [{ functionCall: { name: fc.name, args: fc.args } }]
          });

          contents.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: fc.name,
                  response: { output: toolResultOutput }
                }
              }
            ]
          });
        }
      } catch (err: any) {
        console.error(`[AGENT CORE] ReAct Loop error at step ${stepCount}:`, err);
        return {
          ok: false,
          finalAnswer: `Agent Core execution encountered an error: ${err.message || String(err)}`,
          steps,
          error: err.message
        };
      }
    }

    return {
      ok: true,
      finalAnswer,
      steps
    };
  }
}

export const agentCore = new MairaAgentCore();
