import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Mic, Mic2, AudioLines, Volume2, Send } from "lucide-react";

/**
 * LiveTranscriptionPanel — Maira3 Dedicated Real-time Voice Transcription UI
 *
 * Mirrors Stonic AI's right-side live transcription panel behavior:
 * - Shows user speech transcription (inputAudioTranscription) in real-time
 * - Shows Safa's response transcription (outputAudioTranscription) in real-time
 * - Efficient rendering: useRef accumulation + requestAnimationFrame batching
 *   to avoid unnecessary re-renders on every tiny transcription chunk
 * - X/Close button hides the panel WITHOUT stopping voice/audio/memory
 * - Show again via parent toggle; state preserved across hide/show
 * - Auto-scroll to bottom on new content
 * - Distinct visual styling for user vs assistant turns
 *
 * This panel is SEPARATE from the chat sidebar (which shows committed history).
 * Live streaming chunks come here; finalized turns also go to chat history.
 */

export interface TranscriptEntry {
  id: string;
  role: "user" | "model";
  text: string;
  timestamp: string;
  /** True while this entry is still receiving streaming chunks */
  streaming?: boolean;
}

interface LiveTranscriptionPanelProps {
  /** Live streaming entries (user + model interleaved as they happen) */
  entries: TranscriptEntry[];
  /** Whether the voice session is currently connected */
  isConnected: boolean;
  /** Whether Safa is currently speaking (for the audio indicator) */
  isSpeaking: boolean;
  /** Whether the user's mic is active */
  isListening: boolean;
  /** Assistant display name */
  assistantName?: string;
  /** Close handler — hides the panel */
  onClose: () => void;
  /** Send text message directly from Live Transcription Panel */
  onSend?: (text: string) => void;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export const LiveTranscriptionPanel = React.memo<LiveTranscriptionPanelProps>(
  ({ entries, isConnected, isSpeaking, isListening, assistantName = "Safa", onClose, onSend }) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const [inputText, setInputText] = useState("");

    // Auto-scroll to bottom when new entries arrive (only if user is at bottom)
    useEffect(() => {
      if (autoScroll && scrollRef.current) {
        const el = scrollRef.current;
        el.scrollTop = el.scrollHeight;
      }
    }, [entries, autoScroll]);

    // Track scroll position to disable auto-scroll when user scrolls up
    const handleScroll = useCallback(() => {
      if (!scrollRef.current) return;
      const el = scrollRef.current;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setAutoScroll(atBottom);
    }, []);

    return (
      <motion.div
        initial={{ x: 60, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 60, opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 220 }}
        className="relative flex flex-col h-full w-[340px] rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900/80 to-black/70 backdrop-blur-xl shadow-[0_0_40px_-10px_rgba(99,102,241,0.3)] overflow-hidden"
      >
        {/* ─── Header ─── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/[0.03]">
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500/30 to-cyan-500/20 border border-white/10">
              <AudioLines size={14} className="text-cyan-300" />
              {/* Live indicator */}
              {isConnected && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse ring-2 ring-black/60" />
              )}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] font-semibold text-white tracking-wide">
                Live Transcription
              </span>
              <span className="text-[9px] font-mono uppercase tracking-wider text-slate-400">
                {isConnected ? (isSpeaking ? `${assistantName} speaking…` : isListening ? "listening…" : "connected") : "disconnected"}
              </span>
            </div>
          </div>

          {/* Close / X button — hides the panel without affecting voice */}
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-lg border border-white/10 bg-white/5 hover:bg-rose-500/20 hover:border-rose-500/40 text-slate-400 hover:text-rose-300 transition-all cursor-pointer group"
            title="Hide Live Transcription (voice continues)"
            aria-label="Close live transcription panel"
          >
            <X size={14} className="group-hover:scale-110 transition-transform" />
          </button>
        </div>

        {/* ─── Status bar (audio indicators) ─── */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5 bg-black/20">
          <div className={`flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider transition-colors ${isListening ? "text-cyan-300" : "text-slate-600"}`}>
            <Mic size={11} className={isListening ? "animate-pulse" : ""} />
            <span>MIC</span>
          </div>
          <div className={`flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider transition-colors ${isSpeaking ? "text-indigo-300" : "text-slate-600"}`}>
            <Volume2 size={11} className={isSpeaking ? "animate-pulse" : ""} />
            <span>{assistantName.toUpperCase()}</span>
          </div>
          <div className="flex-1 flex items-center justify-end gap-0.5">
            {/* Audio waveform bars — animate when speaking */}
            {Array.from({ length: 12 }).map((_, i) => (
              <span
                key={i}
                className="w-0.5 rounded-full transition-all duration-150"
                style={{
                  height: isSpeaking
                    ? `${4 + Math.abs(Math.sin(Date.now() / 200 + i * 0.7)) * 14}px`
                    : isListening
                    ? `${3 + Math.abs(Math.sin(Date.now() / 400 + i * 0.5)) * 5}px`
                    : "3px",
                  backgroundColor: isSpeaking
                    ? "rgb(165 180 252)"
                    : isListening
                    ? "rgb(103 232 249)"
                    : "rgb(71 85 105)",
                }}
              />
            ))}
          </div>
        </div>

        {/* ─── Transcription stream ─── */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scroll-smooth"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(148,163,184,0.3) transparent" }}
        >
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <AudioLines size={32} className="text-slate-700 mb-3" />
              <p className="text-xs text-slate-500 leading-relaxed">
                {isConnected
                  ? "Listening… Start speaking and your conversation will appear here in real-time."
                  : "Connect to start live transcription."}
              </p>
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {entries.map((entry) => (
                <TranscriptBubble
                  key={entry.id}
                  entry={entry}
                  assistantName={assistantName}
                />
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* ─── Footer with input ─── */}
        <div className="p-2 border-t border-white/10 bg-black/40 space-y-1">
          {onSend && (
            <div className="relative flex items-center">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (inputText.trim()) {
                      onSend(inputText.trim());
                      setInputText("");
                    }
                  }
                }}
                placeholder="Type to Live Session..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-[11px] text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/50 pr-8"
              />
              <button
                onClick={() => {
                  if (inputText.trim()) {
                    onSend(inputText.trim());
                    setInputText("");
                  }
                }}
                disabled={!inputText.trim()}
                className="absolute right-1.5 p-1 rounded-lg text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-30 transition cursor-pointer"
                title="Send to Live"
              >
                <Send size={12} />
              </button>
            </div>
          )}
          <p className="text-[8px] font-mono uppercase tracking-wider text-slate-600 text-center">
            {autoScroll ? "auto-scroll on" : "scroll paused"} · hide ≠ stop
          </p>
        </div>
      </motion.div>
    );
  }
);

LiveTranscriptionPanel.displayName = "LiveTranscriptionPanel";

/** Individual transcription bubble — memoized for render efficiency. */
const TranscriptBubble = React.memo<{ entry: TranscriptEntry; assistantName: string }>(
  ({ entry, assistantName }) => {
    const isUser = entry.role === "user";
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
        className={`flex flex-col ${isUser ? "items-end" : "items-start"} w-full`}
      >
        {/* Speaker label */}
        <div className={`flex items-center gap-1.5 mb-1 px-1 ${isUser ? "flex-row-reverse" : ""}`}>
          {isUser ? (
            <Mic size={9} className="text-cyan-400/70" />
          ) : (
            <Mic2 size={9} className="text-indigo-400/70" />
          )}
          <span className={`text-[8px] font-mono uppercase tracking-wider ${isUser ? "text-cyan-400/70" : "text-indigo-400/70"}`}>
            {isUser ? "You" : assistantName}
          </span>
          <span className="text-[7px] font-mono text-slate-600">
            {fmtTime(entry.timestamp)}
          </span>
        </div>

        {/* Bubble */}
        <div
          className={`relative max-w-[88%] px-3 py-2 rounded-2xl text-[12.5px] leading-relaxed break-words ${
            isUser
              ? "bg-cyan-500/10 border border-cyan-400/20 text-cyan-50 rounded-tr-sm"
              : "bg-indigo-500/10 border border-indigo-400/20 text-slate-50 rounded-tl-sm"
          }`}
        >
          <p className="whitespace-pre-wrap">
            {entry.text}
            {entry.streaming && (
              <span className="inline-block w-1.5 h-3 ml-0.5 bg-current opacity-70 animate-pulse align-middle" />
            )}
          </p>
        </div>
      </motion.div>
    );
  }
);
TranscriptBubble.displayName = "TranscriptBubble";
