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
const MAX_BODY_BYTES = 10 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// Legacy / fallback judge password support
let judgePassword = process.env.JUDGE_PASSWORD;
if (!judgePassword) {
  if (fs.existsSync(JUDGE_PASSWORD_PATH)) {
    judgePassword = fs.readFileSync(JUDGE_PASSWORD_PATH, "utf8").trim();
  } else {
    judgePassword = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(JUDGE_PASSWORD_PATH, `${judgePassword}\n`, { flag: "wx", mode: 0o600 });
  }
}

// ----------------------------------------------------
// DATABASE INITIALIZATION & MIGRATIONS
// ----------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_supervisor INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    user_id TEXT,
    room_id TEXT,
    participant_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'running', 'paused', 'completed', 'terminated')),
    settings TEXT NOT NULL DEFAULT '{}',
    current_turn INTEGER NOT NULL DEFAULT 0,
    turn_started_at TEXT,
    paused_remaining_ms INTEGER,
    roles_revealed INTEGER NOT NULL DEFAULT 0,
    vote_open INTEGER NOT NULL DEFAULT 0,
    vote_limit INTEGER NOT NULL DEFAULT 1,
    started_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_roles (
    id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
    team TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    objectives TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, id),
    UNIQUE (room_id, name COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT,
    pin TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, name COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS role_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    old_role TEXT,
    new_role TEXT,
    reason TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
    turn_number INTEGER NOT NULL DEFAULT 1,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'assigned'
      CHECK (status IN ('assigned', 'active', 'submitted', 'under_review', 'completed', 'rejected')),
    proof TEXT NOT NULL DEFAULT '',
    proof_attachment TEXT DEFAULT NULL,
    review_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('judge', 'player')),
    kind TEXT NOT NULL CHECK (kind IN ('message', 'report', 'announcement')),
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    attachment TEXT DEFAULT NULL,
    team TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS secret_actions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
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
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, voter_id, target_id),
    CHECK (voter_id != target_id)
  );

  CREATE TABLE IF NOT EXISTS score_ledger (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    points INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, source_type, source_id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Migration checks for existing databases
for (const table of ["participants", "role_history", "missions", "messages", "secret_actions", "votes", "score_ledger", "audit_log"]) {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (tableExists) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!cols.has("room_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE`);
    }
    if (table === "participants" && !cols.has("pin")) {
      db.exec(`ALTER TABLE participants ADD COLUMN pin TEXT`);
    }
    if (table === "messages" && !cols.has("attachment")) {
      db.exec(`ALTER TABLE messages ADD COLUMN attachment TEXT DEFAULT NULL`);
    }
    if (table === "missions" && !cols.has("proof_attachment")) {
      db.exec(`ALTER TABLE missions ADD COLUMN proof_attachment TEXT DEFAULT NULL`);
    }
  }
}

function generateUniqueParticipantPin(roomId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pin = String(crypto.randomInt(1000, 9999));
    const exists = db.prepare("SELECT 1 FROM participants WHERE room_id = ? AND pin = ?").get(roomId, pin);
    if (!exists) return pin;
  }
  return String(crypto.randomInt(10000, 99999));
}

// Ensure all participants have a PIN
try {
  const pinless = db.prepare("SELECT id, room_id FROM participants WHERE pin IS NULL OR TRIM(pin) = ''").all();
  for (const p of pinless) {
    const newPin = generateUniqueParticipantPin(p.room_id);
    db.prepare("UPDATE participants SET pin = ? WHERE id = ?").run(newPin, p.id);
  }
} catch (err) {
  console.error("Migration error assigning participant PINs:", err);
}

const usersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
if (usersTable) {
  const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  if (!cols.has("is_supervisor")) {
    db.exec("ALTER TABLE users ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0");
  }
}

const gameRolesDef = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'game_roles'").get();
if (gameRolesDef && !gameRolesDef.sql.includes("room_id")) {
  db.exec(`
    ALTER TABLE game_roles RENAME TO game_roles_legacy;
    CREATE TABLE game_roles (
      id TEXT NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
      team TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      objectives TEXT NOT NULL DEFAULT '',
      rules TEXT NOT NULL DEFAULT '',
      actions TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, id),
      UNIQUE (room_id, name COLLATE NOCASE)
    );
    DROP TABLE game_roles_legacy;
  `);
}

// ----------------------------------------------------
// SMART HALLOWEEN CATALOG & PRESETS
// ----------------------------------------------------
const HALLOWEEN_ROLE_PRESETS = [
  {
    id: "sentinella",
    name: "Sentinella",
    target_count: 4,
    team: "Sentinelle",
    description: "Guardiani silenziosi della notte. Conoscono gli altri membri della propria squadra e vigilano su mosse sospette.",
    objectives: "Smascherare e votare tutti i Sabotatori prima dello scadere dei turni.",
    rules: "Possono comunicare e coordinarsi con le altre Sentinelle in segreto.",
    actions: "Sorveglianza notturna\nInterroga un sospetto\nScorta protetta",
  },
  {
    id: "sabotatore",
    name: "Sabotatore",
    target_count: 3,
    team: "Sabotatori",
    description: "Infiltrati nell'ombra. Conoscono i loro complici e agiscono nell'oscurità per seminare il panico.",
    objectives: "Completare i sabotaggi segreti ed eliminare o sviare i sospetti senza farsi smascherare.",
    rules: "Agire con discrezione. Non rivelare mai la propria identità ai Malcapitati.",
    actions: "Sabotaggio furtivo\nFalso indizio\nAlibi falso",
  },
  {
    id: "veggente",
    name: "Veggente",
    target_count: 1,
    team: "Malcapitati",
    description: "Possiede una dote mistica speciale ma fa parte a tutti gli effetti della squadra dei Malcapitati. NON conosce gli altri alleati in anticipo.",
    objectives: "Aiutare gli innocenti a identificare i Sabotatori attraverso le proprie visioni.",
    rules: "Non rivelare subito il proprio potere per evitare di essere presa di mira dai Sabotatori.",
    actions: "Visione chiaroveggente\nLettura dell'aura\nPresagio oscuro",
  },
  {
    id: "malcapitato",
    name: "Malcapitato",
    target_count: 12,
    team: "Malcapitati",
    description: "Ospite ignaro della magione. Non ha poteri speciali iniziali, ma con acume e osservazione può salvare tutti.",
    objectives: "Sopravvivere ai turni, completare le missioni assegnate e votare i veri colpevoli.",
    rules: "Collaborare con gli altri invitati e segnalare qualsiasi comportamento anomalo al Giudice.",
    actions: "Ispezione stanza\nRichiesta di chiarimento\nSegnalazione anonima",
  },
];

const HALLOWEEN_MISSION_TEMPLATES = [
  {
    title: "Il Brindisi Avvelenato",
    description: "Avvicinati a un gruppo e proponi un brindisi pronunciando chiaramente la parola 'Spettro' prima che tutti bevano.",
    objective: "Fai brindare almeno 3 persone con te dicendo la parola segreta 'Spettro'.",
    rules: "Non farti scoprire e non svelare che è una missione assegnata.",
    verification: "Indica i nomi delle 3 persone che hanno brindato e il momento esatto.",
    score: 15,
  },
  {
    title: "L'Interrogatorio ad Arte",
    description: "Fai domande con disinvoltura a due partecipanti per ricostruire i loro spostamenti negli ultimi 10 minuti.",
    objective: "Scopri e trascrivi l'alibi di due giocatori per i turni precedenti.",
    rules: "Comportati con naturalezza senza sembrare un inquisitore palese.",
    verification: "Riporta i nomi dei due interrogati e cosa hanno dichiarato di aver fatto.",
    score: 15,
  },
  {
    title: "Ombra Silenziosa",
    description: "Scegli un sospetto e condividi la stessa stanza con lui per almeno 2 minuti consecutivi.",
    objective: "Resta a distanza ravvicinata dal bersaglio senza rivolgergli mai la parola.",
    rules: "Se il bersaglio ti parla o si allontana prima dei 2 minuti, la missione fallisce.",
    verification: "Nome del bersaglio e descrizione di cosa stava facendo in quei minuti.",
    score: 20,
  },
  {
    title: "Il Patto nel Buio",
    description: "Convincere un altro partecipante a scambiare una stretta di mano segreta con una parola d'ordine inventata da te.",
    objective: "Sigla un patto segreto con un partecipante facendogli credere che siete alleati.",
    rules: "La parola d'ordine deve essere composta da due parole (es. 'Luna Nera').",
    verification: "Nome del complice e parola d'ordine concordata.",
    score: 15,
  },
  {
    title: "Il Falso Indizio",
    description: "Durante una conversazione di gruppo, convinci almeno due persone che un dettaglio insolito della casa nasconda un segreto.",
    objective: "Semina un dubbio o una falsa pista su un oggetto o angolo della stanza.",
    rules: "Due giocatori devono commentare seriamente la tua teoria.",
    verification: "Descrivi la falsa pista creata e chi è caduto nell'inganno.",
    score: 20,
  },
  {
    title: "Il Testimone Cieco",
    description: "Fai ammettere apertamente a un sospetto di non ricordare chi sia entrato o uscito per ultimo dalla stanza.",
    objective: "Metti in crisi la memoria di un partecipante durante una discussione.",
    rules: "La persona deve pronunciare una frase come 'non ci ho fatto caso' o 'non ricordo chi fosse'.",
    verification: "Nome del giocatore e frase esatta pronunciata.",
    score: 15,
  },
  {
    title: "Il Rito di Mezzanotte",
    description: "Raduna attorno a te almeno 4 persone per raccontare un aneddoto misterioso o una breve storia da brividi.",
    objective: "Cattura l'attenzione di 4 partecipanti per almeno un minuto intero.",
    rules: "Nessuno deve abbandonare il cerchio prima del finale della storia.",
    verification: "Nomi dei 4 partecipanti che hanno ascoltato la storia.",
    score: 20,
  },
  {
    title: "Il Confessionale",
    description: "Riesci a farti confidare da un altro partecipante di chi diffida di più in questa partita.",
    objective: "Fatti rivelare il nome del suo principale sospettato.",
    rules: "Non devi suggerire tu il nome: deve pronunciarlo spontaneamente il giocatore.",
    verification: "Nome del giocatore e il nome del suo sospettato rivelato.",
    score: 15,
  },
  {
    title: "Scambio Furtivo",
    description: "Fatti prestare un oggetto personale (es. penna, accendino, bicchiere, accessorio) da un altro giocatore e tienilo per 5 minuti.",
    objective: "Ottieni e custodisci un oggetto di un altro giocatore senza spiegare il motivo.",
    rules: "L'oggetto deve esserti consegnato spontaneamente, non rubato.",
    verification: "Oggetto ricevuto e nome del proprietario.",
    score: 15,
  },
  {
    title: "L'Alibi di Ferro",
    description: "Fai in modo che altri due giocatori possano testimoniare con certezza che sei rimasto con loro negli ultimi minuti.",
    objective: "Costruisci un alibi pubblico e inattaccabile per il turno corrente.",
    rules: "I due testimoni devono essere disposti a confermarlo apertamente al Giudice se interrogati.",
    verification: "Nomi dei due testimoni che garantiscono per te.",
    score: 15,
  },
  {
    title: "Il Sussurro nel Buio",
    description: "Avvicinati a un giocatore e sussurragli all'orecchio: 'Qualcuno nella stanza sa la verità...'.",
    objective: "Sussurra la frase enigmatica e osserva la sua reazione immediata.",
    rules: "Fallo con tono misterioso senza farti sentire da altri vicini.",
    verification: "Nome del giocatore e trascrizione della sua reazione verbale o mimica.",
    score: 20,
  },
  {
    title: "L'Origliatore",
    description: "Ascolta una conversazione tra due persone a distanza senza che si accorgano che stai prestando attenzione.",
    objective: "Intercetta un dettaglio o una frase detta da due persone a colloquio.",
    rules: "Non unirti alla conversazione né farti scoprire a guardarle fissamente.",
    verification: "Nomi dei due interlocutori e frammento della conversazione origliata.",
    score: 25,
  },
  {
    title: "Il Giuramento Solenne",
    description: "Guarda negli occhi un partecipante e chiedigli se è disposto a giurare sulla sua completa innocenza.",
    objective: "Fai pronunciare al bersaglio la formula esatta 'Giuro che sono innocente'.",
    rules: "Se esita o rifiuta di giurare, annotalo come elemento chiave.",
    verification: "Nome del partecipante e se ha giurato o esitato.",
    score: 15,
  },
  {
    title: "La Maschera Caduta",
    description: "Durante una conversazione di gruppo, cambia deliberatamente l'argomento di discussione per ben due volte.",
    objective: "Devia il discorso per due volte consecutive senza destare sospetti.",
    rules: "Il gruppo deve seguire spontaneamente il tuo nuovo argomento entrambe le volte.",
    verification: "I due argomenti introdotti e i partecipanti coinvolti.",
    score: 20,
  },
  {
    title: "Il Messaggio Cifrato",
    description: "Lascia un bigliettino con scritto un presagio o un indizio cifrato in un posto visibile (es. tavolo, mensola).",
    objective: "Fai trovare e leggere il bigliettino a un altro giocatore senza che sappia chi l'ha lasciato.",
    rules: "Non farti vedere mentre deponi il messaggio.",
    verification: "Dove hai posato il biglietto e chi lo ha raccolto o letto.",
    score: 20,
  },
];

function seedRoomRoles(roomId) {
  const insertRole = db.prepare(`INSERT OR REPLACE INTO game_roles
    (id, room_id, name, target_count, team, description, objectives, rules, actions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of HALLOWEEN_ROLE_PRESETS) {
    insertRole.run(
      r.id, roomId, r.name, r.target_count, r.team,
      r.description, r.objectives, r.rules, r.actions,
      new Date().toISOString()
    );
  }
}

// ----------------------------------------------------
// DEFAULT USER & ROOM SETUP (FOR TESTS & LEGACY)
// ----------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, originalHash] = stored.split(":");
  const testHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(testHash, "hex"), Buffer.from(originalHash, "hex"));
}

let defaultUser = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get();
if (!defaultUser) {
  const adminId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, username, password_hash, is_supervisor, created_at) VALUES (?, ?, ?, 0, ?)").run(
    adminId, "admin", hashPassword(judgePassword), new Date().toISOString()
  );
  defaultUser = { id: adminId };
}

// Exclusive Supervisor Account Seeding / Update
const supervisorUser = db.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER('xMSalvox')").get();
if (supervisorUser) {
  db.prepare("UPDATE users SET password_hash = ?, is_supervisor = 1 WHERE id = ?").run(
    hashPassword("!99xxMSalvoxx99!"), supervisorUser.id
  );
} else {
  db.prepare("INSERT INTO users (id, username, password_hash, is_supervisor, created_at) VALUES (?, ?, ?, 1, ?)").run(
    crypto.randomUUID(), "xMSalvox", hashPassword("!99xxMSalvoxx99!"), new Date().toISOString()
  );
}

let defaultRoom = db.prepare("SELECT * FROM rooms ORDER BY created_at ASC LIMIT 1").get();
if (!defaultRoom) {
  const roomId = crypto.randomUUID();
  const code = "H4LL0";
  db.prepare(`INSERT INTO rooms
    (id, code, name, owner_id, status, settings, current_turn, roles_revealed, vote_open, vote_limit, created_at)
    VALUES (?, ?, ?, ?, 'setup', '{}', 0, 0, 0, 1, ?)`).run(
    roomId, code, "Festa di Halloween", defaultUser.id, new Date().toISOString()
  );
  seedRoomRoles(roomId);
  defaultRoom = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
}

// Attach any existing orphan rows to defaultRoom
for (const table of ["participants", "role_history", "missions", "messages", "secret_actions", "votes", "score_ledger", "audit_log"]) {
  db.prepare(`UPDATE ${table} SET room_id = ? WHERE room_id IS NULL`).run(defaultRoom.id);
}

// ----------------------------------------------------
// SESSIONS & ROOM HELPERS
// ----------------------------------------------------
const roleSecretPath = path.join(DATA_DIR, "role-secret.key");
let roleSecret;
if (fs.existsSync(roleSecretPath)) {
  roleSecret = fs.readFileSync(roleSecretPath);
} else {
  roleSecret = crypto.randomBytes(32);
  fs.writeFileSync(roleSecretPath, roleSecret, { flag: "wx", mode: 0o600 });
}

// userSessions: token -> userId
const userSessions = new Map();
// judgeSessions: token -> { userId, activeRoomId }
const judgeSessions = new Map();
// playerSessions: token -> { participantId, roomId }
const playerSessions = new Map();

// Load persistent sessions from SQLite database
try {
  const loadedSessions = db.prepare("SELECT * FROM sessions").all();
  for (const s of loadedSessions) {
    if (s.type === "user") {
      userSessions.set(s.token, s.user_id);
    } else if (s.type === "judge") {
      judgeSessions.set(s.token, { userId: s.user_id, activeRoomId: s.room_id });
    } else if (s.type === "player") {
      playerSessions.set(s.token, { participantId: s.participant_id, roomId: s.room_id });
    }
  }
} catch (err) {
  console.error("Error loading sessions from db:", err);
}

function saveSession(token, type, { userId = null, roomId = null, participantId = null } = {}) {
  try {
    db.prepare(`INSERT OR REPLACE INTO sessions (token, type, user_id, room_id, participant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      token, type, userId, roomId, participantId, new Date().toISOString()
    );
  } catch (err) {
    console.error("Save session error:", err);
  }
}

function removeSession(token) {
  if (!token) return;
  try {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  } catch (err) {
    console.error("Remove session error:", err);
  }
}

function playerCode(id) {
  return crypto.createHmac("sha256", roleSecret).update(`player:${id}`).digest("base64url");
}

function getUserId(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return userSessions.get(token) || judgeSessions.get(token)?.userId || null;
}

function requireUser(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    sendJson(res, 401, { error: "Autenticazione richiesta." });
    return null;
  }
  return userId;
}

function getRoomByCode(code) {
  if (!code) return null;
  const clean = String(code).trim();
  if (!clean) return null;
  return db.prepare("SELECT * FROM rooms WHERE UPPER(TRIM(code)) = UPPER(TRIM(?))").get(clean);
}

function getRoomById(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    }
    const exists = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
    if (!exists) return code;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
}

function resolveRoom(req, url) {
  // 1. /api/rooms/:code/...
  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)/);
  if (match) {
    const code = decodeURIComponent(match[1]).trim().toUpperCase();
    return getRoomByCode(code);
  }
  // 2. Query param or header
  const paramCode = url.searchParams.get("room") || req.headers["x-room-code"];
  if (paramCode) {
    return getRoomByCode(String(paramCode).trim().toUpperCase());
  }
  // 3. Active room in judge session
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token && judgeSessions.has(token)) {
    const activeId = judgeSessions.get(token).activeRoomId;
    if (activeId) {
      const room = getRoomById(activeId);
      if (room) return room;
    }
  }
  // 4. Fallback to default room (only if no room was specified)
  return getRoomById(defaultRoom.id);
}

function isSupervisor(req) {
  const userId = getUserId(req);
  if (!userId) return false;
  const user = db.prepare("SELECT is_supervisor FROM users WHERE id = ?").get(userId);
  return Boolean(user && user.is_supervisor);
}

function requireSupervisor(req, res) {
  if (isSupervisor(req)) return true;
  sendJson(res, 403, { error: "Accesso riservato al Supervisore della piattaforma." });
  return false;
}

function isJudge(req, room) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const jSession = judgeSessions.get(token);
  if (jSession) return true;
  const uId = userSessions.get(token);
  if (!uId) return false;
  if (isSupervisor(req)) return true; // Supervisor has GM rights to inspect and control all rooms!
  if (!room || room.owner_id === uId) return true;
  return false;
}

function requireJudge(req, res, room) {
  if (isJudge(req, room)) return true;
  sendJson(res, 401, { error: "Accesso giudice richiesto per questa stanza." });
  return false;
}

function logAction(roomId, actor, action, details = {}) {
  try {
    db.prepare(`INSERT INTO audit_log (room_id, actor, action, details, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      roomId, actor, action, typeof details === "string" ? details : JSON.stringify(details), new Date().toISOString()
    );
  } catch (err) {
    console.error("Audit log error:", err);
  }
}

// ----------------------------------------------------
// HTTP PARSERS & UTILITIES
// ----------------------------------------------------
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

// ----------------------------------------------------
// ROOM STATE & GAME LOGIC
// ----------------------------------------------------
function getRoles(roomId) {
  return db.prepare("SELECT * FROM game_roles WHERE room_id = ? ORDER BY id").all(roomId);
}

function getRoleNames(roomId) {
  return Object.fromEntries(getRoles(roomId).map((r) => [r.id, r.name]));
}

function getRoleTargets(roomId) {
  return Object.fromEntries(getRoles(roomId).map((r) => [r.id, r.target_count]));
}

function getCounts(roomId) {
  const counts = Object.fromEntries(getRoles(roomId).map((r) => [r.id, 0]));
  const rows = db.prepare("SELECT role, COUNT(*) AS count FROM participants WHERE room_id = ? AND role IS NOT NULL GROUP BY role").all(roomId);
  for (const row of rows) {
    if (Object.hasOwn(counts, row.role)) counts[row.role] = row.count;
  }
  return counts;
}

function getValidation(roomId) {
  const participants = db.prepare("SELECT id, name, role, pin FROM participants WHERE room_id = ? ORDER BY name").all(roomId);
  const targets = getRoleTargets(roomId);
  const counts = getCounts(roomId);
  const roleNames = getRoleNames(roomId);
  const issues = [];
  const targetTotal = Object.values(targets).reduce((sum, n) => sum + n, 0);

  if (targetTotal !== participants.length) {
    issues.push(`Composizione ruoli non valida: la somma dei ruoli configurati (${targetTotal}) deve coincidere con il numero di partecipanti presenti (${participants.length}).`);
  }
  for (const [roleId, target] of Object.entries(targets)) {
    const assigned = counts[roleId] || 0;
    const name = roleNames[roleId] || roleId;
    if (assigned !== target) {
      issues.push(`Il ruolo ${name} richiede ${target} assegnazioni, ma attualmente ne ha ${assigned}.`);
    }
  }
  const unassigned = participants.filter((p) => !p.role);
  if (unassigned.length > 0) {
    issues.push(`Assegnazioni mancanti: ci sono ${unassigned.length} partecipanti senza ruolo assegnato.`);
  }
  for (const participant of participants) {
    if (!participant.role) {
      issues.push(`${participant.name} non ha ancora un ruolo assegnato.`);
    }
  }
  return {
    participants,
    targets,
    counts,
    issues,
    ready: issues.length === 0,
    roles: getRoles(roomId),
  };
}

function personalScore(participantId, roomId) {
  return db.prepare("SELECT COALESCE(SUM(points), 0) AS score FROM score_ledger WHERE participant_id = ? AND room_id = ?").get(participantId, roomId).score;
}

function finalGameSummary(roomId) {
  const room = getRoomById(roomId);
  if (!room) return null;
  const settings = JSON.parse(room.settings || "{}");
  const winMetric = ["score", "missions", "votes"].includes(settings.winMetric) ? settings.winMetric : "score";
  const players = db.prepare(`SELECT p.id, p.name, r.name AS role, r.team,
    COALESCE((SELECT SUM(points) FROM score_ledger s WHERE s.participant_id = p.id AND s.room_id = ?), 0) AS score,
    (SELECT COUNT(*) FROM missions m WHERE m.participant_id = p.id AND m.room_id = ? AND m.status = 'completed') AS completed_missions,
    (SELECT COUNT(*) FROM votes v WHERE v.target_id = p.id AND v.room_id = ?) AS votes_received
    FROM participants p LEFT JOIN game_roles r ON (r.id = p.role AND r.room_id = p.room_id)
    WHERE p.room_id = ? ORDER BY p.name`).all(roomId, roomId, roomId, roomId);
  
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
    ? rankedTeams.filter((t) => t[metricField] === rankedTeams[0][metricField]).map((t) => t.team)
    : [];
  return {
    winMetric,
    teams: rankedTeams,
    winningTeams: leaders,
    players: [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "it")),
    totalParticipants: players.length,
    totalVotes: db.prepare("SELECT COUNT(*) AS count FROM votes WHERE room_id = ?").get(roomId).count,
    completedMissions: db.prepare("SELECT COUNT(*) AS count FROM missions WHERE room_id = ? AND status = 'completed'").get(roomId).count,
  };
}

function applyDeadlineFailures(room) {
  if (!room || room.status !== "running" || !room.turn_started_at) return;
  const settings = JSON.parse(room.settings || "{}");
  if (settings.deadlineFailure !== true) return;
  const duration = (settings.turnDurationMinutes || 30) * 60000;
  if (Date.now() - new Date(room.turn_started_at).getTime() < duration) return;
  const expired = db.prepare(`SELECT id, participant_id, title FROM missions
    WHERE room_id = ? AND turn_number = ? AND status IN ('assigned', 'active')`).all(room.id, room.current_turn);
  if (!expired.length) return;
  const now = new Date().toISOString();
  const failMission = db.prepare(`UPDATE missions SET status = 'rejected',
    review_note = 'Missione non completata entro la scadenza configurata.', reviewed_at = ?
    WHERE id = ? AND status IN ('assigned', 'active') AND room_id = ?`);
  for (const mission of expired) {
    const result = failMission.run(now, mission.id, room.id);
    if (result.changes) logAction(room.id, "system", "mission_deadline_failed", { missionId: mission.id, participantId: mission.participant_id });
  }
}

function autoBalanceRoles(roomId) {
  const pCount = db.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ?").get(roomId).count;
  const roles = db.prepare("SELECT id, name FROM game_roles WHERE room_id = ? ORDER BY id").all(roomId);
  let sabotatori = 0;
  let sentinelle = 0;
  let veggente = 0;
  let malcapitati = 0;

  if (pCount <= 2) {
    sabotatori = Math.min(pCount, 1);
    sentinelle = Math.max(0, pCount - sabotatori);
  } else if (pCount === 3) {
    sabotatori = 1;
    sentinelle = 1;
    veggente = 1;
  } else {
    veggente = roles.some((r) => r.id === "veggente") ? 1 : 0;
    sabotatori = Math.max(1, Math.round(pCount * 0.18));
    sentinelle = Math.max(1, Math.round(pCount * 0.20));
    malcapitati = Math.max(0, pCount - (sabotatori + sentinelle + veggente));
  }

  const updates = {
    sentinella: sentinelle,
    sabotatore: sabotatori,
    veggente: veggente,
    malcapitato: malcapitati,
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const updateTarget = db.prepare("UPDATE game_roles SET target_count = ? WHERE room_id = ? AND id = ?");
    for (const [roleId, count] of Object.entries(updates)) {
      updateTarget.run(count, roomId, roleId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return updates;
}

function shuffleRolesForRoom(roomId) {
  const participants = db.prepare("SELECT id, name FROM participants WHERE room_id = ? ORDER BY name").all(roomId);
  if (participants.length === 0) {
    throw new Error("Nessun partecipante nella stanza per eseguire il sorteggio.");
  }
  let roles = db.prepare("SELECT id, name, target_count FROM game_roles WHERE room_id = ?").all(roomId);
  const targetTotal = roles.reduce((sum, r) => sum + (r.target_count || 0), 0);
  if (targetTotal !== participants.length) {
    autoBalanceRoles(roomId);
    roles = db.prepare("SELECT id, name, target_count FROM game_roles WHERE room_id = ?").all(roomId);
  }

  const pool = [];
  for (const r of roles) {
    for (let i = 0; i < r.target_count; i++) pool.push(r.id);
  }

  if (pool.length < participants.length) {
    const diff = participants.length - pool.length;
    const defaultRole = roles.find((r) => r.id === "malcapitato")?.id || roles[0]?.id;
    for (let i = 0; i < diff; i++) pool.push(defaultRole);
  } else if (pool.length > participants.length) {
    pool.length = participants.length;
  }

  // Modern Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const updateRole = db.prepare("UPDATE participants SET role = ? WHERE id = ? AND room_id = ?");
    for (let i = 0; i < participants.length; i++) {
      updateRole.run(pool[i], participants[i].id, roomId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return participants.map((p, i) => ({ id: p.id, name: p.name, role: pool[i] }));
}

function randomBatchMissions(roomId, currentTurn) {
  const participants = db.prepare("SELECT id, name FROM participants WHERE room_id = ?").all(roomId);
  if (participants.length === 0) throw new Error("Nessun partecipante a cui assegnare missioni.");

  const templates = [...HALLOWEEN_MISSION_TEMPLATES];
  for (let i = templates.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [templates[i], templates[j]] = [templates[j], templates[i]];
  }

  const insert = db.prepare(`INSERT INTO missions
    (id, room_id, title, description, objective, rules, verification, score, turn_number, participant_id, status, proof, review_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', '', '', ?)`);

  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < participants.length; i++) {
      const template = templates[i % templates.length];
      insert.run(
        crypto.randomUUID(), roomId, template.title, template.description,
        template.objective, template.rules, template.verification, template.score,
        currentTurn, participants[i].id, new Date().toISOString()
      );
      count++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return count;
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces).flat().filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item.address);
}

// ----------------------------------------------------
// MAIN SERVER ROUTER
// ----------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let route = `${req.method} ${url.pathname}`;

  try {
    // --------------------------------------------------
    // PUBLIC / STATUS
    // --------------------------------------------------
    if (route === "GET /api/status") {
      const room = resolveRoom(req, url);
      return sendJson(res, 200, {
        started: Boolean(room?.started_at),
        roomCode: room?.code || "H4LL0",
        addresses: getLanAddresses(),
        port: PORT,
      });
    }

    // --------------------------------------------------
    // AUTHENTICATION (USERS / GAME MASTERS)
    // --------------------------------------------------
    if (route === "POST /api/auth/register") {
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!username || username.length < 3 || username.length > 30) {
        return sendJson(res, 400, { error: "Lo username deve contenere tra 3 e 30 caratteri." });
      }
      if (!password || password.length < 6) {
        return sendJson(res, 400, { error: "La password deve contenere almeno 6 caratteri." });
      }
      const existing = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
      if (existing) {
        return sendJson(res, 409, { error: "Username già registrato. Scegline un altro." });
      }
      const userId = crypto.randomUUID();
      const passwordHash = hashPassword(password);
      db.prepare("INSERT INTO users (id, username, password_hash, is_supervisor, created_at) VALUES (?, ?, ?, 0, ?)").run(
        userId, username, passwordHash, new Date().toISOString()
      );
      const token = crypto.randomBytes(32).toString("base64url");
      userSessions.set(token, userId);
      saveSession(token, "user", { userId });
      return sendJson(res, 201, { token, user: { id: userId, username, is_supervisor: false } });
    }

    if (route === "POST /api/auth/login") {
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: "Username o password non corretti." });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      userSessions.set(token, user.id);
      saveSession(token, "user", { userId: user.id });
      return sendJson(res, 200, { token, user: { id: user.id, username: user.username, is_supervisor: Boolean(user.is_supervisor) } });
    }

    if (route === "GET /api/auth/me") {
      const userId = getUserId(req);
      if (!userId) return sendJson(res, 401, { error: "Non autenticato." });
      const user = db.prepare("SELECT id, username, is_supervisor, created_at FROM users WHERE id = ?").get(userId);
      if (!user) return sendJson(res, 404, { error: "Utente non trovato." });
      return sendJson(res, 200, { user: { id: user.id, username: user.username, is_supervisor: Boolean(user.is_supervisor), created_at: user.created_at } });
    }

    if (route === "POST /api/auth/logout") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token) {
        userSessions.delete(token);
        judgeSessions.delete(token);
        removeSession(token);
      }
      return sendJson(res, 200, { ok: true });
    }

    // Legacy Judge Login Support
    if (route === "POST /api/judge/login") {
      const body = await readJson(req);
      const inputPass = String(body.password || "");
      // Check default admin user or legacy password
      const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
      const valid = (admin && verifyPassword(inputPass, admin.password_hash)) || inputPass === judgePassword;
      if (!valid) return sendJson(res, 401, { error: "Password giudice non corretta." });
      const token = crypto.randomBytes(32).toString("base64url");
      const activeAdminId = admin?.id || defaultUser.id;
      judgeSessions.set(token, { userId: activeAdminId, activeRoomId: defaultRoom.id });
      saveSession(token, "judge", { userId: activeAdminId, roomId: defaultRoom.id });
      return sendJson(res, 200, { token });
    }

    // --------------------------------------------------
    // SUPERVISOR CONSOLE (GLOBAL PLATFORM ROOM ACCESS)
    // --------------------------------------------------
    if (route === "GET /api/supervisor/rooms") {
      if (!requireSupervisor(req, res)) return;
      const rooms = db.prepare(`SELECT r.*,
        u.username AS owner_username,
        (SELECT COUNT(*) FROM participants p WHERE p.room_id = r.id) AS participant_count,
        (SELECT COUNT(*) FROM missions m WHERE m.room_id = r.id) AS mission_count
        FROM rooms r
        LEFT JOIN users u ON u.id = r.owner_id
        ORDER BY r.created_at DESC`).all();
      return sendJson(res, 200, { rooms });
    }

    const supervisorRoomDeleteMatch = route.match(/^DELETE \/api\/supervisor\/rooms\/([^/]+)\/?$/);
    if (supervisorRoomDeleteMatch) {
      if (!requireSupervisor(req, res)) return;
      const code = decodeURIComponent(supervisorRoomDeleteMatch[1]);
      const room = getRoomByCode(code);
      if (!room) return sendJson(res, 404, { error: "Stanza non trovata." });
      db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
      logAction(room.id, "supervisor", "room_deleted_by_supervisor", { code: room.code, name: room.name });
      return sendJson(res, 200, { ok: true });
    }

    // --------------------------------------------------
    // MULTI-ROOM MANAGEMENT
    // --------------------------------------------------
    if (route === "GET /api/rooms") {
      const userId = requireUser(req, res);
      if (!userId) return;
      const rooms = db.prepare(`SELECT r.*,
        (SELECT COUNT(*) FROM participants p WHERE p.room_id = r.id) AS participant_count
        FROM rooms r WHERE r.owner_id = ? ORDER BY r.created_at DESC`).all(userId);
      return sendJson(res, 200, { rooms });
    }

    if (route === "POST /api/rooms") {
      const userId = requireUser(req, res);
      if (!userId) return;
      const body = await readJson(req);
      const name = String(body.name || "Nuova Stanza").trim().slice(0, 60);
      const code = generateRoomCode();
      const roomId = crypto.randomUUID();
      db.prepare(`INSERT INTO rooms
        (id, code, name, owner_id, status, settings, current_turn, roles_revealed, vote_open, vote_limit, created_at)
        VALUES (?, ?, ?, ?, 'setup', '{}', 0, 0, 0, 1, ?)`).run(
        roomId, code, name, userId, new Date().toISOString()
      );
      seedRoomRoles(roomId);
      logAction(roomId, "judge", "room_created", { name, code });
      return sendJson(res, 201, {
        room: { id: roomId, code, name, status: "setup", created_at: new Date().toISOString() },
      });
    }

    const roomGetMatch = route.match(/^GET \/api\/rooms\/([^/]+)\/?$/);
    if (roomGetMatch) {
      const code = decodeURIComponent(roomGetMatch[1]);
      const room = getRoomByCode(code);
      if (!room) return sendJson(res, 404, { error: "Stanza non trovata." });
      const count = db.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ?").get(room.id).count;
      return sendJson(res, 200, {
        room: { id: room.id, code: room.code, name: room.name, status: room.status, participant_count: count },
      });
    }

    const roomDeleteMatch = route.match(/^DELETE \/api\/rooms\/([^/]+)\/?$/);
    if (roomDeleteMatch) {
      const userId = requireUser(req, res);
      if (!userId) return;
      const code = decodeURIComponent(roomDeleteMatch[1]);
      const room = getRoomByCode(code);
      if (!room) return sendJson(res, 404, { error: "Stanza non trovata." });
      if (room.owner_id !== userId && !isSupervisor(req)) {
        return sendJson(res, 403, { error: "Non sei autorizzato a eliminare questa stanza." });
      }
      db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
      logAction(room.id, isSupervisor(req) ? "supervisor" : "judge", "room_deleted", { code: room.code, name: room.name });
      return sendJson(res, 200, { ok: true });
    }

    // --------------------------------------------------
    // PLAYER JOIN (LOBBY WITH CODE + PLAYER PIN / PASSWORD)
    // --------------------------------------------------
    if (route.match(/^POST \/api\/rooms\/[^/]+\/join\/?$/) || route === "POST /api/player/join") {
      const body = await readJson(req);
      const rawCode = route.match(/^POST \/api\/rooms\/([^/]+)\/join\/?$/)?.[1] || body.roomCode || body.code;
      const code = rawCode ? decodeURIComponent(rawCode).trim().toUpperCase() : "";
      const room = getRoomByCode(code);
      if (!room) return sendJson(res, 404, { error: "Codice stanza inesistente. Verifica il codice a 5 lettere." });

      const pin = body.pin ? String(body.pin).trim() : (body.password ? String(body.password).trim() : null);
      const name = body.name ? String(body.name).trim() : null;

      let participant = null;

      // 1. Direct login by PIN/Password (primary method intended by Game Master)
      if (pin) {
        participant = db.prepare("SELECT * FROM participants WHERE room_id = ? AND LOWER(TRIM(pin)) = LOWER(TRIM(?))").get(room.id, pin);
      }

      // 2. Fallback: Search by Name in this room (if PIN was omitted or didn't match directly)
      if (!participant && name) {
        const byName = db.prepare("SELECT * FROM participants WHERE room_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))").get(room.id, name);
        if (byName) {
          if (byName.pin && pin && byName.pin.toLowerCase().trim() !== pin.toLowerCase()) {
            return sendJson(res, 401, { error: "Questo nome è già presente e la Password / PIN inserita non è corretta." });
          }
          participant = byName;
          if (!participant.pin && pin) {
            db.prepare("UPDATE participants SET pin = ? WHERE id = ?").run(pin, participant.id);
            participant.pin = pin;
          }
        }
      }

      // 3. Handle not found or auto-create fallback (for tests / legacy self-registration)
      if (!participant) {
        const totalParticipants = db.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ?").get(room.id).count;
        if (!name && pin) {
          if (totalParticipants === 0) {
            return sendJson(res, 404, { error: "Il Game Master non ha ancora inserito partecipanti in questa stanza. Attendi che il Master ti configuri." });
          }
          return sendJson(res, 401, { error: "Password / PIN non valida per questa stanza. Verifica il codice fornito dal Game Master." });
        }

        if (name) {
          if (room.status !== "setup") {
            return sendJson(res, 409, { error: "La partita è già iniziata e non accetta nuovi ingressi." });
          }
          const participantId = crypto.randomUUID();
          const assignedPin = pin || generateUniqueParticipantPin(room.id);
          db.prepare("INSERT INTO participants (id, room_id, name, role, pin, created_at) VALUES (?, ?, ?, NULL, ?, ?)").run(
            participantId, room.id, name, assignedPin, new Date().toISOString()
          );
          participant = { id: participantId, room_id: room.id, name, role: null, pin: assignedPin };
          logAction(room.id, "player", "player_joined", { name, pin: assignedPin });
        } else {
          return sendJson(res, 400, { error: "Inserisci la Password / PIN fornita dal tuo Game Master." });
        }
      }

      const token = crypto.randomBytes(32).toString("base64url");
      playerSessions.set(token, { participantId: participant.id, roomId: room.id });
      saveSession(token, "player", { participantId: participant.id, roomId: room.id });
      logAction(room.id, "player", "player_logged_in", { name: participant.name, id: participant.id });

      return sendJson(res, 200, {
        token,
        participant: { id: participant.id, name: participant.name, role: participant.role || null },
        room: { code: room.code, name: room.name, status: room.status },
      });
    }

    // Legacy player login with code
    if (route === "POST /api/player/login") {
      const body = await readJson(req);
      const code = String(body.code || "").trim();
      const allParticipants = db.prepare("SELECT id, room_id, name, role FROM participants").all();
      const match = allParticipants.find((p) => playerCode(p.id) === code);
      if (!match) return sendJson(res, 401, { error: "Codice giocatore non riconosciuto." });
      const token = crypto.randomBytes(32).toString("base64url");
      playerSessions.set(token, { participantId: match.id, roomId: match.room_id });
      saveSession(token, "player", { participantId: match.id, roomId: match.room_id });
      return sendJson(res, 200, { token });
    }

    if (route === "GET /api/player/me") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const session = playerSessions.get(token);
      if (!session) return sendJson(res, 401, { error: "Accesso giocatore richiesto." });
      const { participantId, roomId } = session;
      const room = getRoomById(roomId);
      if (!room || !room.started_at) {
        return sendJson(res, 409, { error: "La partita non è ancora iniziata." });
      }
      const participant = db.prepare("SELECT * FROM participants WHERE id = ? AND room_id = ?").get(participantId, roomId);
      if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });
      const role = participant.role
        ? db.prepare("SELECT name FROM game_roles WHERE id = ? AND room_id = ?").get(participant.role, roomId)
        : null;
      return sendJson(res, 200, {
        name: participant.name,
        role: role ? role.name : null,
      });
    }

    // --------------------------------------------------
    // PLAYER DASHBOARD & ACTIONS
    // --------------------------------------------------
    if (route === "GET /api/player/dashboard" || route.match(/^GET \/api\/rooms\/[^/]+\/player\/dashboard$/)) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const session = playerSessions.get(token);
      if (!session) return sendJson(res, 401, { error: "Accesso giocatore richiesto." });
      const { participantId, roomId } = session;
      const room = getRoomById(roomId);
      if (!room) return sendJson(res, 404, { error: "Stanza non trovata." });
      const participant = db.prepare("SELECT * FROM participants WHERE id = ? AND room_id = ?").get(participantId, roomId);
      if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });

      // Sala d'Attesa (Waiting Room) se la partita è ancora in preparazione
      if (room.status === "setup" || !room.started_at) {
        const allInRoom = db.prepare("SELECT id, name FROM participants WHERE room_id = ? ORDER BY name").all(roomId);
        return sendJson(res, 200, {
          waiting: true,
          roomCode: room.code,
          roomName: room.name,
          participant: { id: participant.id, name: participant.name },
          participantsCount: allInRoom.length,
          players: allInRoom.map((p) => ({
            id: p.id,
            name: p.name,
            online: [...playerSessions.values()].some((s) => s.participantId === p.id),
          })),
        });
      }

      applyDeadlineFailures(room);
      const role = participant.role
        ? db.prepare("SELECT * FROM game_roles WHERE id = ? AND room_id = ?").get(participant.role, roomId)
        : null;

      // Fix Alleati: Solo fazioni cospiratrici/operative vedono i compagni; mai Malcapitati o Veggente!
      const isHiddenInnocent = !role || !role.team || role.team.toLowerCase() === "malcapitati" || role.id === "veggente";
      const allies = !isHiddenInnocent && role.team
        ? db.prepare(`SELECT name FROM participants WHERE room_id = ? AND role IN (SELECT id FROM game_roles WHERE room_id = ? AND LOWER(team) = LOWER(?)) AND id != ? ORDER BY name`)
            .all(roomId, roomId, role.team, participant.id)
            .map((r) => r.name)
        : [];

      const missions = db.prepare("SELECT * FROM missions WHERE participant_id = ? AND room_id = ? ORDER BY created_at DESC").all(participant.id, roomId);
      const messages = db.prepare(`SELECT m.* FROM messages m
        WHERE m.room_id = ? AND (
          m.participant_id = ? OR 
          (m.sender = 'judge' AND m.participant_id IS NULL AND (m.team IS NULL OR m.team = ?))
        ) ORDER BY m.created_at ASC LIMIT 100`).all(roomId, participant.id, role?.team || null);
      const actions = db.prepare("SELECT * FROM secret_actions WHERE participant_id = ? AND room_id = ? ORDER BY created_at DESC").all(participant.id, roomId);
      const settings = JSON.parse(room.settings || "{}");
      const candidates = db.prepare("SELECT id, name FROM participants WHERE room_id = ? AND id != ? ORDER BY name").all(roomId, participant.id);
      const myVotes = db.prepare("SELECT target_id FROM votes WHERE room_id = ? AND voter_id = ?").all(roomId, participant.id).map((v) => v.target_id);

      const roleObj = role ? {
        id: role.id,
        name: role.name,
        team: role.team,
        description: role.description,
        objectives: role.objectives,
        rules: role.rules,
        actions: role.actions ? role.actions.split("\n").filter(Boolean) : [],
      } : null;

      const gameObj = {
        id: room.id,
        code: room.code,
        name: room.name,
        status: room.status,
        currentTurn: room.current_turn,
        turnCount: settings.turnCount || 1,
        turnStartedAt: room.turn_started_at,
        pausedRemainingMs: room.paused_remaining_ms,
        turnDurationMinutes: settings.turnDurationMinutes || 30,
        rolesRevealed: Boolean(room.roles_revealed),
        voteOpen: Boolean(room.vote_open),
        voteLimit: room.vote_limit,
        winMetric: settings.winMetric || "score",
        rules: settings.rules || "",
        winConditions: settings.winConditions || "",
      };

      return sendJson(res, 200, {
        waiting: false,
        game: gameObj,
        room: gameObj,
        participant: {
          id: participant.id,
          name: participant.name,
          role: roleObj,
          score: personalScore(participant.id, roomId),
        },
        role: roleObj,
        score: personalScore(participant.id, roomId),
        allies,
        missions,
        messages,
        actions,
        candidates,
        myVotes,
        summary: room.roles_revealed ? finalGameSummary(roomId) : null,
        finalResults: room.roles_revealed ? finalGameSummary(roomId) : null,
      });
    }

    if (route === "POST /api/player/messages") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const session = playerSessions.get(token);
      if (!session) return sendJson(res, 401, { error: "Accesso giocatore richiesto." });
      const body = await readJson(req);
      const messageText = String(body.body || "").trim();
      const subject = String(body.subject || "").trim().slice(0, 100);
      const kind = ["message", "report"].includes(body.kind) ? body.kind : "message";
      const attachment = body.attachment ? String(body.attachment) : null;
      if (!messageText && !attachment) return sendJson(res, 400, { error: "Il messaggio o una foto è obbligatorio." });
      const msgId = crypto.randomUUID();
      db.prepare(`INSERT INTO messages (id, room_id, participant_id, sender, kind, subject, body, attachment, status, created_at)
        VALUES (?, ?, ?, 'player', ?, ?, ?, ?, 'pending', ?)`).run(
        msgId, session.roomId, session.participantId, kind, subject, messageText, attachment, new Date().toISOString()
      );
      logAction(session.roomId, "player", "player_message", { kind, hasAttachment: Boolean(attachment) });
      return sendJson(res, 201, { ok: true, id: msgId });
    }

    if (route === "POST /api/player/actions") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const session = playerSessions.get(token);
      if (!session) return sendJson(res, 401, { error: "Accesso giocatore richiesto." });
      const body = await readJson(req);
      const title = String(body.title || "").trim();
      const details = String(body.details || "").trim();
      if (!title) return sendJson(res, 400, { error: "Inserisci un titolo per l'azione segreta." });

      const participant = db.prepare("SELECT role FROM participants WHERE id = ? AND room_id = ?").get(session.participantId, session.roomId);
      if (participant?.role) {
        const role = db.prepare("SELECT actions FROM game_roles WHERE id = ? AND room_id = ?").get(participant.role, session.roomId);
        if (role && role.actions && role.actions.trim()) {
          const allowed = role.actions.split("\n").map((a) => a.trim().toLowerCase()).filter(Boolean);
          if (allowed.length > 0 && !allowed.includes(title.toLowerCase())) {
            return sendJson(res, 403, { error: "Azione non consentita per il tuo ruolo." });
          }
        }
      }

      db.prepare(`INSERT INTO secret_actions (id, room_id, participant_id, title, details, status, score, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`).run(
        crypto.randomUUID(), session.roomId, session.participantId, title, details, new Date().toISOString()
      );
      return sendJson(res, 201, { ok: true });
    }

    if (route === "POST /api/player/vote") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const session = playerSessions.get(token);
      if (!session) return sendJson(res, 401, { error: "Accesso giocatore richiesto." });
      const room = getRoomById(session.roomId);
      if (!room || !room.vote_open) return sendJson(res, 409, { error: "Le votazioni sono attualmente chiuse." });
      const alreadyVoted = db.prepare("SELECT 1 FROM votes WHERE room_id = ? AND voter_id = ?").get(session.roomId, session.participantId);
      if (alreadyVoted) return sendJson(res, 409, { error: "Hai già espresso il tuo voto per questa sessione." });
      const body = await readJson(req);
      const targets = Array.isArray(body.targets) ? [...new Set(body.targets)] : [];
      if (!targets.length) return sendJson(res, 400, { error: "Seleziona almeno un sospetto." });
      if (targets.length > room.vote_limit) return sendJson(res, 400, { error: `Puoi votare al massimo ${room.vote_limit} sospetti.` });
      if (targets.includes(session.participantId)) return sendJson(res, 400, { error: "Non puoi votare te stesso." });

      db.exec("BEGIN IMMEDIATE");
      try {
        const insertVote = db.prepare("INSERT INTO votes (room_id, voter_id, target_id, created_at) VALUES (?, ?, ?, ?)");
        const now = new Date().toISOString();
        for (const targetId of targets) {
          insertVote.run(session.roomId, session.participantId, targetId, now);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return sendJson(res, 201, { ok: true });
    }

    if (route.startsWith("POST /api/player/missions/")) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const session = playerSessions.get(token);
      if (!session) return sendJson(res, 401, { error: "Accesso giocatore richiesto." });
      const parts = url.pathname.split("/");
      const missionId = decodeURIComponent(parts[4]);
      const action = parts[5];
      const mission = db.prepare("SELECT * FROM missions WHERE id = ? AND participant_id = ? AND room_id = ?").get(missionId, session.participantId, session.roomId);
      if (!mission) return sendJson(res, 404, { error: "Missione non trovata." });
      const body = await readJson(req);

      if (action === "start") {
        db.prepare("UPDATE missions SET status = 'active' WHERE id = ? AND status = 'assigned'").run(missionId);
      } else if (action === "submit") {
        const proof = String(body.proof || "").trim();
        const proofAttachment = body.proofAttachment ? String(body.proofAttachment) : null;
        if (!proof && !proofAttachment) return sendJson(res, 400, { error: "Inserisci una prova o una foto del completamento." });
        db.prepare("UPDATE missions SET status = 'submitted', proof = ?, proof_attachment = ?, submitted_at = ? WHERE id = ?").run(
          proof, proofAttachment, new Date().toISOString(), missionId
        );
      }
      return sendJson(res, 200, { ok: true });
    }

    if (route === "POST /api/player/logout") {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token) {
        playerSessions.delete(token);
        removeSession(token);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (route === "GET /api/judge/mission-templates" || route.match(/\/judge\/mission-templates$/)) {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!token || (!userSessions.has(token) && !judgeSessions.has(token))) {
        return sendJson(res, 401, { error: "Accesso giudice richiesto." });
      }
      return sendJson(res, 200, { templates: HALLOWEEN_MISSION_TEMPLATES });
    }

    // --------------------------------------------------
    // JUDGE / GAME MASTER ENDPOINTS (MULTI-ROOM SUPPORT)
    // --------------------------------------------------
    if (url.pathname.includes("/judge") || url.pathname.startsWith("/api/judge/")) {
      const room = resolveRoom(req, url);
      if (!room) return sendJson(res, 404, { error: "Stanza non trovata." });
      if (!requireJudge(req, res, room)) return;

      // Normalize route string so /api/rooms/:code/judge/... and /api/judge/... share code
      let judgeAction = route;
      if (route.includes("/judge")) {
        const idx = route.indexOf("/judge");
        judgeAction = `${req.method} /api/judge${route.slice(idx + 6)}`;
      }

      if (judgeAction === "GET /api/judge/state") {
        applyDeadlineFailures(room);
        const state = getValidation(room.id);
        const history = db.prepare("SELECT participant_name, old_role, new_role, reason, changed_at FROM role_history WHERE room_id = ? ORDER BY id DESC LIMIT 100").all(room.id);
        const participants = state.participants.map((p) => ({
          ...p,
          accessCode: playerCode(p.id),
          score: personalScore(p.id, room.id),
          online: [...playerSessions.values()].some((s) => s.participantId === p.id),
        }));
        const missions = db.prepare(`SELECT m.*, p.name AS participant_name
          FROM missions m JOIN participants p ON p.id = m.participant_id
          WHERE m.room_id = ? ORDER BY m.created_at DESC`).all(room.id);
        const messages = db.prepare(`SELECT m.*, p.name AS participant_name
          FROM messages m LEFT JOIN participants p ON p.id = m.participant_id
          WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT 200`).all(room.id);
        const actions = db.prepare(`SELECT a.*, p.name AS participant_name
          FROM secret_actions a JOIN participants p ON p.id = a.participant_id
          WHERE a.room_id = ? ORDER BY a.created_at DESC`).all(room.id);
        const votes = room.vote_open ? [] : db.prepare(`SELECT v.target_id, COUNT(*) AS count, p.name
          FROM votes v JOIN participants p ON p.id = v.target_id
          WHERE v.room_id = ? GROUP BY v.target_id ORDER BY count DESC, p.name`).all(room.id);

        return sendJson(res, 200, {
          ...state,
          room: {
            id: room.id,
            code: room.code,
            name: room.name,
            status: room.status,
            ownerId: room.owner_id,
          },
          participants,
          started: Boolean(room.started_at),
          startedAt: room.started_at,
          history,
          roles: getRoleNames(room.id),
          rolesDetailed: state.roles,
          limits: state.targets,
          settings: JSON.parse(room.settings || "{}"),
          game: {
            status: room.status,
            currentTurn: room.current_turn,
            turnStartedAt: room.turn_started_at,
            pausedRemainingMs: room.paused_remaining_ms,
            rolesRevealed: Boolean(room.roles_revealed),
            voteOpen: Boolean(room.vote_open),
            voteLimit: room.vote_limit,
          },
          missions,
          messages,
          actions,
          votes,
          finalSummary: finalGameSummary(room.id),
          audit: db.prepare("SELECT actor, action, details, created_at FROM audit_log WHERE room_id = ? ORDER BY id DESC LIMIT 100").all(room.id),
        });
      }

      // SMART AUTO-BALANCE
      if (judgeAction === "POST /api/judge/auto-balance") {
        if (room.started_at) return sendJson(res, 409, { error: "Non puoi ribilanciare i ruoli a partita già iniziata." });
        const targets = autoBalanceRoles(room.id);
        logAction(room.id, "judge", "roles_auto_balanced", targets);
        return sendJson(res, 200, { ok: true, targets });
      }

      // SMART SHUFFLE ROLES
      if (judgeAction === "POST /api/judge/shuffle-roles") {
        if (room.started_at) return sendJson(res, 409, { error: "Non puoi sorteggiare i ruoli a partita già iniziata." });
        const assignments = shuffleRolesForRoom(room.id);
        logAction(room.id, "judge", "roles_shuffled", { count: assignments.length });
        return sendJson(res, 200, { ok: true, assignments });
      }

      // SMART MISSION TEMPLATES
      if (judgeAction === "GET /api/judge/mission-templates") {
        return sendJson(res, 200, { templates: HALLOWEEN_MISSION_TEMPLATES });
      }

      // SMART RANDOM BATCH MISSIONS
      if (judgeAction === "POST /api/judge/missions/random-batch") {
        const assigned = randomBatchMissions(room.id, room.current_turn || 1);
        logAction(room.id, "judge", "missions_batch_assigned", { count: assigned });
        return sendJson(res, 200, { ok: true, assignedCount: assigned });
      }

      // SETTINGS
      if (judgeAction === "PUT /api/judge/settings") {
        if (room.started_at) return sendJson(res, 409, { error: "Le regole di base non si possono modificare dopo l'inizio." });
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
        db.prepare("UPDATE rooms SET settings = ?, vote_limit = ? WHERE id = ?").run(JSON.stringify(settings), voteLimit, room.id);
        logAction(room.id, "judge", "game_settings_updated", settings);
        return sendJson(res, 200, { ok: true });
      }

      // PARTICIPANTS CRUD
      if (judgeAction === "POST /api/judge/participants") {
        if (room.started_at) return sendJson(res, 409, { error: "I partecipanti non si possono aggiungere dopo l'inizio." });
        const body = await readJson(req);
        const name = String(body.name || "").trim();
        if (!name || name.length > 60) return sendJson(res, 400, { error: "Inserisci un nome da 1 a 60 caratteri." });
        const dup = db.prepare("SELECT 1 FROM participants WHERE room_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))").get(room.id, name);
        if (dup) return sendJson(res, 409, { error: "Questo nome è già presente nell'elenco." });

        let pin = body.pin ? String(body.pin).trim() : null;
        if (pin) {
          const pinDup = db.prepare("SELECT 1 FROM participants WHERE room_id = ? AND LOWER(TRIM(pin)) = LOWER(TRIM(?))").get(room.id, pin);
          if (pinDup) return sendJson(res, 409, { error: "Questa Password / PIN è già assegnata a un altro partecipante." });
        } else {
          pin = generateUniqueParticipantPin(room.id);
        }

        const participantId = crypto.randomUUID();
        db.prepare("INSERT INTO participants (id, room_id, name, role, pin, created_at) VALUES (?, ?, ?, NULL, ?, ?)").run(
          participantId, room.id, name, pin, new Date().toISOString()
        );
        logAction(room.id, "judge", "participant_added", { name, pin });
        return sendJson(res, 201, { ok: true, participant: { id: participantId, name, pin } });
      }

      if (judgeAction.startsWith("PATCH /api/judge/participants/")) {
        const id = decodeURIComponent(judgeAction.replace(/^PATCH \/api\/judge\/participants\//, "").replace(/\/+$/, ""));
        const participant = db.prepare("SELECT * FROM participants WHERE id = ? AND room_id = ?").get(id, room.id);
        if (!participant) return sendJson(res, 404, { error: "Partecipante non trovato." });
        const body = await readJson(req);
        const newName = body.name ? String(body.name).trim() : participant.name;
        const newRole = body.role !== undefined ? (body.role || null) : participant.role;
        const selectedRole = newRole ? db.prepare("SELECT * FROM game_roles WHERE id = ? AND room_id = ?").get(newRole, room.id) : null;
        if (newRole && !selectedRole) return sendJson(res, 400, { error: "Ruolo selezionato non valido." });

        let newPin = participant.pin;
        if (body.pin !== undefined) {
          const pinVal = String(body.pin || "").trim();
          if (pinVal) {
            const pinDup = db.prepare("SELECT 1 FROM participants WHERE room_id = ? AND id != ? AND LOWER(TRIM(pin)) = LOWER(TRIM(?))").get(room.id, id, pinVal);
            if (pinDup) return sendJson(res, 409, { error: "Questa Password / PIN è già usata da un altro giocatore." });
            newPin = pinVal;
          } else {
            newPin = generateUniqueParticipantPin(room.id);
          }
        }

        if (room.started_at && !String(body.reason || "").trim()) {
          return sendJson(res, 400, { error: "Per una modifica eccezionale dopo l'inizio, inserisci il motivo." });
        }
        if (newRole !== null && newRole !== participant.role) {
          const current = db.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ? AND role = ?").get(room.id, newRole).count;
          if (current >= selectedRole.target_count) return sendJson(res, 409, { error: `Quantità prevista raggiunta per ${selectedRole.name}.` });
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET name = ?, role = ?, pin = ? WHERE id = ? AND room_id = ?").run(newName, newRole, newPin, id, room.id);
          if (newRole !== participant.role) {
            db.prepare(`INSERT INTO role_history (room_id, participant_id, participant_name, old_role, new_role, reason, changed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
              room.id, id, newName, participant.role, newRole,
              room.started_at ? String(body.reason).trim() : "Assegnazione manuale prima dell'inizio",
              new Date().toISOString()
            );
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true, participant: { id, name: newName, role: newRole, pin: newPin } });
      }

      if (judgeAction === "DELETE /api/judge/participants/all" || judgeAction === "POST /api/judge/participants/clear") {
        const force = url.searchParams.get("force") === "true";
        if (room.status === "running" && room.current_turn > 0 && !force) {
          return sendJson(res, 409, { error: "La partita è già in corso con turni attivi. Usa 'Nuova Partita' per azzerarla." });
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM messages WHERE room_id = ? AND participant_id IS NOT NULL").run(room.id);
          db.prepare("DELETE FROM missions WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM secret_actions WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM votes WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM score_ledger WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM role_history WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM participants WHERE room_id = ?").run(room.id);
          logAction(room.id, "judge", "all_participants_cleared");
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction.startsWith("DELETE /api/judge/participants/")) {
        const force = url.searchParams.get("force") === "true";
        if (room.status === "running" && room.current_turn > 0 && !force) {
          return sendJson(res, 409, { error: "I partecipanti non si possono rimuovere durante un turno in corso." });
        }
        const id = decodeURIComponent(judgeAction.replace(/^DELETE \/api\/judge\/participants\//, "").replace(/\/+$/, ""));
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM messages WHERE room_id = ? AND participant_id = ?").run(room.id, id);
          db.prepare("DELETE FROM missions WHERE room_id = ? AND participant_id = ?").run(room.id, id);
          db.prepare("DELETE FROM secret_actions WHERE room_id = ? AND participant_id = ?").run(room.id, id);
          db.prepare("DELETE FROM votes WHERE room_id = ? AND (voter_id = ? OR target_id = ?)").run(room.id, id, id);
          db.prepare("DELETE FROM score_ledger WHERE room_id = ? AND participant_id = ?").run(room.id, id);
          db.prepare("DELETE FROM role_history WHERE room_id = ? AND participant_id = ?").run(room.id, id);
          const result = db.prepare("DELETE FROM participants WHERE id = ? AND room_id = ?").run(id, room.id);
          if (!result.changes) {
            db.exec("ROLLBACK");
            return sendJson(res, 404, { error: "Partecipante non trovato." });
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      // ROLES CRUD
      if (judgeAction === "PUT /api/judge/role-configuration") {
        if (room.started_at) return sendJson(res, 409, { error: "La composizione dei ruoli non si può modificare dopo l'inizio." });
        const body = await readJson(req);
        const targets = body.targets;
        const roleIds = getRoles(room.id).map((r) => r.id);
        if (!targets || typeof targets !== "object" || Array.isArray(targets)
          || roleIds.some((r) => !Object.hasOwn(targets, r))
          || Object.values(targets).some((n) => !Number.isSafeInteger(n) || n < 0)) {
          return sendJson(res, 400, { error: "Indica una quantità valida per ogni ruolo configurato." });
        }
        const saveTarget = db.prepare("UPDATE game_roles SET target_count = ? WHERE room_id = ? AND id = ?");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const role of roleIds) saveTarget.run(Number(targets[role]) || 0, room.id, role);
          logAction(room.id, "judge", "role_configuration_updated", targets);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true, targets: getRoleTargets(room.id) });
      }

      if (judgeAction === "POST /api/judge/roles") {
        if (room.started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        const body = await readJson(req);
        const name = String(body.name || "").trim();
        if (!name) return sendJson(res, 400, { error: "Il nome del ruolo è obbligatorio." });
        const exists = db.prepare("SELECT 1 FROM game_roles WHERE room_id = ? AND LOWER(name) = LOWER(?)").get(room.id, name);
        if (exists) return sendJson(res, 409, { error: "Un ruolo con questo nome esiste già nella stanza." });
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || crypto.randomUUID();
        const targetCount = Number(body.target_count || body.targetCount || 0);
        db.prepare(`INSERT INTO game_roles
          (id, room_id, name, target_count, team, description, objectives, rules, actions, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, room.id, name, targetCount,
          String(body.team || "").trim(),
          String(body.description || "").trim(),
          String(body.objectives || "").trim(),
          String(body.rules || "").trim(),
          String(body.actions || "").trim(),
          new Date().toISOString()
        );
        logAction(room.id, "judge", "role_created", { id, name });
        return sendJson(res, 201, { id, name });
      }

      if (judgeAction.startsWith("PATCH /api/judge/roles/")) {
        if (room.started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        const id = decodeURIComponent(judgeAction.replace(/^PATCH \/api\/judge\/roles\//, "").replace(/\/+$/, ""));
        const role = db.prepare("SELECT * FROM game_roles WHERE id = ? AND room_id = ?").get(id, room.id);
        if (!role) return sendJson(res, 404, { error: "Ruolo non trovato." });
        const body = await readJson(req);
        const name = body.name !== undefined ? String(body.name).trim() : role.name;
        const targetCount = body.target_count !== undefined ? Number(body.target_count) : role.target_count;
        db.prepare(`UPDATE game_roles SET name = ?, target_count = ?, team = ?, description = ?, objectives = ?, rules = ?, actions = ?
          WHERE id = ? AND room_id = ?`).run(
          name, targetCount,
          body.team !== undefined ? String(body.team).trim() : role.team,
          body.description !== undefined ? String(body.description).trim() : role.description,
          body.objectives !== undefined ? String(body.objectives).trim() : role.objectives,
          body.rules !== undefined ? String(body.rules).trim() : role.rules,
          body.actions !== undefined ? String(body.actions).trim() : role.actions,
          id, room.id
        );
        logAction(room.id, "judge", "role_updated", { id, name });
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction.startsWith("DELETE /api/judge/roles/")) {
        if (room.started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        const id = decodeURIComponent(judgeAction.replace(/^DELETE \/api\/judge\/roles\//, "").replace(/\/+$/, ""));
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET role = NULL WHERE role = ? AND room_id = ?").run(id, room.id);
          const result = db.prepare("DELETE FROM game_roles WHERE id = ? AND room_id = ?").run(id, room.id);
          if (!result.changes) {
            db.exec("ROLLBACK");
            return sendJson(res, 404, { error: "Ruolo non trovato." });
          }
          logAction(room.id, "judge", "role_deleted", { id });
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/roles/clear") {
        if (room.started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET role = NULL WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM game_roles WHERE room_id = ?").run(room.id);
          logAction(room.id, "judge", "all_roles_cleared");
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/roles/preset") {
        if (room.started_at) return sendJson(res, 409, { error: "I ruoli non si possono modificare dopo l'inizio." });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE participants SET role = NULL WHERE room_id = ?").run(room.id);
          db.prepare("DELETE FROM game_roles WHERE room_id = ?").run(room.id);
          seedRoomRoles(room.id);
          logAction(room.id, "judge", "halloween_roles_preset_loaded");
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      // START GAME
      if (judgeAction === "POST /api/judge/start") {
        const body = await readJson(req);
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
        const state = getValidation(room.id);
        if (!state.ready) return sendJson(res, 409, { error: "La configurazione non è valida.", issues: state.issues });
        const now = new Date().toISOString();
        const result = db.prepare(`UPDATE rooms SET started_at = ?, status = 'running', current_turn = 1,
          turn_started_at = ? WHERE id = ? AND started_at IS NULL AND status = 'setup'`).run(now, now, room.id);
        if (!result.changes) return sendJson(res, 409, { error: "La partita è già iniziata." });
        logAction(room.id, "judge", "game_started", { participants: state.participants.length });
        return sendJson(res, 200, { ok: true });
      }

      // GAME ACTIONS (pause, resume, next-turn, end, terminate, reset)
      if (judgeAction === "POST /api/judge/game-action" || judgeAction === "POST /api/judge/game/reset") {
        const body = (await readJson(req).catch(() => ({}))) || {};
        if (judgeAction === "POST /api/judge/game/reset") {
          body.action = "reset";
          body.confirmed = true;
        }
        const now = new Date().toISOString();
        if (body.action === "pause" && room.status === "running") {
          const settings = JSON.parse(room.settings || "{}");
          const duration = (settings.turnDurationMinutes || 30) * 60000;
          const remaining = Math.max(0, duration - (Date.now() - new Date(room.turn_started_at).getTime()));
          db.prepare("UPDATE rooms SET status = 'paused', paused_remaining_ms = ? WHERE id = ?").run(remaining, room.id);
        } else if (body.action === "resume" && room.status === "paused") {
          const settings = JSON.parse(room.settings || "{}");
          const duration = (settings.turnDurationMinutes || 30) * 60000;
          const remaining = room.paused_remaining_ms ?? duration;
          db.prepare("UPDATE rooms SET status = 'running', turn_started_at = ?, paused_remaining_ms = NULL WHERE id = ?")
            .run(new Date(Date.now() - (duration - remaining)).toISOString(), room.id);
        } else if (body.action === "next-turn" && (room.status === "running" || room.status === "paused")) {
          const settings = JSON.parse(room.settings || "{}");
          const maxTurns = settings.turnCount || 1;
          if (room.current_turn >= maxTurns) return sendJson(res, 409, { error: "È già stato raggiunto l'ultimo turno." });
          db.prepare("UPDATE rooms SET current_turn = current_turn + 1, turn_started_at = ?, paused_remaining_ms = NULL, status = 'running' WHERE id = ?").run(now, room.id);
        } else if (body.action === "end" && (room.status === "running" || room.status === "paused")) {
          if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
          db.prepare("UPDATE rooms SET status = 'completed', vote_open = 0, turn_started_at = NULL, paused_remaining_ms = NULL WHERE id = ?").run(room.id);
        } else if (body.action === "terminate") {
          // Fix terminate action
          if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
          db.prepare("UPDATE rooms SET status = 'terminated', vote_open = 0, turn_started_at = NULL, paused_remaining_ms = NULL WHERE id = ?").run(room.id);
          logAction(room.id, "judge", "game_terminated");
        } else if (body.action === "reset" || body.action === "new-game") {
          if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare(`UPDATE rooms SET started_at = NULL, status = 'setup', current_turn = 0,
              turn_started_at = NULL, paused_remaining_ms = NULL, roles_revealed = 0, vote_open = 0 WHERE id = ?`).run(room.id);
            db.prepare("DELETE FROM messages WHERE room_id = ?").run(room.id);
            db.prepare("DELETE FROM missions WHERE room_id = ?").run(room.id);
            db.prepare("DELETE FROM secret_actions WHERE room_id = ?").run(room.id);
            db.prepare("DELETE FROM votes WHERE room_id = ?").run(room.id);
            db.prepare("DELETE FROM score_ledger WHERE room_id = ?").run(room.id);
            db.prepare("DELETE FROM role_history WHERE room_id = ?").run(room.id);
            if (body.clearParticipants === true) {
              db.prepare("DELETE FROM participants WHERE room_id = ?").run(room.id);
            } else {
              db.prepare("UPDATE participants SET role = NULL WHERE room_id = ?").run(room.id);
            }
            if (body.clearRoles === true) {
              db.prepare("DELETE FROM game_roles WHERE room_id = ?").run(room.id);
            }
            logAction(room.id, "judge", "game_reset");
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        } else {
          return sendJson(res, 409, { error: "Azione non valida per lo stato attuale della partita." });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/reveal") {
        const body = await readJson(req);
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Conferma esplicita richiesta." });
        if (room.status !== "completed") return sendJson(res, 409, { error: "I ruoli possono essere rivelati solo al termine della partita." });
        db.prepare("UPDATE rooms SET roles_revealed = 1 WHERE id = ?").run(room.id);
        logAction(room.id, "judge", "roles_revealed");
        return sendJson(res, 200, { ok: true, summary: finalGameSummary(room.id) });
      }

      if (judgeAction === "POST /api/judge/missions") {
        const body = await readJson(req);
        const title = String(body.title || "").trim();
        const description = String(body.description || "").trim();
        const score = Number(body.score || 0);
        const turnNumber = Number(body.turn || room.current_turn || 1);
        if (!title) return sendJson(res, 400, { error: "Il titolo della missione è obbligatorio." });

        let assignedCount = 0;
        let createdId = crypto.randomUUID();
        const insert = db.prepare(`INSERT INTO missions
          (id, room_id, title, description, objective, rules, verification, score, turn_number, participant_id, status, proof, review_note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', '', '', ?)`);
        const now = new Date().toISOString();

        if (body.participantId) {
          createdId = crypto.randomUUID();
          insert.run(createdId, room.id, title, description, String(body.objective || "").trim(), String(body.rules || "").trim(), String(body.verification || "").trim(), score, turnNumber, body.participantId, now);
          assignedCount = 1;
        } else if (body.roleId) {
          const targets = db.prepare("SELECT id FROM participants WHERE room_id = ? AND role = ?").all(room.id, body.roleId);
          for (const t of targets) {
            createdId = crypto.randomUUID();
            insert.run(createdId, room.id, title, description, String(body.objective || "").trim(), String(body.rules || "").trim(), String(body.verification || "").trim(), score, turnNumber, t.id, now);
            assignedCount++;
          }
        }
        logAction(room.id, "judge", "mission_assigned", { title, assignedCount });
        return sendJson(res, 201, { ok: true, id: createdId, assigned: assignedCount, assignedCount });
      }

      if (judgeAction.startsWith("PATCH /api/judge/missions/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const mission = db.prepare("SELECT * FROM missions WHERE id = ? AND room_id = ?").get(id, room.id);
        if (!mission) return sendJson(res, 404, { error: "Missione non trovata." });
        const body = await readJson(req);
        const status = body.status;
        if (mission.status === status) {
          return sendJson(res, 409, { error: `La missione si trova già nello stato ${status}.` });
        }
        const note = String(body.note || body.reviewNote || "").trim();
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE missions SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ? AND room_id = ?").run(
            status, note, new Date().toISOString(), id, room.id
          );
          if (status === "completed" && mission.score > 0) {
            db.prepare(`INSERT OR REPLACE INTO score_ledger
              (id, room_id, participant_id, source_type, source_id, points, reason, created_at)
              VALUES (?, ?, ?, 'mission', ?, ?, ?, ?)`).run(
              crypto.randomUUID(), room.id, mission.participant_id, id, mission.score, `Completamento missione: ${mission.title}`, new Date().toISOString()
            );
          } else if (status === "rejected") {
            db.prepare("DELETE FROM score_ledger WHERE room_id = ? AND source_type = 'mission' AND source_id = ?").run(room.id, id);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/messages") {
        const body = await readJson(req);
        const text = String(body.body || "").trim();
        const subject = String(body.subject || "").trim().slice(0, 100);
        const attachment = body.attachment ? String(body.attachment) : null;
        if (!text && !attachment) return sendJson(res, 400, { error: "Il testo della comunicazione o un allegato è obbligatorio." });
        const kind = body.kind || "message";
        db.prepare(`INSERT INTO messages (id, room_id, participant_id, sender, kind, subject, body, attachment, team, status, created_at)
          VALUES (?, ?, ?, 'judge', ?, ?, ?, ?, ?, 'sent', ?)`).run(
          crypto.randomUUID(), room.id, body.participantId || null, kind, subject, text, attachment, body.team || null, new Date().toISOString()
        );
        logAction(room.id, "judge", "message_sent", { recipient: body.participantId ? "player" : body.team ? "team" : "all", hasAttachment: Boolean(attachment) });
        return sendJson(res, 201, { ok: true });
      }

      if (judgeAction.startsWith("PATCH /api/judge/messages/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND room_id = ?").get(id, room.id);
        if (!msg) return sendJson(res, 404, { error: "Messaggio non trovato." });
        if (msg.status === "approved" || msg.status === "rejected") {
          return sendJson(res, 409, { error: "Questo messaggio è già stato valutato." });
        }
        const body = await readJson(req);
        db.prepare("UPDATE messages SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ? AND room_id = ?").run(
          body.status, String(body.note || "").trim(), new Date().toISOString(), id, room.id
        );
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction.startsWith("PATCH /api/judge/actions/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const action = db.prepare("SELECT * FROM secret_actions WHERE id = ? AND room_id = ?").get(id, room.id);
        if (!action) return sendJson(res, 404, { error: "Azione segreta non trovata." });
        const body = await readJson(req);
        const status = body.status;
        const note = String(body.note || "").trim();
        const score = Number(body.score || 0);

        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE secret_actions SET status = ?, review_note = ?, score = ?, reviewed_at = ? WHERE id = ? AND room_id = ?").run(
            status, note, score, new Date().toISOString(), id, room.id
          );
          if (status === "approved" && score > 0) {
            db.prepare(`INSERT OR REPLACE INTO score_ledger
              (id, room_id, participant_id, source_type, source_id, points, reason, created_at)
              VALUES (?, ?, ?, 'action', ?, ?, ?, ?)`).run(
              crypto.randomUUID(), room.id, action.participant_id, id, score, `Azione speciale approvata: ${action.title}`, new Date().toISOString()
            );
          } else if (status === "rejected") {
            db.prepare("DELETE FROM score_ledger WHERE room_id = ? AND source_type = 'action' AND source_id = ?").run(room.id, id);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/vote") {
        const body = await readJson(req);
        const limit = Number(body.limit || 1);
        const hasVotes = db.prepare("SELECT 1 FROM votes WHERE room_id = ?").get(room.id);
        if (hasVotes) return sendJson(res, 409, { error: "La votazione per questa sessione si è già conclusa." });
        db.prepare("UPDATE rooms SET vote_open = 1, vote_limit = ? WHERE id = ?").run(limit, room.id);
        logAction(room.id, "judge", "voting_opened", { limit });
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/vote/close") {
        db.prepare("UPDATE rooms SET vote_open = 0 WHERE id = ?").run(room.id);
        logAction(room.id, "judge", "voting_closed");
        return sendJson(res, 200, { ok: true });
      }

      if (judgeAction === "POST /api/judge/score-adjustment") {
        const body = await readJson(req);
        const points = Number(body.points);
        const reason = String(body.reason || "Correzione manuale del giudice").trim();
        if (!body.participantId || !Number.isSafeInteger(points)) {
          return sendJson(res, 400, { error: "Specifica il partecipante e un punteggio valido." });
        }
        db.prepare(`INSERT INTO score_ledger (id, room_id, participant_id, source_type, source_id, points, reason, created_at)
          VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`).run(
          crypto.randomUUID(), room.id, body.participantId, crypto.randomUUID(), points, reason, new Date().toISOString()
        );
        logAction(room.id, "judge", "score_adjusted", { participantId: body.participantId, points, reason });
        return sendJson(res, 201, { ok: true });
      }

      if (judgeAction === "POST /api/judge/logout") {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token) {
          judgeSessions.delete(token);
          removeSession(token);
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    // --------------------------------------------------
    // STATIC FILE SERVING
    // --------------------------------------------------
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.resolve(ROOT, "public", requested);
      const publicRoot = path.resolve(ROOT, "public") + path.sep;
      if (!filePath.startsWith(publicRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const contentTypes = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
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

setInterval(() => {
  const activeRooms = db.prepare("SELECT * FROM rooms WHERE status = 'running'").all();
  for (const r of activeRooms) applyDeadlineFailures(r);
}, 15000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`La Notte dei Sospetti è pronta sulla porta ${PORT}.`);
  console.log(`Giudice: http://localhost:${PORT}`);
  for (const address of getLanAddresses()) console.log(`Giocatori sulla stessa rete Wi-Fi: http://${address}:${PORT}`);
  console.log(`Password giudice: ${judgePassword}`);
  console.log("Condividi la password del giudice solo con il giudice. Non condividere i codici privati dei giocatori.");
});
