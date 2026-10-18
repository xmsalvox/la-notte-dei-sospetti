const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sospetti-custom-test-"));
const port = 30000 + Math.floor(Math.random() * 20000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let output = "";
let judgeToken;

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

test("judge can define, allocate and securely assign a fully custom role", async () => {
  const created = await request("/api/judge/roles", {
    method: "POST", token: judgeToken,
    body: {
      name: "Archivista", team: "Custodi", description: "Proteggi gli indizi.",
      objectives: "Conserva una prova", rules: "Non rivelare la fonte",
      actions: "Esamina un documento\nInvia un rapporto",
    },
  });
  assert.equal(created.status, 201);
  const roleId = created.body.id;
  assert.equal((await request(`/api/judge/roles/${roleId}`, {
    method: "PATCH", token: judgeToken, body: { objectives: "Custodisci un indizio." },
  })).status, 200);

  const names = ["Ada", "Nico"];
  const players = [];
  for (const name of names) {
    assert.equal((await request("/api/judge/participants", {
      method: "POST", token: judgeToken, body: { name },
    })).status, 201);
  }
  assert.equal((await request("/api/judge/roles/veggente", {
    method: "DELETE", token: judgeToken,
  })).status, 200);
  let state = (await request("/api/judge/state", { token: judgeToken })).body;
  assert.equal(Object.hasOwn(state.roles, "veggente"), false);
  for (const participant of state.participants) players.push(participant);
  const targets = Object.fromEntries(Object.keys(state.roles).map((id) => [id, 0]));
  targets[roleId] = 2;
  assert.equal((await request("/api/judge/role-configuration", {
    method: "PUT", token: judgeToken, body: { targets },
  })).status, 200);
  for (const participant of players) {
    assert.equal((await request(`/api/judge/participants/${participant.id}`, {
      method: "PATCH", token: judgeToken, body: { role: roleId },
    })).status, 200);
  }
  state = (await request("/api/judge/state", { token: judgeToken })).body;
  assert.equal(state.ready, true);
  assert.equal((await request("/api/judge/start", {
    method: "POST", token: judgeToken, body: { confirmed: true },
  })).status, 200);
  const login = await request("/api/player/login", {
    method: "POST", body: { code: state.participants[0].accessCode },
  });
  const dashboard = await request("/api/player/dashboard", { token: login.body.token });
  assert.equal(dashboard.body.role.name, "Archivista");
  assert.equal(dashboard.body.role.objectives, "Custodisci un indizio.");
  assert.deepEqual(dashboard.body.allies, ["Nico"]);
  assert.equal(Object.hasOwn(dashboard.body, "roles"), false);
  const roleMission = await request("/api/judge/missions", {
    method: "POST", token: judgeToken,
    body: { roleId, title: "Indaga il documento", score: 1, turn: 1 },
  });
  assert.equal(roleMission.status, 201);
  assert.equal(roleMission.body.assigned, 2);
  const secondLogin = await request("/api/player/login", {
    method: "POST", body: { code: state.participants[1].accessCode },
  });
  assert.equal((await request("/api/player/dashboard", { token: secondLogin.body.token })).body.missions[0].title, "Indaga il documento");
  assert.equal((await request(`/api/judge/roles/${roleId}`, {
    method: "DELETE", token: judgeToken,
  })).status, 409);
  assert.equal((await request("/api/player/actions", {
    method: "POST", token: login.body.token,
    body: { title: "Esamina un documento", details: "Indizio riservato" },
  })).status, 201);
  assert.equal((await request("/api/player/actions", {
    method: "POST", token: login.body.token,
    body: { title: "Azione inventata", details: "" },
  })).status, 403);
});
