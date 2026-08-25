'use client';

import { useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, User } from 'lucide-react';

export default function VoiceRoom() {
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(false);
  
  // Fake transcript state for UI scaffolding
  const [transcripts] = useState([
    { id: 1, role: 'System', text: 'Waiting for participants...', final: true }
  ]);

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Controls */}
      <div className="glass-panel rounded-xl p-4 flex flex-col items-center gap-4">
        {!joined ? (
          <button 
            onClick={() => setJoined(true)}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-medium transition-colors flex justify-center items-center gap-2"
          >
            <Phone size={18} /> Join Incident Bridge
          </button>
        ) : (
          <div className="flex gap-2 w-full">
            <button 
              onClick={() => setMicOn(!micOn)}
              className={`flex-1 py-2.5 rounded-lg font-medium transition-colors flex justify-center items-center gap-2 ${micOn ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-red-900/50 text-red-400 hover:bg-red-900/70 border border-red-900/50'}`}
            >
              {micOn ? <Mic size={18} /> : <MicOff size={18} />}
              {micOn ? 'Mute' : 'Unmute'}
            </button>
            <button 
              onClick={() => { setJoined(false); setMicOn(false); }}
              className="px-4 py-2.5 bg-red-600 hover:bg-red-700 rounded-lg transition-colors flex justify-center items-center"
            >
              <PhoneOff size={18} />
            </button>
          </div>
        )}
      </div>

      {/* Visualizer Area */}
      <div className="glass-panel rounded-xl p-4 flex flex-col gap-3 min-h-32 justify-center items-center relative overflow-hidden">
        <div className="text-xs font-semibold text-zinc-500 uppercase absolute top-3 left-3">AI Agent Status</div>
        
        {joined ? (
          <div className="flex items-center gap-3 mt-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-indigo-900/50 border border-indigo-500/30">
              <span className="text-indigo-400 text-lg">E</span>
            </div>
            <div className="flex gap-1 h-6 items-end">
              <div className="w-1.5 bg-indigo-500 rounded-t h-2 animate-pulse"></div>
              <div className="w-1.5 bg-indigo-500 rounded-t h-4 animate-pulse delay-75"></div>
              <div className="w-1.5 bg-indigo-500 rounded-t h-3 animate-pulse delay-150"></div>
              <div className="w-1.5 bg-indigo-500 rounded-t h-5 animate-pulse delay-75"></div>
              <div className="w-1.5 bg-indigo-500 rounded-t h-2 animate-pulse"></div>
            </div>
            <span className="text-sm text-zinc-400 ml-2">Listening...</span>
          </div>
        ) : (
          <div className="text-zinc-600 text-sm">Agent Offline</div>
        )}
      </div>

      {/* RTM Transcripts */}
      <div className="glass-panel rounded-xl flex-1 flex flex-col overflow-hidden">
        <div className="bg-zinc-800/50 py-2 px-3 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase">
          Live Transcripts
        </div>
        <div className="flex-1 p-3 overflow-y-auto space-y-3">
          {transcripts.map((t) => (
            <div key={t.id} className="text-sm">
              <span className="font-semibold text-indigo-400 mr-2">[{t.role}]</span>
              <span className={t.final ? 'text-zinc-300' : 'text-zinc-500'}>{t.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
