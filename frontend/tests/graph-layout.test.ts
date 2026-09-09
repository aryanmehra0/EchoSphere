import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeGraphLayout } from "../src/lib/graph-layout.ts";
import type { IncidentEntity, IncidentLink } from "../src/lib/types.ts";

describe("Deterministic Topological Tiered Layout", () => {
  const makeEntity = (id: string, kind: IncidentEntity["kind"], position?: { x: number; y: number }): IncidentEntity => ({
    id,
    kind,
    label: id,
    status: "OK",
    position,
  });

  test("returns empty map when no entities provided", () => {
    const layout = computeGraphLayout([]);
    assert.equal(layout.size, 0);
  });

  test("assigns architectural tiers monotonically (client -> gateway -> network -> service -> datastore)", () => {
    const entities: IncidentEntity[] = [
      makeEntity("store-db", "datastore"),
      makeEntity("api-gw", "gateway"),
      makeEntity("web-client", "client"),
      makeEntity("vpc-net", "network"),
      makeEntity("auth-svc", "service"),
    ];

    const layout = computeGraphLayout(entities);

    const clientPos = layout.get("web-client")!;
    const gwPos = layout.get("api-gw")!;
    const netPos = layout.get("vpc-net")!;
    const svcPos = layout.get("auth-svc")!;
    const dbPos = layout.get("store-db")!;

    assert.ok(clientPos.x < gwPos.x, "client should be left of gateway");
    assert.ok(gwPos.x < netPos.x, "gateway should be left of network");
    assert.ok(netPos.x < svcPos.x, "network should be left of service");
    assert.ok(svcPos.x < dbPos.x, "service should be left of datastore");
  });

  test("refines tiers topologically when directional links exist", () => {
    // Two services initially at tier 3.
    // If auth-svc calls payment-svc, payment-svc must be shifted downstream.
    const entities: IncidentEntity[] = [
      makeEntity("auth-svc", "service"),
      makeEntity("payment-svc", "service"),
    ];
    const links: IncidentLink[] = [
      { id: "l1", source: "auth-svc", target: "payment-svc", label: "calls", kind: "depends" },
    ];

    const layout = computeGraphLayout(entities, links);
    const authPos = layout.get("auth-svc")!;
    const payPos = layout.get("payment-svc")!;

    assert.ok(
      authPos.x < payPos.x,
      `caller auth-svc (x=${authPos.x}) should be placed upstream of target payment-svc (x=${payPos.x})`,
    );
  });

  test("spaces nodes within the same tier vertically without collision", () => {
    const entities: IncidentEntity[] = [
      makeEntity("auth-svc", "service"),
      makeEntity("order-svc", "service"),
      makeEntity("billing-svc", "service"),
    ];

    const layout = computeGraphLayout(entities);
    const yCoordinates = entities.map((e) => layout.get(e.id)!.y);

    // All should share same x tier column
    const xCoordinates = entities.map((e) => layout.get(e.id)!.x);
    assert.equal(new Set(xCoordinates).size, 1);

    // All y coordinates should be distinct and spaced by 140px
    assert.equal(new Set(yCoordinates).size, 3);
    const sortedY = [...yCoordinates].sort((a, b) => a - b);
    assert.equal(sortedY[1] - sortedY[0], 140);
    assert.equal(sortedY[2] - sortedY[1], 140);
  });

  test("manual user drag coordinates take highest precedence", () => {
    const entities: IncidentEntity[] = [
      makeEntity("web-client", "client", { x: 50, y: 50 }),
    ];
    const manualPositions = {
      "web-client": { x: 777, y: 888 },
    };

    const layout = computeGraphLayout(entities, [], manualPositions);
    assert.deepEqual(layout.get("web-client"), { x: 777, y: 888 });
  });

  test("persisted entity.position fallback takes precedence over auto-layout when no manual drag exists", () => {
    const entities: IncidentEntity[] = [
      makeEntity("web-client", "client", { x: 123, y: 456 }),
    ];

    const layout = computeGraphLayout(entities, []);
    assert.deepEqual(layout.get("web-client"), { x: 123, y: 456 });
  });
});
