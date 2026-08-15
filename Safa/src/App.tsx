import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Settings as SettingsIcon,
  Brain,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Cpu,
  Heart,
} from 'lucide-react';
import {
  MyraaCoreVisualizer,
  type MyraaEmotion,
} from './components/MyraaCoreVisualizer';
import { ChatPanel, type ChatMessage } from './components/ChatPanel';
import { StonicSidebar } from './components/StonicSidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { MemoryDashboard } from './components/MemoryDashboard';
import { SabitPanel } from './components/SabitPanel';
import { SoulModal } from './components/SoulModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MyraaAudioSession, type LiveState } from './lib/audio';
import {
  loadSettings,
  saveSettings,
  type MyraaSettings,
} from './lib/settingsStore';
import type { Memory, MemoryCategory } from './lib/memoryTypes';

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

function App() {
  const [runningTask, setRunningTask] = useState<string | null>(null);
  // ── Settings & persistence ──────────────────────────────────────────────
  const [settings, setSettings] = useState<MyraaSettings>(loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showChat, setShowChat] = useState(false); // toggleable chat
  const [showSoul, setShowSoul] = useState(false);

  const handleSettingsChange = useCallback((patch: Partial<MyraaSettings>) => {
    setSettings(prev => saveSettings({ ...prev, ...patch }));
  }, []);

  // ── Audio session & live state ──────────────────────────────────────────
  const audioRef = useRef<MyraaAudioSession | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('disconnected');
  const [emotion, setEmotion] = useState<MyraaEmotion>('idle');
  const [error, setError] = useState<string | null>(null);

  // ── Chat ─────────────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // Whether a model response is currently streaming in (drives the typing UI).
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  // Tracks the id of the model bubble currently receiving streamed chunks so
  // consecutive transcription chunks accumulate into ONE bubble (the model's
  // response arrives in pieces over the WS bridge). Resets on turn-complete.
  const streamingBubbleIdRef = useRef<string | null>(null);

  const [sessionId, setSessionId] = useState<string>(() => {
    try {
      const key = "maira_session_id";
      let existingSid = localStorage.getItem(key);
      if (!existingSid) {
        existingSid = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        localStorage.setItem(key, existingSid);
      }
      return existingSid;
    } catch (e) {
      return `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    }
  });

  const [sessionTitle, setSessionTitle] = useState<string>("Chat 1");

  const loadSessionMessages = useCallback((sid: string) => {
    fetch(`/api/sessions/${sid}/messages`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setChatMessages(data.map((m: any) => ({
            id: m.id || Math.random().toString(36).slice(2),
            role: m.role || "model",
            text: m.content || "",
            messageType: m.message_type,
            thinkingSummary: m.thinking_summary,
            timestamp: m.timestamp || new Date().toISOString()
          })));
        } else {
          setChatMessages([]);
        }
      })
      .catch(() => {
        setChatMessages([]);
      });
  }, []);

  // ── Memories ─────────────────────────────────────────────────────────────
  const [memories, setMemories] = useState<Memory[]>([]);

  // ── Screen Share ─────────────────────────────────────────────────────────
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── Sabit states ─────────────────────────────────────────────────────────
  const [sabitOpen, setSabitOpen] = useState(false);
  const [sabitTask, setSabitTask] = useState<string | null>(null);
  const [sabitAssistantName, setSabitAssistantName] = useState("Sabit");
  const [sabitVoiceTone, setSabitVoiceTone] = useState("Cool and Collected");
  const [sabitState, setSabitState] = useState<LiveState>('disconnected');
  const [sabitHasError, setSabitHasError] = useState(false);
  const [sabitManuallyDisconnected, setSabitManuallyDisconnected] = useState(false);
  const [sabitIsThinking, setSabitIsThinking] = useState(false);
  const [sabitRunningTask, setSabitRunningTask] = useState<string | null>(null);
  const [sabitTranscription, setSabitTranscription] = useState<{ role: "user" | "model"; text: string }[]>([]);
  const [sabitIsMuted, setSabitIsMuted] = useState(true);
  const sabitAudioRef = useRef<MyraaAudioSession | null>(null);

  const connectSabit = useCallback(() => {
    if (sabitAudioRef.current) return;
    setSabitIsMuted(true);
    setSabitHasError(false);
    const session = new MyraaAudioSession({
      endpoint: "/sabit-live",
      defaultMuted: true,
      onStateChange: s => setSabitState(s),
      onTranscription: (role, text) => {
        setSabitTranscription(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === role) {
            return [
              ...prev.slice(0, -1),
              { role, text: last.text + text }
            ];
          }
          return [
            ...prev,
            { role, text }
          ];
        });
      },
      onToolCall: (name, args, cb) => {
        cb({ result: "ok" });
      },
      onError: e => {
        console.error("[Sabit error]:", e);
        setSabitHasError(true);
      },
    });

    session.onBrowserAutomationEvent = event => {
      if (event.status === 'started') {
        setSabitIsThinking(true);
        setSabitRunningTask(event.name);
      }
      // Note: Do NOT clear isThinking or runningTask on individual browser automation event completion.
      // Active task state machine in onSabitTaskStatus governs task completion/failure.
    };

    session.onSabitTaskStatus = event => {
      console.log("[Sabit Session Task Status]", event);
      if (event.task) {
        setSabitTask(event.task && typeof event.task === 'object' ? event.task.taskGoal : (event.task || null));
        const status = event.task.status;
        if (status === "acquiring" || status === "running" || status === "waiting_for_user" || status === "recovering") {
          setSabitIsThinking(true);
          setSabitRunningTask(event.task.taskGoal);
        } else {
          setSabitIsThinking(false);
          setSabitRunningTask(null);
        }
      }
    };

    sabitAudioRef.current = session;
    session.connect({
      voiceTone: sabitVoiceTone,
      assistantName: sabitAssistantName,
      fileSystemAccess: settings.fileSystemAccess,
      screenShareAccess: settings.screenShareAccess,
      microphoneAccess: settings.microphoneAccess,
      cameraAccess: settings.cameraAccess,
      systemCommandsAccess: settings.systemCommandsAccess,
    });
  }, [settings, sabitVoiceTone, sabitAssistantName]);

  const disconnectSabit = useCallback(() => {
    sabitAudioRef.current?.disconnect();
    sabitAudioRef.current = null;
    setSabitState('disconnected');
    setSabitIsThinking(false);
    setSabitRunningTask(null);
    setSabitIsMuted(true);
  }, []);

  const handleConnectSabitManual = useCallback(() => {
    setSabitManuallyDisconnected(false);
    setSabitHasError(false);
    fetch("/api/sabit-manual-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disconnected: false }),
    }).catch(() => {});
    connectSabit();
  }, [connectSabit]);

  const handleDisconnectSabitManual = useCallback(() => {
    setSabitManuallyDisconnected(true);
    setSabitHasError(false);
    fetch("/api/sabit-manual-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disconnected: true }),
    }).catch(() => {});
    disconnectSabit();
  }, [disconnectSabit]);

  const handleToggleSabitMute = () => {
    if (sabitAudioRef.current) {
      const isMutedNow = sabitAudioRef.current.toggleMute();
      setSabitIsMuted(isMutedNow);
    }
  };

  const handleSendSabitChat = (text: string) => {
    const t = text.trim();
    if (!t) return;
    sabitAudioRef.current?.sendTextMessage(t);
  };

  const handleCancelSabitTask = () => {
    sabitAudioRef.current?.cancelActiveTask();
    setSabitTask(null);
    setSabitOpen(false);
  };

  // Synchronize Sabit's connection state with Maira's connection state (auto-sync)
  useEffect(() => {
    if (liveState !== 'disconnected') {
      if (!sabitManuallyDisconnected) {
        connectSabit();
      }
    } else {
      disconnectSabit();
      setSabitManuallyDisconnected(false); // Reset override on Maira disconnect
    }
  }, [liveState, connectSabit, disconnectSabit, sabitManuallyDisconnected]);

  useEffect(() => {
    return () => {
      sabitAudioRef.current?.disconnect();
    };
  }, []);

  // Load memories & transcript history on mount
  useEffect(() => {
    fetch('/api/memories')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setMemories(data);
      })
      .catch(() => {});

    // Ensure session is created in the DB and load its messages
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    })
      .then(() => {
        loadSessionMessages(sessionId);
      })
      .catch(() => {
        loadSessionMessages(sessionId);
      });

    // Load the session title (e.g. "Chat 1") from the sessions list
    fetch('/api/sessions')
      .then(r => r.json())
      .then(list => {
        if (Array.isArray(list)) {
          const found = list.find((s: any) => s.id === sessionId);
          if (found && found.title) setSessionTitle(found.title);
        }
      })
      .catch(() => {});
  }, [sessionId, loadSessionMessages]);

  // Character state: talking while speaking, thinking during automation
  const [isThinking, setIsThinking] = useState(false);
  const characterState: 'idle' | 'thinking' | 'talking' =
    liveState === 'speaking' ? 'talking' : isThinking ? 'thinking' : 'idle';

  // ── Connect / disconnect audio session ─────────────────────────────────
  const connect = useCallback(() => {
    if (audioRef.current) return;
    const session = new MyraaAudioSession({
      onStateChange: s => setLiveState(s),
      onTranscription: (role, text, msgType) => {
        const resolvedType = msgType || (role === 'user' ? 'user_voice' : 'safa_voice');
        const nowIso = new Date().toISOString();

        // ── Chat sidebar (live voice transcription + text, merged) ──
        // USER: always starts a new entry. MODEL: accumulates into one streaming entry per turn.
        if (role === 'user') {
          streamingBubbleIdRef.current = null;
          setIsChatStreaming(true);
          setChatMessages(prev => [
            ...prev,
            {
              id: Math.random().toString(36).slice(2),
              role,
              text,
              messageType: resolvedType,
              timestamp: nowIso,
            },
          ]);
        } else {
          setIsChatStreaming(true);
          setChatMessages(prev => {
            const id = streamingBubbleIdRef.current;
            const lastMsg = prev.find(m => m.id === id);
            if (id && lastMsg && lastMsg.messageType === resolvedType) {
              return prev.map(m =>
                m.id === id ? { ...m, text: m.text + text } : m
              );
            }
            const newId = Math.random().toString(36).slice(2);
            streamingBubbleIdRef.current = newId;
            return [
              ...prev,
              {
                id: newId,
                role: 'model',
                text,
                messageType: resolvedType,
                timestamp: nowIso,
              },
            ];
          });
        }
        setShowChat(true);
      },
      onToolCall: (name, args, cb) => {
        cb({ result: 'ok' });
      },
      onError: e => setError(e),
      onMemorySync: mems => setMemories(mems),
      onEmotionChange: emo => setEmotion(emo as MyraaEmotion),
    });
    // Desktop automation events (tool start/complete/fail) are processed
    // silently: they drive the "thinking" character state, but we deliberately
    // do NOT surface any floating console / debug HUD to the user (P3). All
    // detail remains in the developer console only.
    session.onBrowserAutomationEvent = event => {
      if (event.status === 'started') {
        setIsThinking(true);
        setRunningTask(event.name);
      } else if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
        setIsThinking(false);
        setRunningTask(null);
      }
      // Dev-console trace only — never user-visible.
      console.debug('[Myraa automation]', event.name, event.status, event.result ?? event.error ?? '');
    };
    session.onSabitDelegated = event => {
      setSabitTask(event.task && typeof event.task === 'object' ? event.task.taskGoal : (event.task || null));
      setSabitAssistantName(event.sabitAssistantName || "Sabit");
      setSabitVoiceTone(event.sabitVoiceTone || "Cool and Collected");
      setSabitTranscription([]);
      setSabitOpen(true);
    };
    session.onSabitTaskStatus = event => {
      console.log("[Maira Session Task Status]", event);
      if (event.task) {
        setSabitTask(event.task && typeof event.task === 'object' ? event.task.taskGoal : (event.task || null));
      }
    };
    // When the model finishes a turn, stop the typing indicator so the last
    // bubble's streaming caret disappears.
    session.onTurnComplete = () => {
      setIsChatStreaming(false);
      streamingBubbleIdRef.current = null;
    };
    session.onSessionSwitch = (sid: string, msgs: any[]) => {
      try {
        localStorage.setItem('maira_session_id', sid);
      } catch (e) {}
      setSessionId(sid);
      if (Array.isArray(msgs) && msgs.length > 0) {
        setChatMessages(msgs.map((m: any) => ({
          id: m.id || Math.random().toString(36).slice(2),
          role: m.role || "model",
          text: m.content || "",
          messageType: m.message_type,
          thinkingSummary: m.thinking_summary,
          timestamp: m.timestamp || new Date().toISOString(),
        })));
      } else {
        loadSessionMessages(sid);
      }
      disconnect();
      setTimeout(() => {
        connect();
      }, 300);
    };
    audioRef.current = session;
    session.connect({
      voiceTone: settings.voiceTone,
      assistantName: settings.assistantName,
      fileSystemAccess: settings.fileSystemAccess,
      screenShareAccess: settings.screenShareAccess,
      microphoneAccess: settings.microphoneAccess,
      cameraAccess: settings.cameraAccess,
      systemCommandsAccess: settings.systemCommandsAccess,
    });
  }, [settings]);

  const disconnect = useCallback(() => {
    audioRef.current?.disconnect();
    audioRef.current = null;
    setLiveState('disconnected');
  }, []);

  useEffect(() => () => audioRef.current?.disconnect(), []);

  // ── Chat send (text input) ──────────────────────────────────────────────
  // We append the message locally first for instant, lag-free visual feedback
  // in the sidebar transcript. Then we push it to the live session WebSocket.
  const handleSendChat = async (text: string) => {
    const t = text.trim();
    if (!t) return;

    const userMessageId = Math.random().toString(36).slice(2);
    setChatMessages(prev => [
      ...prev,
      {
        id: userMessageId,
        role: "user",
        text: t,
        messageType: "user_text",
        timestamp: new Date().toISOString(),
      },
    ]);

    if (audioRef.current && isConnected) {
      audioRef.current.sendTextMessage(t);
    } else {
      console.log("[App] WebSocket offline, falling back to unified REST endpoint.");
      setIsChatStreaming(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: t, inputType: "text" })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.safaMessage) {
            setChatMessages(prev => [
              ...prev,
              {
                id: data.safaMessage.id,
                role: "model",
                text: data.safaMessage.content,
                messageType: "safa_text",
                timestamp: data.safaMessage.timestamp
              }
            ]);
          }
        } else {
          console.error("[App] Unified REST fallback failed:", res.statusText);
        }
      } catch (err) {
        console.error("[App] Error calling REST fallback:", err);
      } finally {
        setIsChatStreaming(false);
      }
    }
  };

  // ── Memory handlers ─────────────────────────────────────────────────────
  const handleAddMemory = async (category: MemoryCategory, text: string) => {
    const res = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, text }),
    });
    if (res.ok) {
      const newMem = await res.json();
      setMemories(prev => [...prev, newMem]);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: 'DELETE' });
    setMemories(prev => prev.filter(m => m.id !== id));
  };

  // ── Screen Share toggle ─────────────────────────────────────────────────
  // Captures the user's screen via getDisplayMedia, samples frames to a canvas,
  // encodes as JPEG base64, and pushes to the audio session so Mayra can "see".
  //
  // In Electron, getDisplayMedia requires the desktopCapturer permission
  // which is configured in main.cjs. As a fallback, we try using Electron's
  // desktopCapturer via IPC to pick a source first, then pass its id to
  // getDisplayMedia (the { desktopId } option) so the picker is bypassed.
  const toggleScreenShare = useCallback(async () => {
    // STOP path
    if (isSharingScreen) {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
        screenIntervalRef.current = null;
      }
      screenStreamRef.current?.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
      setIsSharingScreen(false);
      return;
    }

    // START path — requires an active audio session
    if (!audioRef.current) {
      setError('Connect to Safa first to share your screen.');
      return;
    }
    if (!settings.screenShareAccess) {
      setError('Screen sharing is disabled in Settings → Permissions.');
      return;
    }

    let stream: MediaStream | null = null;

    // Strategy 1: Use Electron desktopCapturer IPC to get source ID, then pass to getDisplayMedia
    // This avoids the picker dialog and is the most reliable Electron approach.
    try {
      const electronSources = await (window as any).myraaDesktop?.getSources?.({ types: ['screen'] });
      
      if (electronSources && electronSources.length > 0) {
        const screenSource = electronSources.find((s: any) =>
          s.name.toLowerCase().includes('screen') || s.name.toLowerCase().includes('display')
        ) || electronSources[0];
        
        // @ts-ignore — desktopId is Electron-specific extension to getDisplayMedia
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 1, desktopId: screenSource.id } as any,
          audio: false,
        });
      }
    } catch (e1: any) {
      console.warn('[ScreenShare] Electron desktopCapturer strategy failed:', e1?.message);
    }

    // Strategy 2: Direct getDisplayMedia (shows picker or uses setDisplayMediaRequestHandler)
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 1 } as any,
          audio: false,
        });
      } catch (e2: any) {
        console.warn('[ScreenShare] All getDisplayMedia strategies failed:', e2?.message);
        setError('Screen sharing is not supported. Try updating Electron or use Chrome.');
        return;
      }
    }

    try {
      screenStreamRef.current = stream;
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement('canvas');
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      // Sample a frame every ~1s and send to Gemini via the WS bridge.
      screenIntervalRef.current = setInterval(() => {
        if (!video.videoWidth) return;
        // Downscale to keep payload small (~640px wide)
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
        // strip the "data:image/jpeg;base64," prefix
        audioRef.current?.sendVideoFrame(dataUrl.split(',')[1]);
      }, 1000);

      // If the user stops sharing from the browser's native bar, clean up.
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
        screenIntervalRef.current = null;
        screenStreamRef.current = null;
        setIsSharingScreen(false);
      });

      setIsSharingScreen(true);
    } catch (e: any) {
      setError(e?.message || 'Could not start screen sharing.');
    }
  }, [isSharingScreen, settings.screenShareAccess]);

  const isConnected = liveState !== 'disconnected';
  const themeColor = 'charcoal';

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black text-white font-sans">
      {/* Fixed Background Image (original layout) */}
      <div className="absolute inset-0 z-0">
        <video
          src="assets/Background.mp4"
          autoPlay // ← camelCase
          loop
          muted
          playsInline // ← মোবাইলের জন্য যোগ করুন
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/80" />
      </div>

      {/* Floating Particles (original layout) */}
      <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
        {[...Array(30)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-blue-400/30 animate-float"
            style={{
              width: `${Math.random() * 8 + 4}px`,
              height: `${Math.random() * 8 + 4}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDuration: `${Math.random() * 15 + 10}s`,
              animationDelay: `${Math.random() * 5}s`,
            }}
          />
        ))}
      </div>

      {/* Top-right control buttons */}
      <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
        {/* Connect / Disconnect */}
        {!isConnected ? (
          <button
            onClick={connect}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 hover:brightness-110 text-xs font-semibold tracking-wide transition cursor-pointer"
          >
            <Mic size={14} />
            <span className="hidden sm:inline">Connect</span>
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-semibold transition cursor-pointer"
          >
            <MicOff size={14} />
            <span className="hidden sm:inline">Disconnect</span>
          </button>
        )}
        {/* Screen Share toggle */}
        <button
          onClick={toggleScreenShare}
          disabled={!isConnected}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
            isSharingScreen
              ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-200 animate-pulse'
              : 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white'
          }`}
          title={
            isSharingScreen
              ? 'Stop sharing screen'
              : 'Share your screen with Mayra'
          }
        >
          {isSharingScreen ? <MonitorOff size={14} /> : <Monitor size={14} />}
          <span className="hidden sm:inline">
            {isSharingScreen ? 'STOP SHARE' : 'SHARE'}
          </span>
        </button>
        {/* Memory */}
        <button
          onClick={() => setShowMemory(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-mono tracking-wider text-slate-300 hover:text-white transition cursor-pointer"
          title="Memory Core"
        >
          <Brain size={14} />
          <span className="hidden sm:inline">MEMORY</span>
        </button>
        {/* Chat toggle */}
        <button
          onClick={() => setShowChat(!showChat)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-mono tracking-wider transition cursor-pointer ${
            showChat
              ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-300'
              : 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white'
          }`}
          title="Chat"
        >
          <MessageSquare size={14} />
          <span className="hidden sm:inline">CHAT</span>
        </button>

        {/* SOUL Popup Button */}
        <button
          onClick={() => setShowSoul(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-pink-500/30 bg-pink-500/10 hover:bg-pink-500/20 text-pink-300 hover:text-white text-xs font-mono tracking-wider transition cursor-pointer"
          title="Safa SOUL Engine"
        >
          <Heart size={14} className="fill-pink-400 text-pink-400" />
          <span className="hidden sm:inline">SOUL</span>
        </button>

        {/* Assistant toggle */}
        <button
          onClick={() => setSabitOpen(!sabitOpen)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-mono tracking-wider transition cursor-pointer ${
            sabitOpen
              ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-300 ring-1 ring-cyan-400/50'
              : 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white'
          }`}
          title="Assistant"
        >
          <Cpu size={14} className={sabitIsThinking ? "animate-spin [animation-duration:3s]" : ""} />
          <span className="hidden sm:inline">ASSISTANT</span>
        </button>
        {/* Settings */}
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition cursor-pointer"
          title="Settings"
        >
          <SettingsIcon size={16} />
        </button>
      </div>

      {/* Connection status badge (top-left) */}
      <div className="absolute top-4 left-4 z-30 flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`}
        />
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-400">
          {liveState}
        </span>
        {error && (
          <span
            className="text-[9px] font-mono text-rose-400 ml-2 max-w-[200px] truncate"
            title={error}
          >
            ⚠ {error}
          </span>
        )}
      </div>

      {/* Active Task Floating Pill */}
      <AnimatePresence>
        {runningTask && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-full border border-red-500/30 bg-black/60 backdrop-blur-md shadow-[0_0_20px_rgba(239,68,68,0.2)] text-xs font-medium text-white select-none"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
            </span>
            <span className="text-slate-300">Myraa is:</span>
            <span className="font-semibold text-rose-400">
              {TASK_DISPLAY_NAMES[runningTask] || runningTask}
            </span>
            <button
              onClick={() => audioRef.current?.cancelActiveTask()}
              className="ml-2 flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-red-500/20 hover:bg-red-500 hover:text-white border border-red-500/30 hover:border-transparent text-red-400 transition-all cursor-pointer text-[10px] uppercase font-bold tracking-wider"
            >
              Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main split-view or centered layout */}
      <div className="relative z-20 flex w-full h-full pt-16 pb-4">
        {/* Left/Center side: Holographic Character Visualizer */}
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="max-w-3xl w-full flex justify-center drop-shadow-2xl"
          >
            <div
              className="relative w-full max-w-2xl aspect-video rounded-[2rem] border-2 border-white/10 overflow-hidden shadow-[0_0_60px_-10px_rgba(99,102,241,0.4)] bg-gradient-to-b from-indigo-950/30 to-black/40 backdrop-blur-sm"
              style={{ boxShadow: "0 0 80px -20px rgba(99,102,241,0.5), inset 0 0 40px rgba(0,0,0,0.3)" }}
            >
              <MyraaCoreVisualizer
                state={liveState}
                themeColor={themeColor}
                activeEmotion={emotion}
                characterState={characterState}
              />
            </div>
          </motion.div>
        </div>

        {/* Right side: Stonic Chat Sidebar with Clock and Plus buttons */}
        <AnimatePresence>
          {showChat && (
            <motion.div
              initial={{ x: 400, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 400, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 180 }}
              className="h-full z-30"
            >
              <StonicSidebar
                messages={chatMessages}
                assistantName={settings.assistantName || 'Mayra'}
                isStreaming={isChatStreaming}
                onSend={handleSendChat}
                onClose={() => setShowChat(false)}
                sessionId={sessionId}
                sessionTitle={sessionTitle}
                onRenameSession={(newTitle: string) => {
                  const t = newTitle.trim();
                  if (!t) return;
                  setSessionTitle(t);
                  fetch(`/api/sessions/${sessionId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: t })
                  }).catch(() => {});
                }}
                onSwitchSession={(sid) => {
                  try {
                    localStorage.setItem('maira_session_id', sid);
                  } catch (e) {}
                  setSessionId(sid);
                  loadSessionMessages(sid);
                  if (audioRef.current) {
                    disconnect();
                    setTimeout(() => {
                      connect();
                    }, 300);
                  }
                }}
                onNewSession={() => {
                  const newSid = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                  try {
                    localStorage.setItem('maira_session_id', newSid);
                  } catch (e) {}
                  setSessionId(newSid);
                  setChatMessages([]);
                  fetch('/api/sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: newSid })
                  }).catch(() => {});
                  if (audioRef.current) {
                    disconnect();
                    setTimeout(() => {
                      connect();
                    }, 300);
                  }
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Overlays ── */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onChange={handleSettingsChange}
        themeColor={themeColor}
      />

      <MemoryDashboard
        isOpen={showMemory}
        onClose={() => setShowMemory(false)}
        memories={memories}
        onAddMemory={handleAddMemory}
        onDeleteMemory={handleDeleteMemory}
        themeColor={themeColor}
      />

      <SoulModal
        isOpen={showSoul}
        onClose={() => setShowSoul(false)}
      />

      {/* Sabit Concurrency Assistant HUD */}
      <ErrorBoundary>
        <SabitPanel
          isOpen={sabitOpen}
          onClose={() => setSabitOpen(false)}
          task={sabitTask}
          assistantName={sabitAssistantName}
          voiceTone={sabitVoiceTone}
          state={sabitHasError ? 'error' : sabitState}
          isThinking={sabitIsThinking}
          runningTask={sabitRunningTask}
          transcription={sabitTranscription}
          onSend={handleSendSabitChat}
          onCancel={handleCancelSabitTask}
          onConnect={handleConnectSabitManual}
          onDisconnect={handleDisconnectSabitManual}
          onClearLog={() => setSabitTranscription([])}
          isMuted={sabitIsMuted}
          onToggleMute={handleToggleSabitMute}
        />
      </ErrorBoundary>
    </div>
  );
}

export default App;
