const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-test-"));
const port = 20000 + Math.floor(Math.random() * 30000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let output = "";
let judgeToken;
let judgePassword;
let participants;

async function request(route, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server stopped unexpectedly: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output}`);
}

async function launchServer() {
  output = "";
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await waitUntilReady();
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
}

before(async () => {
  await launchServer();
  judgePassword = output.match(/Password giudice: (.+)/)?.[1];
  assert.ok(judgePassword, "server prints its initial judge password");
  const login = await request("/api/judge/login", { method: "POST", body: { password: judgePassword } });
  assert.equal(login.status, 200);
  judgeToken = login.body.token;
});

after(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("roles start unassigned and roster changes are judge-only", async () => {
  const unauthorized = await request("/api/judge/state");
  assert.equal(unauthorized.status, 401);
  const initial = await request("/api/judge/state", { token: judgeToken });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.participants.length, 0);
  assert.deepEqual(initial.body.counts, { sentinella: 0, sabotatore: 0, veggente: 0, malcapitato: 0 });

  for (let index = 0; index < 6; index += 1) {
    const response = await request("/api/judge/participants", {
      method: "POST",
      body: { name: `Partecipante ${index + 1}` },
      token: judgeToken,
    });
    assert.equal(response.status, 201);
  }
  participants = (await request("/api/judge/state", { token: judgeToken })).body.participants;
  assert.equal(participants.length, 6);
  assert.ok(participants.every((participant) => participant.role === null));
});

test("backend enforces the judge's variable roster and role composition", async () => {
  const invalidStart = await request("/api/judge/start", {
    method: "POST", body: { confirmed: true }, token: judgeToken,
  });
  assert.equal(invalidStart.status, 409);
  assert.equal(invalidStart.body.issues.some((issue) => issue.includes("Assegnazioni mancanti")), true);
  assert.equal(invalidStart.body.issues.some((issue) => issue.includes("Composizione ruoli")), true);
  const invalidComposition = await request("/api/judge/role-configuration", {
    method: "PUT",
    body: { targets: { sentinella: 2, sabotatore: 1, veggente: 1, malcapitato: 3 } },
    token: judgeToken,
  });
  assert.equal(invalidComposition.status, 200);
  const invalidQuantity = await request("/api/judge/role-configuration", {
    method: "PUT",
    body: { targets: { sentinella: -1, sabotatore: 1, veggente: 0, malcapitato: 6 } },
    token: judgeToken,
  });
  assert.equal(invalidQuantity.status, 400);
  const configuration = await request("/api/judge/role-configuration", {
    method: "PUT",
    body: { targets: { sentinella: 2, sabotatore: 1, veggente: 0, malcapitato: 3 } },
    token: judgeToken,
  });
  assert.equal(configuration.status, 200);
  const withinLimit = await request(`/api/judge/participants/${participants[0].id}`, {
    method: "PATCH", body: { role: "sentinella" }, token: judgeToken,
  });
  assert.equal(withinLimit.status, 200);
  const assignments = [
    [1, "sentinella"],
    [2, "sabotatore"],
    [3, "malcapitato"],
    [4, "malcapitato"],
    [5, "malcapitato"],
  ];
  for (const [participantIndex, role] of assignments) {
    const response = await request(`/api/judge/participants/${participants[participantIndex].id}`, {
      method: "PATCH", body: { role }, token: judgeToken,
    });
    assert.equal(response.status, 200);
  }
  const readyState = await request("/api/judge/state", { token: judgeToken });
  assert.equal(readyState.body.ready, true);
  assert.equal(readyState.body.participants.length, 6);
  assert.equal(readyState.body.limits.veggente, 0);
  assert.ok(readyState.body.participants.every((participant) => participant.role));
  assert.equal((await request("/api/judge/roles/sentinella", {
    method: "PATCH", body: { actions: "Azione segreta" }, token: judgeToken,
  })).status, 200);
  assert.equal((await request("/api/judge/settings", {
    method: "PUT", token: judgeToken,
    body: { turnCount: 3, turnDurationMinutes: 10, voteLimit: 2, winMetric: "score", rules: "Regola del test", winConditions: "Punteggio", deadlineFailure: false },
  })).status, 200);
  const overLimit = await request(`/api/judge/participants/${participants[4].id}`, {
    method: "PATCH", body: { role: "sentinella" }, token: judgeToken,
  });
  assert.equal(overLimit.status, 409);

  const playerCode = readyState.body.participants[0].accessCode;
  const playerLogin = await request("/api/player/login", { method: "POST", body: { code: playerCode } });
  assert.equal(playerLogin.status, 200);
  const playerBeforeStart = await request("/api/player/me", { token: playerLogin.body.token });
  assert.equal(playerBeforeStart.status, 409);

  const start = await request("/api/judge/start", {
    method: "POST", body: { confirmed: true }, token: judgeToken,
  });
  assert.equal(start.status, 200);
  assert.equal((await request("/api/judge/game-action", {
    method: "POST", token: judgeToken, body: { action: "pause" },
  })).status, 200);
  assert.equal((await request("/api/judge/state", { token: judgeToken })).body.game.status, "paused");
  assert.equal((await request("/api/judge/game-action", {
    method: "POST", token: judgeToken, body: { action: "resume" },
  })).status, 200);
  assert.equal((await request("/api/judge/game-action", {
    method: "POST", token: judgeToken, body: { action: "next-turn" },
  })).status, 200);
  const personalRole = await request("/api/player/me", { token: playerLogin.body.token });
  assert.equal(personalRole.status, 200);
  assert.equal(Object.keys(personalRole.body).sort().join(","), "name,role");
  assert.equal(personalRole.body.role, "Sentinella");
  const liveDashboard = await request("/api/player/dashboard", { token: playerLogin.body.token });
  assert.equal(liveDashboard.body.game.currentTurn, 2);
  assert.equal(liveDashboard.body.game.rules, "Regola del test");

  const blockedRosterChange = await request("/api/judge/participants", {
    method: "POST", body: { name: "Dopo inizio" }, token: judgeToken,
  });
  assert.equal(blockedRosterChange.status, 409);
  const missingReason = await request(`/api/judge/participants/${participants[0].id}`, {
    method: "PATCH", body: { role: "sabotatore" }, token: judgeToken,
  });
  assert.equal(missingReason.status, 400);
  const exceptionalChange = await request(`/api/judge/participants/${participants[0].id}`, {
    method: "PATCH", body: { role: null, reason: "Correzione richiesta dal giudice" }, token: judgeToken,
  });
  assert.equal(exceptionalChange.status, 200);
  const afterChange = await request("/api/judge/state", { token: judgeToken });
  assert.equal(afterChange.body.history[0].reason, "Correzione richiesta dal giudice");
  assert.equal(afterChange.body.history[0].new_role, null);
  const persistedRoles = afterChange.body.participants.map((participant) => participant.role);

  await stopServer();
  await launchServer();
  const relogin = await request("/api/judge/login", { method: "POST", body: { password: judgePassword } });
  assert.equal(relogin.status, 200);
  judgeToken = relogin.body.token;
  const restored = await request("/api/judge/state", { token: judgeToken });
  assert.equal(restored.body.started, true);
  assert.equal(restored.body.participants.length, 6);
  assert.deepEqual(restored.body.limits, { sentinella: 2, sabotatore: 1, veggente: 0, malcapitato: 3 });
  assert.deepEqual(restored.body.participants.map((participant) => participant.role), persistedRoles);
  assert.equal(restored.body.history[0].reason, "Correzione richiesta dal giudice");
});

test("missions, private communications, secret actions, votes and final reveal are protected and persistent", async () => {
  const state = await request("/api/judge/state", { token: judgeToken });
  const assigned = state.body.participants.find((participant) => participant.role);
  const other = state.body.participants.find((participant) => participant.id !== assigned.id);
  const login = await request("/api/player/login", { method: "POST", body: { code: assigned.accessCode } });
  assert.equal(login.status, 200);
  const token = login.body.token;

  const created = await request("/api/judge/missions", {
    method: "POST",
    body: {
      participantId: assigned.id, title: "Verifica testimonianza", description: "Confronta i dettagli.",
      objective: "Trova una contraddizione", rules: "Non mostrare la prova agli altri",
      verification: "Verifica privata", score: 3, turn: 1,
    },
    token: judgeToken,
  });
  assert.equal(created.status, 201);
  const missionId = created.body.id;
  const personal = await request("/api/player/dashboard", { token });
  assert.equal(personal.status, 200);
  assert.equal(personal.body.missions[0].title, "Verifica testimonianza");
  assert.equal(personal.body.role.name, state.body.roles[assigned.role]);
  assert.equal(JSON.stringify(personal.body).includes(other.accessCode), false);

  assert.equal((await request(`/api/player/missions/${missionId}/start`, { method: "POST", token })).status, 200);
  assert.equal((await request(`/api/player/missions/${missionId}/submit`, {
    method: "POST", token, body: { proof: "La testimonianza non coincide." },
  })).status, 200);
  const submitted = await request("/api/judge/state", { token: judgeToken });
  assert.equal(submitted.body.missions.find((mission) => mission.id === missionId).proof, "La testimonianza non coincide.");
  assert.equal((await request(`/api/judge/missions/${missionId}`, {
    method: "PATCH", token: judgeToken, body: { status: "completed", note: "Verificata" },
  })).status, 200);
  assert.equal((await request(`/api/judge/missions/${missionId}`, {
    method: "PATCH", token: judgeToken, body: { status: "completed" },
  })).status, 409);

  assert.equal((await request("/api/player/messages", {
    method: "POST", token, body: { kind: "report", subject: "Sospetto", body: "Ho visto un indizio." },
  })).status, 201);
  const messages = await request("/api/judge/state", { token: judgeToken });
  const report = messages.body.messages.find((message) => message.kind === "report");
  assert.equal(report.participant_id, assigned.id);
  const otherLogin = await request("/api/player/login", { method: "POST", body: { code: other.accessCode } });
  const otherDashboard = await request("/api/player/dashboard", { token: otherLogin.body.token });
  assert.equal(otherDashboard.body.messages.some((message) => message.body === "Ho visto un indizio."), false);
  assert.equal(otherDashboard.body.role, null);
  assert.equal(Object.hasOwn(otherDashboard.body, "roles"), false);
  assert.equal((await request(`/api/judge/messages/${report.id}`, {
    method: "PATCH", token: judgeToken, body: { status: "approved", note: "Segnalazione verificata." },
  })).status, 200);
  assert.equal((await request(`/api/judge/messages/${report.id}`, {
    method: "PATCH", token: judgeToken, body: { status: "rejected", note: "Duplicata." },
  })).status, 409);
  assert.equal((await request("/api/player/dashboard", { token })).body.messages.find((message) => message.id === report.id).status, "approved");
  assert.equal((await request("/api/judge/messages", {
    method: "POST", token: judgeToken,
    body: { participantId: assigned.id, subject: "Risposta", body: "Grazie, ho preso nota." },
  })).status, 201);
  assert.equal((await request("/api/player/dashboard", { token })).body.messages.some((message) => message.body === "Grazie, ho preso nota."), true);
  assert.equal((await request("/api/player/dashboard", { token: otherLogin.body.token })).body.messages.some((message) => message.body === "Grazie, ho preso nota."), false);
  assert.equal((await request("/api/judge/messages", {
    method: "POST", token: judgeToken,
    body: { team: "Sentinelle", subject: "Comunicazione al gruppo", body: "Solo le Sentinelle possono leggere." },
  })).status, 201);
  assert.equal((await request("/api/player/dashboard", { token })).body.messages.some((message) => message.body === "Solo le Sentinelle possono leggere."), true);
  assert.equal((await request("/api/player/dashboard", { token: otherLogin.body.token })).body.messages.some((message) => message.body === "Solo le Sentinelle possono leggere."), false);

  assert.equal((await request("/api/player/actions", {
    method: "POST", token, body: { title: "Azione segreta", details: "Dettagli riservati" },
  })).status, 201);
  const pendingAction = (await request("/api/judge/state", { token: judgeToken })).body.actions[0];
  assert.equal((await request(`/api/judge/actions/${pendingAction.id}`, {
    method: "PATCH", token: judgeToken, body: { status: "approved", score: 2 },
  })).status, 200);
  assert.equal((await request("/api/player/dashboard", { token })).body.score, 5);
  assert.equal((await request("/api/judge/score-adjustment", {
    method: "POST", token: judgeToken,
    body: { participantId: assigned.id, points: 1, reason: "Bonus per verifica finale" },
  })).status, 201);
  assert.equal((await request("/api/player/dashboard", { token })).body.score, 6);

  assert.equal((await request("/api/judge/vote", {
    method: "POST", token: judgeToken, body: { limit: 1 },
  })).status, 200);
  assert.equal((await request("/api/player/vote", {
    method: "POST", token, body: { targets: [assigned.id] },
  })).status, 400);
  assert.equal((await request("/api/player/vote", {
    method: "POST", token, body: { targets: [other.id] },
  })).status, 201);
  assert.equal((await request("/api/player/vote", {
    method: "POST", token, body: { targets: [other.id] },
  })).status, 409);
  assert.deepEqual((await request("/api/judge/state", { token: judgeToken })).body.votes, []);
  assert.equal((await request("/api/judge/vote/close", { method: "POST", token: judgeToken })).status, 200);
  assert.equal((await request("/api/judge/state", { token: judgeToken })).body.votes[0].count, 1);
  assert.equal((await request("/api/judge/vote", {
    method: "POST", token: judgeToken, body: { limit: 1 },
  })).status, 409);

  assert.equal((await request("/api/judge/reveal", {
    method: "POST", token: judgeToken, body: { confirmed: true },
  })).status, 409);
  assert.equal((await request("/api/judge/game-action", {
    method: "POST", token: judgeToken, body: { action: "end", confirmed: true },
  })).status, 200);
  assert.equal((await request("/api/judge/reveal", {
    method: "POST", token: judgeToken, body: { confirmed: true },
  })).status, 200);
  const finalView = await request("/api/player/dashboard", { token });
  assert.equal(finalView.body.finalResults.players.length, 6);
  assert.equal(finalView.body.finalResults.players[0].score >= 0, true);
});
