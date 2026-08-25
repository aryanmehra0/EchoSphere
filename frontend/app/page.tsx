import GraphVisualizer from '@/components/GraphVisualizer';
import VoiceRoom from '@/components/VoiceRoom';
import { Activity, LayoutDashboard, ShieldAlert } from 'lucide-react';

export default function Home() {
  return (
    <main className="flex h-screen w-full flex-col bg-zinc-950 text-zinc-50 overflow-hidden">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-6 glass-panel z-10">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-lg shadow-indigo-600/20">
            <ShieldAlert size={18} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Echo<span className="text-zinc-400 font-medium">Sphere Incident Commander</span></h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 rounded-full bg-zinc-800/80 px-3 py-1.5 text-sm font-medium border border-zinc-700/50">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            System Active
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left Sidebar - Voice & Transcripts */}
        <div className="w-96 flex-col border-r border-zinc-800 bg-zinc-900/30 flex z-10">
          <div className="p-4 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
              <Activity size={14} /> Live Voice Bridge
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
             <VoiceRoom />
          </div>
        </div>

        {/* Center - Graph Visualization */}
        <div className="flex-1 relative bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-900 via-zinc-950 to-zinc-950">
          <GraphVisualizer />
        </div>
        
        {/* Right Sidebar - Action Items & Timeline */}
        <div className="w-80 flex-col border-l border-zinc-800 bg-zinc-900/30 flex z-10">
          <div className="p-4 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
              <LayoutDashboard size={14} /> Tasks & Timeline
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="text-zinc-500 text-sm italic text-center mt-10">
              Awaiting incident data...
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
