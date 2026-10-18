const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-chat-media-test-"));
const port = 36000 + Math.floor(Math.random() * 10000);
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

async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const start = Date.now();
  while (Date.now() - start < 8000) {
    try {
      const res = await fetch(`${baseUrl}/api/judge/state`);
      if (res.status === 401 || res.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server failed to start:\n${output}`);
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

test("chat messenger and photo proofs end-to-end", async () => {
  // 1. Register a Judge and create room
  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { username: "MediaMaster", password: "Password123!" }
  });
  assert.equal(reg.status, 201);
  const token = reg.body.token;

  const roomRes = await request("/api/rooms", {
    method: "POST",
    token,
    body: { name: "Stanza Foto", turnDurationMinutes: 30 }
  });
  assert.equal(roomRes.status, 201);
  const roomCode = roomRes.body.room.code;

  // 2. Join a player
  const joinRes = await request("/api/player/join", {
    method: "POST",
    body: { roomCode, name: "Investigatore Marco" }
  });
  assert.equal(joinRes.status, 200);
  const playerToken = joinRes.body.token;
  const participantId = joinRes.body.participant.id;

  // 3. Auto-balance and start game so player dashboard activates
  await request(`/api/rooms/${roomCode}/judge/auto-balance`, { method: "POST", token });
  await request(`/api/rooms/${roomCode}/judge/shuffle-roles`, { method: "POST", token });
  const startRes = await request(`/api/rooms/${roomCode}/judge/start`, {
    method: "POST",
    token,
    body: { confirmed: true }
  });
  assert.equal(startRes.status, 200);

  // 4. Player sends a chat message with photo attachment to Master
  const samplePhotoDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...";
  const sendMsgRes = await request("/api/player/messages", {
    method: "POST",
    token: playerToken,
    body: { kind: "message", body: "Master, ho scattato questa foto del sospettato!", attachment: samplePhotoDataUrl }
  });
  assert.equal(sendMsgRes.status, 201);

  // 5. Judge checks state and sees the player message with attachment
  const judgeState = await request(`/api/rooms/${roomCode}/judge/state`, { token });
  assert.equal(judgeState.status, 200);
  const foundMsg = judgeState.body.messages.find(m => m.participant_id === participantId && m.sender === "player");
  assert.ok(foundMsg);
  assert.equal(foundMsg.body, "Master, ho scattato questa foto del sospettato!");
  assert.equal(foundMsg.attachment, samplePhotoDataUrl);

  // 6. Judge responds directly with an attachment indizio
  const judgeReplyPhoto = "data:image/jpeg;base64,INDIO_FOTO_12345";
  const replyRes = await request(`/api/rooms/${roomCode}/judge/messages`, {
    method: "POST",
    token,
    body: { participantId, body: "Ottimo lavoro! Ecco l'indizio fotografico di risposta:", attachment: judgeReplyPhoto }
  });
  assert.equal(replyRes.status, 201);

  // 7. Player checks dashboard and sees judge response with attachment
  const playerDash = await request("/api/player/dashboard", { token: playerToken });
  assert.equal(playerDash.status, 200);
  const judgeReply = playerDash.body.messages.find(m => m.sender === "judge" && m.participant_id === participantId);
  assert.ok(judgeReply);
  assert.equal(judgeReply.attachment, judgeReplyPhoto);

  // 8. Judge creates a mission for the player
  const missionCreate = await request(`/api/rooms/${roomCode}/judge/missions`, {
    method: "POST",
    token,
    body: { participantId, title: "Foto Segreta", description: "Fai una foto alla zucca", score: 20, turn: 1 }
  });
  assert.equal(missionCreate.status, 201);

  // Re-fetch player dashboard to get mission ID
  const dashAfterMission = await request("/api/player/dashboard", { token: playerToken });
  const missionId = dashAfterMission.body.missions[0].id;

  // 9. Player submits mission proof with photo attachment
  const missionPhoto = "data:image/jpeg;base64,PROVA_ZUCCA_HALLOWEEN";
  const submitProofRes = await request(`/api/player/missions/${missionId}/submit`, {
    method: "POST",
    token: playerToken,
    body: { proof: "Ho trovato la zucca!", proofAttachment: missionPhoto }
  });
  assert.equal(submitProofRes.status, 200);

  // 10. Judge inspects mission and verifies proof_attachment
  const judgeStateFinal = await request(`/api/rooms/${roomCode}/judge/state`, { token });
  const reviewedMission = judgeStateFinal.body.missions.find(m => m.id === missionId);
  assert.ok(reviewedMission);
  assert.equal(reviewedMission.status, "submitted");
  assert.equal(reviewedMission.proof, "Ho trovato la zucca!");
  assert.equal(reviewedMission.proof_attachment, missionPhoto);
});
