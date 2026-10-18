const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-prompts-test-"));
const port = 35000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let output = "";
let judgeToken;

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

async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server stopped: ${output}`);
    try {
      if ((await fetch(`${baseUrl}/api/status`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output}`);
}

before(async () => {
  await startServer();
  const password = output.match(/Password giudice: (.+)/)?.[1];
  assert.ok(password);
  const login = await request("/api/judge/login", { method: "POST", body: { password } });
  assert.equal(login.status, 200);
  judgeToken = login.body.token;
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("prompt 1: default configuration enforces 20 players, 4-3-1-12 and Veggente in Malcapitati team", async () => {
  const stateRes = await request("/api/judge/state", { token: judgeToken });
  assert.equal(stateRes.status, 200);
  const { targets, rolesDetailed } = stateRes.body;

  // 1. Quantità standard di ruoli: 4 Sentinelle, 3 Sabotatori, 1 Veggente, 12 Malcapitati (Totale 20)
  assert.equal(targets.sentinella, 4, "4 Sentinelle");
  assert.equal(targets.sabotatore, 3, "3 Sabotatori");
  assert.equal(targets.veggente, 1, "1 Veggente");
  assert.equal(targets.malcapitato, 12, "12 Malcapitati");
  const total = targets.sentinella + targets.sabotatore + targets.veggente + targets.malcapitato;
  assert.equal(total, 20, "20 giocatori standard totali");

  // 2. Veggente fa parte della squadra dei Malcapitati
  const veggente = rolesDetailed.find((r) => r.id === "veggente");
  assert.ok(veggente);
  assert.equal(veggente.team, "Malcapitati", "La Veggente appartiene alla squadra Malcapitati");
});

test("prompt 2: judge messages to players and announcements are persistent and retrievable", async () => {
  // Aggiungi un partecipante
  const pRes = await request("/api/judge/participants", {
    method: "POST", body: { name: "Investigatore Test" }, token: judgeToken,
  });
  assert.equal(pRes.status, 201);

  const stateRes = await request("/api/judge/state", { token: judgeToken });
  const participant = stateRes.body.participants.find((p) => p.name === "Investigatore Test");
  assert.ok(participant);

  // Invia messaggio privato dal giudice
  const msgRes = await request("/api/judge/messages", {
    method: "POST",
    body: { participantId: participant.id, subject: "Indizio segreto", body: "Controlla la biblioteca." },
    token: judgeToken,
  });
  assert.equal(msgRes.status, 201);

  // Invia annuncio globale
  const annRes = await request("/api/judge/messages", {
    method: "POST",
    body: { subject: "Attenzione", body: "La nebbia cala sul salone." },
    token: judgeToken,
  });
  assert.equal(annRes.status, 201);

  // Verifica che il giudice veda entrambi i messaggi nello stato
  const updatedState = await request("/api/judge/state", { token: judgeToken });
  assert.ok(updatedState.body.messages.some((m) => m.subject === "Indizio segreto"));
  assert.ok(updatedState.body.messages.some((m) => m.subject === "Attenzione"));
});

test("game master freedom: master can clear default roles, create custom roles, and configure arbitrary roster", async () => {
  // 1. Il Game Master azzera tutti i partecipanti
  const clearP = await request("/api/judge/participants/all", { method: "DELETE", token: judgeToken });
  assert.equal(clearP.status, 200);

  // 2. Il Game Master azzera tutti i ruoli predefiniti
  const clearR = await request("/api/judge/roles/clear", { method: "POST", token: judgeToken });
  assert.equal(clearR.status, 200);

  let state = (await request("/api/judge/state", { token: judgeToken })).body;
  assert.equal(state.participants.length, 0);
  assert.equal(Object.keys(state.roles).length, 0);

  // 3. Il Master crea una partita custom da 4 persone con ruoli completamente scelti da lui:
  // 1 Cacciatore, 1 Vampiro, 2 Cittadini
  const role1 = await request("/api/judge/roles", {
    method: "POST", body: { name: "Cacciatore", target_count: 1, team: "Umani", description: "Caccia i mostri" },
    token: judgeToken,
  });
  assert.equal(role1.status, 201);

  const role2 = await request("/api/judge/roles", {
    method: "POST", body: { name: "Vampiro", target_count: 1, team: "Mostri", description: "Belve della notte" },
    token: judgeToken,
  });
  assert.equal(role2.status, 201);

  const role3 = await request("/api/judge/roles", {
    method: "POST", body: { name: "Cittadino", target_count: 2, team: "Umani", description: "Sopravvivi" },
    token: judgeToken,
  });
  assert.equal(role3.status, 201);

  // 4. Il Master aggiunge esattamente 4 partecipanti con nomi a sua scelta
  const playerNames = ["Alice", "Bob", "Clara", "David"];
  for (const name of playerNames) {
    const res = await request("/api/judge/participants", { method: "POST", body: { name }, token: judgeToken });
    assert.equal(res.status, 201);
  }

  state = (await request("/api/judge/state", { token: judgeToken })).body;
  assert.equal(state.participants.length, 4);
  assert.equal(Object.keys(state.roles).length, 3);
  assert.equal(state.limits[role1.body.id], 1);
  assert.equal(state.limits[role2.body.id], 1);
  assert.equal(state.limits[role3.body.id], 2);

  // 5. Assegna i ruoli
  const pList = state.participants;
  await request(`/api/judge/participants/${pList[0].id}`, { method: "PATCH", body: { role: role1.body.id }, token: judgeToken });
  await request(`/api/judge/participants/${pList[1].id}`, { method: "PATCH", body: { role: role2.body.id }, token: judgeToken });
  await request(`/api/judge/participants/${pList[2].id}`, { method: "PATCH", body: { role: role3.body.id }, token: judgeToken });
  await request(`/api/judge/participants/${pList[3].id}`, { method: "PATCH", body: { role: role3.body.id }, token: judgeToken });

  // 6. Stato pronto per l'avvio della partita custom del Master
  state = (await request("/api/judge/state", { token: judgeToken })).body;
  assert.equal(state.ready, true, "La partita creata su misura dal Master è pronta per essere avviata!");

  // 7. Il Master può anche ricaricare il preset Halloween con un click se lo desidera
  const presetRes = await request("/api/judge/roles/preset", { method: "POST", token: judgeToken });
  assert.equal(presetRes.status, 200);
  state = (await request("/api/judge/state", { token: judgeToken })).body;
  assert.equal(state.limits.sentinella, 4);
  assert.equal(state.limits.sabotatore, 3);
});
