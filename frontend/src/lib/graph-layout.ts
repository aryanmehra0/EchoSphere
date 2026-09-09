/**
 * Deterministic Topological Tiered Layout Engine.
 *
 * Replaces the naive 3-column modulo grid with an architecture-aware layout:
 *   Tier 0 (Entry):    client
 *   Tier 1 (Edge):     gateway, region
 *   Tier 2 (Network):  network
 *   Tier 3 (Compute):  service
 *   Tier 4 (Storage):  datastore
 *
 * When directional links are present (e.g. A depends on B), tiers are refined
 * topologically so upstream callers sit to the left/above downstream dependencies.
 * Nodes within each tier are centered and spaced with collision avoidance.
 */

import type { EntityKind, IncidentEntity, IncidentLink } from "./types";

export interface NodePosition {
  x: number;
  y: number;
}

const KIND_TIER: Record<EntityKind, number> = {
  client: 0,
  gateway: 1,
  region: 1,
  network: 2,
  service: 3,
  datastore: 4,
};

const X_TIER_SPACING = 280;
const Y_NODE_SPACING = 140;
const START_X = 60;
const START_Y = 60;

/**
 * Computes deterministic, collision-free (x, y) coordinates for graph entities.
 *
 * @param entities The array of incident entities to layout
 * @param links Directed connections between entities
 * @param manualPositions In-session user-dragged coordinates (takes highest precedence)
 * @returns Map of entity ID to { x, y } coordinates
 */
export function computeGraphLayout(
  entities: IncidentEntity[],
  links: IncidentLink[] = [],
  manualPositions: Record<string, NodePosition> = {},
): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  if (!entities.length) return positions;

  // 1. Assign baseline architectural tiers from entity kind
  const tiers = new Map<string, number>();

  for (const e of entities) {
    const defaultTier = KIND_TIER[e.kind] ?? 3;
    tiers.set(e.id, defaultTier);
  }

  // 2. Refine tiers using topological links: source -> target implies tier(target) >= tier(source)
  // Up to 3 relaxation passes to handle chains (e.g. client -> gateway -> service -> db)
  for (let pass = 0; pass < 3; pass++) {
    for (const link of links) {
      if (tiers.has(link.source) && tiers.has(link.target)) {
        const srcTier = tiers.get(link.source)!;
        const tgtTier = tiers.get(link.target)!;
        if (tgtTier <= srcTier) {
          tiers.set(link.target, srcTier + 1);
        }
      }
    }
  }

  // 3. Normalize tiers to contiguous 0..N-1 indices
  const uniqueTiers = Array.from(new Set(tiers.values())).sort((a, b) => a - b);
  const tierIndexMap = new Map(uniqueTiers.map((t, idx) => [t, idx]));

  // 4. Group entities by their normalized tier
  const tierGroups = new Map<number, IncidentEntity[]>();
  for (const e of entities) {
    const rawTier = tiers.get(e.id) ?? 0;
    const normalizedTier = tierIndexMap.get(rawTier) ?? 0;
    const group = tierGroups.get(normalizedTier) ?? [];
    group.push(e);
    tierGroups.set(normalizedTier, group);
  }

  // Find max nodes in any single tier to center shorter columns
  let maxNodesInTier = 1;
  for (const group of tierGroups.values()) {
    if (group.length > maxNodesInTier) maxNodesInTier = group.length;
  }
  const maxColumnHeight = (maxNodesInTier - 1) * Y_NODE_SPACING;

  // 5. Position nodes per tier column
  for (const [tierIdx, group] of tierGroups.entries()) {
    const x = START_X + tierIdx * X_TIER_SPACING;
    const groupHeight = (group.length - 1) * Y_NODE_SPACING;
    const yOffset = START_Y + Math.max(0, (maxColumnHeight - groupHeight) / 2);

    group.forEach((entity, nodeIdx) => {
      // Precedence: manual drag > server position > auto topological placement
      if (manualPositions[entity.id]) {
        positions.set(entity.id, manualPositions[entity.id]);
      } else if (entity.position) {
        positions.set(entity.id, entity.position);
      } else {
        const y = yOffset + nodeIdx * Y_NODE_SPACING;
        positions.set(entity.id, { x, y });
      }
    });
  }

  return positions;
}

