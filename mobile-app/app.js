const auth = window.ashraayAuth;
const offline = window.ashraayOffline;
const t = (text) => window.ashraayI18n.t(text);
const $ = (id) => document.getElementById(id);
let offlineOnly = false;
let current = "";
let reportDone = false;
let geo = null;
const cache = { reports: [], alerts: [], tasks: [], volunteer: null, responseUpdates: [] };
const completionPhotos = new Map();
const completionVoices = new Map();
const completionDrafts = new Map();
let completionRecorder = null;
const responseStatuses = new Map();
const rendered = {};

const roleLabel = (role) => t(auth.roleLabel(role));
const escapeHtml = auth.escapeHtml;

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  report: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.01"/>',
  status: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  alerts: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  tasks: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
document.querySelectorAll("[data-ico]").forEach((slot) => { slot.innerHTML = icon(slot.dataset.ico); });

const SKILLS = [
  ["rescue", "Rescue"], ["first-aid", "First aid"], ["boat-handling", "Boat handling"], ["swimming", "Swimming"],
  ["driving", "Driving"], ["logistics", "Logistics"], ["counselling", "Counselling"], ["translation", "Translation"]
];
const LANGUAGES = [["en", "English"], ["hi", "हिन्दी"], ["ta", "தமிழ்"], ["ml", "മലയാളം"], ["kn", "ಕನ್ನಡ"]];
const TYPE_LABELS = { flood: "Flooding", "heavy-rain": "Heavy rain", landslide: "Landslide", other: "Something else" };
const NEED_LABELS = {
  evacuation: "Evacuation", "drinking-water": "Drinking water", medical: "Medical help", food: "Food", shelter: "Shelter"
};
const RESPONSE_NEEDS = [["shelter", "Move to shelter"], ["preposition", "Preposition assistance"],
  ["rescue", "Rescue assistance"], ["boat", "Boat assistance"], ["other", "Other assistance"]];
const responseNeedLabel = (need) => t(RESPONSE_NEEDS.find(([value]) => value === need)?.[1] || "Safe");
const STAGES = ["Report received", "Being checked", "Verified", "Help on the way", "Resolved"];
const TYPE_ICONS = {
  flood: ["#1E6FE0", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M3 19.5c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M6 11V7l6-4 6 4v4"/></svg>'],
  "heavy-rain": ["#4F5D9E", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 15a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 17.5 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/></svg>'],
  landslide: ["#8B5E34", '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 20l7-12 4 6 2-3 7 9z"/><circle cx="17" cy="6" r="2"/></svg>'],
  other: ["#2A8C82", '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>']
};
const STATUS_PILL = { resolved: "p-ok", verified: "p-off", needs_review: "p-com", field_check_requested: "p-com", dismissed: "p-grey", consent_withdrawn: "p-grey" };
const ALERT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M3 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M3 19.5c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 3-1.3 4.5 0"/><path d="M12 3v7M12 12.5v.5"/></svg>';
const TICK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const TASK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
const PIN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

const isResident = () => auth.hasRole("resident-reporter");
const isWorker = () => auth.hasRole("volunteer", "field-team", "response-agency");
const isVolunteer = () => auth.hasRole("volunteer");

const post = (path, body, key) => auth.postJson(path, body, { key });
const showError = (message) => { $("error").textContent = message || ""; };
const fail = (error) => showError(error.message);
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("on"), 3200);
}
function renderIfChanged(name, data, render, force = false) {
  const signature = JSON.stringify(data);
  if (!force && rendered[name] === signature) return;
  rendered[name] = signature;
  render();
}

async function submit(path, body) {
  const key = auth.randomId();
  const owner = auth.identity()?.sub;
  if (!owner || !auth.hasRole("resident-reporter")) {
    throw new Error(t("Sign-in is required before saving an offline submission."));
  }
  if (offlineOnly || !navigator.onLine) {
    if (!body.consent) throw new Error(t("Consent is required before saving an offline submission."));
    return { queuedOffline: true, id: (await offline.enqueue(path, body, key, owner)).id };
  }
  try {
    return await post(path, body, key);
  } catch (error) {
    if (!(error instanceof TypeError) && navigator.onLine) throw error;
    if (!body.consent) throw new Error(t("Consent is required before saving an offline submission."));
    return { queuedOffline: true, id: (await offline.enqueue(path, body, key, owner)).id };
  }
}

async function updateOfflineQueue() {
  const subject = auth.identity()?.sub;
  const saved = await offline.entries();
  const entries = saved.filter((entry) => subject && entry.ownerSubject === subject);
  const quarantined = saved.some((entry) => !entry.ownerSubject);
  $("offline-view").classList.toggle("hidden", entries.length === 0 && !offlineOnly && !quarantined);
  $("offline-queue").innerHTML = entries.length
    ? entries.map((entry) =>
      `<div class="queue" style="margin-bottom:8px"><strong>${t("Queued for sync")}</strong> · ${t(entry.path === "/reports" ? "Report flooding" : "Safety check-in")}<br><time>${escapeHtml(entry.createdAt)}</time>${entry.lastError ? `<p class="err">${escapeHtml(entry.lastError)}</p>` : ""}</div>`
    ).join("")
    : `<em>${t("No offline submissions")}</em>`;
  if (quarantined) {
    $("offline-queue").innerHTML += `<p class="err">${t("Unowned legacy drafts are quarantined and will not sync. Clear this site's storage to remove them.")}</p>`;
  }
  let status = "";
  if (offlineOnly) {
    status = t("Sign-in is required before saving an offline submission.");
  } else if (!navigator.onLine) {
    status = t("Offline mode. New consented reports and check-ins will sync after sign-in and reconnection.");
  } else if (entries.length) {
    status = `${entries.length} ${t("Queued for sync")}`;
  }
  $("connection-status").textContent = status;
  $("connection-status").classList.toggle("hidden", !status);
  $("net").textContent = navigator.onLine ? "" : t("You are offline. Your reports are saved on this phone.");
  $("net").classList.toggle("on", !navigator.onLine);
}

async function flushOfflineQueue() {
  if (!navigator.onLine || offlineOnly || !auth.hasRole("resident-reporter")) return;
  await offline.flush((entry) => post(entry.path, entry.body, entry.id), auth.identity().sub);
  await updateOfflineQueue();
  await load();
}

function navItems() {
  if (offlineOnly) return [["home", "Home"], ["report", "Report"], ["more", "More"]];
  const items = [];
  if (isResident()) items.push(["home", "Home"], ["report", "Report"], ["status", "My reports"]);
  if (isWorker()) items.push(["tasks", auth.hasRole("field-team") && !isVolunteer() ? "Field" : "Tasks"]);
  items.push(["alerts", "Alerts"], ["more", "More"]);
  return items;
}
function renderNav() {
  const items = navItems();
  $("nav").style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
  $("nav").innerHTML = items.map(([id, label]) =>
    `<button type="button" data-go="${id}" class="${id === current ? "on" : ""}" ${id === current ? 'aria-current="page"' : ""}>${icon(id)}<span>${t(label)}</span></button>`
  ).join("");
}
function show(screen) {
  if (screen !== "tasks" && completionRecorder?.recorder.state === "recording") completionRecorder.recorder.stop();
  if (!navItems().some(([id]) => id === screen)) screen = navItems()[0][0];
  if (screen === "report" && reportDone) resetReport();
  if (screen === "report" && locMode === "gps" && locState === "idle") locate();
  current = screen;
  document.querySelectorAll(".scr").forEach((node) => node.classList.toggle("on", node.dataset.screen === screen));
  renderNav();
  showError("");
  window.scrollTo(0, 0);
}
document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) show(go.dataset.go);
});

const SEVERITY_EN = { low: "Minor", med: "Serious", high: "Critical" };
const MEDIA_LIMITS = { files: 6, image: 15 * 1024 * 1024, video: 100 * 1024 * 1024, audio: 25 * 1024 * 1024, videoSeconds: 120, voiceSeconds: 120 };
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
let locMode = "gps";
let locState = "idle";
let media = [];
let recorder = null;
let player = null;

// Browsers only allow GPS and microphone on HTTPS or localhost; plain-HTTP LAN access falls back to manual entry and file capture.
const canUseGps = () => Boolean(navigator.geolocation) && window.isSecureContext;
const canRecord = () => window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.MediaRecorder);
const formatSeconds = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function selectedNeeds() {
  return [...document.querySelectorAll("#need-chips .sel")].map((chip) => chip.dataset.need);
}
function selectedType() {
  return document.querySelector("#type-chips .sel")?.dataset.type || "flood";
}
function selectedSeverity() {
  return document.querySelector('#sev-group [aria-checked="true"]')?.dataset.sev || "med";
}
function setRadio(groupId, attr, value) {
  document.querySelectorAll(`#${groupId} [data-${attr}]`).forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset[attr] === value));
  });
}

function drawLoc() {
  const card = $("loc-card");
  card.classList.toggle("bad", locState === "err");
  card.classList.toggle("busy", locState === "busy" || locState === "idle");
  $("loc-retry").classList.toggle("hidden", locState !== "err");
  $("loc-title").textContent = t(locState === "ok" ? "Location found" : locState === "err" ? "Location not available" : "Finding your location…");
  $("loc-sub").textContent = locState === "ok"
    ? `${geo.latitude.toFixed(5)}, ${geo.longitude.toFixed(5)} · ±${geo.accuracyM} m`
    : locState === "err" ? t("Retry, or enter it manually.") : "";
}
function locate() {
  locState = "busy";
  geo = null;
  drawLoc();
  if (!navigator.geolocation) {
    locState = "err";
    drawLoc();
    return;
  }
  navigator.geolocation.getCurrentPosition((position) => {
    geo = {
      latitude: Number(position.coords.latitude.toFixed(6)),
      longitude: Number(position.coords.longitude.toFixed(6)),
      accuracyM: Math.min(100000, Math.round(position.coords.accuracy || 0))
    };
    locState = "ok";
    $("rep-loc-err").textContent = "";
    drawLoc();
  }, () => {
    locState = "err";
    drawLoc();
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}
function setLocMode(mode) {
  locMode = mode;
  setRadio("loc-seg", "loc", mode);
  $("gps-pane").hidden = mode !== "gps";
  $("manual-pane").hidden = mode !== "manual";
  $("rep-loc-err").textContent = "";
}
$("loc-seg").addEventListener("click", (event) => {
  const button = event.target.closest("[data-loc]");
  if (!button) return;
  setLocMode(button.dataset.loc);
  if (locMode === "gps" && locState !== "ok" && locState !== "busy") locate();
  if (locMode === "manual") $("address").focus();
});
$("loc-retry").addEventListener("click", locate);
$("sev-group").addEventListener("click", (event) => {
  const button = event.target.closest("[data-sev]");
  if (button) setRadio("sev-group", "sev", button.dataset.sev);
});

function drawMedia() {
  $("media-files").innerHTML = media.map((item, index) => {
    const inner = item.kind === "photo"
      ? '<img alt="">'
      : item.kind === "video"
        ? `<video muted playsinline preload="metadata"></video><span class="badge">▶ ${formatSeconds(item.duration)}</span>`
        : `<div class="aud"><button type="button" data-play="${index}" aria-label="${escapeHtml(t("Voice"))}">${PLAY_ICON}</button><span>${item.duration ? formatSeconds(item.duration) : escapeHtml(t("Voice"))}</span></div>`;
    return `<li>${inner}<button type="button" class="x" data-remove="${index}" aria-label="×">${X_ICON}</button></li>`;
  }).join("");
  $("media-files").querySelectorAll("li").forEach((li, index) => {
    const preview = li.querySelector("img, video");
    if (preview) preview.src = media[index].kind === "video" ? `${media[index].url}#t=0.1` : media[index].url;
  });
  $("media-note").hidden = media.length === 0;
}
function addMedia(kind, blob, duration = 0) {
  if (media.length >= MEDIA_LIMITS.files) {
    toast(t("Up to 6 files only."));
    return;
  }
  media.push({ kind, blob, duration, url: URL.createObjectURL(blob) });
  drawMedia();
}
function stopPlayer() {
  if (player) player.pause();
  player = null;
}
function clearMedia() {
  stopPlayer();
  media.forEach((item) => URL.revokeObjectURL(item.url));
  media = [];
  drawMedia();
}
function probeDuration(file, tag, done) {
  const probe = document.createElement(tag);
  const url = URL.createObjectURL(file);
  probe.preload = "metadata";
  probe.onloadedmetadata = () => { URL.revokeObjectURL(url); done(Number.isFinite(probe.duration) ? probe.duration : 0); };
  probe.onerror = () => { URL.revokeObjectURL(url); done(0); };
  probe.src = url;
}
$("media-photo").addEventListener("change", (event) => {
  for (const file of event.target.files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > MEDIA_LIMITS.image) { toast(t("File is too large.")); continue; }
    addMedia("photo", file);
  }
  event.target.value = "";
});
$("media-video").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !file.type.startsWith("video/")) return;
  if (file.size > MEDIA_LIMITS.video) { toast(t("File is too large.")); return; }
  probeDuration(file, "video", (duration) => {
    if (duration > MEDIA_LIMITS.videoSeconds + 1) { toast(t("Video must be 2 minutes or less.")); return; }
    addMedia("video", file, duration);
  });
});
$("media-voice-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !file.type.startsWith("audio/")) return;
  if (file.size > MEDIA_LIMITS.audio) { toast(t("File is too large.")); return; }
  probeDuration(file, "audio", (duration) => addMedia("voice", file, duration));
});
function stopRecording(discard = false) {
  if (!recorder) return;
  recorder.discard = discard;
  recorder.stop();
}
$("media-voice").addEventListener("click", async () => {
  if (recorder) { stopRecording(); return; }
  if (media.length >= MEDIA_LIMITS.files) { toast(t("Up to 6 files only.")); return; }
  if (!canRecord()) { $("media-voice-file").click(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast(t("Microphone not available."));
    return;
  }
  const button = $("media-voice");
  const chunks = [];
  const rec = new MediaRecorder(stream);
  let seconds = 0;
  recorder = rec;
  button.classList.add("rec");
  button.setAttribute("aria-pressed", "true");
  $("voice-label").textContent = `0:00 · ${t("Stop")}`;
  const timer = setInterval(() => {
    seconds += 1;
    $("voice-label").textContent = `${formatSeconds(seconds)} · ${t("Stop")}`;
    if (seconds >= MEDIA_LIMITS.voiceSeconds) rec.stop();
  }, 1000);
  rec.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  rec.onstop = () => {
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    recorder = null;
    button.classList.remove("rec");
    button.setAttribute("aria-pressed", "false");
    $("voice-label").textContent = t("Voice");
    if (!rec.discard && chunks.length) addMedia("voice", new Blob(chunks, { type: rec.mimeType || "audio/webm" }), seconds);
  };
  rec.start();
});
$("media-files").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    const [item] = media.splice(Number(remove.dataset.remove), 1);
    if (player && player.src === item.url) stopPlayer();
    URL.revokeObjectURL(item.url);
    drawMedia();
    return;
  }
  const play = event.target.closest("[data-play]");
  if (!play) return;
  const index = Number(play.dataset.play);
  const item = media[index];
  const wasPlaying = player && player.src === item.url && !player.paused;
  stopPlayer();
  drawMedia();
  if (wasPlaying) return;
  player = new Audio(item.url);
  player.addEventListener("ended", () => { player = null; drawMedia(); });
  player.play().catch(() => { stopPlayer(); drawMedia(); });
  $("media-files").querySelector(`[data-play="${index}"]`).innerHTML = PAUSE_ICON;
});

function mediaSummary() {
  const counts = { photo: 0, video: 0, voice: 0 };
  media.forEach((item) => { counts[item.kind] += 1; });
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return [
    counts.photo && plural(counts.photo, "photo", "photos"),
    counts.video && plural(counts.video, "video", "videos"),
    counts.voice && plural(counts.voice, "voice note", "voice notes")
  ].filter(Boolean).join(", ");
}
function buildReport() {
  const type = selectedType();
  const attached = mediaSummary();
  // The API has no severity or media fields yet, so both travel in the description the command center reads.
  const description = [
    `[${SEVERITY_EN[selectedSeverity()]}] ${TYPE_LABELS[type]} reported from the citizen app.`,
    $("description").value.trim(),
    attached ? `Reporter has ${attached} on their phone.` : ""
  ].filter(Boolean).join(" ").slice(0, 1000);
  const manualPlace = [$("address").value.trim(), $("landmark").value.trim()].filter(Boolean).join(" · ");
  const landmark = locMode === "gps" && geo
    ? `GPS ${geo.latitude.toFixed(5)}, ${geo.longitude.toFixed(5)}`
    : manualPlace.slice(0, 160);
  return {
    description,
    landmark,
    people: Number($("people").value),
    consent: $("consent").checked,
    incidentType: type,
    needs: selectedNeeds(),
    ...(locMode === "gps" && geo ? geo : {})
  };
}
function validateReport() {
  if (locMode === "gps" && locState !== "ok") return ["rep-loc-err", t("Share your current location or enter the address.")];
  if (locMode === "manual" && $("address").value.trim().length < 3) return ["rep-loc-err", t("Share your current location or enter the address.")];
  const people = Number($("people").value);
  if (!Number.isInteger(people) || people < 0 || people > 500) return ["rep-err", t("Enter a number of people between 0 and 500.")];
  if (!$("consent").checked) return ["rep-err", t("Allow sharing to send.")];
  return null;
}
function resetReport() {
  reportDone = false;
  stopRecording(true);
  clearMedia();
  $("description").value = "";
  $("people").value = "0";
  $("address").value = "";
  $("landmark").value = "";
  document.querySelectorAll("#need-chips .sel").forEach((chip) => chip.classList.remove("sel"));
  document.querySelectorAll("#type-chips button").forEach((chip) => chip.classList.toggle("sel", chip.dataset.type === "flood"));
  setRadio("sev-group", "sev", "med");
  $("consent").checked = true;
  $("rep-err").textContent = "";
  $("report-form").hidden = false;
  $("report-done").hidden = true;
  $("submit-report").disabled = offlineOnly;
  geo = null;
  locState = "idle";
  setLocMode(canUseGps() ? "gps" : "manual");
  drawLoc();
}
document.addEventListener("click", (event) => {
  const chip = event.target.closest("#type-chips button, #need-chips button");
  if (chip) {
    if (chip.dataset.type) {
      document.querySelectorAll("#type-chips button").forEach((other) => other.classList.toggle("sel", other === chip));
    } else {
      chip.classList.toggle("sel");
    }
    return;
  }
  const adj = event.target.closest("[data-adj]");
  if (adj) {
    const input = $("people");
    const value = (Number.parseInt(input.value, 10) || 0) + Number(adj.dataset.adj);
    input.value = String(Math.min(500, Math.max(0, value)));
  }
});
$("report-again").addEventListener("click", () => {
  resetReport();
  if (locMode === "gps") locate();
  window.scrollTo(0, 0);
});
$("submit-report").addEventListener("click", async () => {
  if ($("submit-report").disabled || reportDone) return;
  $("rep-err").textContent = "";
  $("rep-loc-err").textContent = "";
  const problem = validateReport();
  if (problem) {
    $(problem[0]).textContent = problem[1];
    $(problem[0]).scrollIntoView({ block: "center" });
    return;
  }
  stopRecording();
  $("submit-report").disabled = true;
  try {
    const report = await submit("/reports", buildReport());
    reportDone = true;
    $("report-result").textContent = report.queuedOffline
      ? t("Saved on this device. It will sync after sign-in and reconnection.")
      : t("Response teams have been notified.");
    $("done-case").hidden = Boolean(report.queuedOffline);
    $("done-id").textContent = report.caseId || "";
    $("report-form").hidden = true;
    $("report-done").hidden = false;
    window.scrollTo(0, 0);
    $("done-title").focus();
    if (!report.queuedOffline) await load();
    await updateOfflineQueue();
  } catch (error) {
    $("rep-err").textContent = error.message;
  } finally {
    $("submit-report").disabled = reportDone || offlineOnly;
  }
});
setLocMode(canUseGps() ? "gps" : "manual");
drawLoc();

document.querySelectorAll("#checkin-choices button").forEach((button) => button.addEventListener("click", () => {
  $("checkin-status").value = button.dataset.status;
  document.querySelectorAll("#checkin-choices button").forEach((other) => other.classList.toggle("sel", other === button));
}));

// Exact check-in location: GPS (HTTPS/localhost only) or a pin the user drops on the map.
let checkinGeo = null;
let checkinMap = null;
let checkinMarker = null;
const DEFAULT_MAP_CENTER = [12.9716, 77.5946];

function drawCheckinLoc(message) {
  const info = $("checkin-loc-info");
  if (message) info.textContent = message;
  else if (checkinGeo) {
    const source = checkinGeo.locationSource === "gps"
      ? `${t("GPS location")} · ±${checkinGeo.accuracyM} m`
      : t("Pin placed on map");
    info.textContent = `${source} · ${checkinGeo.latitude.toFixed(5)}, ${checkinGeo.longitude.toFixed(5)}`;
  } else {
    info.textContent = canUseGps() ? "" : t("GPS needs a secure (HTTPS) connection. Tap \"Mark on map\" to drop a pin instead.");
  }
  $("checkin-loc-clear").hidden = !checkinGeo;
}

function placeCheckinPin(latitude, longitude) {
  if (!checkinMap) return;
  const point = [latitude, longitude];
  if (checkinMarker) checkinMarker.setLatLng(point);
  else {
    checkinMarker = window.L.marker(point, { draggable: true }).addTo(checkinMap);
    checkinMarker.on("dragend", () => {
      const { lat, lng } = checkinMarker.getLatLng();
      setCheckinGeo({ latitude: lat, longitude: lng, accuracyM: null, locationSource: "map" });
    });
  }
}

function setCheckinGeo(value) {
  checkinGeo = value && {
    ...value,
    latitude: Number(value.latitude.toFixed(6)),
    longitude: Number(value.longitude.toFixed(6))
  };
  if (checkinGeo) placeCheckinPin(checkinGeo.latitude, checkinGeo.longitude);
  else if (checkinMarker) { checkinMarker.remove(); checkinMarker = null; }
  drawCheckinLoc();
}

let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  leafletLoading ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    css.integrity = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";
    css.crossOrigin = "";
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
    script.crossOrigin = "";
    script.onload = resolve;
    script.onerror = () => { leafletLoading = null; reject(new Error("map unavailable")); };
    document.head.append(css, script);
  });
  return leafletLoading;
}

$("checkin-pick").addEventListener("click", async () => {
  const box = $("checkin-map");
  const open = box.hidden;
  box.hidden = !open;
  $("checkin-pick").setAttribute("aria-expanded", String(open));
  if (!open) return;
  try {
    drawCheckinLoc(t("Loading map…"));
    await loadLeaflet();
  } catch {
    box.hidden = true;
    $("checkin-pick").setAttribute("aria-expanded", "false");
    drawCheckinLoc(t("The map needs an internet connection. Enter a landmark instead."));
    return;
  }
  if (!checkinMap) {
    const L = window.L;
    const start = checkinGeo ? [checkinGeo.latitude, checkinGeo.longitude] : geo ? [geo.latitude, geo.longitude] : DEFAULT_MAP_CENTER;
    checkinMap = L.map(box).setView(start, checkinGeo || geo ? 16 : 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
    }).addTo(checkinMap);
    checkinMap.on("click", (event) => setCheckinGeo({
      latitude: event.latlng.lat, longitude: event.latlng.lng, accuracyM: null, locationSource: "map"
    }));
    if (checkinGeo) placeCheckinPin(checkinGeo.latitude, checkinGeo.longitude);
  }
  setTimeout(() => checkinMap.invalidateSize(), 0);
  drawCheckinLoc(checkinGeo ? "" : t("Tap the map to place a pin where you are. Drag it to adjust."));
});

$("checkin-gps").addEventListener("click", () => {
  if (!canUseGps()) { drawCheckinLoc(); return; }
  drawCheckinLoc(t("Finding your location…"));
  navigator.geolocation.getCurrentPosition((position) => {
    setCheckinGeo({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: Math.min(100000, Math.round(position.coords.accuracy || 0)),
      locationSource: "gps"
    });
    if (checkinMap) checkinMap.setView([checkinGeo.latitude, checkinGeo.longitude], 16);
  }, () => drawCheckinLoc(t("Location not available. Tap \"Mark on map\" to drop a pin instead.")),
  { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
});

$("checkin-loc-clear").addEventListener("click", () => setCheckinGeo(null));
drawCheckinLoc();
document.addEventListener("ashraay:language-change", () => drawCheckinLoc());

$("submit-checkin").addEventListener("click", async () => {
  if ($("submit-checkin").disabled) return;
  $("submit-checkin").disabled = true;
  showError("");
  try {
    const result = await submit("/check-ins", {
      status: $("checkin-status").value,
      landmark: $("checkin-landmark").value,
      consent: $("checkin-consent").checked,
      ...(checkinGeo || {})
    });
    const message = result.queuedOffline
      ? t("Saved on this device. It will sync after sign-in and reconnection.")
      : t("Check-in received.");
    toast(message);
    showError(message);
    await updateOfflineQueue();
  } catch (error) {
    fail(error);
  } finally {
    $("submit-checkin").disabled = offlineOnly;
  }
});

function stageIndex(report) {
  if (report.status === "resolved") return 4;
  if (report.helpOnTheWay) return 3;
  if (report.status === "verified") return 2;
  if (["needs_review", "field_check_requested"].includes(report.status)) return 1;
  return 0;
}
function renderReports() {
  $("reports").innerHTML = cache.reports.length ? cache.reports.map((report) => {
    const closed = ["dismissed", "consent_withdrawn"].includes(report.status);
    const reached = stageIndex(report);
    const timeline = closed
      ? `<p class="muted">${t(report.status === "dismissed" ? "Checked and closed. No action was needed." : "You withdrew consent for this report.")}</p>`
      : `<ol class="track">${STAGES.map((label, index) =>
        `<li class="${index < reached || (index === reached && reached === 4) ? "past" : index === reached ? "now" : ""}">${t(label)}</li>`
      ).join("")}</ol>`;
    const [color, svg] = TYPE_ICONS[report.incidentType] || TYPE_ICONS.other;
    const kind = t(TYPE_LABELS[report.incidentType] || "Something else");
    const needs = (report.needs || []).map((need) => `<span>${escapeHtml(t(NEED_LABELS[need] || need))}</span>`).join("");
    return `<li class="rep">
      <div class="rephead"><i style="--c:${color}">${svg}</i><span class="tx"><b>${escapeHtml(kind)}</b><small>${escapeHtml(report.caseId)} · ${escapeHtml(report.time)}</small></span><span class="pill ${STATUS_PILL[report.status] || "p-teal"} status">${escapeHtml(t(report.status))}</span></div>
      <div class="repbody">
        <p>${escapeHtml(report.description)}</p>
        <div class="facts"><span>${escapeHtml(report.landmark)}</span>${needs}</div>
        ${timeline}
        ${closed || report.status === "resolved" ? "" : `<button type="button" class="btn w" data-update="${escapeHtml(report.landmark)}">${t("Report a change here")}</button>`}
      </div>
    </li>`;
  }).join("") : `<li class="empty">${t("No reports submitted yet.")}</li>`;
}
document.addEventListener("click", (event) => {
  const update = event.target.closest("[data-update]");
  if (!update) return;
  resetReport();
  setLocMode("manual");
  $("address").value = update.dataset.update;
  show("report");
});

function alertCard(alert, compact) {
  return `<article class="alertcard"><div class="ahead"><i>${ALERT_ICON}</i><div><span class="lvl">${t("Official advisory")}</span><b>${escapeHtml(alert.headline)}</b></div></div>
    <p class="abody">${escapeHtml(alert.message)}</p>
    <p class="ameta">${alert.place ? `${escapeHtml(alert.place)} · ` : ""}${t("Approved by a human commander")}${compact ? "" : ` · ${escapeHtml(alert.approvedAt || "")}`}</p></article>`;
}
const noAlerts = () => `<div class="alertstate"><span class="ic">${TICK_ICON}</span><span>${t("No active official warnings.")}</span></div>`;
function renderAlerts() {
  const first = cache.alerts[0];
  $("home-alert").innerHTML = first ? alertCard(first, true) : noAlerts();
  const staffNote = !isResident() && !isWorker()
    ? `<div class="queue" style="margin:0 0 12px">${t("This is the resident app. Staff tools are in the Command Center.")}</div>` : "";
  const responses = cache.responseUpdates.map(responseUpdateCard).join("");
  $("alerts").innerHTML = staffNote + responses + (cache.alerts.length
    ? cache.alerts.map((alert) => alertCard(alert, false)).join("")
    : noAlerts());
  const citizenUpdate = cache.responseUpdates.find((item) => item.audience === "citizen");
  if (citizenUpdate) $("home-alert").innerHTML = responseUpdateCard(citizenUpdate) + $("home-alert").innerHTML;
}

function responseUpdateCard(task) {
  const name = task.volunteerName || t("Volunteer");
  const labels = {
    ready: t("Response team is reviewing your request."),
    offered: t("New simulated field task"),
    accepted: `${name} - ${t("Help is on the way (simulation).")}`,
    on_site: `${name} - ${t("Volunteer has arrived (simulation).")}`,
    blocked: t("Task blocked. The response team is reviewing it."),
    declined: t("Waiting for another volunteer."),
    awaiting_confirmation: t("The volunteer completed the simulated task. Are you safe?"),
    completed: t("Completed and confirmed by all notified citizens.")
  };
  return `<article class="card task" data-response-id="${escapeHtml(task.id)}">
    <h3>${escapeHtml(task.requestedHelp === "safe" ? t("Your request is closed.") : labels[task.status] || task.status)}</h3>
    <p>${escapeHtml(task.summary)} · ${escapeHtml(task.place || "")}</p>
    ${task.volunteerName ? `<p>${escapeHtml(t("Volunteer"))}: ${escapeHtml(task.volunteerName)}</p>` : ""}
    <p class="muted small">${escapeHtml(task.detail || "")}</p>
    ${task.completionPhoto ? `<img src="${escapeHtml(task.completionPhoto)}" alt="${escapeHtml(t("Completion photo"))}" style="max-width:100%;max-height:240px">` : ""}
    ${task.completionVoice ? `<audio controls preload="none" src="${escapeHtml(task.completionVoice)}" aria-label="${escapeHtml(t("Completion voice note"))}"></audio>` : ""}
    ${task.completionNote ? `<p>${escapeHtml(task.completionNote)}</p>` : ""}
    ${task.status === "awaiting_confirmation" ? `<p>${t("Citizen confirmations")}: ${task.confirmationCount}/${task.confirmationTotal}</p>` : ""}
    ${task.canRespond ? `<div class="field"><label>${t("What help do you need?")}<select data-response-need="${escapeHtml(task.hazardAlertId)}">
      ${RESPONSE_NEEDS.map(([value, label]) => `<option value="${value}" ${task.requestedHelp === value ? "selected" : ""}>${escapeHtml(t(label))}</option>`).join("")}
      </select></label></div><button type="button" class="btn" data-request-help="${escapeHtml(task.hazardAlertId)}">${t("Request assistance")}</button>
      <button type="button" class="btn teal" data-response-safe="${escapeHtml(task.hazardAlertId)}">${t("Yes, I am safe - acknowledge")}</button>` : task.canConfirm ? `<button type="button" class="btn teal" data-confirm-task="${escapeHtml(task.id)}">${t("Yes, I am safe - acknowledge")}</button>` : ""}
    ${task.requestedHelp && task.requestedHelp !== "safe" ? `<p>${escapeHtml(t("Requested assistance"))}: ${escapeHtml(responseNeedLabel(task.requestedHelp))}</p>` : ""}
    ${task.requestedHelp === "safe" ? `<p>${t("You acknowledged safe. Your request is closed.")}</p>` : ""}
    ${task.confirmed && task.status !== "completed" && task.requestedHelp !== "safe" ? `<p>${t("You confirmed. Waiting for the other notified citizens.")}</p>` : ""}
    ${task.audience === "volunteer" ? `<button type="button" class="btn" data-open-response-tasks>${t("Tasks")}</button>` : ""}
  </article>`;
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-open-response-tasks]")) show("tasks");
  const button = event.target.closest("[data-confirm-task], [data-response-safe], [data-request-help]");
  if (!button) return;
  button.disabled = true;
  showError("");
  try {
    const hazardId = button.dataset.responseSafe || button.dataset.requestHelp;
    if (hazardId) {
      const select = button.closest("[data-response-id]").querySelector("[data-response-need]");
      await post(`/hazards/${encodeURIComponent(hazardId)}/response`, {
        need: button.dataset.responseSafe ? "safe" : select.value
      });
    } else {
      await post(`/tasks/${encodeURIComponent(button.dataset.confirmTask)}/confirm`, {});
    }
    await load(true);
    toast(t("Confirmation saved."));
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
});

function taskActions(status) {
  return {
    offered: [["accepted", "Accept task"], ["declined", "Decline"]],
    accepted: [["on_site", "Arrived"], ["blocked", "Report blocked route"]],
    on_site: [["blocked", "Report blocked route"], ["completed", "Complete task"]]
  }[status] || [];
}
function volunteerMayWork() {
  if (!isVolunteer() || auth.hasRole("field-team", "response-agency")) return true;
  const profile = cache.volunteer?.profile;
  return Boolean(profile && profile.status === "verified" && profile.available);
}
function renderTasks() {
  if (!isWorker()) return;
  if (!volunteerMayWork() && !cache.tasks.length) {
    $("tasks").innerHTML = `<div class="empty">${t("For simulated hazard tasks, accept the alert above and wait for Send to field. Other tasks require a verified, available profile.")}</div>`;
    return;
  }
  $("tasks").innerHTML = cache.tasks.length ? cache.tasks.map((task) => {
    const actions = taskActions(task.status);
    return `<div class="card task${task.status === "offered" ? " new" : ""}">
      <div class="taskhead"><i style="--c:${task.status === "offered" ? "var(--red)" : "var(--indigo)"}">${TASK_ICON}</i><span class="tx"><b>${t("Approved field task")}</b></span><span class="pill p-ind status">${escapeHtml(t(task.status === "awaiting_confirmation" ? "Awaiting citizen confirmation" : task.status))}</span></div>
      <p style="margin:0 0 8px">${escapeHtml(task.summary)}</p>
      ${task.hazardAlertId ? `<p class="muted small">${escapeHtml(t("Simulation only - not an emergency dispatch."))} · ${escapeHtml(task.place || "")}</p><p>${escapeHtml(task.detail || "")}</p>` : ""}
      ${task.assistanceNeeds?.length ? `<p>${t("Requested assistance")}: ${escapeHtml(task.assistanceNeeds.map((item) => `${responseNeedLabel(item.need)} (${item.count})`).join(", "))}</p>` : ""}
      ${task.resources?.length ? `<dl class="kv"><dt>${t("Resources")}</dt><dd>${escapeHtml(task.resources.join(", "))}</dd></dl>` : ""}
      <p class="brief" style="margin:10px 0">${t("Safety briefing: check the route and your own safety first. Do not enter flood water. Report blocked routes.")}</p>
      ${task.status === "on_site" ? `<div class="field"><label>${t("People assisted")}<input data-count="${escapeHtml(task.id)}" type="number" min="0" max="500" value="${escapeHtml(completionDrafts.get(task.id)?.count || 0)}" inputmode="numeric"></label></div>` : ""}
      ${task.hazardAlertId && task.status === "on_site" ? `<p>${t("Add a photo or voice note to complete this simulated task.")}</p>
        <div class="field"><label>${t("Completion photo")}<input type="file" accept="image/*" capture="environment" data-completion-photo="${escapeHtml(task.id)}"></label><small data-photo-status="${escapeHtml(task.id)}">${completionPhotos.has(task.id) ? t("Photo ready to submit.") : ""}</small></div>
        <div class="field"><label>${t("Completion voice note")}<input type="file" accept="audio/*" data-completion-voice="${escapeHtml(task.id)}"></label>
          <button type="button" class="btn" data-record-completion="${escapeHtml(task.id)}">${t("Record voice note")}</button><small data-voice-status="${escapeHtml(task.id)}">${completionVoices.has(task.id) ? t("Voice note ready to submit.") : ""}</small></div>
        <div class="field"><label>${t("Completion note (optional)")}<textarea maxlength="500" data-completion-note="${escapeHtml(task.id)}">${escapeHtml(completionDrafts.get(task.id)?.note || "")}</textarea></label></div>` : ""}
      ${task.status === "awaiting_confirmation" ? `<p>${t("Awaiting citizen confirmation")}: ${task.confirmationCount}/${task.confirmationTotal}</p>` : ""}
      ${actions.length ? `<div class="row">${actions.map(([status, title]) => `<button type="button" data-task="${escapeHtml(task.id)}" data-status="${status}" class="btn ${status === "accepted" || status === "completed" ? "teal" : status === "blocked" ? "red" : ""}">${t(title)}</button>`).join("")}</div>` : ""}
    </div>`;
  }).join("") : `<div class="empty">${t("No approved tasks are available.")}</div>`;
}

function fileDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("Could not read the voice note.")));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function prepareCompletionVoice(file) {
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error(t("Voice note must be at most 2 MB."));
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const starts = (...bytes) => bytes.every((byte, index) => header[index] === byte);
  let mime;
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) mime = "audio/webm";
  else if (starts(79, 103, 103, 83)) mime = "audio/ogg";
  else if (starts(73, 68, 51) || (header[0] === 255 && (header[1] & 224) === 224)) mime = "audio/mpeg";
  else if (starts(82, 73, 70, 70) && String.fromCharCode(...header.slice(8, 12)) === "WAVE") mime = "audio/wav";
  else if (String.fromCharCode(...header.slice(4, 8)) === "ftyp") mime = "audio/mp4";
  else throw new Error(t("Choose a WebM, Ogg, MP3, WAV, or M4A voice note."));
  return fileDataUrl(new Blob([file], { type: mime }));
}

document.addEventListener("input", (event) => {
  const input = event.target.closest("[data-completion-note], [data-count]");
  if (!input) return;
  const taskId = input.dataset.completionNote || input.dataset.count;
  const draft = completionDrafts.get(taskId) || {};
  draft[input.dataset.completionNote ? "note" : "count"] = input.value;
  completionDrafts.set(taskId, draft);
});

document.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-completion-voice]");
  if (!input) return;
  const taskId = input.dataset.completionVoice;
  completionVoices.delete(taskId);
  const status = document.querySelector(`[data-voice-status="${CSS.escape(taskId)}"]`);
  if (status) status.textContent = "";
  if (!input.files?.[0]) return;
  input.disabled = true;
  try {
    completionVoices.set(taskId, await prepareCompletionVoice(input.files[0]));
    if (status) status.textContent = t("Voice note ready to submit.");
  } catch (error) {
    fail(error);
  } finally {
    input.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-record-completion]");
  if (!button) return;
  if (completionRecorder) {
    if (completionRecorder.recorder.state === "recording") completionRecorder.recorder.stop();
    return;
  }
  if (!canRecord()) {
    showError(t("Microphone needs HTTPS or localhost. Upload a voice note instead."));
    return;
  }
  button.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recording = new MediaRecorder(stream);
    const chunks = [];
    let failed = false;
    let timer;
    const taskId = button.dataset.recordCompletion;
    completionRecorder = { recorder: recording, taskId };
    recording.ondataavailable = (data) => { if (data.data.size) chunks.push(data.data); };
    const resetRecording = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      completionRecorder = null;
      button.textContent = t("Record voice note");
      button.disabled = false;
    };
    recording.onerror = () => {
      failed = true;
      showError(t("Could not record the voice note."));
    };
    recording.onstop = async () => {
      try {
        if (failed) return;
        completionVoices.set(taskId, await prepareCompletionVoice(new Blob(chunks, { type: recording.mimeType })));
        const status = document.querySelector(`[data-voice-status="${CSS.escape(taskId)}"]`);
        if (status) status.textContent = t("Voice note ready to submit.");
      } catch (error) {
        fail(error);
      } finally {
        resetRecording();
      }
    };
    recording.start();
    timer = setTimeout(() => {
      if (recording.state === "recording") recording.stop();
    }, 120000);
    button.textContent = t("Stop recording");
    button.disabled = false;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    completionRecorder = null;
    button.disabled = false;
    showError(`${t("Could not record the voice note.")} ${error.message}`);
  }
});

async function prepareCompletionPhoto(file) {
  if (!file.type.startsWith("image/")) throw new Error(t("Choose an image for the completion photo."));
  if (file.size > 20 * 1024 * 1024) throw new Error(t("Photo is too large. Choose an image under 20 MB."));
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("Could not prepare the completion photo."));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL("image/jpeg", 0.8);
    if (photo.length > 2_800_000) throw new Error(t("Photo is too large. Choose a smaller image."));
    return photo;
  } finally {
    image.close();
  }
}

document.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-completion-photo]");
  if (!input) return;
  const taskId = input.dataset.completionPhoto;
  completionPhotos.delete(taskId);
  const status = document.querySelector(`[data-photo-status="${CSS.escape(taskId)}"]`);
  if (status) status.textContent = "";
  const file = input.files?.[0];
  if (!file) return;
  showError("");
  input.disabled = true;
  try {
    completionPhotos.set(taskId, await prepareCompletionPhoto(file));
    if (status) status.textContent = t("Photo ready to submit.");
  } catch (error) {
    fail(error);
  } finally {
    input.disabled = false;
  }
});
function locationStatusBlock() {
  return `<p class="muted small" id="vol-location-status">${canUseGps() ? "" : t("GPS needs a secure (HTTPS) connection. Tap \"Mark on map\" to drop a pin instead.")}</p>
    <div class="row"><button type="button" id="vol-locate" class="btn w" style="margin:6px 0 12px">${t("Use my location")}</button><button type="button" id="vol-pick" class="btn w" style="margin:6px 0 12px" aria-expanded="false">${t("Mark on map")}</button></div>
    <div id="vol-map" class="ci-map" hidden></div>`;
}

// Map instance is rebuilt each time renderVolunteer() replaces #volunteer-card's markup.
let volMap = null;
let volMarker = null;

async function saveVolLocation(latitude, longitude, source) {
  const statusEl = $("vol-location-status");
  try {
    await post("/auth/me/location", { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)) });
    if (statusEl) statusEl.textContent = source === "gps" ? t("Location saved.") : t("Pin location saved.");
    if (volMap) {
      if (volMarker) volMarker.setLatLng([latitude, longitude]);
      else {
        volMarker = window.L.marker([latitude, longitude], { draggable: true }).addTo(volMap);
        volMarker.on("dragend", () => {
          const { lat, lng } = volMarker.getLatLng();
          saveVolLocation(lat, lng, "map");
        });
      }
      volMap.setView([latitude, longitude], 16);
    }
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message;
  }
}
function renderVolunteer() {
  const card = $("volunteer-card");
  card.classList.toggle("hidden", !isVolunteer());
  if (!isVolunteer()) return;
  volMap = null;
  volMarker = null;
  const profile = cache.volunteer?.profile;
  const status = cache.volunteer?.enrolled ? profile.status : "none";
  if (status === "none") {
    const identity = auth.identity();
    card.innerHTML = `<h3>${t("Volunteer profile")}</h3>
      <p class="muted small">${t("Registered volunteers can join simulated hazard tasks now. Profile verification is required for other tasks.")}</p>
      <div class="field"><label for="vol-name">${t("Your name")}</label><input id="vol-name" value="${escapeHtml(identity?.preferred_username || "")}" maxlength="80" autocomplete="name"></div>
      <div class="field"><label>${t("Skills")}</label><div class="chips" id="vol-skills" role="group">${SKILLS.map(([id, label]) => `<button type="button" data-skill="${id}">${t(label)}</button>`).join("")}</div></div>
      <div class="field"><label>${t("Languages you speak")}</label><div class="chips" id="vol-langs" role="group">${LANGUAGES.map(([id, label]) => `<button type="button" data-vlang="${id}" class="${id === window.ashraayI18n.language ? "sel" : ""}">${label}</button>`).join("")}</div></div>
      <div class="field"><label for="vol-area">${t("Area you can reach")}</label><input id="vol-area" maxlength="120" placeholder="${escapeHtml(t("Neighbourhood or ward"))}"></div>
      <div class="field"><label>${t("Location")}</label><p class="muted small">${t("Shared with the response team. Every active volunteer receives every hazard alert, wherever you are.")}</p>${locationStatusBlock()}</div>
      <label class="consent"><input id="vol-consent" type="checkbox"><span>${t("I agree to share this profile with the response team")}</span></label>
      <p class="err" id="vol-err"></p>
      <button type="button" id="vol-enrol" class="btn pri w">${t("Enrol as volunteer")}</button>`;
    return;
  }
  const facts = `<dl class="kv"><dt>${t("Your name")}</dt><dd>${escapeHtml(profile.displayName)}</dd><dt>${t("Skills")}</dt><dd>${escapeHtml(profile.skills.map((skill) => t(SKILLS.find(([id]) => id === skill)?.[1] || skill)).join(", "))}</dd><dt>${t("Languages you speak")}</dt><dd>${escapeHtml(profile.languages.map((id) => LANGUAGES.find(([code]) => code === id)?.[1] || id).join(", "))}</dd><dt>${t("Area you can reach")}</dt><dd>${escapeHtml(profile.area)}</dd></dl>${locationStatusBlock()}`;
  const stop = `<button type="button" id="vol-withdraw" class="btn w" style="margin-top:10px">${t("Stop volunteering")}</button>`;
  if (status === "pending") {
    card.innerHTML = `<div class="item-head"><h3 style="margin:0">${t("Volunteer profile")}</h3><span class="pill p-com" id="vol-status">${t("Waiting for verification")}</span></div>
      <p class="muted small">${t("Registered volunteers can join simulated hazard tasks now. Profile verification is required for other tasks.")}</p>${facts}${stop}`;
  } else if (status === "verified") {
    card.innerHTML = `<div class="item-head"><h3 style="margin:0">${t("Volunteer profile")}</h3><span class="pill p-ok" id="vol-status">${t("Verified")}</span></div>
      <div class="availcard${profile.available ? " on" : ""}"><span class="ic">${PIN_ICON}</span><label for="vol-available">${t("I am available for tasks")}</label><input id="vol-available" class="tog" type="checkbox" ${profile.available ? "checked" : ""}></div>${facts}${stop}`;
  } else {
    card.innerHTML = `<div class="item-head"><h3 style="margin:0">${t("Volunteer profile")}</h3><span class="pill p-hi" id="vol-status">${t("Not approved")}</span></div>
      <p class="muted small">${t("The response team could not approve this profile. You can stop volunteering and enrol again with new details.")}</p>${facts}${stop}`;
  }
}
const HAZARD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3L2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>';
function renderHazardRequests() {
  const box = $("hazard-requests");
  if (!box) return;
  const requests = cache.hazardRequests || [];
  box.innerHTML = requests.map((request) => `<div class="card task new">
      <div class="taskhead"><i style="--c:var(--red)">${HAZARD_ICON}</i><span class="tx"><b>${t("Hazard alert — are you available?")}</b></span><span class="pill p-ind status">${escapeHtml(t(request.severity ? request.severity.charAt(0).toUpperCase() + request.severity.slice(1) : ""))}</span></div>
      <p style="margin:0 0 8px">${escapeHtml(request.place || "")}</p>
      ${request.reasons?.length ? `<ul class="brief" style="margin:0 0 10px;padding-left:18px">${request.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}
      ${request.canRespond ? `<div class="row"><button type="button" data-hazard-respond="${escapeHtml(request.id)}" data-available="true" class="btn teal">${t("Yes, I am available")}</button><button type="button" data-hazard-respond="${escapeHtml(request.id)}" data-available="false" class="btn">${t("Not now")}</button></div>` : `<p>${t(request.status === "accepted" ? "You are volunteering for this alert. Await a field task." : "You are not available for this alert.")}</p>`}
    </div>`).join("");
}
document.addEventListener("click", async (event) => {
  const respond = event.target.closest("button[data-hazard-respond]");
  if (respond) {
    if (respond.disabled) return;
    respond.disabled = true;
    showError("");
    try {
      await post(`/volunteer-requests/${respond.dataset.hazardRespond}/respond`, { available: respond.dataset.available === "true" });
      toast(respond.dataset.available === "true" ? t("Thank you. The response team has been notified.") : t("Thanks for letting us know."));
      await load(true);
    } catch (error) {
      fail(error);
    } finally {
      respond.disabled = false;
    }
    return;
  }
});
document.addEventListener("click", async (event) => {
  if (event.target.closest("#vol-locate")) {
    const statusEl = $("vol-location-status");
    if (!canUseGps()) {
      statusEl.textContent = t("GPS needs a secure (HTTPS) connection. Tap \"Mark on map\" to drop a pin instead.");
      return;
    }
    statusEl.textContent = t("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => saveVolLocation(position.coords.latitude, position.coords.longitude, "gps"),
      () => { statusEl.textContent = t("Location not available."); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
    return;
  }
  if (event.target.closest("#vol-pick")) {
    const button = $("vol-pick");
    const box = $("vol-map");
    const statusEl = $("vol-location-status");
    const open = box.hidden;
    box.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    try {
      statusEl.textContent = t("Loading map…");
      await loadLeaflet();
    } catch {
      box.hidden = true;
      button.setAttribute("aria-expanded", "false");
      statusEl.textContent = t("The map needs an internet connection.");
      return;
    }
    if (!volMap) {
      const L = window.L;
      const start = geo ? [geo.latitude, geo.longitude] : DEFAULT_MAP_CENTER;
      volMap = L.map(box).setView(start, geo ? 16 : 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
      }).addTo(volMap);
      volMap.on("click", (mapEvent) => saveVolLocation(mapEvent.latlng.lat, mapEvent.latlng.lng, "map"));
    }
    setTimeout(() => volMap.invalidateSize(), 0);
    statusEl.textContent = t("Tap the map to place a pin where you are. Drag it to adjust.");
    return;
  }
});
document.addEventListener("click", async (event) => {
  const skill = event.target.closest("[data-skill], [data-vlang]");
  if (skill) { skill.classList.toggle("sel"); return; }
  try {
    if (event.target.closest("#vol-enrol")) {
      const skills = [...document.querySelectorAll("#vol-skills .sel")].map((chip) => chip.dataset.skill);
      const languages = [...document.querySelectorAll("#vol-langs .sel")].map((chip) => chip.dataset.vlang);
      const name = $("vol-name").value.trim();
      const area = $("vol-area").value.trim();
      const problem = name.length < 2 ? t("Please enter your name.")
        : !skills.length ? t("Choose at least one skill.")
          : !languages.length ? t("Choose at least one language.")
            : area.length < 3 ? t("Please enter the area you can reach.")
              : !$("vol-consent").checked ? t("Consent is required to share your volunteer profile with the response team.") : "";
      $("vol-err").textContent = problem;
      if (problem) return;
      await post("/volunteers/me", { displayName: name, skills, languages, area, consent: true });
      toast(t("Enrolment sent. The response team will verify your profile."));
      await load(true);
    } else if (event.target.closest("#vol-withdraw")) {
      if (!confirm(t("Stop volunteering and withdraw your profile?"))) return;
      await post("/volunteers/me/withdraw", {});
      await load(true);
    }
  } catch (error) {
    fail(error);
  }
});
document.addEventListener("change", async (event) => {
  if (event.target.id !== "vol-available") return;
  try {
    await post("/volunteers/me/availability", { available: event.target.checked });
    await load(true);
  } catch (error) {
    event.target.checked = !event.target.checked;
    fail(error);
  }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-task]");
  if (!button) return;
  if (button.disabled) return;
  button.disabled = true;
  showError("");
  try {
    const body = { status: button.dataset.status };
    if (body.status === "blocked") {
      body.note = prompt(t("What is blocked?")) || "Route blocked";
    }
    if (body.status === "completed") {
      const count = document.querySelector(`[data-count="${CSS.escape(button.dataset.task)}"]`);
      body.peopleAssisted = Number(count?.value || 0);
      const task = cache.tasks.find((item) => item.id === button.dataset.task);
      if (task?.hazardAlertId) {
        if (completionRecorder) throw new Error(t("Stop recording before completing the task."));
        body.completionPhoto = completionPhotos.get(task.id);
        body.completionVoice = completionVoices.get(task.id);
        body.note = completionDrafts.get(task.id)?.note || undefined;
        if (!body.completionPhoto && !body.completionVoice) throw new Error(t("Add a photo or voice note to complete this simulated task."));
      }
    }
    await post(`/tasks/${button.dataset.task}/transitions`, body);
    if (body.status === "completed") {
      completionPhotos.delete(button.dataset.task);
      completionVoices.delete(button.dataset.task);
      completionDrafts.delete(button.dataset.task);
    }
    await load(true);
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
});

$("export-data").addEventListener("click", async () => {
  showError("");
  try {
    const data = await auth.request("/privacy/export");
    $("privacy-export").textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    fail(error);
  }
});
$("withdraw-consent").addEventListener("click", async () => {
  showError("");
  try {
    const data = await auth.request("/privacy/export");
    const activeConsents = data.consents.filter((entry) => !entry.withdrawnAt);
    if (!confirm(t("Withdraw future response-coordination consent? Submitted reports remain retained for their response/legal record."))) return;
    await offline.clear(auth.identity().sub);
    for (const consent of activeConsents) {
      await post(`/privacy/consents/${consent.id}/withdraw`, {});
    }
    const updated = await auth.request("/privacy/export");
    $("privacy-export").textContent = JSON.stringify(updated, null, 2);
    await updateOfflineQueue();
    const message = activeConsents.length
      ? t("Submitted reports remain retained for their response/legal record.")
      : t("No active consent to withdraw.");
    $("connection-status").textContent = message;
    $("connection-status").classList.remove("hidden");
    toast(message);
  } catch (error) {
    fail(error);
  }
});

const OPTS_KEY = "ashraay.mobile.options";
function applyOptions(options) {
  document.body.classList.toggle("big", Boolean(options.big));
  document.body.classList.toggle("hc", Boolean(options.hc));
  $("opt-big").checked = Boolean(options.big);
  $("opt-hc").checked = Boolean(options.hc);
}
try {
  applyOptions(JSON.parse(localStorage.getItem(OPTS_KEY) || "{}"));
} catch (error) {
  console.error("Could not load accessibility preferences.", error);
  showError(t("Could not load accessibility preferences."));
}
for (const id of ["opt-big", "opt-hc"]) {
  $(id).addEventListener("change", () => {
    const options = { big: $("opt-big").checked, hc: $("opt-hc").checked };
    localStorage.setItem(OPTS_KEY, JSON.stringify(options));
    applyOptions(options);
  });
}

$("signout").addEventListener("click", () => auth.logout());

async function load(force = false) {
  const jobs = [];
  jobs.push(auth.request("/alerts/official").then((alerts) => { cache.alerts = alerts; }));
  jobs.push(auth.request("/my/response-updates").then((updates) => {
    for (const task of updates) {
      const signature = `${task.status}:${task.confirmationCount}`;
      const previous = responseStatuses.get(task.id);
      if (previous && previous !== signature) toast(t("Response update received. Check Alerts."));
      if (!previous && task.status === "offered") toast(t("New simulated field task. Check Tasks."));
      responseStatuses.set(task.id, signature);
    }
    cache.responseUpdates = updates;
  }));
  if (isResident()) {
    jobs.push(auth.request("/my/reports").then((reports) => { cache.reports = reports; renderIfChanged("reports", reports, renderReports, force); }));
  }
  if (isVolunteer()) {
    jobs.push(auth.request("/volunteers/me").then((profile) => { cache.volunteer = profile; renderIfChanged("volunteer", profile, renderVolunteer, force); }));
    jobs.push(auth.request("/volunteer-requests/me").then((requests) => {
      const knownRequests = new Set((cache.hazardRequests || []).map((request) => request.id));
      if (requests.some((request) => request.canRespond && !knownRequests.has(request.id))) {
        toast(t("Hazard alert — are you available?"));
      }
      cache.hazardRequests = requests;
      renderIfChanged("hazardRequests", requests, renderHazardRequests, force);
    }));
  }
  if (isWorker()) {
    jobs.push(auth.request("/my/tasks").then((tasks) => { cache.tasks = tasks; }));
  }
  await Promise.all(jobs);
  renderIfChanged("alerts", [cache.alerts, cache.responseUpdates], renderAlerts, force);
  const editingEvidence = completionRecorder || document.activeElement?.matches("[data-completion-note], [data-count]")
    || document.querySelector("[data-completion-photo]:disabled, [data-completion-voice]:disabled, [data-record-completion]:disabled");
  if (isWorker() && !completionEvidenceBusy() && (force || !editingEvidence)) renderIfChanged("tasks", [cache.tasks, cache.volunteer], renderTasks, force);
}
function completionEvidenceBusy() {
  return completionRecorder || document.querySelector("[data-completion-photo]:disabled, [data-completion-voice]:disabled, [data-record-completion]:disabled");
}
function renderAll() {
  renderAlerts();
  renderReports();
  renderVolunteer();
  renderHazardRequests();
  if (!completionEvidenceBusy()) renderTasks();
  renderNav();
  drawLoc();
  drawMedia();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch((error) => {
    console.error("Could not register the offline app shell.", error);
  });
}
window.addEventListener("ashraay:offline-queue-change", () => { updateOfflineQueue().catch(fail); });
navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "online") flushOfflineQueue().catch(fail);
});
window.addEventListener("offline", () => { updateOfflineQueue().catch(fail); });
window.addEventListener("online", () => {
  if (offlineOnly) {
    location.reload();
    return;
  }
  flushOfflineQueue().catch(fail);
});

function enterOfflineMode(error) {
  offlineOnly = true;
  $("app-shell").hidden = false;
  $("login-screen").hidden = true;
  $("identity").textContent = t("Offline mode");
  $("signout").classList.add("hidden");
  $("submit-report").disabled = true;
  $("submit-checkin").disabled = true;
  show("home");
  showError(error.message);
  updateOfflineQueue().catch(fail);
}

function startApp() {
  auth.initialize().then(async () => {
    $("login-screen").hidden = true;
    $("app-shell").hidden = false;
    const identity = auth.identity();
    auth.rewriteAppLinks();
    const label = () => `${identity.preferred_username || identity.sub} · ${auth.roles().map(roleLabel).join(", ")}`;
    $("identity").textContent = label();
    show(navItems()[0][0]);
    await load(true);
    await updateOfflineQueue();
    await flushOfflineQueue();
    document.addEventListener("ashraay:language-change", () => {
      $("identity").textContent = label();
      renderAll();
      updateOfflineQueue().catch(fail);
    });
    setInterval(() => {
      if (navigator.onLine) load().catch(fail);
    }, 5000);
  }).catch((error) => {
    if (!navigator.onLine || error instanceof TypeError) {
      enterOfflineMode(error);
    } else {
      $("login-error").textContent = error.message;
      const button = $("login-signin");
      if (button) { button.disabled = false; $("login-signin-label").textContent = t("Sign in"); }
    }
  });
}

if (auth.hasCallback()) {
  $("login-signin-label").textContent = t("Signing in…");
  $("login-signin").disabled = true;
  startApp();
} else if (auth.restoreSession()) {
  window.ashraayLogin.init({ onSignedIn: startApp });
  startApp();
} else if (!navigator.onLine) {
  enterOfflineMode(new Error(t("You are offline.")));
} else {
  window.ashraayLogin.init({ onSignedIn: startApp });
}
