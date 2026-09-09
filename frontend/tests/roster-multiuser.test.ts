import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  allocateHumanUid,
  getRoster,
  isAuthorizedRole,
  putEntry,
  __resetRoster,
} from "../src/lib/server/roster.ts";
import { getSessionUser } from "../src/lib/server/auth.ts";
import { DEV_PERSONAS, findPersonaById } from "../src/lib/auth-personas.ts";
import type { ParticipantRole } from "../src/lib/types.ts";

const FUTURE = Date.now() + 3_600_000;

beforeEach(() => __resetRoster());

describe("Enterprise Identity & Multi-User Roster (AuthN / AuthZ)", () => {
  test("two users can join as DevOps Lead simultaneously without conflict", async () => {
    // User 1: Alice Chen (DevOps Lead)
    const uidAlice = allocateHumanUid("inc-4417");
    await putEntry({
      channel: "inc-4417",
      uid: uidAlice,
      role: "DevOps Lead",
      kind: "human",
      authorized: true,
      issuedAt: Date.now(),
      expiresAt: FUTURE,
      userId: "usr_alice",
      name: "Alice Chen",
      permissions: ["APPROVE_CRITICAL_ACTIONS", "SPEAK_ON_BRIDGE", "MINT_TIMELINE_DECISIONS"],
    });

    // User 2: Bob Smith (DevOps Lead) — would previously fail with 409 Conflict
    const uidBob = allocateHumanUid("inc-4417");
    await putEntry({
      channel: "inc-4417",
      uid: uidBob,
      role: "DevOps Lead",
      kind: "human",
      authorized: true,
      issuedAt: Date.now(),
      expiresAt: FUTURE,
      userId: "usr_bob",
      name: "Bob Smith",
      permissions: ["APPROVE_CRITICAL_ACTIONS", "SPEAK_ON_BRIDGE", "MINT_TIMELINE_DECISIONS"],
    });

    assert.notEqual(uidAlice, uidBob, "Each engineer must receive a distinct Agora UID");
    assert.ok(uidAlice >= 1000 && uidBob >= 1000);

    const roster = await getRoster("inc-4417");
    const devopsUsers = roster.filter((e) => e.role === "DevOps Lead");
    assert.equal(devopsUsers.length, 2, "Both DevOps engineers must coexist on the roster");

    const aliceEntry = devopsUsers.find((e) => e.userId === "usr_alice");
    const bobEntry = devopsUsers.find((e) => e.userId === "usr_bob");
    assert.ok(aliceEntry && bobEntry);
    assert.equal(aliceEntry.name, "Alice Chen");
    assert.equal(bobEntry.name, "Bob Smith");
    assert.equal(aliceEntry.authorized, true);
    assert.equal(bobEntry.authorized, true);
  });

  test("Incident Commander is an authorized operational role", () => {
    assert.equal(isAuthorizedRole("Incident Commander"), true);
    assert.equal(isAuthorizedRole("DevOps Lead"), true);
    assert.equal(isAuthorizedRole("Site Reliability Engineer"), false);
    assert.equal(isAuthorizedRole("Database Admin"), false);
    assert.equal(isAuthorizedRole("Observer"), false);
  });

  test("extended roles can populate the roster with distinct permissions", async () => {
    const rolesToTest: Array<{ role: ParticipantRole; userId: string; name: string; auth: boolean }> = [
      { role: "Incident Commander", userId: "usr_alice", name: "Alice Chen", auth: true },
      { role: "Site Reliability Engineer", userId: "usr_carol", name: "Carol Danvers", auth: false },
      { role: "Database Admin", userId: "usr_david", name: "David Park", auth: false },
      { role: "Observer", userId: "usr_elena", name: "Elena Rostova", auth: false },
    ];

    for (const item of rolesToTest) {
      const uid = allocateHumanUid("inc-enterprise");
      await putEntry({
        channel: "inc-enterprise",
        uid,
        role: item.role,
        kind: item.role === "Observer" ? "observer" : "human",
        authorized: isAuthorizedRole(item.role),
        issuedAt: Date.now(),
        expiresAt: FUTURE,
        userId: item.userId,
        name: item.name,
      });
    }

    const roster = await getRoster("inc-enterprise");
    assert.equal(roster.length, 4);

    const ic = roster.find((e) => e.role === "Incident Commander");
    assert.ok(ic);
    assert.equal(ic.authorized, true);

    const sre = roster.find((e) => e.role === "Site Reliability Engineer");
    assert.ok(sre);
    assert.equal(sre.authorized, false);
  });

  test("session user resolution parses header, cookie, and fallback", async () => {
    // 1. Header parsing
    const headerReq = new Request("http://localhost/api/token", {
      headers: { "x-echo-user-id": "usr_bob" },
    });
    const headerUser = await getSessionUser(headerReq);
    assert.equal(headerUser.id, "usr_bob");
    assert.equal(headerUser.name, "Bob Smith");
    assert.equal(headerUser.defaultRole, "DevOps Lead");

    // 2. Cookie parsing
    const cookieReq = new Request("http://localhost/api/token", {
      headers: { cookie: "other=123; echo_user_id=usr_carol; foo=bar" },
    });
    const cookieUser = await getSessionUser(cookieReq);
    assert.equal(cookieUser.id, "usr_carol");
    assert.equal(cookieUser.name, "Carol Danvers");
    assert.equal(cookieUser.defaultRole, "Site Reliability Engineer");

    // 3. Fallback when no header or cookie is present
    const emptyReq = new Request("http://localhost/api/token");
    const fallbackUser = await getSessionUser(emptyReq);
    assert.equal(fallbackUser.id, "usr_alice");
    assert.equal(fallbackUser.name, "Alice Chen");
  });

  test("persona switcher dictionary provides all core roles", () => {
    assert.equal(DEV_PERSONAS.length, 5);
    const alice = findPersonaById("usr_alice");
    assert.ok(alice);
    assert.equal(alice.defaultRole, "Incident Commander");
    assert.ok(alice.permissions.includes("APPROVE_CRITICAL_ACTIONS"));

    const bob = findPersonaById("usr_bob");
    assert.ok(bob);
    assert.equal(bob.defaultRole, "DevOps Lead");
    assert.ok(bob.permissions.includes("APPROVE_CRITICAL_ACTIONS"));

    const elena = findPersonaById("usr_elena");
    assert.ok(elena);
    assert.equal(elena.defaultRole, "Observer");
    assert.equal(elena.permissions.length, 0);
  });
});
