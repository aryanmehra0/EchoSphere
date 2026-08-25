'use client';

import { useCallback, useState } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node
} from '@xyflow/react';

const initialNodes: Node[] = [
  { id: '1', position: { x: 250, y: 150 }, data: { label: 'Incident Room Open' }, style: { background: '#18181b', color: '#fff', border: '1px solid #3f3f46', borderRadius: '8px', padding: '12px' } },
];
const initialEdges: Edge[] = [];

export default function GraphVisualizer() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
      >
        <Controls className="bg-zinc-800 text-white border-zinc-700" />
        <Background color="#3f3f46" gap={16} />
      </ReactFlow>
      
      {/* Overlay status */}
      <div className="absolute top-4 left-4 glass-panel px-4 py-2 rounded-lg text-sm font-medium z-10 text-zinc-300">
        Root Cause Graph (Live)
      </div>
    </div>
  );
}
