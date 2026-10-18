const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "game.sqlite");
const JUDGE_PASSWORD_PATH = path.join(DATA_DIR, "judge-password.txt");
const ROLE_LIMITS = Object.freeze({
  sentinella: 4,
  sabotatore: 3,
  veggente: 1,
  malcapitato: 12,
});
const ROLE_NAMES = Object.freeze({
  sentinella: "Sentinella",
  sabotatore: "Sabotatore",
  veggente: "Veggente",
  malcapitato: "Malcapitato",
});
const ROLE_KEYS = Object.keys(ROLE_NAMES);
const MAX_BODY_BYTES = 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

let judgePassword = process.env.JUDGE_PASSWORD;
if (!judgePassword) {
  if (fs.existsSync(JUDGE_PASSWORD_PATH)) {
    judgePassword = fs.readFileSync(JUDGE_PASSWORD_PATH, "utf8").trim();
  } else {
    judgePassword = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(JUDGE_PASSWORD_PATH, `${judgePassword}\n`, { flag: "wx", mode: 0o600 });
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS game (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at TEXT
  );
  INSERT OR IGNORE INTO game (id, started_at) VALUES (1, NULL);
  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT CHECK (role IS NULL OR role IN ('sentinella', 'sabotatore', 'veggente', 'malcapitato')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    old_role TEXT,
    new_role TEXT,
    reason TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_config (
    role TEXT PRIMARY KEY CHECK (role IN ('sentinella', 'sabotatore', 'veggente', 'malcapitato')),
    target_count INTEGER NOT NULL CHECK (target_count >= 0)
  );
  CREATE TABLE IF NOT EXISTS removed_roles (id TEXT PRIMARY KEY);
`);
const participantTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'participants'").get().sql;
if (participantTableSql.includes("CHECK (role IS NULL OR role IN")) {
  db.exec(`
    ALTER TABLE participants RENAME TO participants_legacy;
    CREATE TABLE participants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO participants (id, name, role, created_at)
      SELECT id, name, role, created_at FROM participants_legacy;
    DROP TABLE participants_legacy;
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS game_roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
    team TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    objectives TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
    turn_number INTEGER NOT NULL DEFAULT 1,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    status TEXT NOT NULL DEFAULT 'assigned'
      CHECK (status IN ('assigned', 'active', 'submitted', 'under_review', 'completed', 'rejected')),
    proof TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    participant_id TEXT REFERENCES participants(id),
    sender TEXT NOT NULL CHECK (sender IN ('judge', 'player')),
    kind TEXT NOT NULL CHECK (kind IN ('message', 'report', 'announcement')),
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    team TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS secret_actions (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected')),
    review_note TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS votes (
    voter_id TEXT NOT NULL REFERENCES participants(id),
    target_id TEXT NOT NULL REFERENCES participants(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (voter_id, target_id),
    CHECK (voter_id != target_id)
  );
  CREATE TABLE IF NOT EXISTS score_ledger (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    points INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_type, source_id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
const messageColumns = new Set(db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name));
for (const [name, definition] of [
  ["status", "TEXT NOT NULL DEFAULT 'sent'"],
  ["review_note", "TEXT NOT NULL DEFAULT ''"],
  ["reviewed_at", "TEXT"],
  ["team", "TEXT"],
]) {
  if (!messageColumns.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
}
const saveDefaultRoleCount = db.prepare("INSERT OR IGNORE INTO role_config (role, target_count) VALUES (?, ?)");
for (const role of ROLE_KEYS) {
  saveDefaultRoleCount.run(role, ROLE_LIMITS[role]);
  const target = db.prepare("SELECT target_count FROM role_config WHERE role = ?").get(role).target_count;
  if (db.prepare("SELECT 1 FROM removed_roles WHERE id = ?").get(role)) continue;
  db.prepare(`INSERT OR IGNORE INTO game_roles
    (id, name, target_count, team, description, objectives, rules, actions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(role, ROLE_NAMES[role], target,
      role === "sentinella" ? "Sentinelle" : role === "sabotatore" ? "Sabotatori" : "Malcapitati",
      "", "", "", "", new Date().toISOString());
}
const gameColumns = new Set(db.prepare("PRAGMA table_info(game)").all().map((column) => column.name));
for (const [name, definition] of [
  ["status", "TEXT NOT NULL DEFAULT 'setup'"],
  ["settings", "TEXT NOT NULL DEFAULT '{}'"],
  ["current_turn", "INTEGER NOT NULL DEFAULT 0"],
  ["turn_started_at", "TEXT"],
  ["paused_remaining_ms", "INTEGER"],
  ["roles_revealed", "INTEGER NOT NULL DEFAULT 0"],
  ["vote_open", "INTEGER NOT NULL DEFAULT 0"],
  ["vote_limit", "INTEGER NOT NULL DEFAULT 1"],
]) {
  if (!gameColumns.has(name)) db.exec(`ALTER TABLE game ADD COLUMN ${name} ${definition}`);
}
db.prepare("UPDATE game SET status = CASE WHEN started_at IS NULL THEN 'setup' ELSE 'running' END WHERE status = 'setup' AND started_at IS NOT NULL").run();

const roleSecretPath = path.join(DATA_DIR, "role-secret.key");
let roleSecret;
if (fs.existsSync(roleSecretPath)) {
  roleSecret = fs.readFileSync(roleSecretPath);
} else {
  roleSecret = crypto.randomBytes(32);
  fs.writeFileSync(roleSecretPath, roleSecret, { flag: "wx", mode: 0o600 });
}

const judgeSessions = new Set();
const playerSessions = new Map();

function equalSecret(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function playerCode(id) {
  return crypto.createHmac("sha256", roleSecret).update(`player:${id}`).digest("base64url");
}

function isJudge(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return Boolean(token && judgeSessions.has(token));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Richiesta troppo grande."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error("Corpo JSON non valido."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function getCounts() {
  const counts = Object.fromEntries(getRoles().map((role) => [role.id, 0]));
  const rows = db.prepare("SELECT role, COUNT(*) AS count FROM participants WHERE role IS NOT NULL GROUP BY role").all();
  for (const row of rows) if (Object.hasOwn(counts, row.role)) counts[row.role] = row.count;
  return counts;
}

function getRoleTargets() {
  return Object.fromEntries(getRoles().map((role) => [role.id, role.target_count]));
}

function getRoles() {
  return db.prepare("SELECT id, name, target_count, team, description, objectives, rules, actions FROM game_roles ORDER BY created_at, rowid").all();
}

function getRoleNames() {
  return Object.fromEntries(getRoles().map((role) => [role.id, role.name]));
}

function getValidation() {
  const participants = db.prepare("SELECT id, name, role FROM participants ORDER BY created_at, rowid").all();
  const counts = getCounts();
  const targets = getRoleTargets();
  const roles = getRoles();
  const issues = [];
  if (participants.length === 0) issues.push("Aggiungi almeno un partecipante.");
  const roleTotal = Object.values(targets).reduce((total, count) => total + count, 0);
  if (roleTotal !== participants.length) {
    issues.push(`Composizione ruoli: ${roleTotal} persone su ${participants.length} partecipanti. Le quantità dei ruoli devono coincidere con il totale dei presenti.`);
  }
  const missing = participants.filter((participant) => !participant.role).length;
  if (missing) issues.push(`Assegnazioni mancanti: ${missing}.`);
  for (const role of roles) {
    if (counts[role.id] !== role.target_count) {
      issues.push(`${role.name}: ${counts[role.id]}/${role.target_count}.`);
    }
  }
  const invalidAssignments = participants.filter((participant) => participant.role && !Object.hasOwn(targets, participant.role));
  if (invalidAssignments.length) issues.push(`Assegnazioni a ruoli rimossi: ${invalidAssignments.length}.`);
  const duplicates = db.prepare("SELECT LOWER(TRIM(name)) AS name, COUNT(*) AS count FROM participants GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1").all();
  if (duplicates.length) issues.push(`Nomi duplicati: ${duplicates.map((item) => item.name).join(", ")}.`);
  if (participants.some((participant) => !participant.name.trim())) issues.push("Ci sono partecipanti senza nome.");
  return { participants, counts, targets, roles, issues, ready: issues.length === 0 };
}

function logAction(actor, action, details = {}) {
  db.prepare("INSERT INTO audit_log (actor, action, details, created_at) VALUES (?, ?, ?, ?)")
    .run(actor, action, JSON.stringify(details), new Date().toISOString());
}

function gameState() {
  return db.prepare("SELECT * FROM game WHERE id = 1").get();
}

function ensureGameRunning(res) {
  const game = gameState();
  if (game.status !== "running" && game.status !== "paused") {
    sendJson(res, 409, { error: "La partita non è in corso." });
    return null;
  }
  return game;
}

function personalScore(participantId) {
  return db.prepare("SELECT COALESCE(SUM(points), 0) AS score FROM score_ledger WHERE participant_id = ?").get(participantId).score;
}

function finalGameSummary() {
  const settings = JSON.parse(gameState().settings || "{}");
  const winMetric = ["score", "missions", "votes"].includes(settings.winMetric) ? settings.winMetric : "score";
  const players = db.prepare(`SELECT p.id, p.name, r.name AS role, r.team,
    COALESCE((SELECT SUM(points) FROM score_ledger s WHERE s.participant_id = p.id), 0) AS score,
    (SELECT COUNT(*) FROM missions m WHERE m.participant_id = p.id AND m.status = 'completed') AS completed_missions,
    (SELECT COUNT(*) FROM votes v WHERE v.target_id = p.id) AS votes_received
    FROM participants p LEFT JOIN game_roles r ON r.id = p.role ORDER BY p.name`).all();
  const teams = new Map();
  for (const player of players) {
    const team = player.team || player.role || "Senza squadra";
    if (!teams.has(team)) teams.set(team, { team, score: 0, completedMissions: 0, votes: 0, players: 0 });
    const entry = teams.get(team);
    entry.score += player.score;
    entry.completedMissions += player.completed_missions;
    entry.votes += player.votes_received;
    entry.players += 1;
  }
  const metricField = { score: "score", missions: "completedMissions", votes: "votes" }[winMetric];
  const rankedTeams = [...teams.values()].sort((a, b) => b[metricField] - a[metricField] || a.team.localeCompare(b.team, "it"));
  const leaders = rankedTeams.length
    ? rankedTeams.filter((team) => team[metricField] === rankedTeams[0][metricField]).map((team) => team.team)
    : [];
  return {
    winMetric,
    teams: rankedTeams,
    winningTeams: leaders,
    players: [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "it")),
    totalParticipants: players.length,
    totalVotes: db.prepare("SELECT COUNT(*) AS count FROM votes").get().count,
    completedMissions: db.prepare("SELECT COUNT(*) AS count FROM missions WHERE status = 'completed'").get().count,
  };
}

function applyDeadlineFailures(game) {
  if (game.status !== "running" || !game.turn_started_at) return;
  const settings = JSON.parse(game.settings || "{}");
  if (settings.deadlineFailure !== true) return;
  const duration = (settings.turnDurationMinutes || 30) * 60000;
  if (Date.now() - new Date(game.turn_started_at).getTime() < duration) return;
  const expired = db.prepare(`SELECT id, participant_id, title FROM missions
    WHERE turn_number = ? AND status IN ('assigned', 'active')`).all(game.current_turn);
  if (!expired.length) return;
  const now = new Date().toISOString();
  const failMission = db.prepare(`UPDATE missions SET status = 'rejected',
    review_note = 'Missione non completata entro la scadenza configurata.', reviewed_at = ?
    WHERE id = ? AND status IN ('assigned', 'active')`);
  for (const mission of expired) {
    const result = failMission.run(now, mission.id);
    if (result.changes) logAction("system", "mission_deadline_failed", { missionId: mission.id, participantId: mission.participant_id });
  }
}
function requireJudge(req, res) {
  if (isJudge(req)) return true;
  sendJson(res, 401, { error: "Accesso giudice richiesto." });
  return false;
}

function getPlayerId(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return token ? playerSessions.get(token) : undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/status") {
      const game = gameState();
      return sendJson(res, 200, { started: Boolean(game.started_at), addresses: getLanAddresses(), port: PORT });
    }

    if (route === "POST /api/judge/login") {
      const body = await readJson(req);
      if (!equalSecret(body.password || "", judgePassword)) {
        return sendJson(res, 401, { error: "Password giudice non corretta." });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      judgeSessions.add(token);
      return sendJson(res, 200, { token });
    }

    if (url.pathname.startsWith("/api/judge/")) {
      if (!requireJudge(req, res)) return;

      if (route === "GET /api/judge/state") {
        applyDeadlineFailures(gameState());
        const state = getValidation();
        const game = gameState();
        const history = db.prepare("SELECT participant_name, old_role, new_role, reason, changed_at FROM role_history ORDER BY id DESC LIMIT 100").all();
        const participants = state.participants.map((participant) => ({
          ...participant,
          accessCode: playerCode(participant.id),
          score: personalScore(participant.id),
          online: [...playerSessions.values()].includes(participant.id),
        }));
        const missions = db.prepare(`SELECT m.*, p.name AS participant_name
          FROM missions m JOIN participants p ON p.id = m.participant_id ORDER BY m.created_at DESC`).all();
        const messages = db.prepare(`SELECT m.*, p.name AS participant_name
          FROM messages m LEFT JOIN participants p ON p.id = m.participant_id
          ORDER BY m.created_at DESC LIMIT 200`).all();
        const actions = db.prepare(`SELECT a.*, p.name AS participant_name
          FROM secret_actions a JOIN participants p ON p.id = a.participant_id ORDER BY a.created_at DESC`).all();
        const votes = game.vote_open ? [] : db.prepare(`SELECT v.target_id, COUNT(*) AS count, p.name
          FROM votes v JOIN participants p ON p.id = v.target_id GROUP BY v.target_id ORDER BY count DESC, p.name`).all();
        return sendJson(res, 200, {
          ...state,
          participants,
          started: Boolean(game.started_at),
          startedAt: game.started_at,
          history,
          roles: getRoleNames(),
          rolesDetailed: state.roles,
          limits: state.targets,
          settings: JSON.parse(game.settings || "{}"),
          game: {
            status: game.status,
            currentTurn: game.current_turn,
            turnStartedAt: game.turn_started_at,
            pausedRemainingMs: game.paused_remaining_ms,
            rolesRevealed: Boolean(game.roles_revealed),
            voteOpen: Boolean(game.vote_open),
            voteLimit: game.vote_limit,
          },
          missions,
          messages,
          actions,
          votes,
          finalSummary: finalGameSummary(),
          audit: db.prepare("SELECT actor, action, details, created_at FROM audit_log ORDER BY id DESC LIMIT 100").all(),
        });
      }

      if (route === "PUT /api/judge/role-configuration") {
        if (gameState().started_at) {
          return sendJson(res, 409, { error: "La composizione dei ruoli non si può modificare dopo l'inizio." });
        }
        const body = await readJson(req);
        const targets = body.targets;
        const roleIds = getRoles().map((role) => role.id);
        if (!targets || typeof targets !== "object" || Array.isArray(targets)
          || roleIds.some((role) => !Object.hasOwn(targets, role))
          || Object.keys(targets).some((role) => !roleIds.includes(role))) {
          return sendJson(res, 400, { error: "Indica una quantità valida per ogni ruolo configurato." });
        }
        for (const role of roleIds) {
          if (!Number.isSafeInteger(targets[role]) || targets[role] < 0) {
            return sendJson(res, 400, { error: `La quantità di ${getRoleNames()[role]} deve essere un numero intero maggiore o uguale a zero.` });
          }
        }
        const saveTarget = db.prepare("UPDATE game_roles SET target_count = ? WHERE id = ?");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const role of roleIds) saveTarget.run(targets[role], role);
          for (const role of ROLE_KEYS) {
            if (Object.hasOwn(targets, role)) {
              db.prepare("UPDATE role_config SET target_count = ? WHERE role = ?").run(targets[role], role);
            }
          }
          logAction("judge", "role_configuration_updated", targets);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true, targets: getRoleTargets() });
      }

      if (route === "POST /api/judge/roles/clear") {
        if (gameState().started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET role = NULL").run();
          const allRoles = db.prepare("SELECT id FROM game_roles").all();
          const markRemoved = db.prepare("INSERT OR IGNORE INTO removed_roles (id) VALUES (?)");
          for (const r of allRoles) markRemoved.run(r.id);
          db.prepare("DELETE FROM game_roles").run();
          logAction("judge", "all_roles_cleared");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/roles/preset") {
        if (gameState().started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET role = NULL").run();
          db.prepare("DELETE FROM game_roles").run();
          for (const role of ROLE_KEYS) {
            db.prepare("DELETE FROM removed_roles WHERE id = ?").run(role);
            db.prepare(`INSERT INTO game_roles
              (id, name, target_count, team, description, objectives, rules, actions, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(role, ROLE_NAMES[role], ROLE_LIMITS[role],
                role === "sentinella" ? "Sentinelle" : role === "sabotatore" ? "Sabotatori" : "Malcapitati",
                "", "", "", "", new Date().toISOString());
          }
          logAction("judge", "halloween_roles_preset_loaded");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/roles") {
        if (gameState().started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        const body = await readJson(req);
        const name = String(body.name || "").trim();
        if (!name || name.length > 60) return sendJson(res, 400, { error: "Il nome del ruolo deve contenere da 1 a 60 caratteri." });
        if (db.prepare("SELECT 1 FROM game_roles WHERE name = ? COLLATE NOCASE").get(name)) {
          return sendJson(res, 409, { error: "Esiste già un ruolo con questo nome." });
        }
        const count = Number.isSafeInteger(Number(body.target_count)) && Number(body.target_count) >= 0
          ? Number(body.target_count)
          : (Number.isSafeInteger(Number(body.targetCount)) && Number(body.targetCount) >= 0 ? Number(body.targetCount) : 1);
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO game_roles
          (id, name, target_count, team, description, objectives, rules, actions, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, name, count, String(body.team || "").trim(), String(body.description || "").trim(),
            String(body.objectives || "").trim(), String(body.rules || "").trim(),
            String(body.actions || "").trim(), new Date().toISOString());
        logAction("judge", "role_created", { id, name, target_count: count });
        return sendJson(res, 201, { id });
      }

      if (route.startsWith("PATCH /api/judge/roles/")) {
        if (gameState().started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const role = db.prepare("SELECT * FROM game_roles WHERE id = ?").get(id);
        if (!role) return sendJson(res, 404, { error: "Ruolo non trovato." });
        const body = await readJson(req);
        const fields = ["name", "team", "description", "objectives", "rules", "actions"];
        const next = Object.fromEntries(fields.map((field) => [field,
          body[field] === undefined ? role[field] : String(body[field]).trim()]));
        if (!next.name || next.name.length > 60) return sendJson(res, 400, { error: "Il nome del ruolo deve contenere da 1 a 60 caratteri." });
        if (db.prepare("SELECT 1 FROM game_roles WHERE name = ? COLLATE NOCASE AND id != ?").get(next.name, id)) {
          return sendJson(res, 409, { error: "Esiste già un ruolo con questo nome." });
        }
        const targetCount = body.target_count !== undefined && Number.isSafeInteger(Number(body.target_count)) && Number(body.target_count) >= 0
          ? Number(body.target_count)
          : (body.targetCount !== undefined && Number.isSafeInteger(Number(body.targetCount)) && Number(body.targetCount) >= 0 ? Number(body.targetCount) : role.target_count);
        db.prepare(`UPDATE game_roles SET name = ?, target_count = ?, team = ?, description = ?, objectives = ?, rules = ?, actions = ? WHERE id = ?`)
          .run(next.name, targetCount, next.team, next.description, next.objectives, next.rules, next.actions, id);
        logAction("judge", "role_updated", { id, name: next.name, target_count: targetCount });
        return sendJson(res, 200, { ok: true });
      }

      if (route.startsWith("DELETE /api/judge/roles/")) {
        if (gameState().started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        const id = decodeURIComponent(url.pathname.split("/").pop());
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET role = NULL WHERE role = ?").run(id);
          const result = db.prepare("DELETE FROM game_roles WHERE id = ?").run(id);
          if (!result.changes) {
            db.exec("ROLLBACK");
            return sendJson(res, 404, { error: "Ruolo non trovato." });
          }
          db.prepare("INSERT OR IGNORE INTO removed_roles (id) VALUES (?)").run(id);
          logAction("judge", "role_deleted", { id });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "PUT /api/judge/settings") {
        if (gameState().started_at) return sendJson(res, 409, { error: "Le regole di base non si possono modificare dopo l'inizio." });
        const body = await readJson(req);
        const turnCount = body.turnCount;
        const turnDurationMinutes = body.turnDurationMinutes;
        const voteLimit = body.voteLimit;
        const winMetric = body.winMetric || "score";
        if (!Number.isSafeInteger(turnCount) || turnCount < 1 || turnCount > 100
          || !Number.isSafeInteger(turnDurationMinutes) || turnDurationMinutes < 1 || turnDurationMinutes > 1440
          || !Number.isSafeInteger(voteLimit) || voteLimit < 1 || voteLimit > 100
          || !["score", "missions", "votes"].includes(winMetric)) {
          return sendJson(res, 400, { error: "Imposta turni, durata e limite voti con numeri interi validi." });
        }
        const settings = {
          turnCount, turnDurationMinutes, rules: String(body.rules || "").trim().slice(0, 10000),
          winConditions: String(body.winConditions || "").trim().slice(0, 5000),
          deadlineFailure: body.deadlineFailure === true,
          winMetric,
        };
        db.prepare("UPDATE game SET settings = ?, vote_limit = ? WHERE id = 1")
          .run(JSON.stringify(settings), voteLimit);
        logAction("judge", "game_settings_updated", settings);
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/participants") {
        if (db.prepare("SELECT started_at FROM game WHERE id = 1").get().started_at) {
          return sendJson(res, 409, { error: "I partecipanti non si possono aggiungere dopo l'inizio." });
        }
        const body = await readJson(req);
        const name = String(body.name || "").trim();
        if (!name || name.length > 60) return sendJson(res, 400, { error: "Inserisci un nome da 1 a 60 caratteri." });
        const duplicate = db.prepare("SELECT 1 FROM participants WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))").get(name);
        if (duplicate) return sendJson(res, 409, { error: "Questo nome è già presente nell'elenco." });
        db.prepare("INSERT INTO participants (id, name, role, created_at) VALUES (?, ?, NULL, ?)").run(crypto.randomUUID(), name, new Date().toISOString());
        return sendJson(res, 201, { ok: true });
      }

      if (route.startsWith("PATCH /api/judge/participants/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const participant = db.prepare("SELECT id, name, role FROM participants WHERE id = ?").get(id);
        if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });
        const body = await readJson(req);
        const game = db.prepare("SELECT started_at FROM game WHERE id = 1").get();
        const newName = body.name === undefined ? participant.name : String(body.name).trim();
        const newRole = body.role === undefined ? participant.role : body.role || null;
        if (!newName || newName.length > 60) return sendJson(res, 400, { error: "Inserisci un nome da 1 a 60 caratteri." });
        const availableRoles = getRoles();
        const selectedRole = availableRoles.find((role) => role.id === newRole);
        if (newRole !== null && !selectedRole) return sendJson(res, 400, { error: "Ruolo non valido." });
        if (game.started_at && body.name !== undefined) return sendJson(res, 409, { error: "I nomi non si possono modificare dopo l'inizio." });
        const duplicate = db.prepare("SELECT 1 FROM participants WHERE id != ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))").get(id, newName);
        if (duplicate) return sendJson(res, 409, { error: "Questo nome è già presente nell'elenco." });
        if (newRole !== participant.role && game.started_at && !String(body.reason || "").trim()) {
          return sendJson(res, 400, { error: "Per una modifica eccezionale dopo l'inizio, inserisci il motivo." });
        }
        if (newRole !== null && newRole !== participant.role) {
          const current = db.prepare("SELECT COUNT(*) AS count FROM participants WHERE role = ?").get(newRole).count;
          if (current >= selectedRole.target_count) return sendJson(res, 409, { error: `Quantità prevista raggiunta per ${selectedRole.name}.` });
        }
        const update = db.prepare("UPDATE participants SET name = ?, role = ? WHERE id = ?");
        const logChange = db.prepare("INSERT INTO role_history (participant_id, participant_name, old_role, new_role, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?)");
        db.exec("BEGIN IMMEDIATE");
        try {
          update.run(newName, newRole, id);
          if (newRole !== participant.role) {
            logChange.run(id, newName, participant.role, newRole, game.started_at ? String(body.reason).trim() : "Assegnazione del giudice prima dell'inizio", new Date().toISOString());
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "DELETE /api/judge/participants/all" || route === "POST /api/judge/participants/clear") {
        const game = gameState();
        const queryParams = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams;
        const force = queryParams.get("force") === "true";
        if (game.status === "running" && game.current_turn > 0 && !force) {
          return sendJson(res, 409, { error: "La partita è già in corso con turni attivi. Usa 'Nuova Partita' per azzerarla." });
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE game SET started_at = NULL, status = 'setup', current_turn = 0, turn_started_at = NULL, paused_remaining_ms = NULL WHERE id = 1").run();
          db.prepare("DELETE FROM messages WHERE participant_id IS NOT NULL").run();
          db.prepare("DELETE FROM missions").run();
          db.prepare("DELETE FROM secret_actions").run();
          db.prepare("DELETE FROM votes").run();
          db.prepare("DELETE FROM score_ledger").run();
          db.prepare("DELETE FROM role_history").run();
          db.prepare("DELETE FROM participants").run();
          logAction("judge", "all_participants_cleared");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route.startsWith("DELETE /api/judge/participants/")) {
        const game = gameState();
        const queryParams = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams;
        const force = queryParams.get("force") === "true";
        if (game.status === "running" && game.current_turn > 0 && !force) {
          return sendJson(res, 409, { error: "I partecipanti non si possono rimuovere durante un turno in corso." });
        }
        const id = decodeURIComponent(url.pathname.split("/").pop());
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM messages WHERE participant_id = ?").run(id);
          db.prepare("DELETE FROM missions WHERE participant_id = ?").run(id);
          db.prepare("DELETE FROM secret_actions WHERE participant_id = ?").run(id);
          db.prepare("DELETE FROM votes WHERE voter_id = ? OR target_id = ?").run(id, id);
          db.prepare("DELETE FROM score_ledger WHERE participant_id = ?").run(id);
          db.prepare("DELETE FROM role_history WHERE participant_id = ?").run(id);
          const result = db.prepare("DELETE FROM participants WHERE id = ?").run(id);
          if (!result.changes) {
            db.exec("ROLLBACK");
            return sendJson(res, 404, { error: "Partecipante non trovato." });
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/start") {
        const body = await readJson(req);
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
        const state = getValidation();
        if (!state.ready) return sendJson(res, 409, { error: "La configurazione non è valida.", issues: state.issues });
        const now = new Date().toISOString();
        const result = db.prepare(`UPDATE game SET started_at = ?, status = 'running', current_turn = 1,
          turn_started_at = ? WHERE id = 1 AND started_at IS NULL AND status = 'setup'`).run(now, now);
        if (!result.changes) return sendJson(res, 409, { error: "La partita è già iniziata." });
        logAction("judge", "game_started", { participants: state.participants.length });
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/game/reset") {
        const body = await readJson(req);
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(`UPDATE game SET started_at = NULL, status = 'setup', current_turn = 0,
            turn_started_at = NULL, paused_remaining_ms = NULL, roles_revealed = 0, vote_open = 0 WHERE id = 1`).run();
          db.prepare("DELETE FROM messages").run();
          db.prepare("DELETE FROM missions").run();
          db.prepare("DELETE FROM secret_actions").run();
          db.prepare("DELETE FROM votes").run();
          db.prepare("DELETE FROM score_ledger").run();
          db.prepare("DELETE FROM role_history").run();
          if (body.clearParticipants === true) {
            db.prepare("DELETE FROM participants").run();
          } else {
            db.prepare("UPDATE participants SET role = NULL").run();
          }
          if (body.clearRoles === true) {
            const allRoles = db.prepare("SELECT id FROM game_roles").all();
            const markRemoved = db.prepare("INSERT OR IGNORE INTO removed_roles (id) VALUES (?)");
            for (const r of allRoles) markRemoved.run(r.id);
            db.prepare("DELETE FROM game_roles").run();
          }
          logAction("judge", "game_reset", { clearParticipants: Boolean(body.clearParticipants), clearRoles: Boolean(body.clearRoles) });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/game-action") {
        const body = await readJson(req);
        const game = gameState();
        const now = new Date().toISOString();
        if (body.action === "pause" && game.status === "running") {
          const settings = JSON.parse(game.settings || "{}");
          const duration = (settings.turnDurationMinutes || 30) * 60000;
          const remaining = Math.max(0, duration - (Date.now() - new Date(game.turn_started_at).getTime()));
          db.prepare("UPDATE game SET status = 'paused', paused_remaining_ms = ? WHERE id = 1").run(remaining);
        } else if (body.action === "resume" && game.status === "paused") {
          const settings = JSON.parse(game.settings || "{}");
          const duration = (settings.turnDurationMinutes || 30) * 60000;
          const remaining = game.paused_remaining_ms ?? duration;
          db.prepare("UPDATE game SET status = 'running', turn_started_at = ?, paused_remaining_ms = NULL WHERE id = 1")
            .run(new Date(Date.now() - (duration - remaining)).toISOString());
        } else if (body.action === "next-turn" && (game.status === "running" || game.status === "paused")) {
          const settings = JSON.parse(game.settings || "{}");
          const maxTurns = settings.turnCount || 1;
          if (game.current_turn >= maxTurns) return sendJson(res, 409, { error: "È già stato raggiunto l'ultimo turno." });
          db.prepare("UPDATE game SET current_turn = current_turn + 1, turn_started_at = ?, paused_remaining_ms = NULL, status = 'running' WHERE id = 1").run(now);
        } else if (body.action === "end" && (game.status === "running" || game.status === "paused")) {
          if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
          db.prepare("UPDATE game SET status = 'completed', vote_open = 0, turn_started_at = NULL, paused_remaining_ms = NULL WHERE id = 1").run();
        } else if (body.action === "reset" || body.action === "new-game") {
          if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare(`UPDATE game SET started_at = NULL, status = 'setup', current_turn = 0,
              turn_started_at = NULL, paused_remaining_ms = NULL, roles_revealed = 0, vote_open = 0 WHERE id = 1`).run();
            db.prepare("DELETE FROM messages").run();
            db.prepare("DELETE FROM missions").run();
            db.prepare("DELETE FROM secret_actions").run();
            db.prepare("DELETE FROM votes").run();
            db.prepare("DELETE FROM score_ledger").run();
            db.prepare("DELETE FROM role_history").run();
            if (body.clearParticipants === true) {
              db.prepare("DELETE FROM participants").run();
            } else {
              db.prepare("UPDATE participants SET role = NULL").run();
            }
            if (body.clearRoles === true) {
              const allRoles = db.prepare("SELECT id FROM game_roles").all();
              const markRemoved = db.prepare("INSERT OR IGNORE INTO removed_roles (id) VALUES (?)");
              for (const r of allRoles) markRemoved.run(r.id);
              db.prepare("DELETE FROM game_roles").run();
            }
            logAction("judge", "game_reset", { clearParticipants: Boolean(body.clearParticipants), clearRoles: Boolean(body.clearRoles) });
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return sendJson(res, 200, { ok: true });
        } else {
          return sendJson(res, 409, { error: "Azione non valida per lo stato attuale della partita." });
        }
        logAction("judge", `game_${body.action}`, { turn: game.current_turn });
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/game/reset") {
        const body = await readJson(req);
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(`UPDATE game SET started_at = NULL, status = 'setup', current_turn = 0,
            turn_started_at = NULL, paused_remaining_ms = NULL, roles_revealed = 0, vote_open = 0 WHERE id = 1`).run();
          db.prepare("DELETE FROM messages").run();
          db.prepare("DELETE FROM missions").run();
          db.prepare("DELETE FROM secret_actions").run();
          db.prepare("DELETE FROM votes").run();
          db.prepare("DELETE FROM score_ledger").run();
          db.prepare("DELETE FROM role_history").run();
          if (body.clearParticipants === true) {
            db.prepare("DELETE FROM participants").run();
          } else {
            db.prepare("UPDATE participants SET role = NULL").run();
          }
          if (body.clearRoles === true) {
            const allRoles = db.prepare("SELECT id FROM game_roles").all();
            const markRemoved = db.prepare("INSERT OR IGNORE INTO removed_roles (id) VALUES (?)");
            for (const r of allRoles) markRemoved.run(r.id);
            db.prepare("DELETE FROM game_roles").run();
          }
          logAction("judge", "game_reset");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/reveal") {
        if (gameState().status !== "completed") return sendJson(res, 409, { error: "Puoi rivelare i ruoli soltanto dopo aver concluso la partita." });
        const body = await readJson(req);
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
        db.prepare("UPDATE game SET roles_revealed = 1 WHERE id = 1").run();
        logAction("judge", "roles_revealed");
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/missions") {
        const game = ensureGameRunning(res);
        if (!game) return;
        const body = await readJson(req);
        const title = String(body.title || "").trim();
        if (Boolean(body.participantId) === Boolean(body.roleId)) {
          return sendJson(res, 400, { error: "Seleziona un partecipante oppure un ruolo." });
        }
        let targets;
        if (body.roleId) {
          if (!db.prepare("SELECT 1 FROM game_roles WHERE id = ?").get(body.roleId)) {
            return sendJson(res, 400, { error: "Ruolo non valido." });
          }
          targets = db.prepare("SELECT id FROM participants WHERE role = ?").all(body.roleId).map((row) => row.id);
          if (!targets.length) return sendJson(res, 409, { error: "Nessun partecipante è assegnato a questo ruolo." });
        } else {
          const participant = db.prepare("SELECT id FROM participants WHERE id = ?").get(body.participantId);
          if (!participant) return sendJson(res, 400, { error: "Seleziona un partecipante valido." });
          targets = [participant.id];
        }
        if (!title || title.length > 120) return sendJson(res, 400, { error: "Il titolo deve contenere da 1 a 120 caratteri." });
        const score = body.score === undefined ? 0 : body.score;
        const turn = body.turn === undefined ? game.current_turn : body.turn;
        const settings = JSON.parse(game.settings || "{}");
        if (!Number.isSafeInteger(score) || score < 0 || !Number.isSafeInteger(turn) || turn < 1) {
          return sendJson(res, 400, { error: "Punteggio o turno non valido." });
        }
        if (turn > (settings.turnCount || 1)) return sendJson(res, 400, { error: "Il turno supera il numero configurato per la partita." });
        const insertMission = db.prepare(`INSERT INTO missions
          (id, title, description, objective, rules, verification, score, turn_number, participant_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const ids = [];
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const participantId of targets) {
            const id = crypto.randomUUID();
            insertMission.run(id, title, String(body.description || "").trim(), String(body.objective || "").trim(),
              String(body.rules || "").trim(), String(body.verification || "").trim(), score, turn,
              participantId, new Date().toISOString());
            ids.push(id);
          }
          logAction("judge", "mission_assigned", { missionIds: ids, roleId: body.roleId || null });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(res, 201, { id: ids.length === 1 ? ids[0] : null, ids, assigned: ids.length });
      }

      if (route.startsWith("PATCH /api/judge/missions/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const mission = db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
        if (!mission) return sendJson(res, 404, { error: "Missione non trovata." });
        const body = await readJson(req);
        if (!["completed", "rejected"].includes(body.status)) return sendJson(res, 400, { error: "Esito missione non valido." });
        if (!["submitted", "under_review"].includes(mission.status)) return sendJson(res, 409, { error: "La missione non è in attesa di verifica." });
        const note = String(body.note || "").trim().slice(0, 2000);
        if (body.status === "rejected" && !note) return sendJson(res, 400, { error: "Indica il motivo del rifiuto." });
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare("SELECT status FROM missions WHERE id = ?").get(id);
          if (!["submitted", "under_review"].includes(current.status)) throw Object.assign(new Error("La missione è già stata verificata."), { status: 409 });
          db.prepare("UPDATE missions SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
            .run(body.status, note, new Date().toISOString(), id);
          if (body.status === "completed") {
            db.prepare(`INSERT INTO score_ledger
              (id, participant_id, source_type, source_id, points, reason, created_at)
              VALUES (?, ?, 'mission', ?, ?, ?, ?)`)
              .run(crypto.randomUUID(), mission.participant_id, id, mission.score, `Missione: ${mission.title}`, new Date().toISOString());
          }
          logAction("judge", `mission_${body.status}`, { missionId: id, note });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          if (error.status === 409) return sendJson(res, 409, { error: error.message });
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/messages") {
        const body = await readJson(req);
        const team = String(body.team || "").trim();
        if (body.participantId && team) return sendJson(res, 400, { error: "Scegli un giocatore oppure un gruppo." });
        const target = body.participantId
          ? db.prepare("SELECT id FROM participants WHERE id = ?").get(body.participantId) : null;
        if (body.participantId && !target) return sendJson(res, 404, { error: "Partecipante non trovato." });
        if (team && !db.prepare("SELECT 1 FROM game_roles WHERE team = ? COLLATE NOCASE").get(team)) {
          return sendJson(res, 404, { error: "Gruppo non trovato." });
        }
        const text = String(body.body || "").trim();
        if (!text || text.length > 5000) return sendJson(res, 400, { error: "Il messaggio deve contenere da 1 a 5000 caratteri." });
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO messages (id, participant_id, sender, kind, subject, body, team, created_at)
          VALUES (?, ?, 'judge', ?, ?, ?, ?, ?)`)
          .run(id, target?.id || null, target || team ? "message" : "announcement",
            String(body.subject || "").trim().slice(0, 120), text, team || null, new Date().toISOString());
        logAction("judge", target ? "private_message_sent" : team ? "group_message_sent" : "announcement_sent",
          { participantId: target?.id || null, team: team || null });
        return sendJson(res, 201, { id });
      }

      if (route.startsWith("PATCH /api/judge/messages/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const message = db.prepare("SELECT * FROM messages WHERE id = ? AND kind = 'report'").get(id);
        if (!message) return sendJson(res, 404, { error: "Segnalazione non trovata." });
        if (message.status !== "pending") return sendJson(res, 409, { error: "La segnalazione è già stata valutata." });
        const body = await readJson(req);
        if (!["approved", "rejected"].includes(body.status)) return sendJson(res, 400, { error: "Esito segnalazione non valido." });
        const note = String(body.note || "").trim().slice(0, 2000);
        if (body.status === "rejected" && !note) return sendJson(res, 400, { error: "Indica il motivo del rifiuto." });
        const result = db.prepare(`UPDATE messages SET status = ?, review_note = ?, reviewed_at = ?
          WHERE id = ? AND kind = 'report' AND status = 'pending'`)
          .run(body.status, note, new Date().toISOString(), id);
        if (!result.changes) return sendJson(res, 409, { error: "La segnalazione è già stata valutata." });
        logAction("judge", `report_${body.status}`, { reportId: id, participantId: message.participant_id, note });
        return sendJson(res, 200, { ok: true });
      }

      if (route.startsWith("PATCH /api/judge/actions/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const action = db.prepare("SELECT * FROM secret_actions WHERE id = ?").get(id);
        if (!action) return sendJson(res, 404, { error: "Azione non trovata." });
        const body = await readJson(req);
        if (!["approved", "rejected"].includes(body.status)) return sendJson(res, 400, { error: "Esito azione non valido." });
        if (action.status !== "pending") return sendJson(res, 409, { error: "L'azione è già stata valutata." });
        const points = body.score === undefined ? 0 : body.score;
        if (!Number.isSafeInteger(points) || points < 0) return sendJson(res, 400, { error: "Il punteggio deve essere un intero non negativo." });
        const note = String(body.note || "").trim().slice(0, 2000);
        if (body.status === "rejected" && !note) return sendJson(res, 400, { error: "Indica il motivo del rifiuto." });
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare("SELECT status FROM secret_actions WHERE id = ?").get(id);
          if (current.status !== "pending") throw Object.assign(new Error("L'azione è già stata valutata."), { status: 409 });
          db.prepare("UPDATE secret_actions SET status = ?, score = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
            .run(body.status, points, note, new Date().toISOString(), id);
          if (body.status === "approved" && points > 0) {
            db.prepare(`INSERT INTO score_ledger
              (id, participant_id, source_type, source_id, points, reason, created_at)
              VALUES (?, ?, 'action', ?, ?, ?, ?)`)
              .run(crypto.randomUUID(), action.participant_id, id, points, `Azione: ${action.title}`, new Date().toISOString());
          }
          logAction("judge", `action_${body.status}`, { actionId: id, points, note });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          if (error.status === 409) return sendJson(res, 409, { error: error.message });
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/score-adjustment") {
        const body = await readJson(req);
        const participant = db.prepare("SELECT id FROM participants WHERE id = ?").get(body.participantId);
        if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });
        if (!Number.isSafeInteger(body.points) || body.points === 0 || Math.abs(body.points) > 100000) {
          return sendJson(res, 400, { error: "Inserisci un punteggio intero diverso da zero." });
        }
        const reason = String(body.reason || "").trim().slice(0, 500);
        if (!reason) return sendJson(res, 400, { error: "La motivazione è obbligatoria." });
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO score_ledger
          (id, participant_id, source_type, source_id, points, reason, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, ?)`)
          .run(id, participant.id, id, body.points, reason, new Date().toISOString());
        logAction("judge", "score_adjusted", { participantId: participant.id, points: body.points, reason });
        return sendJson(res, 201, { ok: true });
      }

      if (route === "POST /api/judge/vote") {
        const game = gameState();
        if (game.status !== "running" && game.status !== "paused") return sendJson(res, 409, { error: "Apri la votazione durante la partita." });
        if (!game.vote_open && db.prepare("SELECT 1 FROM votes LIMIT 1").get()) {
          return sendJson(res, 409, { error: "La votazione è già stata chiusa e non può essere riaperta." });
        }
        const body = await readJson(req);
        if (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100) return sendJson(res, 400, { error: "Limite voti non valido." });
        db.prepare("UPDATE game SET vote_open = 1, vote_limit = ? WHERE id = 1").run(body.limit);
        logAction("judge", "vote_opened", { limit: body.limit });
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/vote/close") {
        db.prepare("UPDATE game SET vote_open = 0 WHERE id = 1").run();
        logAction("judge", "vote_closed");
        return sendJson(res, 200, { ok: true });
      }

      if (route === "POST /api/judge/logout") {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        judgeSessions.delete(token);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: "Endpoint giudice non trovato." });
    }

    if (route === "POST /api/player/login") {
      const body = await readJson(req);
      const code = String(body.code || "");
      const participants = db.prepare("SELECT id FROM participants").all();
      const participant = participants.find((item) => equalSecret(code, playerCode(item.id)));
      if (!participant) return sendJson(res, 401, { error: "Codice partecipante non valido." });
      const token = crypto.randomBytes(32).toString("base64url");
      playerSessions.set(token, participant.id);
      return sendJson(res, 200, { token });
    }

    if (route === "GET /api/player/me") {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      const game = gameState();
      if (!game.started_at) return sendJson(res, 409, { error: "Il giudice non ha ancora avviato la partita." });
      const participant = db.prepare("SELECT name, role FROM participants WHERE id = ?").get(id);
      if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });
      const role = participant.role ? db.prepare("SELECT name FROM game_roles WHERE id = ?").get(participant.role) : null;
      return sendJson(res, 200, { name: participant.name, role: role?.name || null });
    }

    if (route === "GET /api/player/dashboard") {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      const game = gameState();
      if (!game.started_at) return sendJson(res, 409, { error: "Il giudice non ha ancora avviato la partita." });
      applyDeadlineFailures(game);
      const participant = db.prepare("SELECT id, name, role FROM participants WHERE id = ?").get(id);
      if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });
      const role = participant.role ? db.prepare("SELECT * FROM game_roles WHERE id = ?").get(participant.role) : null;
      const settings = JSON.parse(game.settings || "{}");
      const duration = (settings.turnDurationMinutes || 30) * 60000;
      const remaining = game.status === "paused"
        ? game.paused_remaining_ms
        : Math.max(0, duration - (Date.now() - new Date(game.turn_started_at || game.started_at).getTime()));
      const missions = db.prepare("SELECT * FROM missions WHERE participant_id = ? ORDER BY created_at DESC").all(id);
      const messages = db.prepare(`SELECT id, sender, kind, subject, body, team, created_at, status, review_note FROM messages
        WHERE participant_id = ? OR (participant_id IS NULL AND kind = 'announcement')
          OR (participant_id IS NULL AND team = ?)
        ORDER BY created_at DESC`).all(id, role?.team || "");
      const actions = db.prepare("SELECT id, title, details, status, review_note, score, created_at FROM secret_actions WHERE participant_id = ? ORDER BY created_at DESC").all(id);
      const voteSubmitted = db.prepare("SELECT COUNT(*) AS count FROM votes WHERE voter_id = ?").get(id).count > 0;
      const allies = role?.team
        ? db.prepare(`SELECT name FROM participants WHERE role IN
            (SELECT id FROM game_roles WHERE team = ?) AND id != ? ORDER BY name`).all(role.team, id).map((row) => row.name)
        : [];
      const revealedPlayers = game.roles_revealed ? finalGameSummary() : null;
      return sendJson(res, 200, {
        name: participant.name,
        role: role ? {
          name: role.name, team: role.team, description: role.description,
          objectives: role.objectives, rules: role.rules,
          actions: role.actions.split("\n").filter(Boolean),
        } : null,
        allies,
        startedAt: game.started_at,
        game: {
          status: game.status, currentTurn: game.current_turn,
          turnCount: settings.turnCount || 1,
          turnStartedAt: game.turn_started_at,
          remainingMs: remaining,
          rules: settings.rules || "",
          winConditions: settings.winConditions || "",
          voteOpen: Boolean(game.vote_open), voteLimit: game.vote_limit,
          voteSubmitted,
        },
        score: personalScore(id),
        missions,
        messages,
        actions,
        candidates: game.vote_open ? db.prepare("SELECT id, name FROM participants WHERE id != ? ORDER BY name").all(id) : [],
        finalResults: revealedPlayers,
      });
    }

    if (route === "POST /api/player/messages") {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      if (!ensureGameRunning(res)) return;
      const body = await readJson(req);
      const text = String(body.body || "").trim();
      if (!text || text.length > 5000) return sendJson(res, 400, { error: "Il messaggio deve contenere da 1 a 5000 caratteri." });
      const kind = body.kind === "report" ? "report" : "message";
      const messageId = crypto.randomUUID();
      db.prepare(`INSERT INTO messages (id, participant_id, sender, kind, subject, body, created_at, status)
        VALUES (?, ?, 'player', ?, ?, ?, ?, ?)`)
        .run(messageId, id, kind, String(body.subject || "").trim().slice(0, 120), text,
          new Date().toISOString(), kind === "report" ? "pending" : "sent");
      logAction("player", kind === "report" ? "report_sent" : "message_sent", { participantId: id, messageId });
      return sendJson(res, 201, { id: messageId, received: true });
    }

    if (route.startsWith("POST /api/player/missions/") && route.endsWith("/start")) {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      if (!ensureGameRunning(res)) return;
      const missionId = decodeURIComponent(url.pathname.split("/")[4]);
      const result = db.prepare("UPDATE missions SET status = 'active' WHERE id = ? AND participant_id = ? AND status = 'assigned'").run(missionId, id);
      if (!result.changes) return sendJson(res, 409, { error: "Missione non disponibile o già avviata." });
      logAction("player", "mission_started", { participantId: id, missionId });
      return sendJson(res, 200, { ok: true });
    }

    if (route.startsWith("POST /api/player/missions/") && route.endsWith("/submit")) {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      if (!ensureGameRunning(res)) return;
      const missionId = decodeURIComponent(url.pathname.split("/")[4]);
      const body = await readJson(req);
      const proof = String(body.proof || "").trim();
      if (!proof || proof.length > 20000) return sendJson(res, 400, { error: "Inserisci una prova testuale da 1 a 20000 caratteri." });
      const result = db.prepare(`UPDATE missions SET status = 'submitted', proof = ?, submitted_at = ?
        WHERE id = ? AND participant_id = ? AND status IN ('assigned', 'active')`)
        .run(proof, new Date().toISOString(), missionId, id);
      if (!result.changes) return sendJson(res, 409, { error: "Missione non disponibile per l'invio." });
      logAction("player", "mission_submitted", { participantId: id, missionId });
      return sendJson(res, 200, { ok: true });
    }

    if (route === "POST /api/player/actions") {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      if (!ensureGameRunning(res)) return;
      const body = await readJson(req);
      const title = String(body.title || "").trim();
      const details = String(body.details || "").trim();
      if (!title || title.length > 120 || details.length > 5000) return sendJson(res, 400, { error: "Titolo o dettagli dell'azione non validi." });
      const participant = db.prepare("SELECT role FROM participants WHERE id = ?").get(id);
      const role = participant?.role ? db.prepare("SELECT actions FROM game_roles WHERE id = ?").get(participant.role) : null;
      const allowedActions = role ? role.actions.split("\n").map((action) => action.trim()).filter(Boolean) : [];
      if (!allowedActions.includes(title)) return sendJson(res, 403, { error: "Questa azione non è prevista per il tuo ruolo." });
      const idAction = crypto.randomUUID();
      db.prepare(`INSERT INTO secret_actions (id, participant_id, title, details, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(idAction, id, title, details, new Date().toISOString());
      logAction("player", "secret_action_submitted", { participantId: id, actionId: idAction });
      return sendJson(res, 201, { id: idAction });
    }

    if (route === "POST /api/player/vote") {
      const id = getPlayerId(req);
      if (!id) return sendJson(res, 401, { error: "Effettua l'accesso con il tuo codice privato." });
      const game = gameState();
      if (!game.vote_open) return sendJson(res, 409, { error: "La votazione non è aperta." });
      const body = await readJson(req);
      const targets = body.targets;
      if (!Array.isArray(targets) || !targets.length || targets.length > game.vote_limit
        || new Set(targets).size !== targets.length || targets.includes(id)) {
        return sendJson(res, 400, { error: "Voti non validi: controlla il limite, i duplicati e il voto su te stesso." });
      }
      const known = new Set(db.prepare("SELECT id FROM participants").all().map((row) => row.id));
      if (targets.some((target) => typeof target !== "string" || !known.has(target))) {
        return sendJson(res, 400, { error: "Uno o più partecipanti selezionati non sono validi." });
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!gameState().vote_open) throw Object.assign(new Error("La votazione è chiusa."), { status: 409 });
        if (db.prepare("SELECT 1 FROM votes WHERE voter_id = ? LIMIT 1").get(id)) {
          throw Object.assign(new Error("Hai già inviato il tuo voto."), { status: 409 });
        }
        const insertVote = db.prepare("INSERT INTO votes (voter_id, target_id, created_at) VALUES (?, ?, ?)");
        for (const target of targets) insertVote.run(id, target, new Date().toISOString());
        logAction("player", "vote_submitted", { participantId: id });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (error.status === 409) return sendJson(res, 409, { error: error.message });
        throw error;
      }
      return sendJson(res, 201, { ok: true });
    }

    if (route === "POST /api/player/logout") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token) playerSessions.delete(token);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.resolve(ROOT, "public", requested);
      const publicRoot = path.resolve(ROOT, "public") + path.sep;
      if (!filePath.startsWith(publicRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
      res.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    return sendJson(res, 404, { error: "Endpoint non trovato." });
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return sendJson(res, status, { error: status === 500 ? "Errore interno del server." : error.message });
  }
});

setInterval(() => applyDeadlineFailures(gameState()), 15000).unref();

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces).flat().filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item.address);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`La Notte dei Sospetti è pronta sulla porta ${PORT}.`);
  console.log(`Giudice: http://localhost:${PORT}`);
  for (const address of getLanAddresses()) console.log(`Giocatori sulla stessa rete Wi-Fi: http://${address}:${PORT}`);
  console.log(`Password giudice: ${judgePassword}`);
  console.log("Condividi la password del giudice solo con il giudice. Non condividere i codici privati dei giocatori.");
});
