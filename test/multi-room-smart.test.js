const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-multiroom-test-"));
const port = 35000 + Math.floor(Math.random() * 15000);
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
});

after(() => {
  if (server) server.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

test("multi-room: user auth, room creation, player lobby, auto-balance, shuffle & batch missions", async () => {
  // 1. Auth: Register GM
  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { username: "GameMasterMarco", password: "password123" },
  });
  assert.equal(reg.status, 201);
  assert.ok(reg.body.token);
  const gmToken = reg.body.token;

  // Verify /api/auth/me
  const me = await request("/api/auth/me", { token: gmToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, "GameMasterMarco");

  // 2. Room creation
  const createdRoom = await request("/api/rooms", {
    method: "POST",
    token: gmToken,
    body: { name: "Halloween Party Marco" },
  });
  assert.equal(createdRoom.status, 201);
  assert.ok(createdRoom.body.room.code);
  assert.equal(createdRoom.body.room.code.length, 5);
  const roomCode = createdRoom.body.room.code;

  // GM rooms list
  const roomsList = await request("/api/rooms", { token: gmToken });
  assert.equal(roomsList.status, 200);
  assert.ok(roomsList.body.rooms.some((r) => r.code === roomCode));

  // 3. Self-service Player Join via room code + optional PIN
  const p1 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Alice", pin: "1234" },
  });
  assert.equal(p1.status, 200);
  assert.ok(p1.body.token);
  const aliceToken = p1.body.token;

  const p2 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Bob", pin: "5678" },
  });
  assert.equal(p2.status, 200);

  const p3 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Charlie" },
  });
  assert.equal(p3.status, 200);

  const p4 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Diana" },
  });
  assert.equal(p4.status, 200);

  const p5 = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Elena" },
  });
  assert.equal(p5.status, 200);

  // Re-join with matching PIN
  const p1Rejoin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Alice", pin: "1234" },
  });
  assert.equal(p1Rejoin.status, 200);
  assert.equal(p1Rejoin.body.participant.id, p1.body.participant.id);

  // Re-join with wrong PIN fails
  const p1BadPin = await request(`/api/rooms/${roomCode}/join`, {
    method: "POST",
    body: { name: "Alice", pin: "9999" },
  });
  assert.equal(p1BadPin.status, 401);

  // 4. Waiting Room status for Player
  const aliceDash = await request("/api/player/dashboard", { token: aliceToken });
  assert.equal(aliceDash.status, 200);
  assert.equal(aliceDash.body.waiting, true);
  assert.equal(aliceDash.body.participantsCount, 5);
  assert.equal(aliceDash.body.players.length, 5);

  // 5. Smart Auto-Balance (5 players -> targets adapted)
  const balance = await request(`/api/rooms/${roomCode}/judge/auto-balance`, {
    method: "POST",
    token: gmToken,
  });
  assert.equal(balance.status, 200);
  const totalTargets = Object.values(balance.body.targets).reduce((sum, n) => sum + n, 0);
  assert.equal(totalTargets, 5);

  // 6. Smart Shuffle Roles (Fisher-Yates assign all 5 players)
  const shuffle = await request(`/api/rooms/${roomCode}/judge/shuffle-roles`, {
    method: "POST",
    token: gmToken,
  });
  assert.equal(shuffle.status, 200);
  assert.equal(shuffle.body.assignments.length, 5);

  // Verify judge state shows all 5 participants assigned
  const judgeState = await request(`/api/rooms/${roomCode}/judge/state`, { token: gmToken });
  assert.equal(judgeState.status, 200);
  assert.equal(judgeState.body.participants.length, 5);
  assert.ok(judgeState.body.participants.every((p) => p.role !== null));
  assert.equal(judgeState.body.ready, true);

  // 7. Mission Templates catalog
  const templates = await request("/api/judge/mission-templates", { token: gmToken });
  assert.equal(templates.status, 200);
  assert.ok(Array.isArray(templates.body.templates));
  assert.ok(templates.body.templates.length >= 10);

  // 8. Start Game
  const start = await request(`/api/rooms/${roomCode}/judge/start`, {
    method: "POST",
    token: gmToken,
    body: { confirmed: true },
  });
  assert.equal(start.status, 200);

  // 9. Batch random missions to all players
  const batchMissions = await request(`/api/rooms/${roomCode}/judge/missions/random-batch`, {
    method: "POST",
    token: gmToken,
  });
  assert.equal(batchMissions.status, 200);
  assert.equal(batchMissions.body.assignedCount, 5);

  // Alice now sees live game dashboard with her assigned role and a mission!
  const aliceLive = await request("/api/player/dashboard", { token: aliceToken });
  assert.equal(aliceLive.status, 200);
  assert.equal(aliceLive.body.waiting, false);
  assert.ok(aliceLive.body.role);
  assert.ok(aliceLive.body.role.name);
  assert.equal(aliceLive.body.missions.length, 1);
  assert.ok(aliceLive.body.missions[0].title);

  // 10. Supervisor Authentication & Exclusive Capabilities
  // Normal user tries to access /api/supervisor/rooms -> 403 Forbidden
  const forbiddenAttempt = await request("/api/supervisor/rooms", { token: gmToken });
  assert.equal(forbiddenAttempt.status, 403);

  // Login as exclusive Supervisor: xMSalvox
  const supLogin = await request("/api/auth/login", {
    method: "POST",
    body: { username: "xMSalvox", password: "!99xxMSalvoxx99!" },
  });
  assert.equal(supLogin.status, 200);
  assert.equal(supLogin.body.user.is_supervisor, true);
  assert.equal(supLogin.body.user.username, "xMSalvox");
  const supToken = supLogin.body.token;

  // Supervisor can view ALL rooms on the platform created by ANY user
  const allPlatformRooms = await request("/api/supervisor/rooms", { token: supToken });
  assert.equal(allPlatformRooms.status, 200);
  assert.ok(allPlatformRooms.body.rooms.length >= 1);
  assert.ok(allPlatformRooms.body.rooms.some((r) => r.code === roomCode && r.owner_username === "GameMasterMarco"));

  // Supervisor can inspect ANY room's judge state even though they are not the owner
  const supRoomInspect = await request(`/api/rooms/${roomCode}/judge/state`, { token: supToken });
  assert.equal(supRoomInspect.status, 200);
  assert.equal(supRoomInspect.body.room.code, roomCode);
  assert.equal(supRoomInspect.body.participants.length, 5);
});
