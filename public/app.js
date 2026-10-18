const judgeLoginPanel = document.querySelector("#login-panel");
const judgePanel = document.querySelector("#judge-panel");
const participantList = document.querySelector("#participant-list");
const roleTableBody = document.querySelector("#role-table-body");
const confirmDialog = document.querySelector("#confirm-dialog");
const proofDialog = document.querySelector("#proof-dialog");
const toast = document.querySelector("#toast");

let judgeToken = sessionStorage.getItem("judgeToken");
let playerToken = sessionStorage.getItem("playerToken");
let state = null;
let toastTimeout;
let playerDashboard = null;
let dashboardRefresh;
let judgeRefresh;

function roleEntries() {
  return state && state.roles ? Object.entries(state.roles) : [];
}

function setMissionTargetType(type) {
  const byRole = type === "role";
  const roleField = document.querySelector("#mission-role-field");
  const partField = document.querySelector("#mission-participant-field");
  const partSelect = document.querySelector("#mission-participant");
  const roleSelect = document.querySelector("#mission-role");
  if (roleField) roleField.hidden = !byRole;
  if (partField) partField.hidden = byRole;
  if (partSelect) partSelect.required = !byRole;
  if (roleSelect) roleSelect.required = byRole;
}

function setJudgeMessageTargetType(type) {
  const partField = document.querySelector("#message-participant-field");
  const teamField = document.querySelector("#message-team-field");
  if (partField) partField.hidden = type !== "player";
  if (teamField) teamField.hidden = type !== "team";
}

async function api(url, options = {}, token = judgeToken) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      if (token === judgeToken) {
        judgeToken = null;
        sessionStorage.removeItem("judgeToken");
        clearInterval(judgeRefresh);
        showJudgeLogin();
      } else if (token === playerToken) {
        playerToken = null;
        sessionStorage.removeItem("playerToken");
        clearInterval(dashboardRefresh);
        document.querySelector("#player-role-panel").hidden = true;
        document.querySelector("#player-login-panel").hidden = false;
      }
    }
    throw new Error(payload.error || "Si è verificato un errore.");
  }
  return payload;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3400);
}

function showJudgeLogin() {
  judgeLoginPanel.hidden = false;
  judgePanel.hidden = true;
}

function setActiveView(viewId) {
  document.querySelectorAll(".tab").forEach((tab) => {
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

function setGameLock(started) {
  const statusElement = document.querySelector("#game-status");
  if (statusElement) {
    statusElement.textContent = started
      ? `Partita ${state.game.status} · Ruoli distribuiti e bloccati per i giocatori`
      : "Partita in fase di preparazione (non iniziata)";
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
      await api(`/api/judge/participants/${encodeURIComponent(participant.id)}`, {
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
  participantList.replaceChildren();
  for (const [index, participant] of state.participants.entries()) {
    const item = document.createElement("li");
    item.className = "participant-item";
    const number = document.createElement("span");
    number.className = "participant-number";
    number.textContent = `${index + 1}.`;
    const input = document.createElement("input");
    input.className = "name-edit";
    input.value = participant.name;
    input.maxLength = 60;
    input.setAttribute("aria-label", `Nome partecipante ${index + 1}`);
    input.disabled = state.started;
    input.addEventListener("change", async () => {
      try {
        await api(`/api/judge/participants/${encodeURIComponent(participant.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: input.value }),
        });
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
    remove.setAttribute("aria-label", `Rimuovi ${participant.name}`);
    remove.disabled = state.started;
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Rimuovere definitivamente ${participant.name} dall’elenco dei partecipanti?`)) return;
      try {
        await api(`/api/judge/participants/${encodeURIComponent(participant.id)}?force=true`, { method: "DELETE" });
        await loadJudgeState();
        showToast(`${participant.name} rimosso.`);
      } catch (error) {
        showToast(error.message);
      }
    });
    item.append(number, input, remove);
    participantList.append(item);
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
    targetList.innerHTML = `<p class="empty-state" style="grid-column:1/-1;">Nessun ruolo ancora creato per la partita. Crea il tuo primo ruolo personalizzato nel form qui sopra!</p>`;
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
        await api(`/api/judge/roles/${encodeURIComponent(key)}`, { method: "DELETE" });
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
  statusTotal.innerHTML = `Ruoli previsti configurati: <strong>${total}</strong> · Partecipanti presenti: <strong>${partCount}</strong> ${total === partCount && partCount > 0 ? '<span style="color:var(--green);">✓ (Le quantità coincidono)</span>' : total < partCount ? `<span style="color:var(--orange);">(Mancano ${partCount - total} posti ruolo)</span>` : `<span style="color:var(--red);">(Hai configurato ${total - partCount} ruoli in più)</span>`}`;

  const teams = new Map();
  for (const role of state.rolesDetailed) {
    if (role.team) teams.set(role.team, (teams.get(role.team) || 0) + (state.limits[role.id] || 0));
  }
  document.querySelector("#team-count").textContent = teams.size
    ? [...teams].map(([team, count]) => `${team}: ${count} giocatori`).join(" · ")
    : "Nessun gruppo/fazione configurato.";
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

  roleTableBody.replaceChildren();
  for (const participant of state.participants) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = participant.name;
    const roleCell = document.createElement("td");
    roleCell.append(createRoleSelect(participant));
    const accessCell = document.createElement("td");
    accessCell.className = "access-cell";
    const code = document.createElement("span");
    code.className = "access-code";
    code.textContent = participant.accessCode;
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.type = "button";
    copy.textContent = "📋 Copia codice";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(participant.accessCode);
        showToast(`Codice copiato per ${participant.name}. Consegnalo in privato.`);
      } catch {
        showToast(`Codice privato: ${participant.accessCode}`);
      }
    });
    accessCell.append(code, copy);
    const actionCell = document.createElement("td");
    const isOnline = participant.online;
    actionCell.innerHTML = `<span class="online-indicator ${isOnline ? 'online' : 'offline'}">${isOnline ? '🟢 Connesso' : '⚪ Non connesso'}</span>`;
    row.append(nameCell, roleCell, accessCell, actionCell);
    roleTableBody.append(row);
  }
  renderRoleEditor();
}

function renderRoleEditor() {
  const select = document.querySelector("#role-edit-select");
  const selected = select.value;
  select.replaceChildren(new Option("— Nuovo ruolo personalizzato —", ""));
  for (const role of state.rolesDetailed) select.append(new Option(role.name, role.id));
  select.value = selected;

  const targets = ["mission-participant", "mission-role", "message-participant", "message-team", "score-participant"];
  for (const id of targets) {
    const element = document.querySelector(`#${id}`);
    if (!element) continue;
    const selectedValue = element.value;
    element.replaceChildren();
    if (id === "mission-role") {
      for (const [roleId, roleName] of roleEntries()) element.append(new Option(roleName, roleId));
    } else if (id === "message-team") {
      const teams = [...new Set(state.rolesDetailed.map((role) => role.team).filter(Boolean))];
      for (const team of teams) element.append(new Option(team, team));
    } else {
      for (const participant of state.participants) element.append(new Option(participant.name, participant.id));
    }
    element.value = selectedValue;
  }

  const missionTurn = document.querySelector("#mission-turn");
  if (missionTurn) {
    missionTurn.max = String(state.settings.turnCount || 1);
    if (!missionTurn.value || Number(missionTurn.value) > Number(missionTurn.max)) {
      missionTurn.value = state.game.currentTurn || 1;
    }
  }
  const voteLimit = document.querySelector("#vote-limit");
  if (voteLimit) {
    voteLimit.max = String(Math.max(1, state.participants.length));
    voteLimit.value = state.game.voteLimit || 1;
  }
  document.querySelector("#setting-turn-count").value = state.settings.turnCount || 1;
  document.querySelector("#setting-turn-duration").value = state.settings.turnDurationMinutes || 30;
  document.querySelector("#setting-vote-limit").value = state.game.voteLimit || 1;
  document.querySelector("#setting-win-metric").value = state.settings.winMetric || "score";
  document.querySelector("#setting-rules").value = state.settings.rules || "";
  document.querySelector("#setting-win-conditions").value = state.settings.winConditions || "";
  document.querySelector("#setting-deadline-failure").checked = state.settings.deadlineFailure === true;

  document.querySelector("#settings-form").querySelectorAll("input, textarea, button, select").forEach((item) => {
    item.disabled = state.started;
  });
  document.querySelector("#role-editor-form").querySelectorAll("input, textarea, select, button").forEach((item) => {
    item.disabled = state.started;
  });
  document.querySelector("#role-delete").hidden = !select.value || state.started;

  setMissionTargetType(document.querySelector("#mission-target-type")?.value || "player");
  setJudgeMessageTargetType(document.querySelector("#judge-message-target-type")?.value || "all");
}

function renderValidation() {
  const validation = document.querySelector("#validation");
  validation.replaceChildren();
  if (state.ready) {
    const item = document.createElement("div");
    item.className = "valid";
    item.textContent = `✓ Configurazione valida: ${state.participants.length} partecipanti presenti, tutti assegnati esattamente secondo le quantità previste.`;
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
  const startHint = document.querySelector("#start-hint");
  if (startHint) {
    startHint.textContent = state.started
      ? "Partita avviata. Le modifiche eccezionali ai ruoli richiedono un motivo e vengono registrate nello storico."
      : state.game.status !== "setup" ? "La partita è terminata e non può essere riavviata."
      : state.ready ? "Tutto pronto: puoi verificare il riepilogo riservato e confermare l’avvio della partita."
      : "L’avvio della partita resta disabilitato finché non sono risolti tutti i punti elencati sopra.";
  }
}

function renderHistory() {
  const list = document.querySelector("#history-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.history.length) {
    const item = document.createElement("li");
    item.textContent = "Nessuna modifica eccezionale registrata.";
    list.append(item);
  }
  for (const entry of state.history) {
    const item = document.createElement("li");
    const oldRole = entry.old_role ? state.roles[entry.old_role] || entry.old_role : "non assegnato";
    const newRole = entry.new_role ? state.roles[entry.new_role] || entry.new_role : "non assegnato";
    item.textContent = `${new Date(entry.changed_at).toLocaleString("it-IT")} · ${entry.participant_name}: ${oldRole} → ${newRole}. Motivo: ${entry.reason}`;
    list.append(item);
  }
}

function makeRecord(title, body, status, badgeClass = "") {
  const article = document.createElement("article");
  article.className = "record-card";
  const heading = document.createElement("div");
  heading.className = "record-heading";
  const titleElement = document.createElement("strong");
  titleElement.textContent = title;
  const statusElement = document.createElement("span");
  statusElement.className = `badge ${badgeClass}`;
  statusElement.textContent = status;
  heading.append(titleElement, statusElement);
  article.append(heading);
  if (body) {
    const description = document.createElement("p");
    description.textContent = body;
    article.append(description);
  }
  return article;
}

async function judgeMissionReview(mission, status) {
  const note = status === "rejected" ? window.prompt("Motivo del rifiuto (visibile al giocatore):") : "";
  if (status === "rejected" && !note?.trim()) return;
  try {
    await api(`/api/judge/missions/${encodeURIComponent(mission.id)}`, {
      method: "PATCH", body: JSON.stringify({ status, note }),
    });
    await loadJudgeState();
    showToast(status === "completed" ? "Missione convalidata! Punti accreditati." : "Missione respinta.");
  } catch (error) { showToast(error.message); }
}

async function judgeActionReview(action, status) {
  const note = status === "rejected" ? window.prompt("Motivo del rifiuto (visibile al giocatore):") : "";
  if (status === "rejected" && !note?.trim()) return;
  let score = 0;
  if (status === "approved") {
    const value = window.prompt("Punti da assegnare per questa azione segreta:", "5");
    if (value === null || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
      showToast("Punteggio non valido.");
      return;
    }
    score = Number(value);
  }
  try {
    await api(`/api/judge/actions/${encodeURIComponent(action.id)}`, {
      method: "PATCH", body: JSON.stringify({ status, note, score }),
    });
    await loadJudgeState();
    showToast("Valutazione dell'azione registrata.");
  } catch (error) { showToast(error.message); }
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
  document.querySelector("#next-turn").disabled = !running || game.currentTurn >= (state.settings.turnCount || 1);
  document.querySelector("#end-game").disabled = !running && !paused;
  document.querySelector("#terminate-game").disabled = !state.started || ["completed", "terminated"].includes(game.status);
  document.querySelector("#reveal-roles").disabled = game.status !== "completed" || game.rolesRevealed;
  document.querySelector("#vote-close").disabled = !game.voteOpen;
  document.querySelector("#vote-open-form button[type=submit]").disabled = !running || game.voteOpen;
  document.querySelector("#mission-form").querySelectorAll("input, textarea, select, button").forEach((item) => {
    item.disabled = !running;
  });

  // 1. Missioni e verifiche
  const missionList = document.querySelector("#judge-missions");
  missionList.replaceChildren();
  if (!state.missions.length) {
    missionList.append(makeRecord("Nessuna missione assegnata", "Le missioni compariranno qui dopo l'assegnazione.", "Vuoto"));
  }
  for (const mission of state.missions) {
    const statusLabels = {
      assigned: "Assegnata", active: "In corso", submitted: "In verifica",
      under_review: "In verifica", completed: "Completata", rejected: "Respinta",
    };
    const record = makeRecord(
      `${mission.title} · ${mission.participant_name}`,
      mission.description,
      statusLabels[mission.status] || mission.status,
      mission.status === "completed" ? "badge-success" : mission.status === "submitted" ? "badge-warning" : ""
    );
    const details = document.createElement("p");
    details.innerHTML = `<strong>Turno ${mission.turn_number}</strong> · ${mission.score} punti previsti${mission.proof ? `<br>🔍 <em>Prova inviata dal giocatore:</em> "${mission.proof}"` : ""}${mission.review_note ? `<br>💬 <em>Nota del giudice:</em> "${mission.review_note}"` : ""}`;
    record.append(details);

    if (["submitted", "under_review"].includes(mission.status)) {
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "record-actions";
      const approve = document.createElement("button");
      approve.className = "button secondary";
      approve.textContent = "✓ Convalida e assegna punti";
      approve.addEventListener("click", () => judgeMissionReview(mission, "completed"));
      const reject = document.createElement("button");
      reject.className = "button quiet";
      reject.textContent = "✕ Respingi";
      reject.addEventListener("click", () => judgeMissionReview(mission, "rejected"));
      actionsDiv.append(approve, reject);
      record.append(actionsDiv);
    }
    missionList.append(record);
  }

  // 2. Comunicazioni e segnalazioni
  const messageList = document.querySelector("#judge-messages");
  messageList.replaceChildren();
  if (!state.messages.length) {
    messageList.append(makeRecord("Nessuna comunicazione", "I messaggi dei giocatori e gli annunci inviati compariranno qui.", "Vuoto"));
  }
  for (const message of state.messages) {
    const isPlayer = message.sender === "player";
    const title = isPlayer
      ? `${message.kind === "report" ? "🚨 Segnalazione" : "💬 Domanda"} da ${message.participant_name}`
      : `📤 Inviato dal Giudice ${message.participant_id ? `a ${message.participant_name}` : message.team ? `alla squadra ${message.team}` : "a Tutti (Annuncio)"}`;
    const record = makeRecord(
      title,
      message.body,
      new Date(message.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      isPlayer && message.kind === "report" ? "badge-warning" : ""
    );
    if (message.subject) {
      const subject = document.createElement("p");
      subject.innerHTML = `<strong>Oggetto:</strong> ${message.subject}`;
      record.prepend(subject);
    }

    if (isPlayer && message.kind === "report" && message.status === "pending") {
      const btnRow = document.createElement("div");
      btnRow.className = "record-actions";
      for (const [label, status] of [["✓ Approva segnalazione", "approved"], ["✕ Respingi", "rejected"]]) {
        const button = document.createElement("button");
        button.className = status === "approved" ? "button secondary" : "button quiet";
        button.textContent = label;
        button.addEventListener("click", async () => {
          const note = status === "rejected" ? window.prompt("Motivo del rifiuto (visibile al mittente):") : "";
          if (status === "rejected" && !note?.trim()) return;
          try {
            await api(`/api/judge/messages/${encodeURIComponent(message.id)}`, {
              method: "PATCH", body: JSON.stringify({ status, note }),
            });
            await loadJudgeState();
            showToast("Segnalazione valutata.");
          } catch (error) { showToast(error.message); }
        });
        btnRow.append(button);
      }
      record.append(btnRow);
    } else if (isPlayer && message.kind === "report") {
      const result = document.createElement("p");
      result.textContent = `Esito: ${message.status === 'approved' ? 'Approvata' : 'Respinta'}${message.review_note ? ` · Nota: ${message.review_note}` : ""}`;
      record.append(result);
    }

    if (isPlayer && message.participant_id) {
      const reply = document.createElement("button");
      reply.className = "button quiet";
      reply.textContent = "✉️ Rispondi in privato";
      reply.addEventListener("click", async () => {
        const text = window.prompt(`Risposta privata per ${message.participant_name}:`);
        if (!text?.trim()) return;
        try {
          await api("/api/judge/messages", {
            method: "POST",
            body: JSON.stringify({ participantId: message.participant_id, subject: "Risposta del Giudice", body: text }),
          });
          await loadJudgeState();
          showToast(`Risposta inviata a ${message.participant_name}.`);
        } catch (error) { showToast(error.message); }
      });
      record.append(reply);
    }
    messageList.append(record);
  }

  // 3. Azioni segrete dei ruoli
  const actionList = document.querySelector("#judge-actions");
  actionList.replaceChildren();
  const pendingActions = state.actions.filter((action) => action.status === "pending");
  if (!pendingActions.length) {
    actionList.append(makeRecord("Nessuna azione segreta in attesa", "Le azioni dei ruoli inviate dai giocatori compariranno qui.", "Vuoto"));
  }
  for (const action of pendingActions) {
    const record = makeRecord(`🗡️ ${action.title} · da ${action.participant_name}`, action.details, "In attesa di valutazione");
    const actRow = document.createElement("div");
    actRow.className = "record-actions";
    const approve = document.createElement("button");
    approve.className = "button secondary";
    approve.textContent = "✓ Approva e assegna punti";
    approve.addEventListener("click", () => judgeActionReview(action, "approved"));
    const reject = document.createElement("button");
    reject.className = "button quiet";
    reject.textContent = "✕ Respingi";
    reject.addEventListener("click", () => judgeActionReview(action, "rejected"));
    actRow.append(approve, reject);
    record.append(actRow);
    actionList.append(record);
  }

  // 4. Scoreboard e classifiche
  const scores = document.querySelector("#judge-scoreboard");
  scores.replaceChildren();
  const sorted = [...state.participants].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "it"));
  for (const participant of sorted) {
    const item = document.createElement("li");
    item.textContent = `${participant.name} · ${participant.score} punti${game.rolesRevealed ? ` · Ruolo: ${state.roles[participant.role] || "—"}` : ""}`;
    scores.append(item);
  }

  // 5. Audit log
  const audit = document.querySelector("#audit-log");
  audit.replaceChildren();
  for (const entry of state.audit) {
    const item = document.createElement("li");
    item.textContent = `${new Date(entry.created_at).toLocaleTimeString("it-IT")} · [${entry.actor.toUpperCase()}] ${entry.action}: ${entry.details}`;
    audit.append(item);
  }

  // 6. Risultati voti
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

async function loadJudgeState(isPolling = false) {
  try {
    state = await api("/api/judge/state");
    judgeLoginPanel.hidden = true;
    judgePanel.hidden = false;

    // Se l'utente non sta digitando in un input attivo, esegui il rendering completo
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
      // In modalità polling mentre digita, aggiorna solo le operazioni e il timer
      renderJudgeOperations();
    }
    if (!isPolling) await renderJoinAddresses();
  } catch (error) {
    if (!isPolling) showToast(error.message);
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
      if (headerTitle) headerTitle.textContent = "🌐 Collegamento online per tutti i partecipanti (da smartphone con 4G/5G o qualsiasi rete):";
      const item = document.createElement("li");
      const link = document.createElement("a");
      const address = window.location.origin;
      link.href = address;
      link.textContent = address;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const copy = document.createElement("button");
      copy.className = "copy-code";
      copy.type = "button";
      copy.textContent = "📋 Copia link partita";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(address);
          showToast("Link online copiato! Invialo ai partecipanti (es. su WhatsApp).");
        } catch {
          showToast(`Link: ${address}`);
        }
      });
      item.append(link, document.createTextNode(" "), copy);
      list.append(item);
      panel.hidden = false;
      return;
    }
    if (headerTitle) headerTitle.textContent = "🌐 Collegamento per i partecipanti sulla stessa rete Wi-Fi:";
    const status = await api("/api/status", {}, null);
    const addresses = status.addresses.map((address) => `http://${address}:${status.port}`);
    if (addresses.length === 0) addresses.push(window.location.origin);
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
          showToast("Indirizzo copiato! Condividilo con i partecipanti connessi al Wi-Fi.");
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

// ----------------------------------------------------
// LOGICA GIOCATORE
// ----------------------------------------------------

function renderPlayerDashboard(dashboard) {
  playerDashboard = dashboard;
  document.querySelector("#player-login-panel").hidden = true;
  document.querySelector("#player-role-panel").hidden = false;

  // Header & Home
  document.querySelector("#player-name").textContent = dashboard.name;
  document.querySelector("#player-role").textContent = dashboard.role?.name || "Ruolo non ancora assegnato";
  document.querySelector("#player-role-detail").textContent = dashboard.role?.name || "Ruolo non assegnato";
  document.querySelector("#player-team").textContent = dashboard.role?.team ? `Squadra ${dashboard.role.team}` : "Nessuna squadra";
  document.querySelector("#player-score").textContent = `${dashboard.score} punti`;
  document.querySelector("#player-score-large").textContent = dashboard.score;
  document.querySelector("#player-game-status").textContent = `Turno ${dashboard.game.currentTurn} di ${dashboard.game.turnCount} (${dashboard.game.status})`;

  // Sezione Home: Card missione attiva
  const homeActiveCard = document.querySelector("#player-active-mission-card");
  homeActiveCard.replaceChildren();
  const activeMission = dashboard.missions.find((m) => ["active", "assigned", "submitted", "under_review"].includes(m.status));
  if (activeMission) {
    const statusLabels = { assigned: "Da iniziare", active: "In corso", submitted: "In verifica dal Giudice", under_review: "In verifica" };
    const mCard = makeRecord(
      activeMission.title,
      activeMission.description,
      statusLabels[activeMission.status] || activeMission.status,
      activeMission.status === "active" ? "badge-warning" : ""
    );
    const mScore = document.createElement("p");
    mScore.textContent = `Punti previsti: ${activeMission.score} · Turno ${activeMission.turn_number}`;
    mCard.append(mScore);

    if (activeMission.status === "assigned") {
      const btn = document.createElement("button");
      btn.className = "button secondary";
      btn.textContent = "▶️ Avvia missione adesso";
      btn.addEventListener("click", () => submitPlayerMission(activeMission.id, "start"));
      mCard.append(btn);
    }
    if (["assigned", "active"].includes(activeMission.status)) {
      const btn = document.createElement("button");
      btn.className = "button primary";
      btn.textContent = "📤 Invia risultato prova";
      btn.addEventListener("click", () => openProofDialog(activeMission));
      mCard.append(btn);
    }
    homeActiveCard.append(mCard);
  } else {
    homeActiveCard.innerHTML = `<p class="empty-state">Nessuna missione attiva in questo turno. Il giudice ti assegnerà presto un obiettivo.</p>`;
  }

  // Sezione Home: Notifiche e comunicazioni
  const homeNotifs = document.querySelector("#player-home-notifications");
  homeNotifs.replaceChildren();
  const announcements = dashboard.messages.slice(0, 3);
  if (!announcements.length) {
    homeNotifs.append(makeRecord("Nessuna comunicazione recente", "I messaggi e gli annunci del giudice compariranno qui.", "Info"));
  }
  for (const msg of announcements) {
    homeNotifs.append(makeRecord(
      msg.subject || (msg.sender === "judge" ? "Messaggio del Giudice" : "La tua segnalazione"),
      msg.body,
      new Date(msg.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    ));
  }

  // Sezione Ruolo & Istruzioni
  const instructions = document.querySelector("#player-instructions");
  instructions.replaceChildren();
  for (const [label, content] of [
    ["Descrizione del ruolo", dashboard.role?.description],
    ["Obiettivi di vittoria", dashboard.role?.objectives],
    ["Regole e limitazioni", dashboard.role?.rules],
    ["Azioni consentite", dashboard.role?.actions?.join(", ")],
  ]) {
    if (!content) continue;
    const p = document.createElement("p");
    p.innerHTML = `<strong>${label}:</strong> ${content}`;
    instructions.append(p);
  }
  if (!instructions.childElementCount) {
    instructions.append(makeRecord("Ruolo standard", "Nessuna istruzione speciale configurata.", "Info"));
  }
  const alliesElem = document.querySelector("#player-allies");
  alliesElem.textContent = dashboard.allies.length
    ? `👥 Membri noti del tuo gruppo: ${dashboard.allies.join(", ")}`
    : "Non conosci altri membri del tuo gruppo o operi in solitaria.";

  // Sezione Regole
  document.querySelector("#player-rules").textContent = dashboard.game.rules || "Nessuna regola aggiuntiva.";
  document.querySelector("#player-win-conditions").textContent = dashboard.game.winConditions || "Condizioni standard.";

  // Sezione Missioni
  const missionsList = document.querySelector("#player-missions");
  missionsList.replaceChildren();
  const missionBadge = document.querySelector("#player-mission-badge");
  const pendingCount = dashboard.missions.filter((m) => ["assigned", "active"].includes(m.status)).length;
  if (missionBadge) {
    missionBadge.textContent = pendingCount;
    missionBadge.hidden = pendingCount === 0;
  }
  if (!dashboard.missions.length) {
    missionsList.append(makeRecord("Nessuna missione", "Non hai ancora missioni assegnate per questo turno.", "Vuoto"));
  }
  const statusLabels = {
    assigned: "Da iniziare", active: "In corso", submitted: "In verifica",
    under_review: "In verifica", completed: "Completata ✓", rejected: "Respinta ✕",
  };
  for (const mission of dashboard.missions) {
    const isCompleted = mission.status === "completed";
    const record = makeRecord(
      `${mission.title} · Turno ${mission.turn_number}`,
      mission.description,
      statusLabels[mission.status] || mission.status,
      isCompleted ? "badge-success" : mission.status === "rejected" ? "badge-danger" : ""
    );
    for (const [label, val] of [
      ["Obiettivo", mission.objective],
      ["Regole", mission.rules],
      ["Modalità verifica", mission.verification],
      ["Punti previsti", `${mission.score} punti`],
      ["La tua prova inviata", mission.proof],
      ["Nota del Giudice", mission.review_note],
    ]) {
      if (!val) continue;
      const d = document.createElement("p");
      d.innerHTML = `<strong>${label}:</strong> ${val}`;
      record.append(d);
    }

    if (mission.status === "assigned") {
      const begin = document.createElement("button");
      begin.className = "button secondary";
      begin.textContent = "▶️ Avvia missione";
      begin.addEventListener("click", () => submitPlayerMission(mission.id, "start"));
      record.append(begin);
    }
    if (["assigned", "active"].includes(mission.status)) {
      const submit = document.createElement("button");
      submit.className = "button primary";
      submit.textContent = "📤 Invia risultato prova";
      submit.addEventListener("click", () => openProofDialog(mission));
      record.append(submit);
    }
    missionsList.append(record);
  }

  // Sezione Azioni segrete
  const actionList = document.querySelector("#player-actions");
  actionList.replaceChildren();
  const availableActions = dashboard.role?.actions || [];
  const actionSelect = document.querySelector("#player-action-title");
  actionSelect.replaceChildren(new Option("— Seleziona un'azione —", ""));
  for (const action of availableActions) actionSelect.append(new Option(action, action));
  document.querySelector("#player-action-form").hidden = !availableActions.length || !["running", "paused"].includes(dashboard.game.status);
  if (!availableActions.length) {
    actionList.append(makeRecord("Nessuna azione segreta configurata", "Il tuo ruolo non prevede azioni speciali autonome.", "Info"));
  }
  for (const action of dashboard.actions) {
    actionList.append(makeRecord(
      action.title,
      `${action.details}${action.review_note ? `<br>💬 <em>Risposta Giudice:</em> ${action.review_note}` : ""}${action.score ? ` (+${action.score} punti)` : ""}`,
      action.status === "approved" ? "Approvata ✓" : action.status === "rejected" ? "Respinta ✕" : "In attesa",
      action.status === "approved" ? "badge-success" : ""
    ));
  }

  // Sezione Comunicazioni
  const messagesList = document.querySelector("#player-messages");
  messagesList.replaceChildren();
  if (!dashboard.messages.length) {
    messagesList.append(makeRecord("Nessun messaggio", "Non ci sono ancora messaggi o segnalazioni.", "Vuoto"));
  }
  for (const message of dashboard.messages) {
    const isReport = message.kind === "report";
    const record = makeRecord(
      message.subject || (isReport ? "Segnalazione al Giudice" : message.sender === "judge" ? "Messaggio dal Giudice" : "Messaggio inviato"),
      message.body,
      new Date(message.created_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      isReport ? "badge-warning" : ""
    );
    if (isReport && message.status) {
      const st = document.createElement("p");
      st.innerHTML = `<strong>Stato verifica:</strong> ${message.status === 'approved' ? 'Accolta ✓' : message.status === 'rejected' ? 'Non accolta' : 'In attesa'}${message.review_note ? ` — <em>${message.review_note}</em>` : ""}`;
      record.append(st);
    }
    messagesList.append(record);
  }

  // Sezione Votazione
  const votingTabBtn = document.querySelector("#player-voting-tab-btn");
  votingTabBtn.hidden = !dashboard.game.voteOpen;
  const candidateList = document.querySelector("#vote-candidates");
  candidateList.replaceChildren();
  for (const candidate of dashboard.candidates) {
    const label = document.createElement("label");
    label.className = "candidate";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "vote-target";
    input.value = candidate.id;
    input.disabled = dashboard.game.voteSubmitted;
    input.addEventListener("change", () => {
      const selected = [...candidateList.querySelectorAll("input:checked")];
      if (selected.length > dashboard.game.voteLimit) input.checked = false;
    });
    label.append(input, document.createTextNode(` ${candidate.name}`));
    candidateList.append(label);
  }
  document.querySelector("#player-vote-form button").disabled = dashboard.game.voteSubmitted;
  document.querySelector("#vote-confirmation").textContent = dashboard.game.voteSubmitted
    ? "✓ Voto registrato con successo. Le preferenze rimangono segrete fino al verdetto finale."
    : `Puoi selezionare fino a ${dashboard.game.voteLimit} sospetti.`;

  // Sezione Esito finale
  const resultsTabBtn = document.querySelector("#player-results-tab-btn");
  resultsTabBtn.hidden = !dashboard.finalResults;
  if (dashboard.finalResults) {
    const results = document.querySelector("#final-results");
    results.replaceChildren();
    const finalTeams = document.querySelector("#final-teams");
    finalTeams.replaceChildren();
    const summary = dashboard.finalResults;
    const winner = summary.winningTeams.length === 1
      ? `🏆 Squadra vincitrice: ${summary.winningTeams[0]}!`
      : summary.winningTeams.length ? `🏆 Parità tra le squadre: ${summary.winningTeams.join(", ")}!` : "Partita conclusa.";
    document.querySelector("#final-summary").textContent =
      `${winner} Totale: ${summary.totalParticipants} giocatori, ${summary.completedMissions} missioni completate, ${summary.totalVotes} voti registrati.`;
    for (const team of summary.teams) {
      finalTeams.append(makeRecord(
        team.team,
        `${team.players} partecipanti · ${team.score} punti totali · ${team.completedMissions} missioni riuscite · ${team.votes} voti ricevuti`,
        "Squadra"
      ));
    }
    for (const player of summary.players) {
      const item = document.createElement("li");
      item.textContent = `${player.name} · Ruolo: ${player.role || "Non assegnato"} (${player.team || "Senza squadra"}) · ${player.score} punti · ${player.completed_missions} missioni · ${player.votes_received} voti ricevuti`;
      results.append(item);
    }
  }

  renderPlayerTimer();
}

function renderPlayerTimer() {
  if (!playerDashboard) return;
  const { game } = playerDashboard;
  const elapsed = game.status === "running" ? Date.now() - playerDashboard.fetchedAt : 0;
  const remaining = Math.max(0, game.remainingMs - elapsed);
  const minutes = Math.floor(remaining / 60000).toString().padStart(2, "0");
  const seconds = Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0");
  const timerElem = document.querySelector("#player-timer");
  if (timerElem) {
    timerElem.textContent = `${minutes}:${seconds}${remaining === 0 && game.status === "running" ? " (Tempo scaduto)" : ""}`;
  }
}

function openProofDialog(mission) {
  document.querySelector("#proof-dialog-title").textContent = `Prova per: ${mission.title}`;
  document.querySelector("#proof-mission-id").value = mission.id;
  document.querySelector("#proof-text").value = "";
  proofDialog.showModal();
}

async function submitPlayerMission(id, action, proofText = "") {
  try {
    if (action === "start") {
      await api(`/api/player/missions/${encodeURIComponent(id)}/start`, { method: "POST" }, playerToken);
      showToast("Missione avviata! Buona fortuna.");
    } else {
      await api(`/api/player/missions/${encodeURIComponent(id)}/submit`, {
        method: "POST", body: JSON.stringify({ proof: proofText }),
      }, playerToken);
      showToast("Prova inviata con successo al Giudice.");
    }
    await loadPlayerRole();
  } catch (error) {
    showToast(error.message);
  }
}

// ----------------------------------------------------
// EVENT LISTENERS & INIZIALIZZAZIONE
// ----------------------------------------------------

// Navigazione principale tra Giocatore e Giudice
document.querySelectorAll(".main-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveView(tab.dataset.view);
  });
});

// Navigazione interna schede giocatore
document.querySelectorAll(".player-subtab").forEach((tab) => {
  tab.addEventListener("click", () => {
    setActivePlayerSubview(tab.dataset.subview);
  });
});

// Fix selezione destinatari form giudice
document.querySelector("#mission-target-type")?.addEventListener("change", (event) => {
  setMissionTargetType(event.target.value);
});
document.querySelector("#judge-message-target-type")?.addEventListener("change", (event) => {
  setJudgeMessageTargetType(event.target.value);
});

// Pulsante refresh manuale del giudice
document.querySelector("#judge-refresh-btn")?.addEventListener("click", async () => {
  await loadJudgeState();
  showToast("Dati della partita aggiornati.");
});

// Nuova partita (Game Master reset)
document.querySelector("#judge-new-game-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Vuoi iniziare una Nuova Partita? La partita tornerà in modalità di preparazione (setup) e potrai configurare partecipanti e ruoli da zero.")) return;
  try {
    await api("/api/judge/game/reset", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    await loadJudgeState();
    showToast("Nuova partita avviata in modalità preparazione.");
  } catch (error) {
    showToast(error.message);
  }
});

// Form login giudice
document.querySelector("#judge-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#judge-login-error");
  error.textContent = "";
  try {
    const result = await api("/api/judge/login", {
      method: "POST",
      body: JSON.stringify({ password: document.querySelector("#judge-password").value }),
    }, null);
    judgeToken = result.token;
    sessionStorage.setItem("judgeToken", judgeToken);
    await loadJudgeState();
    startJudgePolling();
  } catch (exception) {
    error.textContent = exception.message;
  }
});

// Logout giudice
document.querySelector("#judge-logout").addEventListener("click", async () => {
  try {
    await api("/api/judge/logout", { method: "POST" });
  } catch {}
  judgeToken = null;
  sessionStorage.removeItem("judgeToken");
  clearInterval(judgeRefresh);
  showJudgeLogin();
  showToast("Disconnesso dall'Area del Giudice.");
});

// Aggiunta partecipante
document.querySelector("#add-participant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-participant");
  const name = input.value.trim();
  try {
    await api("/api/judge/participants", { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    document.querySelector("#roster-message").textContent = `✓ ${name} aggiunto all’elenco dei presenti.`;
    await loadJudgeState();
  } catch (error) {
    document.querySelector("#roster-message").textContent = error.message;
  }
});

// Svuota tutti i partecipanti
document.querySelector("#clear-participants-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Sei sicuro di voler rimuovere tutti i partecipanti inseriti?")) return;
  try {
    await api("/api/judge/participants/all?force=true", { method: "DELETE" });
    await loadJudgeState();
    showToast("Tutti i partecipanti sono stati rimossi.");
  } catch (error) {
    showToast(error.message);
  }
});

// Svuota tutti i ruoli (Parti da zero)
document.querySelector("#clear-roles-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Sei sicuro di voler azzerare tutti i ruoli? Potrai definire da zero i ruoli della tua partita come Game Master.")) return;
  try {
    await api("/api/judge/roles/clear", { method: "POST" });
    resetRoleForm();
    await loadJudgeState();
    showToast("Tutti i ruoli sono stati azzerati. Crea i tuoi ruoli personalizzati.");
  } catch (error) {
    showToast(error.message);
  }
});

// Carica preset classico Halloween
document.querySelector("#preset-roles-btn")?.addEventListener("click", async () => {
  if (!window.confirm("Vuoi caricare i ruoli standard del mistero di Halloween (Sentinelle, Sabotatori, Veggente, Malcapitati)?")) return;
  try {
    await api("/api/judge/roles/preset", { method: "POST" });
    resetRoleForm();
    await loadJudgeState();
    showToast("Ruoli standard di Halloween caricati.");
  } catch (error) {
    showToast(error.message);
  }
});

// Salvataggio configurazione quantità ruoli
document.querySelector("#role-configuration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#role-configuration-message");
  const targets = Object.fromEntries(roleEntries().map(([key]) => [key, Number(document.querySelector(`#target-${key}`).value)]));
  try {
    await api("/api/judge/role-configuration", {
      method: "PUT",
      body: JSON.stringify({ targets }),
    });
    message.textContent = "✓ Quantità ruoli salvata. Ora assegna ciascun ruolo manualmente ai partecipanti.";
    await loadJudgeState();
  } catch (error) {
    message.textContent = error.message;
  }
});

// Form salvataggio/creazione ruolo con quantità
document.querySelector("#role-editor-form").addEventListener("submit", async (event) => {
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
    if (id) await api(`/api/judge/roles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(role) });
    else await api("/api/judge/roles", { method: "POST", body: JSON.stringify(role) });
    resetRoleForm();
    await loadJudgeState();
    showToast(id ? "Ruolo aggiornato con successo." : "Nuovo ruolo aggiunto alla partita!");
  } catch (error) { showToast(error.message); }
});

// Annulla modifica ruolo
document.querySelector("#role-cancel-edit-btn")?.addEventListener("click", () => {
  resetRoleForm();
});

// Eliminazione ruolo
document.querySelector("#role-delete").addEventListener("click", async () => {
  const id = document.querySelector("#role-edit-id").value;
  if (!id || !window.confirm("Eliminare definitivamente questo ruolo? L'operazione non può essere annullata.")) return;
  try {
    await api(`/api/judge/roles/${encodeURIComponent(id)}`, { method: "DELETE" });
    resetRoleForm();
    await loadJudgeState();
    showToast("Ruolo eliminato.");
  } catch (error) { showToast(error.message); }
});

// Salvataggio impostazioni partita
document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.querySelector("#settings-message");
  try {
    await api("/api/judge/settings", {
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
    message.textContent = "✓ Regole e turni salvati.";
    await loadJudgeState();
  } catch (error) { message.textContent = error.message; }
});

// Azioni del gioco (pausa, riprendi, turno, termine)
async function gameAction(action, confirmed = false) {
  if (confirmed && !window.confirm("Confermi questa operazione sulla partita?")) return;
  try {
    await api("/api/judge/game-action", {
      method: "POST", body: JSON.stringify({ action, ...(confirmed ? { confirmed: true } : {}) }),
    });
    await loadJudgeState();
    showToast("Stato della partita aggiornato.");
  } catch (error) { showToast(error.message); }
}

document.querySelector("#pause-game").addEventListener("click", () => gameAction("pause"));
document.querySelector("#resume-game").addEventListener("click", () => gameAction("resume"));
document.querySelector("#next-turn").addEventListener("click", () => gameAction("next-turn", true));
document.querySelector("#end-game").addEventListener("click", () => gameAction("end", true));
document.querySelector("#terminate-game").addEventListener("click", () => gameAction("terminate", true));

// Rivelazione ruoli finale
document.querySelector("#reveal-roles").addEventListener("click", async () => {
  if (!window.confirm("Dopo questa conferma i ruoli segreti e i risultati finali saranno svelati a tutti i giocatori. Confermi la rivelazione?")) return;
  try {
    await api("/api/judge/reveal", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    await loadJudgeState();
    showToast("Ruoli rivelati a tutti i giocatori!");
  } catch (error) { showToast(error.message); }
});

// Assegnazione missione
document.querySelector("#mission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/judge/missions", {
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
    document.querySelector("#mission-verification").value = "";
    await loadJudgeState();
    showToast("Missione assegnata con successo.");
  } catch (error) { showToast(error.message); }
});

// Comunicazione dal giudice
document.querySelector("#judge-message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetType = document.querySelector("#judge-message-target-type").value;
  try {
    await api("/api/judge/messages", {
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
  } catch (error) { showToast(error.message); }
});

// Apertura e chiusura votazione
document.querySelector("#vote-open-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/judge/vote", {
      method: "POST", body: JSON.stringify({ limit: Number(document.querySelector("#vote-limit").value) }),
    });
    await loadJudgeState();
    showToast("Votazione aperta per tutti i partecipanti.");
  } catch (error) { showToast(error.message); }
});

document.querySelector("#vote-close").addEventListener("click", async () => {
  try {
    await api("/api/judge/vote/close", { method: "POST" });
    await loadJudgeState();
    showToast("Votazione chiusa. Risultati visibili al Giudice.");
  } catch (error) { showToast(error.message); }
});

// Correzione manuale punteggio
document.querySelector("#score-adjustment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/judge/score-adjustment", {
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
  } catch (error) { showToast(error.message); }
});

// Modal avvio partita
document.querySelector("#start-game").addEventListener("click", () => {
  const roster = document.querySelector("#confirmation-roster");
  roster.replaceChildren();
  for (const participant of state.participants) {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = participant.name;
    item.append(name, document.createTextNode(` — ${state.roles[participant.role] || "Non assegnato"}`));
    roster.append(item);
  }
  confirmDialog.showModal();
});

document.querySelector("#confirm-start").addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    await api("/api/judge/start", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    confirmDialog.close();
    await loadJudgeState();
    showToast("🎉 Partita avviata! I ruoli sono ora distribuiti ai partecipanti.");
  } catch (error) {
    confirmDialog.close();
    showToast(error.message);
    await loadJudgeState();
  }
});

// Login Giocatore
document.querySelector("#player-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#player-login-error");
  error.textContent = "";
  try {
    const result = await api("/api/player/login", {
      method: "POST",
      body: JSON.stringify({ code: document.querySelector("#player-code").value.trim() }),
    }, null);
    playerToken = result.token;
    sessionStorage.setItem("playerToken", playerToken);
    await loadPlayerRole();
    startPlayerPolling();
  } catch (exception) {
    error.textContent = exception.message;
  }
});

async function loadPlayerRole() {
  const result = await api("/api/player/dashboard", {}, playerToken);
  result.fetchedAt = Date.now();
  renderPlayerDashboard(result);
}

// Logout Giocatore
document.querySelector("#player-logout").addEventListener("click", async () => {
  try {
    await api("/api/player/logout", { method: "POST" }, playerToken);
  } catch {}
  playerToken = null;
  sessionStorage.removeItem("playerToken");
  clearInterval(dashboardRefresh);
  document.querySelector("#player-role-panel").hidden = true;
  document.querySelector("#player-login-panel").hidden = false;
  showToast("Disconnesso dal profilo giocatore.");
});

// Dialog prova missione
document.querySelector("#cancel-proof-btn").addEventListener("click", () => {
  proofDialog.close();
});

document.querySelector("#proof-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#proof-mission-id").value;
  const proofText = document.querySelector("#proof-text").value.trim();
  if (!proofText) return;
  proofDialog.close();
  await submitPlayerMission(id, "submit", proofText);
});

// Form messaggio giocatore
document.querySelector("#player-message-form").addEventListener("submit", async (event) => {
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
    await loadPlayerRole();
    showToast("Messaggio inviato in totale riservatezza al Giudice.");
  } catch (error) { showToast(error.message); }
});

// Form azione segreta giocatore
document.querySelector("#player-action-form").addEventListener("submit", async (event) => {
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
    await loadPlayerRole();
    showToast("Azione segreta inviata al Giudice per la valutazione.");
  } catch (error) { showToast(error.message); }
});

// Form voto sospetti giocatore
document.querySelector("#player-vote-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const targets = [...document.querySelectorAll("#vote-candidates input:checked")].map((input) => input.value);
  if (!targets.length) {
    showToast("Seleziona almeno un sospetto prima di votare.");
    return;
  }
  try {
    await api("/api/player/vote", { method: "POST", body: JSON.stringify({ targets }) }, playerToken);
    await loadPlayerRole();
    showToast("Voto segreto inviato con successo!");
  } catch (error) { showToast(error.message); }
});

// Polling automatico
function startPlayerPolling() {
  clearInterval(dashboardRefresh);
  dashboardRefresh = setInterval(() => {
    if (playerToken && !document.querySelector("#player-role-panel").hidden) {
      loadPlayerRole().catch(() => {});
    }
  }, 10000);
}

function startJudgePolling() {
  clearInterval(judgeRefresh);
  judgeRefresh = setInterval(() => {
    if (judgeToken && !judgePanel.hidden) {
      loadJudgeState(true).catch(() => {});
    }
  }, 6000);
}

setInterval(renderPlayerTimer, 1000);
setInterval(renderJudgeTimer, 1000);

// Inizializzazione sessioni salvate
if (judgeToken) {
  loadJudgeState().then(() => {
    setActiveView("judge-view");
    startJudgePolling();
  }).catch(() => {
    judgeToken = null;
    sessionStorage.removeItem("judgeToken");
    showJudgeLogin();
  });
}

if (playerToken) {
  loadPlayerRole().then(() => {
    setActiveView("player-view");
    startPlayerPolling();
  }).catch(() => {
    playerToken = null;
    sessionStorage.removeItem("playerToken");
  });
}
