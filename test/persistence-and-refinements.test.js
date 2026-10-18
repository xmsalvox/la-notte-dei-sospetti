const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-persistence-test-"));
const port = 36000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let output = "";

async function request(route, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
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

test("room persistence, sqlite sessions, smart shuffle auto-balance, reset and permissions", async () => {
  // 1. Create GM User 1
  const reg1 = await request("/api/auth/register", {
    method: "POST",
    body: { username: "OwnerGM", password: "password123" },
  });
  assert.equal(reg1.status, 201);
  const gm1Token = reg1.body.token;

  // Create GM User 2 (unauthorized to delete GM 1 rooms)
  const reg2 = await request("/api/auth/register", {
    method: "POST",
    body: { username: "OtherGM", password: "password123" },
  });
  assert.equal(reg2.status, 201);
  const gm2Token = reg2.body.token;

  // 2. GM 1 creates room
  const createRoom = await request("/api/rooms", {
    method: "POST",
    token: gm1Token,
    body: { name: "Persistent Haunted Mansion" },
  });
  assert.equal(createRoom.status, 201);
  const roomCode = createRoom.body.room.code;

  // 3. Add 4 players to room
  const p1 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Player1", pin: "1111" },
  });
  assert.equal(p1.status, 200);
  const p1Token = p1.body.token;

  const p2 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Player2" },
  });
  assert.equal(p2.status, 200);

  const p3 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Player3" },
  });
  assert.equal(p3.status, 200);

  const p4 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Player4" },
  });
  assert.equal(p4.status, 200);

  // 4. Test Smart Shuffle without manual autobalance first!
  // Room starts with 20 default target roles, but only 4 participants are in room.
  const shuffle = await request(`/api/rooms/${roomCode}/judge/shuffle-roles`, {
    method: "POST",
    token: gm1Token,
  });
  assert.equal(shuffle.status, 200);
  assert.equal(shuffle.body.assignments.length, 4);

  // State should now be ready: true because targets were auto-balanced to 4!
  const stateCheck = await request(`/api/rooms/${roomCode}/judge/state`, { token: gm1Token });
  assert.equal(stateCheck.status, 200);
  assert.equal(stateCheck.body.ready, true);

  // 5. Start Game
  const start = await request(`/api/rooms/${roomCode}/judge/start`, {
    method: "POST",
    token: gm1Token,
    body: { confirmed: true },
  });
  assert.equal(start.status, 200);

  // 6. Test Allies query: Veggente or Malcapitato should NOT see allies
  const p1Dash = await request(`/api/player/dashboard`, { token: p1Token });
  assert.equal(p1Dash.status, 200);
  assert.equal(p1Dash.body.waiting, false);
  if (p1Dash.body.role?.id === "veggente" || p1Dash.body.role?.team === "Malcapitati") {
    assert.deepEqual(p1Dash.body.allies, []);
  }

  // 7. Test "Nuova Partita" Reset endpoint
  const reset = await request(`/api/rooms/${roomCode}/judge/game/reset`, {
    method: "POST",
    token: gm1Token,
    body: { confirmed: true },
  });
  assert.equal(reset.status, 200);

  // State after reset: status should be 'setup', 4 participants still exist, roles reset to NULL
  const resetState = await request(`/api/rooms/${roomCode}/judge/state`, { token: gm1Token });
  assert.equal(resetState.status, 200);
  assert.equal(resetState.body.room.status, "setup");
  assert.equal(resetState.body.participants.length, 4);
  assert.ok(resetState.body.participants.every((p) => p.role === null));

  // 8. Test Session Persistence across Server Restart
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  output = "";
  spawnServer();
  await waitForServer();

  // Tokens should still be valid from SQLite sessions table!
  const meAfterRestart = await request("/api/auth/me", { token: gm1Token });
  assert.equal(meAfterRestart.status, 200);
  assert.equal(meAfterRestart.body.user.username, "OwnerGM");

  const playerAfterRestart = await request("/api/player/dashboard", { token: p1Token });
  assert.equal(playerAfterRestart.status, 200);
  assert.equal(playerAfterRestart.body.waiting, true); // game was reset to setup

  // 9. Test Room Persistence across Logout
  const logout = await request("/api/auth/logout", {
    method: "POST",
    token: gm1Token,
  });
  assert.equal(logout.status, 200);

  // Login again with credentials
  const loginAgain = await request("/api/auth/login", {
    method: "POST",
    body: { username: "OwnerGM", password: "password123" },
  });
  assert.equal(loginAgain.status, 200);
  const newGmToken = loginAgain.body.token;

  // The room and participants MUST STILL BE INTACT!
  const roomsList = await request("/api/rooms", { token: newGmToken });
  assert.equal(roomsList.status, 200);
  const roomFound = roomsList.body.rooms.find((r) => r.code === roomCode);
  assert.ok(roomFound);
  assert.equal(roomFound.participant_count, 4);

  // 10. Deletion Permissions:
  // OtherGM cannot delete OwnerGM's room (403)
  const forbiddenDelete = await request(`/api/rooms/${roomCode}`, {
    method: "DELETE",
    token: gm2Token,
  });
  assert.equal(forbiddenDelete.status, 403);

  // Supervisor (xMSalvox) can delete any room
  const supLogin = await request("/api/auth/login", {
    method: "POST",
    body: { username: "xMSalvox", password: "!99xxMSalvoxx99!" },
  });
  assert.equal(supLogin.status, 200);
  const supToken = supLogin.body.token;

  const supDelete = await request(`/api/rooms/${roomCode}`, {
    method: "DELETE",
    token: supToken,
  });
  assert.equal(supDelete.status, 200);

  // Room should now be gone
  const afterDelete = await request(`/api/rooms/${roomCode}`);
  assert.equal(afterDelete.status, 404);
});
