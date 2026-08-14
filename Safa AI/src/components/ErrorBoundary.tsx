import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error inside ErrorBoundary:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] p-6 rounded-2xl border border-rose-500/20 bg-rose-500/5 text-rose-300 font-mono space-y-4 max-w-lg mx-auto mt-8">
          <div className="flex items-center gap-2 text-rose-400 font-bold">
            <span className="text-lg">⚠️ UI RENDER ERROR BOUNDARY MATCHED</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed text-center">
            A visual rendering component failed to draw. To protect active WebSocket threads and running agent sessions, the interface was isolated safely.
          </p>
          <div className="w-full bg-black/40 p-3 rounded-lg border border-white/5 text-[10px] text-slate-400 overflow-x-auto select-text">
            {this.state.error?.message || "Unknown rendering exception"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 rounded-xl bg-rose-500 text-white hover:bg-rose-600 transition text-xs font-semibold cursor-pointer"
          >
            Reset UI State & Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
