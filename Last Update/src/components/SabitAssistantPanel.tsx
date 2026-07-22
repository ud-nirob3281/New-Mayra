import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Bot,
  Send,
  Mic,
  MicOff,
  MessageSquare,
  Activity,
  Play,
  Square,
  Trash2,
  Key,
  CheckCircle,
  AlertCircle,
  Clock,
  Terminal,
  Sparkles,
  Zap,
  Volume2,
  VolumeX,
  Radio,
  Settings2
} from 'lucide-react';
import { MyraaAudioSession, type LiveState } from '../lib/audio';

export interface SabitTaskStep {
  step: number;
  description: string;
  toolName?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  timestamp: string;
}

export interface SabitTask {
  id: string;
  title: string;
  type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  userInstruction: string;
  progress: number;
  currentStepIndex: number;
  steps: SabitTaskStep[];
  output?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SabitChatMessage {
  id: string;
  role: 'user' | 'sabit';
  text: string;
  timestamp: string;
  taskId?: string;
  steps?: SabitTaskStep[];
}

interface SabitAssistantPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SabitAssistantPanel: React.FC<SabitAssistantPanelProps> = ({
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'voice'>('chat');
  const [tasks, setTasks] = useState<SabitTask[]>([]);
  const [messages, setMessages] = useState<SabitChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSabitApiKey, setHasSabitApiKey] = useState<boolean>(true);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  // Voice mode state
  const [isListening, setIsListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const recognitionRef = useRef<any>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Poll tasks and chat messages
  const fetchTasksAndChat = async () => {
    try {
      const [tRes, cRes, cfgRes] = await Promise.all([
        fetch('/api/sabit/tasks'),
        fetch('/api/sabit/chat'),
        fetch('/api/config')
      ]);
      if (tRes.ok) {
        const tData = await tRes.json();
        setTasks(tData);
      }
      if (cRes.ok) {
        const cData = await cRes.json();
        setMessages(cData);
      }
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json();
        setHasSabitApiKey(!!cfgData.hasSabitApiKey);
      }
    } catch (e) {
      console.error('Failed to fetch SABIT state:', e);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      if (audioSessionRef.current) {
        stopLiveVoiceSession();
      }
      return;
    }

    fetchTasksAndChat();
    // Auto-connect Sabit to persistent WebSocket Gemini Live Session for fast response
    if (!audioSessionRef.current || audioSessionRef.current.getState() === 'disconnected') {
      startLiveVoiceSession();
    }

    const interval = setInterval(fetchTasksAndChat, 2000);
    return () => clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const speakText = (text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = /[\u0980-\u09FF]/.test(text) ? 'bn-BD' : 'en-US';
      utterance.rate = 1.0;
      utterance.pitch = 0.9; // Deeper male pitch tone for SABIT

      const voices = window.speechSynthesis.getVoices();
      if (voices && voices.length > 0) {
        const langPrefix = utterance.lang.slice(0, 2);
        const maleVoice = voices.find(v => 
          v.lang.toLowerCase().startsWith(langPrefix) && 
          /male|david|mark|george|ravi|guy|deep|bangla male|hasan|samir/i.test(v.name)
        ) || voices.find(v => /male|david|mark|george|ravi|guy|deep/i.test(v.name));

        if (maleVoice) {
          utterance.voice = maleVoice;
        }
      }

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error('Speech synthesis error for SABIT:', err);
    }
  };

  const activeTask = tasks.find(t => t.status === 'running' || t.status === 'queued');

  const handleSendMessage = async (customText?: string) => {
    const textToSend = customText || inputMessage;
    if (!textToSend.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setInputMessage('');

    // If persistent WebSocket session is active, route directly over WebSocket (Matching Maira's fast architecture)
    if (audioSessionRef.current && audioSessionRef.current.getState() !== 'disconnected') {
      try {
        streamingBubbleIdRef.current = null;
        // Append user message locally
        setMessages(prev => [
          ...prev,
          {
            id: Math.random().toString(36).slice(2),
            role: 'user',
            text: textToSend,
            timestamp: new Date().toISOString()
          }
        ]);
        // Forward text to Gemini Live WebSocket pipeline
        audioSessionRef.current.sendTextMessage(textToSend);
      } catch (e) {
        console.error('Error sending text over Sabit WebSocket session:', e);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // Fallback to REST endpoint if WebSocket is offline
    try {
      const res = await fetch('/api/sabit/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: textToSend })
      });
      if (res.ok) {
        const data = await res.json();
        await fetchTasksAndChat();
        if (data && data.reply) {
          if (activeTab === 'voice') {
            speakText(data.reply);
          }
        }
      }
    } catch (e) {
      console.error('Error sending message to SABIT:', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    try {
      await fetch('/api/sabit/tasks/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
      fetchTasksAndChat();
    } catch (e) {
      console.error('Failed to cancel task:', e);
    }
  };

  const handleClearChat = async () => {
    try {
      await fetch('/api/sabit/clear', { method: 'POST' });
      setMessages([]);
      fetchTasksAndChat();
    } catch (e) {
      console.error('Failed to clear chat:', e);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    setApiKeySaving(true);
    setApiKeyError(null);
    try {
      const res = await fetch('/api/config/sabit-apikey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setHasSabitApiKey(true);
        setShowApiKeyModal(false);
        setApiKeyInput('');
      } else {
        setApiKeyError(data.error || 'Failed to validate SABIT key.');
      }
    } catch (e: any) {
      setApiKeyError(e.message || 'Network error while saving key.');
    } finally {
      setApiKeySaving(false);
    }
  };

  // Gemini Live WebSocket Engine & Male Voice Session for SABIT
  const audioSessionRef = useRef<MyraaAudioSession | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('disconnected');
  const [sabitVoice, setSabitVoice] = useState<string>(() => {
    return localStorage.getItem('sabit_voice') || 'Charon';
  });

  useEffect(() => {
    localStorage.setItem('sabit_voice', sabitVoice);
  }, [sabitVoice]);

  const SABIT_MALE_VOICES = [
    { id: 'Charon', name: 'Deep & Calm', icon: '🎙️', desc: 'Resonant, deep male tone (Default)' },
    { id: 'Puck', name: 'Warm Companion', icon: '🗣️', desc: 'Friendly, warm male voice' },
    { id: 'Fenrir', name: 'Bold & Energetic', icon: '⚡', desc: 'Clear, strong male voice' },
    { id: 'Orus', name: 'Authoritative', icon: '👑', desc: 'Executive, deep male voice' },
    { id: 'Aoede', name: 'Baritone Male', icon: '🎙️', desc: 'Smooth, steady male tone' },
  ];

  const streamingBubbleIdRef = useRef<string | null>(null);

  const startLiveVoiceSession = () => {
    if (audioSessionRef.current) return;

    const session = new MyraaAudioSession({
      onStateChange: (state) => {
        setLiveState(state);
        setIsListening(state === 'listening' || state === 'speaking');
      },
      onTranscription: (role, text) => {
        setVoiceTranscript(text);
        if (role === 'user') {
          streamingBubbleIdRef.current = null;
          setMessages(prev => [
            ...prev,
            {
              id: Math.random().toString(36).slice(2),
              role: 'user',
              text,
              timestamp: new Date().toISOString()
            }
          ]);
        } else {
          setMessages(prev => {
            const id = streamingBubbleIdRef.current;
            if (id) {
              return prev.map(m => m.id === id ? { ...m, text: m.text + text } : m);
            }
            const newId = Math.random().toString(36).slice(2);
            streamingBubbleIdRef.current = newId;
            return [
              ...prev,
              { id: newId, role: 'sabit', text, timestamp: new Date().toISOString() }
            ];
          });
        }
      },
      onToolCall: (name, args, callback) => {
        console.log('[SABIT Live Tool Call]:', name, args);
        callback({ status: 'ok' });
      },
      onError: (err) => {
        console.error('[SABIT Audio Session Error]:', err);
      }
    });

    audioSessionRef.current = session;
    session.connect({
      assistantName: 'SABIT',
      voiceTone: sabitVoice,
      fileSystemAccess: true,
      screenShareAccess: true,
      microphoneAccess: true,
      systemCommandsAccess: true
    });
  };

  const stopLiveVoiceSession = () => {
    if (audioSessionRef.current) {
      audioSessionRef.current.disconnect();
      audioSessionRef.current = null;
      setLiveState('disconnected');
      setIsListening(false);
    }
  };

  const toggleLiveVoiceSession = () => {
    if (liveState === 'disconnected') {
      startLiveVoiceSession();
    } else {
      stopLiveVoiceSession();
    }
  };

  useEffect(() => {
    return () => {
      if (audioSessionRef.current) {
        audioSessionRef.current.disconnect();
        audioSessionRef.current = null;
      }
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative w-full max-w-5xl h-[85vh] rounded-3xl overflow-hidden border border-cyan-500/30 shadow-[0_0_50px_rgba(6,182,212,0.25)] flex flex-col bg-slate-950 text-white select-none"
      >
        {/* Background Image Container */}
        <div className="absolute inset-0 z-0 pointer-events-none opacity-40">
          <img
            src="assets/assistantbg.jpg"
            alt="Assistant Background"
            className="w-full h-full object-cover"
            onError={(e) => {
              // Fallback to css gradient if image missing
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-950/80 via-slate-950/60 to-slate-950" />
        </div>

        {/* TOP BAR / HEADER */}
        <div className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-white/10 bg-slate-900/60 backdrop-blur-md">
          {/* Top-Left Corner: SABIT Name with explicit margin */}
          <div className="flex items-center gap-3 my-1 ml-2">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-indigo-600 shadow-lg shadow-cyan-500/30">
              <Bot size={22} className="text-white" />
              {activeTask && (
                <span className="absolute -top-1 -right-1 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
                </span>
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-sky-300 to-indigo-300">
                  SABIT
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                  Sub-Assistant
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-sans">
                Autonomous Background Task Executor for Safa
              </p>
            </div>
          </div>

          {/* Center: Mode Switcher */}
          <div className="flex items-center p-1 rounded-xl bg-slate-800/80 border border-white/10">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeTab === 'chat'
                  ? 'bg-cyan-500 text-black shadow-md shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <MessageSquare size={14} />
              <span>Chat Mode</span>
            </button>
            <button
              onClick={() => setActiveTab('voice')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeTab === 'voice'
                  ? 'bg-cyan-500 text-black shadow-md shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Mic size={14} />
              <span>Voice Mode</span>
            </button>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowApiKeyModal(true)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono transition cursor-pointer ${
                hasSabitApiKey
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                  : 'border-amber-500/40 bg-amber-500/20 text-amber-300 animate-pulse'
              }`}
              title="Configure SABIT API Key"
            >
              <Key size={13} />
              <span>{hasSabitApiKey ? 'Key Configured' : 'Set SABIT Key'}</span>
            </button>

            <button
              onClick={handleClearChat}
              className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 transition cursor-pointer"
              title="Clear SABIT Chat History"
            >
              <Trash2 size={16} />
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ACTIVE TASK PROGRESS BAR & EXECUTION VISUALIZER */}
        {activeTask && (
          <div className="relative z-10 px-6 py-3 border-b border-cyan-500/20 bg-cyan-950/30 backdrop-blur-md">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Activity size={16} className="text-cyan-400 animate-spin" />
                <span className="text-xs font-bold uppercase tracking-wider text-cyan-300">
                  Executing: {activeTask.title}
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/20 text-cyan-200">
                  {activeTask.progress}%
                </span>
              </div>
              <button
                onClick={() => handleCancelTask(activeTask.id)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white border border-rose-500/30 text-[11px] font-semibold transition cursor-pointer"
              >
                <Square size={11} />
                <span>Cancel Task</span>
              </button>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden border border-cyan-500/30">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${activeTask.progress}%` }}
                transition={{ duration: 0.5 }}
                className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 shadow-[0_0_12px_rgba(6,182,212,0.8)]"
              />
            </div>

            {/* Step status text */}
            {activeTask.steps && activeTask.steps.length > 0 && (
              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300 font-mono">
                <span>
                  Step {activeTask.currentStepIndex + 1} of {activeTask.steps.length}:{' '}
                  <span className="text-cyan-200 font-sans">
                    {activeTask.steps[activeTask.currentStepIndex]?.description || 'Processing...'}
                  </span>
                </span>
                {activeTask.steps[activeTask.currentStepIndex]?.toolName && (
                  <span className="text-xs font-mono text-indigo-300">
                    Tool: {activeTask.steps[activeTask.currentStepIndex].toolName}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* CONTENT AREA */}
        <div className="relative z-10 flex-1 overflow-hidden flex flex-col">
          {activeTab === 'chat' ? (
            // CHAT MODE
            <div className="flex-1 flex flex-col overflow-hidden p-6">
              {/* Message List */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-400">
                    <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center mb-4 text-cyan-400">
                      <Zap size={32} />
                    </div>
                    <h3 className="text-lg font-bold text-slate-200 mb-1">
                      SABIT Background Engine Ready
                    </h3>
                    <p className="text-xs max-w-md text-slate-400 mb-6">
                      Give long-running tasks like YouTube automation, WhatsApp messaging, Daraz price checking, or Python code execution directly to SABIT.
                    </p>

                    {/* Quick Task Suggestions */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-xl w-full text-left">
                      <button
                        onClick={() => handleSendMessage('Play Believer song by Imagine Dragons on YouTube')}
                        className="p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition text-xs text-slate-300 flex items-center gap-2 cursor-pointer"
                      >
                        <Play size={14} className="text-cyan-400" />
                        <span>Play "Believer" on YouTube</span>
                      </button>
                      <button
                        onClick={() => handleSendMessage('Search for top AI tools in 2026 and summarize')}
                        className="p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition text-xs text-slate-300 flex items-center gap-2 cursor-pointer"
                      >
                        <Sparkles size={14} className="text-indigo-400" />
                        <span>Search & Summarize AI Tools</span>
                      </button>
                      <button
                        onClick={() => handleSendMessage('Create a test python script in Desktop/sabit_test.py and run it')}
                        className="p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition text-xs text-slate-300 flex items-center gap-2 cursor-pointer"
                      >
                        <Terminal size={14} className="text-emerald-400" />
                        <span>Create & Run Python Script</span>
                      </button>
                      <button
                        onClick={() => handleSendMessage('Check system performance and list active apps')}
                        className="p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 transition text-xs text-slate-300 flex items-center gap-2 cursor-pointer"
                      >
                        <Activity size={14} className="text-sky-400" />
                        <span>System Diagnostics</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${
                        msg.role === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl p-4 text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-gradient-to-r from-cyan-600 to-sky-600 text-white rounded-br-none shadow-md shadow-cyan-900/20'
                            : 'bg-slate-900/90 border border-cyan-500/20 text-slate-200 rounded-bl-none backdrop-blur-md shadow-md'
                        }`}
                      >
                        {msg.role === 'sabit' && (
                          <div className="flex items-center gap-1.5 mb-1 text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                            <Bot size={12} />
                            <span>SABIT Sub-Assistant</span>
                          </div>
                        )}
                        <p className="whitespace-pre-wrap">{msg.text}</p>

                        {/* Task Execution Log details inside message */}
                        {msg.steps && msg.steps.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-white/10 space-y-1.5">
                            <span className="text-[10px] font-mono text-cyan-300 font-bold block">
                              EXECUTION LOGS ({msg.steps.length} Steps):
                            </span>
                            {msg.steps.map((st, sIdx) => (
                              <div
                                key={sIdx}
                                className="flex items-start gap-2 text-[11px] font-mono p-1.5 rounded bg-black/40 border border-white/5"
                              >
                                {st.status === 'completed' && (
                                  <CheckCircle size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                                )}
                                {st.status === 'failed' && (
                                  <AlertCircle size={13} className="text-rose-400 shrink-0 mt-0.5" />
                                )}
                                {st.status === 'running' && (
                                  <Activity size={13} className="text-cyan-400 animate-spin shrink-0 mt-0.5" />
                                )}
                                {st.status === 'pending' && (
                                  <Clock size={13} className="text-slate-500 shrink-0 mt-0.5" />
                                )}
                                <div className="flex-1">
                                  <div className="text-slate-300 font-sans">{st.description}</div>
                                  {st.toolName && (
                                    <span className="text-[10px] text-indigo-300">
                                      Tool: {st.toolName}
                                    </span>
                                  )}
                                  {st.result && (
                                    <div className="text-[10px] text-slate-400 mt-0.5 line-clamp-2">
                                      {st.result}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="text-[9px] font-mono text-slate-500 mt-1 px-1">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat Input Box */}
              <div className="mt-4 pt-3 border-t border-white/10 flex items-center gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Ask SABIT to perform any background task..."
                  disabled={isSubmitting}
                  className="flex-1 px-4 py-3 rounded-xl bg-slate-900 border border-white/10 focus:border-cyan-500 focus:outline-none text-xs text-white placeholder-slate-500"
                />
                <button
                  onClick={() => handleSendMessage()}
                  disabled={!inputMessage.trim() || isSubmitting}
                  className="px-5 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 hover:brightness-110 text-xs font-bold text-slate-950 flex items-center gap-2 transition disabled:opacity-40 cursor-pointer shadow-lg shadow-cyan-500/20"
                >
                  <Send size={14} />
                  <span>Send</span>
                </button>
              </div>
            </div>
          ) : (
            // VOICE MODE - GEMINI LIVE REALTIME WEBSOCKET
            <div className="flex-1 flex flex-col items-center justify-between p-6 text-center relative overflow-y-auto">
              {/* SABIT Male Voice Selector Bar */}
              <div className="w-full max-w-xl bg-slate-900/90 border border-cyan-500/30 rounded-2xl p-3 mb-4 backdrop-blur-md">
                <div className="flex items-center justify-between mb-2 px-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-400 uppercase tracking-wider">
                    <Settings2 size={14} />
                    <span>SABIT VOICES</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {SABIT_MALE_VOICES.map((v) => {
                    const isSelected = sabitVoice === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() => {
                          setSabitVoice(v.id);
                          if (liveState !== 'disconnected') {
                            stopLiveVoiceSession();
                          }
                        }}
                        className={`px-2.5 py-2 rounded-xl text-left transition flex flex-col gap-0.5 cursor-pointer border ${
                          isSelected
                            ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-md shadow-cyan-500/20'
                            : 'bg-slate-950/60 border-white/10 text-slate-400 hover:border-slate-600 hover:text-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-1 text-xs font-bold truncate">
                          <span>{v.icon}</span>
                          <span className="truncate">{v.name}</span>
                        </div>
                        <span className="text-[9px] opacity-70 truncate">{v.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Center Assistant Avatar Image & Visualizer */}
              <div className="relative my-4 flex flex-col items-center">
                {/* Glowing Wave/Pulse Rings */}
                {(liveState === 'listening' || liveState === 'speaking') && (
                  <>
                    <motion.div
                      animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0.1, 0.6] }}
                      transition={{ duration: 1.8, repeat: Infinity }}
                      className="absolute -inset-4 rounded-full border-2 border-cyan-400/60 pointer-events-none"
                    />
                    <motion.div
                      animate={{ scale: [1, 1.7, 1], opacity: [0.4, 0.05, 0.4] }}
                      transition={{ duration: 1.8, delay: 0.4, repeat: Infinity }}
                      className="absolute -inset-8 rounded-full border border-indigo-400/40 pointer-events-none"
                    />
                  </>
                )}

                <div className="relative w-36 h-36 rounded-full border-4 border-cyan-500/50 p-1 shadow-[0_0_60px_rgba(6,182,212,0.4)] bg-slate-900 overflow-hidden">
                  <img
                    src="assets/assistantimg.jpg"
                    alt="SABIT Avatar"
                    className="w-full h-full object-cover rounded-full"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                  <div className="w-full h-full rounded-full bg-gradient-to-tr from-cyan-600 to-indigo-700 flex items-center justify-center text-white">
                    <Bot size={56} />
                  </div>
                </div>

                {/* Status Indicator Badge */}
                <div className="mt-4 px-3 py-1 rounded-full bg-slate-900/90 border border-cyan-500/40 text-xs font-mono text-cyan-300 flex items-center gap-2 shadow-lg">
                  <span className={`w-2 h-2 rounded-full ${
                    liveState === 'speaking' ? 'bg-indigo-400 animate-ping' :
                    liveState === 'listening' ? 'bg-emerald-400 animate-pulse' :
                    liveState === 'connecting' ? 'bg-amber-400 animate-spin' : 'bg-slate-500'
                  }`} />
                  <span className="uppercase tracking-wider font-bold">
                    {liveState === 'speaking' ? 'SABIT Speaking...' :
                     liveState === 'listening' ? 'LISTENING... SPEAK ANY LANGUAGE' :
                     liveState === 'connecting' ? 'Connecting SABIT Live...' : 'Ready for Voice Call'}
                  </span>
                </div>
              </div>

              {/* Realtime Live Transcript */}
              {voiceTranscript && (
                <div className="mb-4 px-4 py-2 rounded-xl bg-slate-900/90 border border-cyan-500/30 text-xs font-mono text-cyan-300 max-w-lg truncate shadow-inner">
                  "{voiceTranscript}"
                </div>
              )}

              {/* Call Control Button */}
              <div className="flex flex-col items-center gap-2 mb-2">
                <button
                  onClick={toggleLiveVoiceSession}
                  className={`w-20 h-20 rounded-full flex items-center justify-center transition-all cursor-pointer shadow-2xl ${
                    liveState !== 'disconnected'
                      ? 'bg-rose-500 text-white shadow-rose-500/40 animate-pulse scale-110'
                      : 'bg-gradient-to-tr from-cyan-500 via-sky-500 to-indigo-600 text-slate-950 shadow-cyan-500/40 hover:scale-105'
                  }`}
                >
                  {liveState !== 'disconnected' ? <MicOff size={32} /> : <Mic size={32} />}
                </button>
                <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                  {liveState !== 'disconnected' ? 'Tap to Disconnect Call' : 'TAP TO SPEAK SABIT'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* API KEY MODAL OVERLAY */}
        <AnimatePresence>
          {showApiKeyModal && (
            <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="w-full max-w-md p-6 rounded-2xl bg-slate-900 border border-cyan-500/40 shadow-2xl text-left"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 text-cyan-400 font-bold text-base">
                    <Key size={18} />
                    <span>SABIT Gemini API Key</span>
                  </div>
                  <button
                    onClick={() => setShowApiKeyModal(false)}
                    className="p-1 rounded-lg text-slate-400 hover:text-white"
                  >
                    <X size={16} />
                  </button>
                </div>

                <p className="text-xs text-slate-300 mb-4 leading-relaxed">
                  Provide a dedicated Gemini API key for SABIT background processing. If left empty or not provided, SABIT will fallback to using Myraa's primary Gemini key.
                </p>

                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-3 py-2.5 rounded-xl bg-black border border-white/20 focus:border-cyan-500 text-xs text-white mb-3"
                />

                {apiKeyError && (
                  <p className="text-[11px] text-rose-400 mb-3">{apiKeyError}</p>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowApiKeyModal(false)}
                    className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-semibold text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveApiKey}
                    disabled={apiKeySaving || !apiKeyInput.trim()}
                    className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-xs font-bold text-black disabled:opacity-40"
                  >
                    {apiKeySaving ? 'Validating...' : 'Save SABIT Key'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
