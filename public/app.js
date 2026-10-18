// ====================================================
// LA NOTTE DEI SOSPETTI — CLIENT APPLICATION
// Multi-Room, Smart UX, Self-Service Lobby & Role Engine
// ====================================================

const toast = document.querySelector("#toast");
const confirmDialog = document.querySelector("#confirm-dialog");
const proofDialog = document.querySelector("#proof-dialog");

// Session State
let userToken = sessionStorage.getItem("userToken");
let judgeToken = sessionStorage.getItem("judgeToken");
let playerToken = sessionStorage.getItem("playerToken");
let currentRoomCode = sessionStorage.getItem("currentRoomCode");
let currentUser = JSON.parse(sessionStorage.getItem("currentUser") || "null");

let state = null; // Current room judge state
let toastTimeout;
let playerDashboard = null;
let dashboardRefresh;
let judgeRefresh;
let spoilersHidden = false;
let missionTemplates = [];

// ----------------------------------------------------
// UTILITIES & API
// ----------------------------------------------------
function getActiveAuthToken() {
  return judgeToken || userToken || null;
}

async function api(url, options = {}, token = null) {
  const authToken = token !== null ? token : getActiveAuthToken();
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  if (currentRoomCode && !headers.has("X-Room-Code")) {
    headers.set("X-Room-Code", currentRoomCode);
  }

  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      if (token === playerToken) {
        playerToken = null;
        sessionStorage.removeItem("playerToken");
        clearInterval(dashboardRefresh);
        showPlayerLoginView();
      }
    }
    throw new Error(payload.error || "Si è verificato un errore nella richiesta.");
  }
  return payload;
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3400);
}

function roleEntries() {
  return state && state.roles ? Object.entries(state.roles) : [];
}

function setActiveView(viewId) {
  document.querySelectorAll(".main-tabs .tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== viewId;
  });
}

function setActivePlayerSubview(subviewId) {
  document.querySelectorAll(".player-subtab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.subview === subviewId);
  });
  document.querySelectorAll(".player-subview").forEach((subview) => {
    subview.hidden = subview.id !== subviewId;
  });
}

function makeRecord(title, description, meta, badgeClass = "") {
  const card = document.createElement("div");
  card.className = "record-item";

  const head = document.createElement("div");
  head.className = "record-header";

  const titleElem = document.createElement("strong");
  titleElem.textContent = title;
  head.append(titleElem);

  if (meta) {
    const metaElem = document.createElement("span");
    metaElem.className = `record-meta ${badgeClass}`.trim();
    metaElem.textContent = meta;
    head.append(metaElem);
  }
  card.append(head);

  if (description) {
    const descElem = document.createElement("p");
    descElem.className = "record-desc";
    descElem.textContent = description;
    card.append(descElem);
  }
  return card;
}

// ----------------------------------------------------
// PLAYER JOIN & WAITING ROOM
// ----------------------------------------------------
function showPlayerLoginView() {
  document.querySelector("#player-login-panel").hidden = false;
  document.querySelector("#player-waiting-room").hidden = true;
  document.querySelector("#player-role-panel").hidden = true;
}

function showPlayerWaitingRoom(data) {
  document.querySelector("#player-login-panel").hidden = true;
  document.querySelector("#player-waiting-room").hidden = false;
  document.querySelector("#player-role-panel").hidden = true;

  document.querySelector("#waiting-room-name").textContent = data.roomName || "Stanza di Gioco";
  document.querySelector("#waiting-room-code").textContent = data.roomCode || "—";
  document.querySelector("#waiting-participants-count").textContent = data.participantsCount || data.players?.length || 0;

  const list = document.querySelector("#waiting-player-list");
  list.replaceChildren();
  for (const player of data.players || []) {
    const item = document.createElement("li");
    item.className = "waiting-player-item";
    const dot = document.createElement("span");
    dot.textContent = player.online ? "🟢" : "⚪";
    const name = document.createElement("span");
    name.textContent = player.name;
    if (player.id === data.participant?.id) {
      name.textContent += " (Tu)";
      item.style.borderColor = "var(--orange)";
    }
    item.append(dot, name);
    list.append(item);
  }
}

async function loadPlayerDashboard() {
  if (!playerToken) return;
  try {
    const data = await api("/api/player/dashboard", {}, playerToken);
    playerDashboard = data;

    if (data.waiting) {
      showPlayerWaitingRoom(data);
      return;
    }

    // Partita avviata -> Render Dashboard completa
    document.querySelector("#player-login-panel").hidden = true;
    document.querySelector("#player-waiting-room").hidden = true;
    document.querySelector("#player-role-panel").hidden = false;
    renderPlayerDashboard(data);
  } catch (error) {
    showToast(error.message);
  }
}

function renderPlayerDashboard(data) {
  const p = data.participant;
  document.querySelector("#player-name").textContent = p.name;
  document.querySelector("#player-role").textContent = p.role?.name || "Non assegnato";
  document.querySelector("#player-role-detail").textContent = p.role?.name || "Ruolo non assegnato";
  document.querySelector("#player-team").textContent = p.role?.team || "Nessuna";
  document.querySelector("#player-score").textContent = `${p.score} punti`;
  document.querySelector("#player-score-total").textContent = p.score;
  document.querySelector("#player-game-status").textContent = `Turno ${data.room.currentTurn}/${data.room.turnCount}`;

  // Istruzioni Ruolo
  const inst = document.querySelector("#player-instructions");
  inst.replaceChildren();
  if (p.role) {
    if (p.role.description) {
      const d = document.createElement("p");
      d.innerHTML = `<strong>Descrizione:</strong> ${p.role.description}`;
      inst.append(d);
    }
    if (p.role.objectives) {
      const o = document.createElement("p");
      o.innerHTML = `<strong>Obiettivo di vittoria:</strong> ${p.role.objectives}`;
      inst.append(o);
    }
    if (p.role.rules) {
      const r = document.createElement("p");
      r.innerHTML = `<strong>Regole speciali:</strong> ${p.role.rules}`;
      inst.append(r);
    }
  }

  // Alleati (FIX: visibili SOLO a fazioni segrete operative/cospiratrici)
  const alliesElem = document.querySelector("#player-allies");
  if (data.allies && data.allies.length > 0) {
    alliesElem.textContent = `👥 Compagni di squadra conosciuti: ${data.allies.join(", ")}`;
    alliesElem.hidden = false;
  } else {
    alliesElem.textContent = "";
    alliesElem.hidden = true;
  }

  // Missioni
  const missionList = document.querySelector("#player-missions");
  missionList.replaceChildren();
  const activeMissionCard = document.querySelector("#player-active-mission-card");
  activeMissionCard.replaceChildren();

  const activeMission = data.missions.find((m) => ["assigned", "active"].includes(m.status));
  if (activeMission) {
    const card = makeRecord(
      activeMission.title,
      activeMission.description,
      `${activeMission.score} pt · ${activeMission.status === 'active' ? 'In corso' : 'Assegnata'}`,
      "badge-warning"
    );
    const actionBtn = document.createElement("button");
    actionBtn.className = "button secondary";
    actionBtn.style.marginTop = "8px";
    if (activeMission.status === "assigned") {
      actionBtn.textContent = "▶ Avvia Missione";
      actionBtn.addEventListener("click", () => submitPlayerMission(activeMission.id, "start"));
    } else {
      actionBtn.textContent = "📤 Invia Prova al Giudice";
      actionBtn.addEventListener("click", () => openProofModal(activeMission));
    }
    card.append(actionBtn);
    activeMissionCard.append(card);
  } else {
    activeMissionCard.innerHTML = `<p class="empty-state">Nessuna missione attiva per questo turno.</p>`;
  }

  for (const m of data.missions) {
    const statusLabel = {
      assigned: "Assegnata",
      active: "In corso",
      submitted: "In verifica dal Giudice",
      under_review: "In valutazione",
      completed: "✓ Completata (+ punti)",
      rejected: "✕ Respinta",
    }[m.status] || m.status;
    const badge = m.status === "completed" ? "badge-success" : m.status === "rejected" ? "badge-danger" : "badge-warning";
    const item = makeRecord(m.title, m.description, `${m.score} pt · ${statusLabel}`, badge);

    if (m.review_note) {
      const note = document.createElement("p");
      note.className = "record-meta";
      note.style.marginTop = "6px";
      note.textContent = `Nota del Giudice: ${m.review_note}`;
      item.append(note);
    }
    if (m.status === "assigned") {
      const startBtn = document.createElement("button");
      startBtn.className = "button quiet";
      startBtn.textContent = "▶ Avvia";
      startBtn.addEventListener("click", () => submitPlayerMission(m.id, "start"));
      item.append(startBtn);
    } else if (m.status === "active") {
      const sendProofBtn = document.createElement("button");
      sendProofBtn.className = "button secondary";
      sendProofBtn.textContent = "📤 Invia Prova";
      sendProofBtn.addEventListener("click", () => openProofModal(m));
      item.append(sendProofBtn);
    }
    missionList.append(item);
  }

  // Notifiche Home & Messaggi
  const notifList = document.querySelector("#player-home-notifications");
  const msgList = document.querySelector("#player-messages");
  notifList.replaceChildren();
  msgList.replaceChildren();
  for (const msg of data.messages) {
    const isFromMe = msg.sender === "player";
    const rec = makeRecord(
      msg.subject ? `${msg.subject}` : isFromMe ? "Tua comunicazione al Giudice" : "Messaggio dal Giudice",
      msg.body,
      new Date(msg.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    );
    msgList.append(rec);
    if (!isFromMe) notifList.append(rec.cloneNode(true));
  }

  // Azioni Speciali
  const actionTitleSelect = document.querySelector("#player-action-title");
  actionTitleSelect.replaceChildren();
  if (p.role?.actions?.length) {
    for (const a of p.role.actions) {
      actionTitleSelect.append(new Option(a, a));
    }
  } else {
    actionTitleSelect.append(new Option("Azione generica", "Azione speciale"));
  }

  const actionsList = document.querySelector("#player-actions");
  actionsList.replaceChildren();
  for (const act of data.actions) {
    const stLabel = act.status === "approved" ? `✓ Approvata (+${act.score} pt)` : act.status === "rejected" ? "✕ Respinta" : "In attesa di valutazione";
    const rec = makeRecord(act.title, act.details, stLabel, act.status === "approved" ? "badge-success" : act.status === "rejected" ? "badge-danger" : "badge-warning");
    if (act.review_note) {
      const note = document.createElement("p");
      note.className = "record-meta";
      note.textContent = `Nota Giudice: ${act.review_note}`;
      rec.append(note);
    }
    actionsList.append(rec);
  }

  // Regole & Condizioni
  document.querySelector("#player-rules-content").textContent = data.room.rules || "Nessuna regola speciale inserita dal Giudice.";
  document.querySelector("#player-win-conditions-content").textContent = data.room.winConditions || "La fazione con più punti o sopravvissuti si aggiudica la vittoria.";

  // Votazione
  const votingTabBtn = document.querySelector("#player-voting-tab-btn");
  votingTabBtn.hidden = !data.room.voteOpen;
  if (data.room.voteOpen) {
    document.querySelector("#vote-instruction").textContent = `Puoi votare fino a ${data.room.voteLimit} sospetti:`;
    const candBox = document.querySelector("#vote-candidates");
    candBox.replaceChildren();
    for (const c of data.candidates) {
      const lbl = document.createElement("label");
      lbl.className = "candidate-checkbox-label";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.value = c.id;
      chk.checked = data.myVotes.includes(c.id);
      lbl.append(chk, document.createTextNode(` ${c.name}`));
      candBox.append(lbl);
    }
  }

  // Esito Finale
  const resultsTabBtn = document.querySelector("#player-results-tab-btn");
  resultsTabBtn.hidden = !data.room.rolesRevealed || !data.summary;
  if (data.room.rolesRevealed && data.summary) {
    renderFinalResults(data.summary, document.querySelector("#player-final-results"));
  }
}

function renderFinalResults(summary, container) {
  container.replaceChildren();
  const winnersBox = document.createElement("div");
  winnersBox.className = "highlight-score";
  winnersBox.style.fontSize = "1.3rem";
  winnersBox.textContent = `🎉 Squadra Vincitrice: ${summary.winningTeams.join(", ") || "Nessuna"}`;
  container.append(winnersBox);

  const table = document.createElement("table");
  table.className = "role-table";
  table.style.marginTop = "14px";
  table.innerHTML = `
    <thead><tr><th>Giocatore</th><th>Ruolo</th><th>Squadra</th><th>Punti</th></tr></thead>
    <tbody>
      ${summary.players.map(p => `<tr><td><strong>${p.name}</strong></td><td>${p.role || "—"}</td><td>${p.team || "—"}</td><td>${p.score} pt</td></tr>`).join("")}
    </tbody>
  `;
  container.append(table);
}

function openProofModal(mission) {
  document.querySelector("#proof-mission-id").value = mission.id;
  document.querySelector("#proof-dialog-title").textContent = `Prova per: ${mission.title}`;
  document.querySelector("#proof-text").value = "";
  proofDialog.showModal();
}

async function submitPlayerMission(missionId, action, proof = "") {
  try {
    await api(`/api/player/missions/${encodeURIComponent(missionId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ proof }),
    }, playerToken);
    showToast(action === "start" ? "Missione avviata!" : "Prova inviata al Giudice!");
    await loadPlayerDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

function startPlayerPolling() {
  clearInterval(dashboardRefresh);
  dashboardRefresh = setInterval(() => {
    if (playerToken) {
      loadPlayerDashboard().catch(() => {});
    }
  }, 4000);
}

// ----------------------------------------------------
// GAME MASTER (MULTI-ROOM & SMART ACTIONS)
// ----------------------------------------------------
function showJudgeAuthView() {
  document.querySelector("#judge-auth-panel").hidden = false;
  document.querySelector("#judge-rooms-manager").hidden = true;
  document.querySelector("#judge-panel").hidden = true;
}

function showJudgeRoomsView() {
  document.querySelector("#judge-auth-panel").hidden = true;
  document.querySelector("#judge-rooms-manager").hidden = false;
  document.querySelector("#judge-panel").hidden = true;
  document.querySelector("#judge-username").textContent = currentUser?.username || "Master";
  loadJudgeRooms();
}

async function loadJudgeRooms() {
  try {
    const data = await api("/api/rooms");
    const grid = document.querySelector("#judge-rooms-list");
    grid.replaceChildren();
    document.querySelector("#rooms-count").textContent = `${data.rooms.length} stanze create`;

    if (!data.rooms.length) {
      grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1;">Non hai ancora creato nessuna stanza. Inserisci un nome qui sopra per creare la tua prima partita!</p>`;
      return;
    }

    for (const r of data.rooms) {
      const card = document.createElement("div");
      card.className = "room-card";

      const header = document.createElement("div");
      header.className = "room-card-header";
      const title = document.createElement("h4");
      title.className = "room-card-title";
      title.textContent = r.name;
      const code = document.createElement("span");
      code.className = "room-card-code";
      code.textContent = r.code;
      header.append(title, code);

      const meta = document.createElement("div");
      meta.className = "room-card-meta";
      meta.textContent = `Stato: ${r.status.toUpperCase()} · ${r.participant_count} giocatori connessi`;

      const actions = document.createElement("div");
      actions.className = "room-card-actions";
      const enterBtn = document.createElement("button");
      enterBtn.className = "button secondary";
      enterBtn.textContent = "👑 Entra in Regia";
      enterBtn.addEventListener("click", () => enterRoomAsJudge(r.code));

      const delBtn = document.createElement("button");
      delBtn.className = "button quiet";
      delBtn.textContent = "🗑️ Elimina";
      delBtn.addEventListener("click", async () => {
        if (!window.confirm(`Sei sicuro di voler eliminare la stanza "${r.name}" (${r.code})?`)) return;
        try {
          await api(`/api/rooms/${encodeURIComponent(r.code)}`, { method: "DELETE" });
          showToast("Stanza eliminata.");
          await loadJudgeRooms();
        } catch (err) {
          showToast(err.message);
        }
      });

      actions.append(enterBtn, delBtn);
      card.append(header, meta, actions);
      grid.append(card);
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function enterRoomAsJudge(roomCode) {
  currentRoomCode = roomCode;
  sessionStorage.setItem("currentRoomCode", roomCode);
  document.querySelector("#judge-auth-panel").hidden = true;
  document.querySelector("#judge-rooms-manager").hidden = true;
  document.querySelector("#judge-panel").hidden = false;
  document.querySelector("#judge-room-code-display").textContent = roomCode;

  await loadJudgeState();
  await loadMissionTemplates();
  startJudgePolling();
}

async function loadMissionTemplates() {
  if (missionTemplates.length > 0) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/mission-templates` : "/api/judge/mission-templates";
    const res = await api(url);
    missionTemplates = res.templates || [];
    const select = document.querySelector("#mission-template-select");
    if (!select) return;
    select.replaceChildren(new Option("— Seleziona una missione dal mazzo (15 disponibili) —", ""));
    for (let i = 0; i < missionTemplates.length; i++) {
      select.append(new Option(`${i + 1}. ${missionTemplates[i].title} (+${missionTemplates[i].score} pt)`, String(i)));
    }
  } catch {}
}

async function loadJudgeState(isPolling = false) {
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/state` : "/api/judge/state";
    state = await api(url);

    document.querySelector("#current-room-title").textContent = state.room?.name ? `Regia: ${state.room.name}` : "Pannello del Giudice";
    document.querySelector("#judge-room-code-display").textContent = state.room?.code || currentRoomCode || "H4LL0";

    const activeTag = document.activeElement ? document.activeElement.tagName : null;
    const isEditing = activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";

    if (!isPolling || !isEditing) {
      renderParticipants();
      renderRoleConfiguration();
      renderRoles();
      renderValidation();
      renderHistory();
      renderJudgeOperations();
      setGameLock(state.started);
    } else {
      // Non distruttivo durante il polling mentre il master digita
      updateParticipantPresence();
      renderJudgeOperations();
    }
    if (!isPolling) await renderJoinAddresses();
  } catch (error) {
    if (!isPolling) showToast(error.message);
  }
}

function updateParticipantPresence() {
  if (!state) return;
  document.querySelector("#participant-count").textContent = state.participants.length;
}

function setGameLock(started) {
  const statusElement = document.querySelector("#game-status");
  if (statusElement) {
    statusElement.textContent = started
      ? `Partita ${state.game.status.toUpperCase()} · Ruoli distribuiti e bloccati per i giocatori`
      : "Partita in fase di preparazione (Lobby aperta)";
  }
  const historyPanel = document.querySelector("#history-panel");
  if (historyPanel) historyPanel.hidden = !started;
}

function createRoleSelect(participant) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Ruolo di ${participant.name}`);
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "— Seleziona ruolo —";
  select.append(empty);

  for (const [value, label] of roleEntries()) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.disabled = state.counts[value] >= state.limits[value] && participant.role !== value;
    select.append(option);
  }
  select.value = participant.role || "";
  select.addEventListener("change", async () => {
    let reason;
    if (state.started) {
      reason = window.prompt("Motivo della modifica eccezionale (verrà salvato nel registro di tracciabilità):");
      if (!reason?.trim()) {
        select.value = participant.role || "";
        return;
      }
    }
    try {
      const url = currentRoomCode
        ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/participants/${encodeURIComponent(participant.id)}`
        : `/api/judge/participants/${encodeURIComponent(participant.id)}`;
      await api(url, {
        method: "PATCH",
        body: JSON.stringify({ role: select.value || null, ...(reason ? { reason } : {}) }),
      });
      await loadJudgeState();
      showToast(`Ruolo aggiornato per ${participant.name}.`);
    } catch (error) {
      select.value = participant.role || "";
      showToast(error.message);
    }
  });
  return select;
}

function renderParticipants() {
  const list = document.querySelector("#participant-list");
  list.replaceChildren();
  for (const [index, participant] of state.participants.entries()) {
    const item = document.createElement("li");
    item.className = "participant-item";

    const number = document.createElement("span");
    number.className = "participant-number";
    number.textContent = `${index + 1}.`;

    const statusDot = document.createElement("span");
    statusDot.textContent = participant.online ? "🟢" : "⚪";
    statusDot.title = participant.online ? "Online in questo momento" : "Disconnesso";

    const input = document.createElement("input");
    input.className = "name-edit";
    input.value = participant.name;
    input.maxLength = 60;
    input.disabled = state.started;
    input.addEventListener("change", async () => {
      try {
        const url = currentRoomCode
          ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/participants/${encodeURIComponent(participant.id)}`
          : `/api/judge/participants/${encodeURIComponent(participant.id)}`;
        await api(url, { method: "PATCH", body: JSON.stringify({ name: input.value }) });
        await loadJudgeState();
        showToast("Nome aggiornato.");
      } catch (error) {
        input.value = participant.name;
        showToast(error.message);
      }
    });

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "✕ Rimuovi";
    remove.disabled = state.started;
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Rimuovere definitivamente ${participant.name} dalla stanza?`)) return;
      try {
        const url = currentRoomCode
          ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/participants/${encodeURIComponent(participant.id)}?force=true`
          : `/api/judge/participants/${encodeURIComponent(participant.id)}?force=true`;
        await api(url, { method: "DELETE" });
        await loadJudgeState();
        showToast(`${participant.name} rimosso.`);
      } catch (error) {
        showToast(error.message);
      }
    });

    item.append(number, statusDot, input, remove);
    list.append(item);
  }
  document.querySelector("#participant-count").textContent = state.participants.length;
  document.querySelector("#empty-roster").hidden = state.participants.length > 0;
  document.querySelector("#add-participant-form").hidden = state.started;
}

function renderRoleConfiguration() {
  const targetList = document.querySelector("#role-target-list");
  targetList.replaceChildren();
  const entries = roleEntries();
  if (entries.length === 0) {
    targetList.innerHTML = `<p class="empty-state" style="grid-column:1/-1;">Nessun ruolo configurato. Usa il form qui sopra o ricarica il preset Halloween.</p>`;
  }
  for (const [key, label] of entries) {
    const roleObj = state.rolesDetailed.find((r) => r.id === key);
    const wrapper = document.createElement("div");
    wrapper.className = "role-target-card";

    const topRow = document.createElement("div");
    topRow.className = "role-target-top";
    const title = document.createElement("strong");
    title.textContent = label;
    if (roleObj?.team) {
      const teamBadge = document.createElement("span");
      teamBadge.className = "badge";
      teamBadge.textContent = roleObj.team;
      topRow.append(title, teamBadge);
    } else {
      topRow.append(title);
    }

    const inputRow = document.createElement("div");
    inputRow.className = "role-target-input-row";
    const inputLabel = document.createElement("label");
    inputLabel.htmlFor = `target-${key}`;
    inputLabel.textContent = "Giocatori previsti:";
    const input = document.createElement("input");
    input.id = `target-${key}`;
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.required = true;
    input.value = state.limits[key];
    input.disabled = state.started;
    inputRow.append(inputLabel, input);

    const btnRow = document.createElement("div");
    btnRow.className = "role-target-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "button quiet";
    editBtn.textContent = "✏️ Modifica";
    editBtn.disabled = state.started;
    editBtn.addEventListener("click", () => populateRoleEditor(roleObj));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "button quiet";
    delBtn.textContent = "🗑️ Elimina";
    delBtn.disabled = state.started;
    delBtn.addEventListener("click", async () => {
      if (!window.confirm(`Eliminare definitivamente il ruolo "${label}" dalla partita?`)) return;
      try {
        const url = currentRoomCode
          ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/roles/${encodeURIComponent(key)}`
          : `/api/judge/roles/${encodeURIComponent(key)}`;
        await api(url, { method: "DELETE" });
        await loadJudgeState();
        showToast(`Ruolo "${label}" eliminato.`);
      } catch (error) {
        showToast(error.message);
      }
    });

    btnRow.append(editBtn, delBtn);
    wrapper.append(topRow, inputRow, btnRow);
    targetList.append(wrapper);
  }

  const total = entries.reduce((sum, [key]) => sum + (state.limits[key] || 0), 0);
  const partCount = state.participants.length;
  document.querySelector("#save-role-configuration").disabled = state.started || entries.length === 0;
  const statusTotal = document.querySelector("#role-configuration-total");
  statusTotal.innerHTML = `Ruoli previsti configurati: <strong>${total}</strong> · Partecipanti presenti: <strong>${partCount}</strong> ${
    total === partCount && partCount > 0
      ? '<span style="color:var(--green);">✓ (Le quantità coincidono)</span>'
      : total < partCount
      ? `<span style="color:var(--orange);">(Mancano ${partCount - total} posti ruolo)</span>`
      : `<span style="color:var(--red);">(Hai configurato ${total - partCount} ruoli in più)</span>`
  }`;
}

function populateRoleEditor(role) {
  if (!role) return;
  document.querySelector("#role-form-title").textContent = `✏️ Modifica Ruolo: ${role.name}`;
  document.querySelector("#role-edit-id").value = role.id;
  document.querySelector("#role-edit-name").value = role.name;
  document.querySelector("#role-edit-count").value = state.limits[role.id] || 1;
  document.querySelector("#role-edit-team").value = role.team || "";
  document.querySelector("#role-edit-description").value = role.description || "";
  document.querySelector("#role-edit-objectives").value = role.objectives || "";
  document.querySelector("#role-edit-rules").value = role.rules || "";
  document.querySelector("#role-edit-actions").value = role.actions || "";
  document.querySelector("#role-save-btn").textContent = "✓ Salva Modifiche Ruolo";
  document.querySelector("#role-cancel-edit-btn").hidden = false;
  document.querySelector("#role-delete").hidden = state.started;
  document.querySelector("#role-editor-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetRoleForm() {
  document.querySelector("#role-form-title").textContent = "➕ Crea un Ruolo per la tua partita";
  document.querySelector("#role-editor-form").reset();
  document.querySelector("#role-edit-id").value = "";
  document.querySelector("#role-edit-count").value = 1;
  document.querySelector("#role-save-btn").textContent = "+ Salva Ruolo";
  document.querySelector("#role-cancel-edit-btn").hidden = true;
  document.querySelector("#role-delete").hidden = true;
}

function renderRoles() {
  const counts = document.querySelector("#role-counts");
  counts.replaceChildren();
  for (const [key, label] of roleEntries()) {
    const card = document.createElement("div");
    card.className = "role-count";
    const name = document.createElement("span");
    name.textContent = `${label}${key === "malcapitato" ? " (senza poteri)" : key === "veggente" ? " (sq. Malcapitati)" : ""}`;
    const count = document.createElement("strong");
    const assigned = state.counts[key] || 0;
    const max = state.limits[key] || 0;
    count.textContent = `${assigned}/${max}`;
    if (assigned === max && max > 0) card.classList.add("count-complete");
    card.append(name, count);
    counts.append(card);
  }

  const roleTableBody = document.querySelector("#role-table-body");
  roleTableBody.replaceChildren();
  for (const participant of state.participants) {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = participant.name;

    const roleCell = document.createElement("td");
    const roleWrapper = document.createElement("div");
    roleWrapper.className = `role-cell-content ${spoilersHidden ? 'spoiler-masked' : ''}`;
    roleWrapper.append(createRoleSelect(participant));
    roleCell.append(roleWrapper);

    const accessCell = document.createElement("td");
    accessCell.className = "access-cell";
    const code = document.createElement("span");
    code.className = "access-code";
    code.textContent = participant.accessCode;
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.type = "button";
    copy.textContent = "📋 Copia";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(participant.accessCode);
        showToast(`Codice copiato per ${participant.name}.`);
      } catch {
        showToast(`Codice: ${participant.accessCode}`);
      }
    });
    accessCell.append(code, copy);

    const actionCell = document.createElement("td");
    const isOnline = participant.online;
    actionCell.innerHTML = `<span class="online-indicator ${isOnline ? 'online' : 'offline'}">${isOnline ? '🟢 Online' : '⚪ Offline'}</span>`;

    row.append(nameCell, roleCell, accessCell, actionCell);
    roleTableBody.append(row);
  }

  // Safe targets synchronization (FIX role-edit-select crash!)
  const targets = ["mission-participant", "mission-role", "message-participant", "message-team", "score-participant"];
  for (const id of targets) {
    const element = document.querySelector(`#${id}`);
    if (!element) continue;
    const selectedValue = element.value;
    element.replaceChildren();
    if (id === "mission-role") {
      for (const [roleId, roleName] of roleEntries()) element.append(new Option(roleName, roleId));
    } else if (id === "message-team") {
      const teams = [...new Set(state.rolesDetailed.map((r) => r.team).filter(Boolean))];
      for (const team of teams) element.append(new Option(team, team));
    } else {
      for (const participant of state.participants) element.append(new Option(participant.name, participant.id));
    }
    element.value = selectedValue;
  }

  // Settings sync
  document.querySelector("#setting-turn-count").value = state.settings.turnCount || 1;
  document.querySelector("#setting-turn-duration").value = state.settings.turnDurationMinutes || 30;
  document.querySelector("#setting-vote-limit").value = state.game.voteLimit || 1;
  document.querySelector("#setting-win-metric").value = state.settings.winMetric || "score";
  document.querySelector("#setting-rules").value = state.settings.rules || "";
  document.querySelector("#setting-win-conditions").value = state.settings.winConditions || "";
  document.querySelector("#setting-deadline-failure").checked = state.settings.deadlineFailure === true;
}

function renderValidation() {
  const validation = document.querySelector("#validation");
  validation.replaceChildren();
  if (state.ready) {
    const item = document.createElement("div");
    item.className = "valid";
    item.textContent = `✓ Configurazione pronta: ${state.participants.length} partecipanti presenti e assegnati esattamente secondo i posti disponibili.`;
    validation.append(item);
  } else {
    for (const issue of state.issues) {
      const item = document.createElement("div");
      item.textContent = `• ${issue}`;
      validation.append(item);
    }
  }
  const startBtn = document.querySelector("#start-game");
  if (startBtn) {
    startBtn.disabled = !state.ready || state.game.status !== "setup";
  }
}

function renderHistory() {
  const list = document.querySelector("#history-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.history.length) {
    list.append(makeRecord("Nessuna modifica registrata", "Le modifiche eccezionali compariranno qui.", "Vuoto"));
    return;
  }
  for (const item of state.history) {
    list.append(makeRecord(
      `${item.participant_name}: da ${item.old_role || "Nessuno"} a ${item.new_role || "Nessuno"}`,
      item.reason,
      new Date(item.changed_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    ));
  }
}

function renderJudgeTimer() {
  if (!state) return;
  const game = state.game;
  const duration = (state.settings.turnDurationMinutes || 30) * 60000;
  const remaining = game.status === "paused"
    ? game.pausedRemainingMs ?? 0
    : game.status === "running" && game.turnStartedAt
      ? Math.max(0, duration - (Date.now() - new Date(game.turnStartedAt).getTime()))
      : 0;
  const minutes = Math.floor(remaining / 60000).toString().padStart(2, "0");
  const seconds = Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0");
  const timerElem = document.querySelector("#judge-timer");
  if (timerElem) {
    timerElem.textContent = ["running", "paused"].includes(game.status)
      ? `⏳ Timer Turno: ${minutes}:${seconds}${game.status === 'paused' ? ' (IN PAUSA)' : ''}`
      : "";
  }
}

function renderJudgeOperations() {
  const game = state.game;
  const summary = document.querySelector("#judge-game-summary");
  if (summary) {
    summary.textContent = `Stato: ${game.status.toUpperCase()} · Turno ${game.currentTurn}/${state.settings.turnCount || 1}${game.voteOpen ? " · 🗳️ Votazione aperta" : ""}`;
  }
  renderJudgeTimer();
  const running = game.status === "running";
  const paused = game.status === "paused";

  document.querySelector("#pause-game").disabled = !running;
  document.querySelector("#resume-game").disabled = !paused;
  // FIX: consenti next-turn sia in running che in paused!
  document.querySelector("#next-turn").disabled = (!running && !paused) || game.currentTurn >= (state.settings.turnCount || 1);
  document.querySelector("#end-game").disabled = !running && !paused;
  document.querySelector("#terminate-game").disabled = !state.started || ["completed", "terminated"].includes(game.status);

  // Missioni lista
  const missionList = document.querySelector("#judge-mission-list");
  missionList.replaceChildren();
  if (!state.missions.length) {
    missionList.append(makeRecord("Nessuna missione", "Usa il form o il pulsante '⚡ Distribuisci Missioni Casuali' per assegnare compiti.", "Vuoto"));
  }
  for (const m of state.missions) {
    const card = makeRecord(
      `${m.title} — a ${m.participant_name}`,
      `${m.description}${m.proof ? ` | Prova inviata: "${m.proof}"` : ""}`,
      `${m.score} pt · Turno ${m.turn_number} · ${m.status}`
    );
    if (m.status === "submitted" || m.status === "under_review") {
      const btnRow = document.createElement("div");
      btnRow.className = "record-actions";
      const completeBtn = document.createElement("button");
      completeBtn.className = "button secondary";
      completeBtn.textContent = "✓ Approva (+ punti)";
      completeBtn.addEventListener("click", () => reviewMission(m.id, "completed"));

      const rejectBtn = document.createElement("button");
      rejectBtn.className = "button quiet";
      rejectBtn.textContent = "✕ Respingi";
      rejectBtn.addEventListener("click", () => reviewMission(m.id, "rejected"));

      btnRow.append(completeBtn, rejectBtn);
      card.append(btnRow);
    }
    missionList.append(card);
  }

  // Messaggi lista
  const messageList = document.querySelector("#judge-message-list");
  messageList.replaceChildren();
  for (const msg of state.messages) {
    const isPlayer = msg.sender === "player";
    const title = isPlayer ? `💬 Da ${msg.participant_name}` : `📤 Inviato dal Giudice`;
    const rec = makeRecord(title, msg.body, new Date(msg.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }));
    messageList.append(rec);
  }

  // Azioni segrete lista (FIX: mostra sia pending che già valutate)
  const actionsList = document.querySelector("#judge-actions-list");
  actionsList.replaceChildren();
  if (!state.actions.length) {
    actionsList.append(makeRecord("Nessuna azione segreta", "Le azioni speciali dichiarate dai giocatori compariranno qui.", "Vuoto"));
  }
  for (const act of state.actions) {
    const isPending = act.status === "pending";
    const rec = makeRecord(
      `🗡️ ${act.title} — da ${act.participant_name}`,
      act.details,
      new Date(act.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      isPending ? "badge-warning" : act.status === "approved" ? "badge-success" : "badge-danger"
    );
    if (isPending) {
      const btnRow = document.createElement("div");
      btnRow.className = "record-actions";
      const approveBtn = document.createElement("button");
      approveBtn.className = "button secondary";
      approveBtn.textContent = "✓ Approva e assegna punti";
      approveBtn.addEventListener("click", () => reviewSecretAction(act, "approved"));
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "button quiet";
      rejectBtn.textContent = "✕ Respingi";
      rejectBtn.addEventListener("click", () => reviewSecretAction(act, "rejected"));
      btnRow.append(approveBtn, rejectBtn);
      rec.append(btnRow);
    } else {
      const outcome = document.createElement("p");
      outcome.className = "record-meta";
      outcome.textContent = `Esito: ${act.status === 'approved' ? 'Approvata (+ ' + act.score + ' pt)' : 'Respinta'}${act.review_note ? ' · Nota: ' + act.review_note : ''}`;
      rec.append(outcome);
    }
    actionsList.append(rec);
  }

  // Audit log
  const auditList = document.querySelector("#audit-log");
  if (auditList) {
    auditList.replaceChildren();
    for (const entry of state.audit || []) {
      const item = document.createElement("li");
      item.textContent = `${new Date(entry.created_at).toLocaleTimeString("it-IT")} · [${entry.actor.toUpperCase()}] ${entry.action}: ${entry.details}`;
      auditList.append(item);
    }
  }

  // Risultati voti
  const voteResults = document.querySelector("#judge-vote-results");
  voteResults.replaceChildren();
  if (game.voteOpen) {
    voteResults.append(makeRecord("🗳️ Votazione aperta", "I voti rimangono segreti fino alla chiusura della votazione.", "Privato"));
  } else if (state.votes && state.votes.length) {
    for (const vote of state.votes) {
      voteResults.append(makeRecord(vote.name, `${vote.count} voti ricevuti come sospetto`, "Risultato"));
    }
  } else {
    voteResults.append(makeRecord("Nessun voto registrato", "I risultati compariranno dopo la chiusura della votazione.", "Vuoto"));
  }
}

async function reviewMission(missionId, status) {
  const note = status === "rejected" ? window.prompt("Motivo del rifiuto (visibile al giocatore):") : "";
  if (status === "rejected" && !note?.trim()) return;
  try {
    const url = currentRoomCode
      ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/missions/${encodeURIComponent(missionId)}`
      : `/api/judge/missions/${encodeURIComponent(missionId)}`;
    await api(url, { method: "PATCH", body: JSON.stringify({ status, reviewNote: note }) });
    await loadJudgeState();
    showToast("Verifica missione registrata.");
  } catch (err) {
    showToast(err.message);
  }
}

async function reviewSecretAction(action, status) {
  let score = 0;
  let note = "";
  if (status === "approved") {
    const val = window.prompt("Punti da assegnare per questa azione speciale:", "5");
    if (val === null || !Number.isSafeInteger(Number(val)) || Number(val) < 0) return showToast("Punteggio non valido.");
    score = Number(val);
  } else {
    note = window.prompt("Motivo del rifiuto (opzionale):") || "";
  }
  try {
    const url = currentRoomCode
      ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/actions/${encodeURIComponent(action.id)}`
      : `/api/judge/actions/${encodeURIComponent(action.id)}`;
    await api(url, { method: "PATCH", body: JSON.stringify({ status, note, score }) });
    await loadJudgeState();
    showToast("Valutazione azione registrata.");
  } catch (err) {
    showToast(err.message);
  }
}

async function renderJoinAddresses() {
  const panel = document.querySelector("#join-address-panel");
  const list = document.querySelector("#join-address-list");
  if (!panel || !list) return;
  list.replaceChildren();
  try {
    const isOnline = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
    const headerTitle = panel.querySelector("strong");
    if (isOnline) {
      if (headerTitle) headerTitle.textContent = "🌐 Collegamento online per tutti i partecipanti (4G/5G da cellulare):";
      const item = document.createElement("li");
      const link = document.createElement("a");
      const address = `${window.location.origin}/?room=${encodeURIComponent(currentRoomCode || state?.room?.code || "H4LL0")}`;
      link.href = address;
      link.textContent = address;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const copy = document.createElement("button");
      copy.className = "copy-code";
      copy.type = "button";
      copy.textContent = "📋 Copia link";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(address);
          showToast("Link partita copiato!");
        } catch {
          showToast(`Link: ${address}`);
        }
      });
      item.append(link, document.createTextNode(" "), copy);
      list.append(item);
      panel.hidden = false;
      return;
    }
    const status = await api("/api/status", {}, null);
    const addresses = (status.addresses || []).map((address) => `http://${address}:${status.port}/?room=${encodeURIComponent(currentRoomCode || "H4LL0")}`);
    if (addresses.length === 0) addresses.push(`${window.location.origin}/?room=${encodeURIComponent(currentRoomCode || "H4LL0")}`);
    for (const address of addresses) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = address;
      link.textContent = address;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const copy = document.createElement("button");
      copy.className = "copy-code";
      copy.type = "button";
      copy.textContent = "📋 Copia link Wi-Fi";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(address);
          showToast("Indirizzo copiato!");
        } catch {
          showToast(`Indirizzo: ${address}`);
        }
      });
      item.append(link, document.createTextNode(" "), copy);
      list.append(item);
    }
    panel.hidden = false;
  } catch {
    panel.hidden = true;
  }
}

function startJudgePolling() {
  clearInterval(judgeRefresh);
  judgeRefresh = setInterval(() => {
    if ((judgeToken || userToken) && !document.querySelector("#judge-panel").hidden) {
      loadJudgeState(true).catch(() => {});
    }
  }, 4000);
}

// ----------------------------------------------------
// EVENT LISTENERS INITIALIZATION
// ----------------------------------------------------
document.querySelectorAll(".main-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => setActiveView(tab.dataset.view));
});

document.querySelectorAll(".player-subtab").forEach((tab) => {
  tab.addEventListener("click", () => setActivePlayerSubview(tab.dataset.subview));
});

// URL Query Param auto-fill for room invite: ?room=XXXXX
const urlParams = new URLSearchParams(window.location.search);
const inviteRoom = urlParams.get("room");
if (inviteRoom) {
  const roomInput = document.querySelector("#join-room-code");
  if (roomInput) roomInput.value = inviteRoom.toUpperCase().trim();
  setActiveView("player-view");
}

// Player Join Form
document.querySelector("#player-room-join-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const roomCode = document.querySelector("#join-room-code").value.trim().toUpperCase();
  const name = document.querySelector("#join-player-name").value.trim();
  const pin = document.querySelector("#join-player-pin").value.trim() || undefined;
  const errorEl = document.querySelector("#player-login-error");
  errorEl.textContent = "";

  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: "POST",
      body: JSON.stringify({ name, pin }),
    }, null);

    playerToken = result.token;
    sessionStorage.setItem("playerToken", playerToken);
    await loadPlayerDashboard();
    startPlayerPolling();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// Legacy player login toggle & submit
document.querySelector("#toggle-legacy-player-btn")?.addEventListener("click", () => {
  const box = document.querySelector("#legacy-player-box");
  box.hidden = !box.hidden;
});

document.querySelector("#player-login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = document.querySelector("#player-code").value.trim();
  const errorEl = document.querySelector("#player-login-error");
  errorEl.textContent = "";
  try {
    const result = await api("/api/player/login", {
      method: "POST",
      body: JSON.stringify({ code }),
    }, null);
    playerToken = result.token;
    sessionStorage.setItem("playerToken", playerToken);
    await loadPlayerDashboard();
    startPlayerPolling();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// Player Leave Room
document.querySelector("#waiting-leave-btn")?.addEventListener("click", async () => {
  try {
    await api("/api/player/logout", { method: "POST" }, playerToken);
  } catch {}
  playerToken = null;
  sessionStorage.removeItem("playerToken");
  clearInterval(dashboardRefresh);
  showPlayerLoginView();
  showToast("Sei uscito dalla stanza.");
});

document.querySelector("#player-logout")?.addEventListener("click", async () => {
  try {
    await api("/api/player/logout", { method: "POST" }, playerToken);
  } catch {}
  playerToken = null;
  sessionStorage.removeItem("playerToken");
  clearInterval(dashboardRefresh);
  showPlayerLoginView();
  showToast("Disconnesso dal profilo giocatore.");
});

// Modal Prova Missione Giocatore
document.querySelector("#cancel-proof-btn")?.addEventListener("click", () => proofDialog.close());
document.querySelector("#proof-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#proof-mission-id").value;
  const proof = document.querySelector("#proof-text").value.trim();
  if (!proof) return;
  proofDialog.close();
  await submitPlayerMission(id, "submit", proof);
});

// Form Messaggio Giocatore
document.querySelector("#player-message-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/player/messages", {
      method: "POST",
      body: JSON.stringify({
        kind: document.querySelector("#player-message-kind").value,
        subject: document.querySelector("#player-message-subject").value,
        body: document.querySelector("#player-message-body").value,
      }),
    }, playerToken);
    document.querySelector("#player-message-subject").value = "";
    document.querySelector("#player-message-body").value = "";
    await loadPlayerDashboard();
    showToast("Messaggio inviato al Giudice.");
  } catch (err) {
    showToast(err.message);
  }
});

// Form Azione Segreta Giocatore
document.querySelector("#player-action-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/player/actions", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#player-action-title").value,
        details: document.querySelector("#player-action-details").value,
      }),
    }, playerToken);
    document.querySelector("#player-action-details").value = "";
    await loadPlayerDashboard();
    showToast("Azione segreta inviata al Giudice.");
  } catch (err) {
    showToast(err.message);
  }
});

// Form Voto Giocatore
document.querySelector("#player-vote-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targets = [...document.querySelectorAll("#vote-candidates input:checked")].map((i) => i.value);
  if (!targets.length) return showToast("Seleziona almeno un sospetto prima di votare.");
  try {
    await api("/api/player/vote", { method: "POST", body: JSON.stringify({ targets }) }, playerToken);
    await loadPlayerDashboard();
    showToast("Voto segreto inviato con successo!");
  } catch (err) {
    showToast(err.message);
  }
});

// ----------------------------------------------------
// GAME MASTER UI LISTENERS
// ----------------------------------------------------
document.querySelector("#auth-tab-login")?.addEventListener("click", () => {
  document.querySelector("#judge-user-login-form").hidden = false;
  document.querySelector("#judge-user-register-form").hidden = true;
  document.querySelector("#auth-tab-login").className = "button secondary";
  document.querySelector("#auth-tab-register").className = "button quiet";
});

document.querySelector("#auth-tab-register")?.addEventListener("click", () => {
  document.querySelector("#judge-user-login-form").hidden = true;
  document.querySelector("#judge-user-register-form").hidden = false;
  document.querySelector("#auth-tab-login").className = "button quiet";
  document.querySelector("#auth-tab-register").className = "button secondary";
});

document.querySelector("#toggle-legacy-judge-btn")?.addEventListener("click", () => {
  const form = document.querySelector("#judge-login-form");
  form.hidden = !form.hidden;
});

// GM User Login Form
document.querySelector("#judge-user-login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#judge-user-username").value.trim();
  const password = document.querySelector("#judge-user-password").value;
  const errorEl = document.querySelector("#judge-login-error");
  errorEl.textContent = "";
  try {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }, null);
    userToken = res.token;
    currentUser = res.user;
    sessionStorage.setItem("userToken", userToken);
    sessionStorage.setItem("currentUser", JSON.stringify(currentUser));
    showJudgeRoomsView();
    showToast(`Benvenuto, ${currentUser.username}!`);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// GM User Register Form
document.querySelector("#judge-user-register-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.querySelector("#judge-reg-username").value.trim();
  const password = document.querySelector("#judge-reg-password").value;
  const errorEl = document.querySelector("#judge-login-error");
  errorEl.textContent = "";
  try {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }, null);
    userToken = res.token;
    currentUser = res.user;
    sessionStorage.setItem("userToken", userToken);
    sessionStorage.setItem("currentUser", JSON.stringify(currentUser));
    showJudgeRoomsView();
    showToast("Profilo Game Master creato con successo!");
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// GM Legacy Login Form
document.querySelector("#judge-login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#judge-password").value;
  const errorEl = document.querySelector("#judge-login-error");
  errorEl.textContent = "";
  try {
    const res = await api("/api/judge/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }, null);
    judgeToken = res.token;
    sessionStorage.setItem("judgeToken", judgeToken);
    document.querySelector("#judge-auth-panel").hidden = true;
    document.querySelector("#judge-rooms-manager").hidden = true;
    document.querySelector("#judge-panel").hidden = false;
    await loadJudgeState();
    startJudgePolling();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// GM Logout
document.querySelector("#judge-user-logout")?.addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  userToken = null;
  currentUser = null;
  sessionStorage.removeItem("userToken");
  sessionStorage.removeItem("currentUser");
  showJudgeAuthView();
  showToast("Disconnesso dal profilo Game Master.");
});

document.querySelector("#judge-logout")?.addEventListener("click", async () => {
  try { await api("/api/judge/logout", { method: "POST" }); } catch {}
  judgeToken = null;
  sessionStorage.removeItem("judgeToken");
  clearInterval(judgeRefresh);
  if (userToken) {
    showJudgeRoomsView();
  } else {
    showJudgeAuthView();
  }
});

// Create Room Form
document.querySelector("#create-room-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#new-room-name").value.trim();
  const msg = document.querySelector("#room-create-message");
  msg.textContent = "";
  try {
    const res = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    document.querySelector("#new-room-name").value = "";
    showToast(`Stanza "${res.room.name}" creata!`);
    enterRoomAsJudge(res.room.code);
  } catch (err) {
    msg.textContent = err.message;
  }
});

// Back to rooms button
document.querySelector("#judge-back-to-rooms")?.addEventListener("click", () => {
  clearInterval(judgeRefresh);
  currentRoomCode = null;
  sessionStorage.removeItem("currentRoomCode");
  showJudgeRoomsView();
});

// Copy room code & link & share
document.querySelector("#copy-room-code-btn")?.addEventListener("click", async () => {
  const code = document.querySelector("#judge-room-code-display").textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast(`Codice stanza "${code}" copiato negli appunti!`);
  } catch {
    showToast(`Codice stanza: ${code}`);
  }
});

document.querySelector("#copy-room-link-btn")?.addEventListener("click", async () => {
  const code = document.querySelector("#judge-room-code-display").textContent;
  const link = `${window.location.origin}/?room=${encodeURIComponent(code)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link invito copiato!");
  } catch {
    showToast(`Link: ${link}`);
  }
});

document.querySelector("#share-whatsapp-btn")?.addEventListener("click", () => {
  const code = document.querySelector("#judge-room-code-display").textContent;
  const link = `${window.location.origin}/?room=${encodeURIComponent(code)}`;
  const text = encodeURIComponent(`🎃 Entra nella partita de "La Notte dei Sospetti"!\nCodice stanza: ${code}\nLink diretto: ${link}`);
  window.open(`https://wa.me/?text=${text}`, "_blank");
});

// SMART BAR ACTIONS
document.querySelector("#btn-smart-auto-balance")?.addEventListener("click", async () => {
  if (state?.started) return showToast("La partita è già iniziata.");
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/auto-balance` : "/api/judge/auto-balance";
    const res = await api(url, { method: "POST" });
    await loadJudgeState();
    showToast("⚖️ Ruoli auto-bilanciati con successo sui giocatori presenti!");
  } catch (err) {
    showToast(err.message);
  }
});

document.querySelector("#btn-smart-shuffle")?.addEventListener("click", async () => {
  if (state?.started) return showToast("La partita è già iniziata.");
  if (!window.confirm("Vuoi sorteggiare e assegnare casualmente i ruoli a tutti i partecipanti presenti nella lobby?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/shuffle-roles` : "/api/judge/shuffle-roles";
    await api(url, { method: "POST" });
    await loadJudgeState();
    showToast("🎲 Ruoli sorteggiati e distribuiti a tutti!");
  } catch (err) {
    showToast(err.message);
  }
});

document.querySelector("#btn-smart-toggle-spoilers")?.addEventListener("click", () => {
  spoilersHidden = !spoilersHidden;
  document.querySelectorAll(".role-cell-content").forEach((el) => {
    el.classList.toggle("spoiler-masked", spoilersHidden);
  });
  document.querySelector("#btn-smart-toggle-spoilers").textContent = spoilersHidden ? "👁️ Mostra Ruoli (Spoiler TV)" : "👁️ Nascondi Ruoli (Privacy TV)";
  showToast(spoilersHidden ? "Modalità Privacy TV attiva: ruoli oscurati." : "Ruoli visibili a schermo.");
});

async function triggerBatchMissions() {
  if (!window.confirm("Vuoi distribuire con un click una missione casuale dal mazzo a ogni partecipante per il turno attuale?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/missions/random-batch` : "/api/judge/missions/random-batch";
    const res = await api(url, { method: "POST" });
    await loadJudgeState();
    showToast(`⚡ Assegnate con successo ${res.assignedCount} missioni casuali!`);
  } catch (err) {
    showToast(err.message);
  }
}
document.querySelector("#btn-batch-missions-panel")?.addEventListener("click", triggerBatchMissions);

// Mission Template Select
document.querySelector("#mission-template-select")?.addEventListener("change", (e) => {
  const idx = e.target.value;
  if (!idx || !missionTemplates[Number(idx)]) return;
  const t = missionTemplates[Number(idx)];
  document.querySelector("#mission-title").value = t.title;
  document.querySelector("#mission-description").value = t.description;
  document.querySelector("#mission-objective").value = t.objective;
  document.querySelector("#mission-rules").value = t.rules;
  document.querySelector("#mission-verification").value = t.verification;
  document.querySelector("#mission-score").value = t.score;
  showToast(`Template "${t.title}" caricato.`);
});

// Judge Form Add Participant
document.querySelector("#add-participant-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-participant");
  const name = input.value.trim();
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/participants` : "/api/judge/participants";
    await api(url, { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    document.querySelector("#roster-message").textContent = `✓ ${name} aggiunto alla stanza.`;
    await loadJudgeState();
  } catch (error) {
    document.querySelector("#roster-message").textContent = error.message;
  }
});

// Clear Participants
document.querySelector("#clear-participants-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Sei sicuro di voler rimuovere tutti i partecipanti dalla stanza?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/participants/all?force=true` : "/api/judge/participants/all?force=true";
    await api(url, { method: "DELETE" });
    await loadJudgeState();
    showToast("Tutti i partecipanti sono stati rimossi.");
  } catch (error) {
    showToast(error.message);
  }
});

// Clear Roles & Preset Roles
document.querySelector("#clear-roles-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Sei sicuro di voler azzerare tutti i ruoli della stanza?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/roles/clear` : "/api/judge/roles/clear";
    await api(url, { method: "POST" });
    resetRoleForm();
    await loadJudgeState();
    showToast("Tutti i ruoli sono stati azzerati.");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#preset-roles-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Ricaricare il preset Halloween standard (Sentinelle, Sabotatori, Veggente, Malcapitati)?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/roles/preset` : "/api/judge/roles/preset";
    await api(url, { method: "POST" });
    resetRoleForm();
    await loadJudgeState();
    showToast("Preset ruoli Halloween ricaricato.");
  } catch (error) {
    showToast(error.message);
  }
});

// Role editor form submit
document.querySelector("#role-editor-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#role-edit-id").value;
  const count = Number(document.querySelector("#role-edit-count")?.value || 1);
  const role = {
    name: document.querySelector("#role-edit-name").value,
    target_count: count,
    team: document.querySelector("#role-edit-team").value,
    description: document.querySelector("#role-edit-description").value,
    objectives: document.querySelector("#role-edit-objectives").value,
    rules: document.querySelector("#role-edit-rules").value,
    actions: document.querySelector("#role-edit-actions").value,
  };
  try {
    if (id) {
      const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/roles/${encodeURIComponent(id)}` : `/api/judge/roles/${encodeURIComponent(id)}`;
      await api(url, { method: "PATCH", body: JSON.stringify(role) });
    } else {
      const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/roles` : "/api/judge/roles";
      await api(url, { method: "POST", body: JSON.stringify(role) });
    }
    resetRoleForm();
    await loadJudgeState();
    showToast(id ? "Ruolo aggiornato." : "Nuovo ruolo aggiunto!");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#role-cancel-edit-btn")?.addEventListener("click", resetRoleForm);

document.querySelector("#role-delete")?.addEventListener("click", async () => {
  const id = document.querySelector("#role-edit-id").value;
  if (!id || !window.confirm("Eliminare definitivamente questo ruolo?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/roles/${encodeURIComponent(id)}` : `/api/judge/roles/${encodeURIComponent(id)}`;
    await api(url, { method: "DELETE" });
    resetRoleForm();
    await loadJudgeState();
    showToast("Ruolo eliminato.");
  } catch (error) {
    showToast(error.message);
  }
});

// Role configuration form
document.querySelector("#role-configuration-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#role-configuration-message");
  const targets = Object.fromEntries(roleEntries().map(([key]) => [key, Number(document.querySelector(`#target-${key}`)?.value || 0)]));
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/role-configuration` : "/api/judge/role-configuration";
    await api(url, { method: "PUT", body: JSON.stringify({ targets }) });
    message.textContent = "✓ Quantità ruoli salvata.";
    await loadJudgeState();
  } catch (error) {
    message.textContent = error.message;
  }
});

// Start Game Modal
document.querySelector("#start-game")?.addEventListener("click", () => {
  const roster = document.querySelector("#confirmation-roster");
  roster.replaceChildren();
  for (const p of state.participants) {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = p.name;
    item.append(name, document.createTextNode(` — ${state.roles[p.role] || "Non assegnato"}`));
    roster.append(item);
  }
  confirmDialog.showModal();
});

document.querySelector("#confirm-start")?.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/start` : "/api/judge/start";
    await api(url, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    confirmDialog.close();
    await loadJudgeState();
    showToast("🎉 Partita avviata! I ruoli segreti sono ora distribuiti a tutti i giocatori.");
  } catch (error) {
    confirmDialog.close();
    showToast(error.message);
  }
});

// Judge Mission Form
document.querySelector("#mission-target-type")?.addEventListener("change", (e) => {
  const byRole = e.target.value === "role";
  document.querySelector("#mission-role-field").hidden = !byRole;
  document.querySelector("#mission-participant-field").hidden = byRole;
});

document.querySelector("#mission-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/missions` : "/api/judge/missions";
    await api(url, {
      method: "POST",
      body: JSON.stringify({
        ...(document.querySelector("#mission-target-type").value === "role"
          ? { roleId: document.querySelector("#mission-role").value }
          : { participantId: document.querySelector("#mission-participant").value }),
        title: document.querySelector("#mission-title").value,
        description: document.querySelector("#mission-description").value,
        objective: document.querySelector("#mission-objective").value,
        rules: document.querySelector("#mission-rules").value,
        verification: document.querySelector("#mission-verification").value,
        score: Number(document.querySelector("#mission-score").value),
        turn: Number(document.querySelector("#mission-turn").value),
      }),
    });
    document.querySelector("#mission-title").value = "";
    document.querySelector("#mission-description").value = "";
    document.querySelector("#mission-objective").value = "";
    document.querySelector("#mission-rules").value = "";
    document.querySelector("#mission-verification").value = "";
    await loadJudgeState();
    showToast("Missione assegnata con successo.");
  } catch (error) {
    showToast(error.message);
  }
});

// Judge Message Form
document.querySelector("#judge-message-target-type")?.addEventListener("change", (e) => {
  const type = e.target.value;
  document.querySelector("#message-participant-field").hidden = type !== "player";
  document.querySelector("#message-team-field").hidden = type !== "team";
});

document.querySelector("#judge-message-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetType = document.querySelector("#judge-message-target-type").value;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/messages` : "/api/judge/messages";
    await api(url, {
      method: "POST",
      body: JSON.stringify({
        ...(targetType === "player" ? { participantId: document.querySelector("#message-participant").value } : {}),
        ...(targetType === "team" ? { team: document.querySelector("#message-team").value } : {}),
        subject: document.querySelector("#message-subject").value,
        body: document.querySelector("#judge-message-body").value,
      }),
    });
    document.querySelector("#message-subject").value = "";
    document.querySelector("#judge-message-body").value = "";
    await loadJudgeState();
    showToast("Comunicazione inviata.");
  } catch (error) {
    showToast(error.message);
  }
});

// Game operations actions
async function gameAction(action, confirmed = false) {
  if (confirmed && !window.confirm("Confermi questa operazione sulla partita?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/game-action` : "/api/judge/game-action";
    await api(url, {
      method: "POST",
      body: JSON.stringify({ action, ...(confirmed ? { confirmed: true } : {}) }),
    });
    await loadJudgeState();
    showToast("Stato della partita aggiornato.");
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#pause-game")?.addEventListener("click", () => gameAction("pause"));
document.querySelector("#resume-game")?.addEventListener("click", () => gameAction("resume"));
document.querySelector("#next-turn")?.addEventListener("click", () => gameAction("next-turn", true));
document.querySelector("#end-game")?.addEventListener("click", () => gameAction("end", true));
document.querySelector("#terminate-game")?.addEventListener("click", () => gameAction("terminate", true));

// Reveal roles
document.querySelector("#reveal-roles")?.addEventListener("click", async () => {
  if (!window.confirm("I ruoli segreti e i risultati finali saranno svelati a tutti i giocatori. Confermi?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/reveal` : "/api/judge/reveal";
    await api(url, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    await loadJudgeState();
    showToast("Ruoli rivelati a tutti i giocatori!");
  } catch (error) {
    showToast(error.message);
  }
});

// Vote open / close
document.querySelector("#vote-open-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/vote` : "/api/judge/vote";
    await api(url, {
      method: "POST",
      body: JSON.stringify({ limit: Number(document.querySelector("#vote-limit").value) }),
    });
    await loadJudgeState();
    showToast("Votazione aperta per tutti i partecipanti.");
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#vote-close")?.addEventListener("click", async () => {
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/vote/close` : "/api/judge/vote/close";
    await api(url, { method: "POST" });
    await loadJudgeState();
    showToast("Votazione chiusa.");
  } catch (error) {
    showToast(error.message);
  }
});

// Score adjustment
document.querySelector("#score-adjustment-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/score-adjustment` : "/api/judge/score-adjustment";
    await api(url, {
      method: "POST",
      body: JSON.stringify({
        participantId: document.querySelector("#score-participant").value,
        points: Number(document.querySelector("#score-points").value),
        reason: document.querySelector("#score-reason").value,
      }),
    });
    document.querySelector("#score-reason").value = "";
    await loadJudgeState();
    showToast("Punteggio aggiornato nel registro.");
  } catch (error) {
    showToast(error.message);
  }
});

// Settings form
document.querySelector("#settings-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#settings-message");
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/settings` : "/api/judge/settings";
    await api(url, {
      method: "PUT",
      body: JSON.stringify({
        turnCount: Number(document.querySelector("#setting-turn-count").value),
        turnDurationMinutes: Number(document.querySelector("#setting-turn-duration").value),
        voteLimit: Number(document.querySelector("#setting-vote-limit").value),
        winMetric: document.querySelector("#setting-win-metric").value,
        rules: document.querySelector("#setting-rules").value,
        winConditions: document.querySelector("#setting-win-conditions").value,
        deadlineFailure: document.querySelector("#setting-deadline-failure").checked,
      }),
    });
    message.textContent = "✓ Impostazioni salvate.";
    await loadJudgeState();
  } catch (error) {
    message.textContent = error.message;
  }
});

// Refresh button & new game button
document.querySelector("#judge-refresh-btn")?.addEventListener("click", async () => {
  await loadJudgeState();
  showToast("Dati della partita aggiornati.");
});

document.querySelector("#judge-new-game-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Vuoi azzerare la partita per ripartire in fase di preparazione (setup)?")) return;
  try {
    const url = currentRoomCode ? `/api/rooms/${encodeURIComponent(currentRoomCode)}/judge/game/reset` : "/api/judge/game/reset";
    await api(url, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    await loadJudgeState();
    showToast("Partita ripristinata in preparazione.");
  } catch (error) {
    showToast(error.message);
  }
});

// Timers
setInterval(renderJudgeTimer, 1000);

// Auto-init on page load
if (playerToken) {
  loadPlayerDashboard().then(() => {
    setActiveView("player-view");
    startPlayerPolling();
  }).catch(() => {
    playerToken = null;
    sessionStorage.removeItem("playerToken");
  });
}

if (userToken) {
  if (currentRoomCode) {
    enterRoomAsJudge(currentRoomCode);
  } else {
    showJudgeRoomsView();
  }
} else if (judgeToken) {
  enterRoomAsJudge("H4LL0");
}
