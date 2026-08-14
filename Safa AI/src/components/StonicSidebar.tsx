import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Send,
  Trash2,
  X,
  MessageSquare,
  Copy,
  Check,
  Mic,
  Volume2,
  Brain,
  Cpu,
  Sparkles,
  Clock,
  Plus,
  MessageCircle,
  ChevronDown,
  ChevronRight,
  Terminal,
  FileText,
  List,
  ArrowUp,
  HelpCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatMessage } from "./ChatPanel";

interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface StonicSidebarProps {
  messages: ChatMessage[];
  assistantName?: string;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
  sessionId: string;
  sessionTitle?: string;
  onRenameSession?: (title: string) => void;
  onSwitchSession: (id: string) => void;
  onNewSession: () => void;
}

function fmtDateBadge(iso: string): string {
  try {
    const d = new Date(iso);
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  } catch {
    return "RECENT";
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* ignore */
        }
      }}
      className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 hover:text-cyan-300 transition cursor-pointer"
      title="Copy"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {label && <span>{label}</span>}
    </button>
  );
};

const CodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-white/10 bg-black/70">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/10">
        <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/80">
          {language || "code"}
        </span>
        <CopyButton text={code} label="copy" />
      </div>
      <pre className="p-3 overflow-x-auto text-[11px] leading-relaxed font-mono text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
};

/** Collapsible Thought Process Section (matching Stonic UI screenshot 1 & 2) */
const ThoughtProcessAccordion: React.FC<{ text: string }> = ({ text }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (!text || !text.trim()) return null;

  return (
    <div className="my-2 rounded-xl border border-indigo-500/20 bg-indigo-950/20 overflow-hidden text-xs">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 transition text-left cursor-pointer"
      >
        <span className="flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-widest uppercase text-indigo-300">
          <Brain size={12} className="text-indigo-400 animate-pulse" />
          THOUGHT PROCESS
        </span>
        {isOpen ? <ChevronDown size={14} className="text-indigo-300" /> : <ChevronRight size={14} className="text-indigo-300" />}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="p-3 border-t border-indigo-500/15 text-slate-300 font-sans text-[11.5px] leading-relaxed space-y-2"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p className="my-1 text-slate-300">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-cyan-200 font-mono text-[11px] block mt-2">{children}</strong>,
              }}
            >
              {text}
            </ReactMarkdown>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/** Tool execution pill matching Stonic UI screenshot 2: `Module: generate_diagram >_ 0.8s >` */
const ToolExecutionPill: React.FC<{ toolName: string; duration?: string }> = ({ toolName, duration = "0.8s" }) => {
  return (
    <div className="my-2 flex items-center justify-between px-3 py-1.5 rounded-xl border border-cyan-500/30 bg-slate-900/90 text-xs font-mono select-none">
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-cyan-400 animate-pulse" />
        <span className="text-slate-400 text-[11px]">Module:</span>
        <span className="px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 font-bold text-[11px]">
          {toolName}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[10px] text-slate-500">
        <Terminal size={11} className="text-cyan-400" />
        <span>{duration}</span>
        <ChevronRight size={11} className="text-slate-400" />
      </div>
    </div>
  );
};

export const StonicSidebar: React.FC<StonicSidebarProps> = ({
  messages,
  assistantName = "Stonic AI",
  isStreaming,
  onSend,
  onClose,
  sessionId,
  sessionTitle = "Chat 1",
  onRenameSession,
  onSwitchSession,
  onNewSession,
}) => {
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState<"CHATS" | "LOGS" | "TASKS" | "NOTES">("CHATS");
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedMode, setSelectedMode] = useState<"voice" | "expert">("voice");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load chat sessions on mount and whenever history panel opens
  const loadSessions = async () => {
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  };

  useEffect(() => {
    loadSessions();
  }, [sessionId]);

  // Auto scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming, activeTab]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this chat session?")) return;
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (res.ok) {
        if (sessionId === id) {
          onNewSession();
        } else {
          loadSessions();
        }
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  return (
    <div className="relative flex flex-col h-full w-[420px] border-l border-white/10 bg-[#090d14] backdrop-blur-xl shadow-2xl text-white font-sans overflow-hidden">
      {/* ─── Top Header Bar (Stonic UI Tabs & Icons) ─── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#0c121d]">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-4 text-xs font-mono uppercase tracking-widest">
          {(["CHATS", "LOGS", "TASKS", "NOTES"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                if (showHistory) setShowHistory(false);
              }}
              className={`transition-colors cursor-pointer py-0.5 ${
                activeTab === tab && !showHistory
                  ? "text-cyan-300 font-bold border-b-2 border-cyan-400"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Top Right Action Icons */}
        <div className="flex items-center gap-2">
          {/* New Chat (+) Icon */}
          <button
            onClick={() => {
              setShowHistory(false);
              onNewSession();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-white/5 transition cursor-pointer"
            title="New Chat"
          >
            <Plus size={17} />
          </button>

          {/* History / Clock Icon */}
          <button
            onClick={() => {
              setShowHistory(!showHistory);
              if (!showHistory) loadSessions();
            }}
            className={`p-1.5 rounded-lg transition cursor-pointer ${
              showHistory
                ? "text-cyan-300 bg-cyan-500/20 border border-cyan-500/40"
                : "text-slate-400 hover:text-cyan-300 hover:bg-white/5"
            }`}
            title="History Sessions"
          >
            <Clock size={17} />
          </button>

          {/* Close Sidebar Icon */}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5 transition cursor-pointer"
            title="Close Panel"
          >
            <X size={17} />
          </button>
        </div>
      </div>

      {/* ─── Main Content Area ─── */}
      <div className="flex-1 overflow-hidden relative bg-[#070a10]">
        <AnimatePresence mode="wait">
          {showHistory ? (
            /* ─── HISTORY SESSIONS VIEW (Matching Stonic UI Screenshot 3) ─── */
            <motion.div
              key="history"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="absolute inset-0 flex flex-col p-4 bg-[#090d14] z-20 overflow-y-auto custom-scrollbar"
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-cyan-400">
                  HISTORY SESSIONS
                </span>
                <button
                  onClick={() => {
                    setShowHistory(false);
                    onNewSession();
                  }}
                  className="p-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 transition cursor-pointer"
                  title="New Session"
                >
                  <Plus size={14} />
                </button>
              </div>

              {sessions.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-slate-600 text-xs font-mono">
                  No saved sessions.
                </div>
              ) : (
                <div className="space-y-3">
                  {sessions.map((sess) => {
                    const isActive = sess.id === sessionId;
                    return (
                      <div
                        key={sess.id}
                        onClick={() => {
                          onSwitchSession(sess.id);
                          setShowHistory(false);
                        }}
                        className={`group relative flex items-center justify-between p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                          isActive
                            ? "bg-cyan-950/40 border-cyan-500/60 shadow-[0_0_15px_rgba(6,182,212,0.15)]"
                            : "bg-slate-900/50 border-white/5 hover:border-cyan-500/30 hover:bg-slate-900"
                        }`}
                      >
                        {/* Cyan left bar highlight for active card */}
                        {isActive && (
                          <div className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-cyan-400" />
                        )}

                        <div className="flex flex-col flex-1 pl-2 pr-3 min-w-0">
                          <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-cyan-400/80 mb-1">
                            {fmtDateBadge(sess.updated_at)}
                          </span>
                          <span className="text-xs font-semibold text-slate-100 truncate">
                            {sess.title || "New Chat"}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500 mt-1 truncate">
                            Awaiting transmission
                          </span>
                        </div>

                        {/* Delete Session Button */}
                        <button
                          onClick={(e) => handleDeleteSession(sess.id, e)}
                          className="p-2 rounded-lg text-rose-400/70 hover:text-rose-400 hover:bg-rose-500/20 transition cursor-pointer"
                          title="Delete Session"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          ) : activeTab === "LOGS" ? (
            /* ─── LOGS TAB ─── */
            <div className="p-4 text-xs font-mono text-slate-400 space-y-2 h-full overflow-y-auto">
              <div className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest mb-2">System Diagnostics Log</div>
              <div className="p-3 rounded-lg bg-black/60 border border-white/10 text-[11px] leading-relaxed space-y-1">
                <p className="text-emerald-400">[SYSTEM] Memory Core initialized with Stonic AI 2-tier architecture.</p>
                <p className="text-cyan-400">[SESSION] SQLite FTS5 active on session DB.</p>
                <p className="text-slate-400">[AGENT] ReAct loop online & ready.</p>
              </div>
            </div>
          ) : activeTab === "TASKS" ? (
            /* ─── TASKS TAB ─── */
            <div className="p-4 text-xs font-mono text-slate-400 space-y-2 h-full overflow-y-auto">
              <div className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest mb-2">Active Agent Tasks</div>
              <div className="p-3 rounded-lg bg-black/60 border border-white/10 text-[11px]">
                <p className="text-slate-400">No active background tasks running.</p>
              </div>
            </div>
          ) : activeTab === "NOTES" ? (
            /* ─── NOTES TAB ─── */
            <div className="p-4 text-xs font-mono text-slate-400 space-y-2 h-full overflow-y-auto">
              <div className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest mb-2">Quick Reference Notes</div>
              <div className="p-3 rounded-lg bg-black/60 border border-white/10 text-[11px] text-slate-300">
                <p>MEMORY.md entries are stored with §-delimiters and automatically recalled during conversations.</p>
              </div>
            </div>
          ) : (
            /* ─── CHATS TAB TRANSCRIPT ─── */
            <div className="flex flex-col h-full">
              {/* Active Session Name Header (renameable) */}
              <div className="px-4 py-2.5 border-b border-white/10 bg-[#0b101a] flex items-center justify-between">
                {isRenaming ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const t = renameDraft.trim();
                      if (t) onRenameSession?.(t);
                      setIsRenaming(false);
                    }}
                    className="flex items-center gap-2 flex-1"
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => setIsRenaming(false)}
                      className="flex-1 bg-[#0c121d] border border-cyan-500/40 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                      placeholder="Session name..."
                    />
                    <button
                      type="submit"
                      className="p-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-300 transition cursor-pointer"
                      title="Save name"
                    >
                      <Check size={14} />
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center gap-2 min-w-0">
                      <MessageCircle size={14} className="text-cyan-400 shrink-0" />
                      <span className="text-xs font-semibold text-slate-100 truncate">
                        {sessionTitle}
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        setRenameDraft(sessionTitle);
                        setIsRenaming(true);
                      }}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-cyan-300 hover:bg-white/5 transition cursor-pointer"
                      title="Rename session"
                    >
                      <FileText size={14} />
                    </button>
                  </>
                )}
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs text-center px-6 py-16 space-y-2">
                  <MessageSquare size={32} className="text-cyan-500/30 animate-pulse" />
                  <span className="font-mono text-[10px] uppercase tracking-widest text-cyan-400/70">
                    CHANNEL READY
                  </span>
                  <p className="max-w-[240px] text-slate-500 text-[11px] leading-relaxed">
                    Start speaking or type a prompt below to communicate with {assistantName}.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isUser = msg.role === "user";
                  const hasThought = !!msg.thinkingSummary;
                  const isTool = msg.messageType === "tool_result";

                  return (
                    <div key={msg.id} className={`flex flex-col ${isUser ? "items-end" : "items-start"} w-full`}>
                      {/* Speaker Badge */}
                      <div className="flex items-center gap-1.5 mb-1 px-1 text-[9px] font-mono uppercase tracking-wider text-slate-500">
                        {isUser ? (
                          <span className="flex items-center gap-1 text-cyan-400 font-bold">
                            <Mic size={10} /> YOU
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-cyan-300 font-bold">
                            <Sparkles size={10} /> {assistantName.toUpperCase()}
                          </span>
                        )}
                        <span className="text-slate-600">· {fmtTime(msg.timestamp)}</span>
                      </div>

                      {/* Render Thought Process if present */}
                      {!isUser && (hasThought || msg.text.includes("**Interpreting the Prompt**")) && (
                        <div className="w-full max-w-[95%]">
                          <ThoughtProcessAccordion text={msg.thinkingSummary || msg.text} />
                        </div>
                      )}

                      {/* Render Tool Execution Pill if tool call */}
                      {isTool && (
                        <div className="w-full max-w-[95%]">
                          <ToolExecutionPill toolName={msg.text.split("\n")[0] || "tool"} />
                        </div>
                      )}

                      {/* Content Bubble */}
                      <div
                        className={`relative max-w-[92%] px-4 py-3 rounded-2xl text-xs leading-relaxed ${
                          isUser
                            ? "bg-slate-900 border border-slate-700/60 text-slate-100 font-sans"
                            : "bg-transparent text-slate-200 font-sans"
                        }`}
                      >
                        {/* Hover Copy Button */}
                        <div className="absolute -top-2 right-2 opacity-0 hover:opacity-100 transition z-10">
                          <CopyButton text={msg.text} />
                        </div>

                        {/* Text Render */}
                        <div className="prose-chat break-words whitespace-pre-wrap">
                          {isUser ? (
                            <span>{msg.text}</span>
                          ) : (
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                code({ className, children }: any) {
                                  const text = String(children ?? "");
                                  const isBlock = /\blanguage-/.test(className || "") || text.includes("\n");
                                  if (isBlock) {
                                    const lang = /language-(\w+)/.exec(className || "")?.[1] || "";
                                    return <CodeBlock language={lang} code={text.replace(/\n$/, "")} />;
                                  }
                                  return (
                                    <code className="px-1.5 py-0.5 rounded bg-black/60 text-cyan-300 font-mono text-[10px]">
                                      {children}
                                    </code>
                                  );
                                },
                                p: ({ children }) => <p className="my-1">{children}</p>,
                              }}
                            >
                              {msg.text}
                            </ReactMarkdown>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}

              {/* Streaming Indicator */}
              {isStreaming && (
                <div className="flex items-center gap-2 text-cyan-400 text-xs font-mono pl-2 py-1">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                  </span>
                  <span className="text-[10px] uppercase tracking-wider">{assistantName} is generating response…</span>
                </div>
              )}
              </div>
              </div>
          )}
        </AnimatePresence>
      </div>

      {/* ─── Bottom Controls Bar (Stonic UI Input & Mode Switcher) ─── */}
      <div className="p-3 border-t border-white/10 bg-[#090d14] space-y-2">
        {/* Text Input Row */}
        <div className="relative flex items-center">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={showHistory}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={showHistory ? "Close history to type..." : "Type to Assistant (Gemini Live)..."}
            className="w-full bg-[#0c121d] border border-white/10 rounded-xl px-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/50 pr-10"
          />
          <button
            onClick={handleSend}
            disabled={showHistory || !input.trim()}
            className="absolute right-2 p-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-300 disabled:opacity-30 transition cursor-pointer"
            title="Send"
          >
            <ArrowUp size={15} />
          </button>
        </div>

        {/* Mode Switcher Pills (Matching Stonic UI Screenshot 2) */}
        <div className="flex items-center justify-between text-[10px] font-mono select-none pt-1">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedMode("voice")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border transition cursor-pointer ${
                selectedMode === "voice"
                  ? "bg-cyan-950 border-cyan-500 text-cyan-300 font-bold shadow-[0_0_10px_rgba(6,182,212,0.2)]"
                  : "bg-slate-900 border-white/10 text-slate-400 hover:text-white"
              }`}
            >
              <Mic size={11} />
              <span>VOICE ASSISTANT</span>
            </button>

            <button
              onClick={() => setSelectedMode("expert")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full border transition cursor-pointer ${
                selectedMode === "expert"
                  ? "bg-indigo-950 border-indigo-500 text-indigo-300 font-bold shadow-[0_0_10px_rgba(99,102,241,0.2)]"
                  : "bg-slate-900 border-white/10 text-slate-400 hover:text-white"
              }`}
            >
              <Terminal size={11} />
              <span>EXPERT AGENT</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[9px] uppercase tracking-wider text-slate-400">Voice Assistant</span>
          </div>
        </div>
      </div>
    </div>
  );
};
