import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  X, Cpu, Sparkles, MessageSquare, Send, Mic, MicOff, 
  Trash2, Power, Radio, Square, User, Volume2, ShieldAlert
} from "lucide-react";
import { LiveState } from "../lib/audio";

interface SabitPanelProps {
  isOpen: boolean;
  onClose: () => void;
  task: string | null;
  assistantName: string;
  voiceTone: string;
  state: LiveState;
  isThinking: boolean;
  runningTask: string | null;
  transcription: { role: "user" | "model"; text: string }[];
  onSend: (text: string) => void;
  onCancel: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onClearLog: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
}

const TASK_DISPLAY_NAMES: Record<string, string> = {
  openApplication: "Launching Application",
  closeApplication: "Closing Application",
  openWebsite: "Opening Website",
  searchWeb: "Searching the Web",
  searchYouTube: "Searching YouTube",
  searchGoogle: "Searching Google",
  searchGitHub: "Searching GitHub",
  createFile: "Creating File",
  readFile: "Reading File",
  editFile: "Editing File",
  deleteFile: "Deleting File",
  takeScreenshot: "Taking Screenshot",
  analyzeScreenshot: "Analyzing Screen",
  readScreen: "Reading Screen Content",
  desktopBrowserOpen: "Opening Automated Browser",
  desktopBrowserSnapshot: "Scanning Page Elements",
  desktopBrowserClick: "Clicking Page Element",
  desktopBrowserType: "Typing into Field",
  desktopBrowserSearch: "Searching Web Page",
  desktopBrowserClose: "Closing Browser",
  clickOnText: "Finding and Clicking Text",
  findOnScreen: "Searching Screen",
  runPythonScript: "Running Python Script",
};

export const SabitPanel: React.FC<SabitPanelProps> = ({
  isOpen,
  onClose,
  task,
  assistantName = "Sabit",
  voiceTone,
  state,
  isThinking,
  runningTask,
  transcription,
  onSend,
  onCancel,
  onConnect,
  onDisconnect,
  onClearLog,
  isMuted,
  onToggleMute,
}) => {
  const [input, setInput] = useState("");
  const [panelMode, setPanelMode] = useState<"voice" | "chat">("voice");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcription feed to bottom (whenever user sent messages update)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcription]);

  if (!isOpen) return null;

  const isConnected = state !== "disconnected";
  // Sabit is busy if he is actively processing a browser/system task
  const isBusy = isThinking || !!runningTask;

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isBusy) return;
    onSend(input.trim());
    setInput("");
  };

  const getStatusText = () => {
    if (isBusy) return "SABIT IS BUSY";
    if (state === "connecting") return "Connecting...";
    if (state === "speaking") return "Speaking";
    if (state === "listening") return "Listening";
    return "Disconnected";
  };

  const getStatusColorClass = () => {
    if (isBusy) return "text-amber-400 bg-amber-500/15 border-amber-500/30";
    if (state === "speaking") return "text-cyan-400 bg-cyan-500/15 border-cyan-500/30";
    if (state === "listening") return "text-emerald-400 bg-emerald-500/15 border-emerald-500/30";
    if (state === "connecting") return "text-blue-400 bg-blue-500/15 border-blue-500/30";
    return "text-slate-400 bg-white/5 border-white/10";
  };

  // Only keep the user's sent messages in the visible log history for Chat Mode
  const userMessagesOnly = transcription.filter((msg) => msg.role === "user");

  // Handler to clear chat history (clears transcription) without interrupting task
  const handleClearHistory = () => {
    onClearLog();
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 bg-[#010103]/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
        {/* Animated Modal Container */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.15 }}
          className="relative w-full max-w-4xl h-[640px] bg-gradient-to-b from-[#0a0b16] to-[#040409] rounded-2xl border border-cyan-500/25 flex flex-col shadow-[0_0_80px_rgba(6,182,212,0.18)] overflow-hidden"
        >
          {/* Futuristic Grid Overlay Background */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(18,24,38,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(18,24,38,0.1)_1px,transparent_1px)] bg-[size:16px_16px] pointer-events-none opacity-40" />

          {/* Core Header (Matching Reference Design structure perfectly) */}
          <div className="relative p-5 border-b border-white/10 flex items-center justify-between bg-black/40 z-10">
            {/* Left Header Section */}
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl border border-cyan-500/30 text-cyan-400 bg-cyan-500/10 shadow-[0_0_20px_rgba(6,182,212,0.25)] flex items-center justify-center">
                <Cpu size={20} className={isBusy ? "animate-spin [animation-duration:4s]" : "animate-pulse"} />
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <h3 className="font-display font-semibold text-base tracking-tight text-white uppercase">
                    SABIT
                  </h3>
                  <span className="text-[9px] font-mono font-bold tracking-wider px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-300 bg-cyan-500/10 uppercase">
                    Sub-Assistant
                  </span>
                </div>
                <p className="text-[10px] font-mono text-slate-400 mt-0.5 tracking-normal">
                  Autonomous Background Task Executor for Myraa
                </p>
              </div>
            </div>

            {/* Central Mode Switch (Strict Visual Reference) */}
            <div className="flex items-center bg-black/50 p-1 rounded-xl border border-white/10">
              <button
                onClick={() => setPanelMode("voice")}
                disabled={isBusy}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  panelMode === "voice"
                    ? "bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.15)]"
                    : "border border-transparent text-slate-400 hover:text-white"
                }`}
              >
                <Radio size={12} className={panelMode === "voice" && isConnected ? "animate-pulse" : ""} />
                Voice Mode
              </button>
              <button
                onClick={() => setPanelMode("chat")}
                disabled={isBusy}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  panelMode === "chat"
                    ? "bg-cyan-500/15 border border-cyan-500/35 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.15)]"
                    : "border border-transparent text-slate-400 hover:text-white"
                }`}
              >
                <MessageSquare size={12} />
                Chat Mode
              </button>
            </div>

            {/* Right Action Section */}
            <div className="flex items-center gap-2.5">
              {/* Connected / Disconnected Toggle Button (Manual Override supported) */}
              <button
                onClick={isConnected ? onDisconnect : onConnect}
                disabled={state === "connecting" || isBusy}
                className={`flex items-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-mono uppercase tracking-wider transition-all border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  state === "listening" || state === "speaking"
                    ? "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/25 shadow-[0_0_15px_rgba(16,185,129,0.1)]"
                    : state === "connecting"
                    ? "bg-amber-500/10 text-amber-300 border-amber-500/25 animate-pulse"
                    : state === "error"
                    ? "bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border-rose-500/25 shadow-[0_0_15px_rgba(244,63,94,0.1)]"
                    : "bg-slate-500/10 hover:bg-slate-500/20 text-slate-400 border-slate-500/20"
                }`}
                title={
                  state === "listening" || state === "speaking"
                    ? "Disconnect Sabit"
                    : state === "connecting"
                    ? "Connecting..."
                    : state === "error"
                    ? "Click to Retry Connection"
                    : "Connect Sabit"
                }
              >
                <Power size={11} className={(state === "listening" || state === "speaking") ? "animate-pulse text-emerald-400" : ""} />
                <span>
                  {state === "listening" || state === "speaking"
                    ? "Connected"
                    : state === "connecting"
                    ? "Connecting"
                    : state === "error"
                    ? "Connection Error"
                    : "Offline"}
                </span>
              </button>

              {/* Mute / Unmute Button (Top Right) */}
              <button
                onClick={onToggleMute}
                disabled={!isConnected || isBusy}
                className={`p-2 rounded-lg border transition-all cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed ${
                  isMuted
                    ? "bg-rose-500/15 border-rose-500/30 text-rose-400 hover:bg-rose-500/25"
                    : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                }`}
                title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
              >
                {isMuted ? <MicOff size={13} /> : <Mic size={13} />}
              </button>

              {/* Delete Chat History Button */}
              <button
                onClick={handleClearHistory}
                className="p-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-rose-400 transition cursor-pointer"
                title="Clear Chat History (Does not stop busy tasks)"
              >
                <Trash2 size={13} />
              </button>

              {/* Close Panel Button */}
              <button
                onClick={onClose}
                className="p-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition cursor-pointer"
                title="Close Window"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Core Body Container */}
          <div className="flex-1 flex overflow-hidden">
            
            {/* Left Stage Panel: Modes Visualizer/Communicator */}
            <div className="flex-1 flex flex-col bg-black/20 p-6 overflow-hidden">
              {panelMode === "voice" ? (
                /* Voice Mode Container (Centered Visualizer + One Voice Card) */
                <div className="flex-1 flex flex-col justify-between items-center py-6">
                  
                  {/* Status Headline Banner */}
                  <div className="text-center">
                    <span className={`text-[10px] font-mono uppercase tracking-widest px-3 py-1 rounded-full border ${getStatusColorClass()}`}>
                      {getStatusText()}
                    </span>
                    <p className="text-xs text-slate-400 font-mono mt-3 uppercase tracking-wider">
                      {isBusy ? "Automated execution active" : isConnected ? (isMuted ? "Audio connection on standby (muted)" : "Bilateral audio pipeline live") : "Voice interface offline"}
                    </p>
                  </div>

                  {/* Central Dynamic Visualizer with Advanced Cyberpunk Animations */}
                  <div className="relative flex items-center justify-center w-64 h-64">
                    
                    {/* Background Neon Ripple Rings */}
                    <AnimatePresence>
                      {isConnected && !isMuted && (
                        <>
                          {/* Inner Ripple ring */}
                          <motion.div
                            animate={{
                              scale: state === "speaking" ? [1, 1.4, 1] : state === "listening" ? [1, 1.2, 1] : [1, 1.05, 1],
                              opacity: state === "speaking" ? [0.15, 0.4, 0.15] : 0.1,
                            }}
                            transition={{ repeat: Infinity, duration: state === "speaking" ? 1.5 : 3, ease: "easeInOut" }}
                            className="absolute inset-0 rounded-full border border-cyan-500/20 bg-cyan-500/[0.01]"
                          />
                          {/* Outer Ripple ring */}
                          <motion.div
                            animate={{
                              scale: state === "speaking" ? [1, 1.8, 1] : state === "listening" ? [1, 1.4, 1] : [1, 1.1, 1],
                              opacity: state === "speaking" ? [0.08, 0.25, 0.08] : 0.05,
                            }}
                            transition={{ repeat: Infinity, duration: state === "speaking" ? 2 : 4, ease: "easeInOut" }}
                            className="absolute -inset-8 rounded-full border border-cyan-500/10 bg-cyan-500/[0.005]"
                          />
                        </>
                      )}
                    </AnimatePresence>

                    {/* Orbit Ring (Thinking state) */}
                    {isBusy && (
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
                        className="absolute inset-2 rounded-full border-2 border-dashed border-amber-500/40"
                      />
                    )}

                    {/* Glowing Core Sphere */}
                    <motion.div
                      animate={{
                        scale: state === "speaking" ? [1, 1.12, 1] : state === "listening" ? [1, 1.06, 1] : [1, 1.02, 1],
                        boxShadow: isMuted 
                          ? "0 0 20px rgba(100, 116, 139, 0.1)"
                          : isBusy
                          ? "0 0 35px rgba(245, 158, 11, 0.35)"
                          : state === "speaking"
                          ? "0 0 45px rgba(6, 182, 212, 0.55)"
                          : state === "listening"
                          ? "0 0 35px rgba(16, 185, 129, 0.35)"
                          : "0 0 25px rgba(6, 182, 212, 0.2)",
                      }}
                      transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                      className={`w-32 h-32 rounded-full flex flex-col items-center justify-center border transition-colors duration-500 relative z-10 ${
                        isMuted 
                          ? "bg-slate-900/80 border-slate-700/40 text-slate-500"
                          : isBusy
                          ? "bg-amber-950/20 border-amber-500/40 text-amber-300"
                          : state === "speaking"
                          ? "bg-cyan-950/30 border-cyan-400/50 text-cyan-300"
                          : state === "listening"
                          ? "bg-emerald-950/20 border-emerald-400/40 text-emerald-300"
                          : "bg-cyan-950/10 border-cyan-500/30 text-cyan-400"
                      }`}
                    >
                      {/* Animated Core Icon */}
                      <div className="flex flex-col items-center gap-1">
                        <Radio size={24} className={isConnected && !isMuted ? "animate-pulse" : ""} />
                        <span className="text-[9px] font-mono uppercase tracking-widest font-bold">
                          {isMuted ? "Muted" : getStatusText()}
                        </span>
                      </div>
                    </motion.div>
                  </div>

                  {/* Single Deep & Warm Voice Selection Card (Strictly Required) */}
                  <div className="w-full max-w-sm">
                    <span className="block text-[9px] font-mono uppercase text-slate-500 tracking-wider mb-2 text-center">
                      Voice Allocation
                    </span>
                    
                    {/* Voice Card with animated border, glow, and hover */}
                    <div className="relative group rounded-xl p-3 border border-cyan-500/30 bg-cyan-500/5 shadow-[0_0_20px_rgba(6,182,212,0.1)] transition-all duration-300 hover:border-cyan-400 hover:shadow-[0_0_25px_rgba(6,182,212,0.18)]">
                      {/* Animated Glow Border Effect */}
                      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-cyan-500/10 to-blue-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                      
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-300">
                            <Volume2 size={16} />
                          </div>
                          <div>
                            <span className="block text-xs font-mono font-bold text-white uppercase tracking-wider">
                              Deep & Warm
                            </span>
                            <span className="block text-[10px] text-slate-400 leading-normal mt-0.5">
                              Natural, deep male voice with calm and human-like resonance.
                            </span>
                          </div>
                        </div>
                        <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* Chat Mode Container */
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Chat logs feed */}
                  <div ref={scrollRef} className="flex-1 overflow-y-auto pr-2 space-y-4 scrollbar-thin">
                    {userMessagesOnly.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500 space-y-2">
                        <MessageSquare size={28} className="opacity-30 text-cyan-400" />
                        <p className="text-xs font-mono text-slate-300 uppercase tracking-widest">
                          Chat Interceptor Stream
                        </p>
                        <p className="text-[10px] text-slate-500 font-mono max-w-xs leading-normal uppercase">
                          {isConnected ? "Awaiting your chat input packet..." : "Please link Sabit's core to chat"}
                        </p>
                      </div>
                    ) : (
                      userMessagesOnly.map((m, idx) => (
                        <motion.div
                          key={idx}
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="flex flex-col max-w-[85%] ml-auto items-end"
                        >
                          <div className="flex items-center gap-1 mb-1 text-[8px] font-mono text-slate-500 uppercase tracking-widest">
                            <User size={10} />
                            <span>YOU</span>
                          </div>
                          <div className="p-3 rounded-2xl text-xs leading-relaxed bg-cyan-500 text-slate-950 font-medium font-mono shadow-[0_4px_15px_rgba(6,182,212,0.15)]">
                            {m.text}
                          </div>
                        </motion.div>
                      ))
                    )}
                  </div>

                  {/* Chat Input form */}
                  <div className="pt-4 border-t border-white/5">
                    {isConnected ? (
                      <form onSubmit={handleSendMessage} className="flex gap-2">
                        <input
                          type="text"
                          value={input}
                          disabled={isBusy}
                          onChange={(e) => setInput(e.target.value)}
                          placeholder={isBusy ? "SABIT IS BUSY — Controls Disabled" : `Type instruction to ${assistantName}...`}
                          className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 bg-black/40 text-xs text-white placeholder-slate-500 outline-none focus:border-cyan-400/50 transition font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                        <button
                          type="submit"
                          disabled={!input.trim() || isBusy}
                          className="p-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-all duration-200 disabled:opacity-20 disabled:cursor-not-allowed shrink-0 flex items-center justify-center cursor-pointer shadow-[0_0_15px_rgba(6,182,212,0.2)]"
                          title="Send Packet"
                        >
                          <Send size={14} />
                        </button>
                      </form>
                    ) : (
                      <div className="text-center py-3 bg-white/[0.01] border border-dashed border-white/5 rounded-xl">
                        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                          Voice stream offline. Link Sabit connection.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Right Side Panel: Task status banner, delegated logs, cancel triggers */}
            <div className="w-80 border-l border-white/10 flex flex-col bg-black/40 p-5 space-y-4">
              
              {/* Heading */}
              <div>
                <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500 block">
                  Autopilot Status
                </span>
                <h4 className="text-xs font-mono font-bold text-white mt-1 uppercase tracking-wider">
                  Delegation Monitor
                </h4>
              </div>

              {/* Busy visual / Task indicator */}
              <div className="flex-1 flex flex-col justify-between">
                <div className="space-y-3">
                  {/* Active Task Banner */}
                  <div className={`p-3 rounded-xl border ${isBusy ? "bg-amber-500/10 border-amber-500/30 text-amber-300" : "bg-white/5 border-white/10 text-slate-400"} space-y-1.5`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-mono uppercase tracking-widest">
                        Core Task State
                      </span>
                      {isBusy && (
                        <span className="flex h-2 w-2 relative">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono font-bold uppercase leading-tight">
                      {isBusy ? "TASK IN PROGRESS" : "STANDBY / IDLE"}
                    </p>
                    
                    {isBusy && runningTask && (
                      <div className="pt-2 border-t border-amber-500/20 text-[10px] font-mono text-slate-300">
                        <span className="text-slate-500 uppercase block text-[8px] tracking-wider mb-0.5">Automated Worker Action:</span>
                        {TASK_DISPLAY_NAMES[runningTask] || runningTask}
                      </div>
                    )}
                  </div>

                  {/* Task description block */}
                  <div className="p-3.5 rounded-xl bg-black/60 border border-white/5 space-y-2">
                    <span className="text-[8px] font-mono uppercase tracking-widest text-slate-500 block">
                      Assigned Task Instruction
                    </span>
                    <p className="text-[11px] font-mono text-slate-300 leading-normal select-all break-words">
                      {task || "No background tasks active or currently assigned."}
                    </p>
                  </div>
                </div>

                {/* Cancel Trigger & Disconnect warning */}
                <div className="space-y-3">
                  {isBusy && (
                    <button
                      onClick={onCancel}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-rose-500/30 hover:border-rose-500 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-white text-xs font-mono uppercase tracking-wider transition cursor-pointer shadow-[0_0_15px_rgba(239,68,68,0.1)]"
                    >
                      <Square size={13} />
                      <span>Abort Active Task</span>
                    </button>
                  )}

                  {!isConnected && (
                    <div className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl flex gap-2 items-start text-rose-300">
                      <ShieldAlert size={14} className="shrink-0 mt-0.5" />
                      <div className="text-[9px] font-mono leading-normal uppercase">
                        Sabit is currently offline. Delegated background automation tasks will run on Maira instead.
                      </div>
                    </div>
                  )}

                  <button
                    onClick={onClose}
                    className="w-full py-2.5 px-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-mono uppercase tracking-wider transition cursor-pointer text-center"
                  >
                    Close Dashboard
                  </button>
                </div>
              </div>

            </div>

          </div>

          {/* Footer Bar */}
          <div className="p-3 border-t border-white/5 bg-black/80 flex items-center justify-between text-[9px] font-mono text-slate-500 uppercase tracking-widest relative z-10">
            <span>Secured Sub-Process Session</span>
            <span>Link Channel Active</span>
          </div>

        </motion.div>
      </div>
    </AnimatePresence>
  );
};
