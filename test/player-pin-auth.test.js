const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-pin-test-"));
const port = 37000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let output = "";

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

function spawnServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
}

async function waitForServer() {
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
  spawnServer();
  await waitForServer();
});

after(() => {
  if (server) server.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

test("player PIN login without nickname directly associates player and prevents duplicate creation", async () => {
  // 1. Create Game Master
  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { username: "MasterNicola", password: "passwordHalloween1" },
  });
  assert.equal(reg.status, 201);
  const gmToken = reg.body.token;

  // 2. Create room
  const roomRes = await request("/api/rooms", {
    method: "POST",
    token: gmToken,
    body: { name: "Villa dei Misteri" },
  });
  assert.equal(roomRes.status, 201);
  const roomCode = roomRes.body.room.code;
  assert.equal(roomCode.length, 5);

  // 3. Player attempts to join before GM adds any participants -> informative error
  const emptyJoin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { pin: "1234" },
  });
  assert.equal(emptyJoin.status, 404);
  assert.match(emptyJoin.body.error, /non ha ancora inserito partecipanti/i);

  // 4. GM adds participant "Nicola" with specific PIN "4821"
  const addNicola = await request(`/api/rooms/${roomCode}/judge/participants`, {
    method: "POST",
    token: gmToken,
    body: { name: "Nicola", pin: "4821" },
  });
  assert.equal(addNicola.status, 201);
  assert.equal(addNicola.body.participant.name, "Nicola");
  assert.equal(addNicola.body.participant.pin, "4821");

  // 5. GM adds participant "Sara" without PIN -> auto-generates 4-digit PIN
  const addSara = await request(`/api/rooms/${roomCode}/judge/participants`, {
    method: "POST",
    token: gmToken,
    body: { name: "Sara" },
  });
  assert.equal(addSara.status, 201);
  assert.equal(addSara.body.participant.name, "Sara");
  assert.ok(addSara.body.participant.pin);
  assert.match(addSara.body.participant.pin, /^\d{4,5}$/);
  const saraPin = addSara.body.participant.pin;

  // 6. Inspect GM room state to verify participants and PINs
  const state = await request(`/api/rooms/${roomCode}/judge/state`, { token: gmToken });
  assert.equal(state.status, 200);
  assert.equal(state.body.participants.length, 2);
  const nicolaInState = state.body.participants.find((p) => p.name === "Nicola");
  const saraInState = state.body.participants.find((p) => p.name === "Sara");
  assert.equal(nicolaInState.pin, "4821");
  assert.equal(saraInState.pin, saraPin);

  // 7. Player joins with ONLY room code and Nicola's PIN (NO NICKNAME PROVIDED!)
  const nicolaLogin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { pin: "4821" },
  });
  assert.equal(nicolaLogin.status, 200);
  assert.ok(nicolaLogin.body.token);
  assert.equal(nicolaLogin.body.participant.name, "Nicola");
  assert.equal(nicolaLogin.body.participant.id, nicolaInState.id);
  assert.equal(nicolaLogin.body.room.code, roomCode);

  // 8. Player joins with Sara's PIN (NO NICKNAME PROVIDED!)
  const saraLogin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { pin: saraPin },
  });
  assert.equal(saraLogin.status, 200);
  assert.ok(saraLogin.body.token);
  assert.equal(saraLogin.body.participant.name, "Sara");
  assert.equal(saraLogin.body.participant.id, saraInState.id);

  // 9. Verify no new participants were created: count remains strictly 2!
  const stateAfterJoins = await request(`/api/rooms/${roomCode}/judge/state`, { token: gmToken });
  assert.equal(stateAfterJoins.body.participants.length, 2);

  // 10. Wrong PIN gives 401
  const badPin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { pin: "9999" },
  });
  assert.equal(badPin.status, 401);
  assert.match(badPin.body.error, /Password \/ PIN non valida/i);

  // 11. Wrong Room Code gives 404
  const badRoom = await request(`/api/rooms/ZZZZZ/join`, {
    method: "POST",
    body: { pin: "4821" },
  });
  assert.equal(badRoom.status, 404);
  assert.match(badRoom.body.error, /Codice stanza inesistente/i);

  // 12. GM updates Sara's PIN to "7777"
  const patchSara = await request(`/api/rooms/${roomCode}/judge/participants/${saraInState.id}`, {
    method: "PATCH",
    token: gmToken,
    body: { pin: "7777" },
  });
  assert.equal(patchSara.status, 200);
  assert.equal(patchSara.body.participant.pin, "7777");

  // Sara can now login with new PIN "7777"
  const saraNewLogin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { pin: "7777" },
  });
  assert.equal(saraNewLogin.status, 200);
  assert.equal(saraNewLogin.body.participant.name, "Sara");
});
