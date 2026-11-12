const auth = window.ashraayAuth;
const t = window.ashraayI18n.t;
const api = "/state";
const $ = (id) => document.getElementById(id);
const escapeHtml = auth.escapeHtml;
const post = (path, body = {}, key) => auth.postJson(path, body, { key: key || idempotencyKey() });
const idempotencyKey = () => auth.randomId();
document.getElementById("signout").addEventListener("click", () => auth.logout());
let currentScreen = "dashboard";
let lastState = null;
let lastStateSerialized = "";

let toastTimer;
function toast(message) {
  const el = $("app-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3600);
}
function showScreen(screen) {
  const nav = document.querySelector(`.nav [data-go="${CSS.escape(screen)}"]`);
  if (!nav) return;
  currentScreen = screen;
  document.querySelectorAll("[data-screen]").forEach((section) => {
    section.hidden = section.dataset.screen !== screen;
  });
  document.querySelectorAll(".nav [data-go]").forEach((button) => {
    button.classList.toggle("on", button === nav);
    if (button === nav) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("view-title").dataset.i18n = nav.dataset.i18n;
  $("view-title").textContent = t(nav.dataset.i18n);
  const cityWrap = $("db-city-wrap");
  if (cityWrap) cityWrap.hidden = !["dashboard", "weather", "hazard-agents"].includes(screen);
  if (screen === "dashboard") window.ashraayDashboard.shown();
  if (screen === "weather") window.ashraayWeather.shown();
  if (screen === "people") {
    window.ashraayPeople.shown();
    window.ashraayPeople.refresh(lastState).catch((error) => { $("error").textContent = error.message; });
  } else window.ashraayPeople.hidden();
  window.scrollTo(0, 0);
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-go]");
  if (button) showScreen(button.dataset.go);
});

function rows(items, render, empty = "No items") {
  return items.length ? items.map(render).join("") : `<em class="muted">${t(empty)}</em>`;
}

async function load() {
  const state = await auth.request(api);
  const serializedState = JSON.stringify(state);
  if (serializedState === lastStateSerialized) return;
  lastStateSerialized = serializedState;
  window.ashraayCases.update(state, load);
  window.ashraayDashboard.render(state);
  window.ashraayWeather.render(state);
  window.ashraayHazard.render(state);
  lastState = state;
  if (currentScreen === "people") await window.ashraayPeople.refresh(state);
  const mayVerify = auth.hasRole("incident-commander", "verifier");
  $("volunteers-view").classList.toggle("hidden", !mayVerify);
  $("volunteers").innerHTML = rows((state.volunteers || []).filter((profile) => profile.status !== "withdrawn"), (profile) =>
    `<div class="item"><div class="item-head"><strong>${escapeHtml(profile.displayName)}</strong><span class="pill">${escapeHtml(t(profile.status))}</span></div><p>${escapeHtml(profile.area)} · ${escapeHtml(profile.skills.join(", "))} · ${escapeHtml(profile.languages.join(", "))}</p><p class="muted">${t(profile.available ? "available" : "unavailable")}</p>${mayVerify ? `<div class="actions"><button data-action="volunteer-verify" data-id="${escapeHtml(profile.id)}">${t("Verify volunteer")}</button><button class="danger" data-action="volunteer-reject" data-id="${escapeHtml(profile.id)}">${t("Reject")}</button></div>` : ""}</div>`
  );
  const reservations = state.reservations || [];
  $("resources").innerHTML = rows(state.resources || [], (resource) => {
    const active = reservations.find(
      (item) => item.resourceId === resource.id && ["held", "committed"].includes(item.status)
    );
    return `<div class="item"><strong>${escapeHtml(resource.name)}</strong> · ${escapeHtml(t(resource.kind))} · ${escapeHtml(t(active?.status || resource.status))} · ${resource.capacity} ${t("capacity")}${active ? ` · ${t("plan revision")} ${active.revision}` : ""}</div>`;
  });
  $("deliveries").innerHTML = rows(state.deliveries, (item) =>
    `<div class="item"><strong>${escapeHtml(t(item.status))}</strong><p>${escapeHtml(item.channels.join(", "))} · ${t("plan revision")} ${item.revision}</p><time>${escapeHtml(item.time)}</time></div>`
  );
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  button.disabled = true;
  $("error").textContent = "";
  try {
    switch (button.dataset.action) {
      case "hazard-auto-start":
        await post("/hazards/auto-run/start");
        await window.ashraayHazard.refreshAutoRun();
        toast(t("Agents are live. New simulator inputs and citizen reports are checked every 10 seconds."));
        break;
      case "hazard-auto-stop":
        await post("/hazards/auto-run/stop");
        await window.ashraayHazard.refreshAutoRun();
        toast(t("Agents paused. Press Start to resume; anything sent meanwhile is picked up."));
        break;
      case "hazard-ignore":
        await post(`/hazards/${button.dataset.id}/ignore`);
        toast(t("Hazard alert ignored."));
        break;
      case "hazard-dispatch":
        // Agent 3: ask the nearest available volunteers. Shown as "Analyse" the first time (after
        // Agents 1 & 2 finish), and as "Check volunteers" for later retry rounds.
        await post(`/hazards/${button.dataset.id}/dispatch-volunteers`);
        toast(t("Agent 3 notified the nearest available volunteers."));
        break;
      case "hazard-approve": {
        const override = window.ashraayDashboard.hazardActionOverride(button.dataset.id);
        await post(`/hazards/${button.dataset.id}/approve`, override ? { actions: override } : {});
        toast(t("Alert sent to registered users; registered volunteers can accept or decline."));
        break;
      }
      case "hazard-reject":
        await post(`/hazards/${button.dataset.id}/reject`);
        toast(t("Hazard alert rejected."));
        break;
      case "hazard-escalate":
        await post(`/hazards/${button.dataset.id}/escalate`);
        toast(t("Hazard alert escalated."));
        break;
      case "hazard-plan-approve":
        await post(`/hazards/${button.dataset.hazardId}/plan/${button.dataset.stepId}/approve`);
        toast(t("Field task offered to volunteers who accepted this alert."));
        break;
      case "hazard-plan-dispatch":
        await post(`/hazards/${button.dataset.hazardId}/plan/dispatch`);
        toast(t("All pending response tasks offered to available volunteers."));
        break;
      case "report-response":
        await post(`/reports/${button.dataset.id}/response`);
        toast(t("Citizen risk sent to Response."));
        break;
      case "hazard-plan-complete":
        await post(`/hazards/${button.dataset.hazardId}/plan/${button.dataset.stepId}/complete`);
        break;
      case "reset":
        if (!confirm(t("Reset all simulated events and operational data?"))) return;
        await post("/demo/reset");
        break;
      case "report-approve":
      case "report-discard":
        await post(`/reports/${button.dataset.id}/decision`, {
          action: button.dataset.action === "report-approve" ? "approve" : "discard"
        });
        break;
      case "review-confirm":
      case "review-dismiss":
        await post(`/reviews/${button.dataset.id}/decision`, {
          action: button.dataset.action === "review-confirm" ? "confirm" : "dismiss"
        });
        break;
      case "volunteer-verify":
      case "volunteer-reject": {
        const reason = prompt(t("Record review evidence (at least 5 characters):"));
        if (!reason) return;
        await post(`/volunteers/${button.dataset.id}/verify`, {
          action: button.dataset.action === "volunteer-verify" ? "verify" : "reject", reason
        });
        break;
      }
    }
    await load();
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById("alert-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const form = new FormData(element);
  $("error").textContent = "";
  try {
    await post("/alerts", {
      place: form.get("place"),
      message: form.get("message"),
      language: form.get("language")
    }, idempotencyKey());
    element.reset();
    await load();
    showScreen("gate");
  } catch (error) {
    $("error").textContent = error.message;
  }
});

async function refreshLlmSettings() {
  const status = $("llm-settings-status");
  try {
    const settings = await auth.request("/agents/llm-settings");
    const form = document.getElementById("llm-settings-form");
    const select = form.elements.llmModel;
    if (settings.llmModel && settings.llmModel !== "n/a") {
      // Seed the dropdown with the currently saved model so Save works without re-listing first.
      select.innerHTML = `<option value="${escapeHtml(settings.llmModel)}">${escapeHtml(settings.llmModel)}</option>`;
    } else {
      select.innerHTML = `<option value="">${t("List models to choose one")}</option>`;
    }
    form.elements.githubToken.value = "";
    form.elements.githubToken.placeholder = settings.hasToken ? t("Token is set - leave blank to keep it") : t("No token set");
    status.textContent = `${t("Model")}: ${settings.llmModel}`;
  } catch (error) {
    status.textContent = error.message;
  }
}

document.getElementById("llm-list-models").addEventListener("click", async () => {
  const form = document.getElementById("llm-settings-form");
  const select = form.elements.llmModel;
  const modelsStatus = $("llm-models-status");
  const tokenInput = form.elements.githubToken.value.trim();
  modelsStatus.textContent = t("Listing models…");
  $("error").textContent = "";
  try {
    const result = await post("/agents/llm-models", { githubToken: tokenInput || null });
    const models = result.models || [];
    if (!models.length) {
      select.innerHTML = `<option value="">${t("No models found for this account")}</option>`;
      modelsStatus.textContent = t("No models found for this account");
      return;
    }
    const current = select.value;
    select.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${escapeHtml(m.id)})${m.enabled ? "" : ` - ${t("disabled")}`}</option>`)
      .join("");
    if (models.some((m) => m.id === current)) select.value = current;
    modelsStatus.textContent = `${t("Found")} ${models.length} ${t("models")}.`;
  } catch (error) {
    modelsStatus.textContent = "";
    $("error").textContent = error.message;
  }
});

document.getElementById("llm-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $("error").textContent = "";
  try {
    await post("/agents/llm-settings", {
      llmMode: "copilot-sdk",
      llmModel: form.get("llmModel") || null,
      githubToken: form.get("githubToken") || null
    });
    await refreshLlmSettings();
  } catch (error) {
    $("error").textContent = error.message;
  }
});

function startApp() {
  auth.initialize().then(async () => {
    $("login-screen").hidden = true;
    $("app-shell").hidden = false;
    window.ashraayDashboard.init();
    window.ashraayDashboard.shown();
    window.ashraayHazard.init();
    window.ashraayPeople.init(load);
    window.ashraayWeather.init();
    document.querySelector('.nav [data-go="people"]').hidden = !auth.hasRole("incident-commander", "verifier");
    $("db-hazard-card").classList.toggle("hidden", !auth.hasRole("incident-commander", "verifier"));
    const identity = auth.identity();
    const roleLabel = (role) => t(auth.roleLabel(role));
    auth.rewriteAppLinks();
    $("identity").textContent = `${identity.preferred_username || identity.sub} · ${auth.roles().map(roleLabel).join(", ")}`;
    document.querySelector('[data-action="reset"]').disabled = !auth.hasRole("platform-admin");
    const isPlatformAdmin = auth.hasRole("platform-admin");
    $("llm-settings-card").classList.toggle("hidden", !isPlatformAdmin);
    if (isPlatformAdmin) await refreshLlmSettings();
    $("alert-form").classList.toggle("hidden", !auth.hasRole("incident-commander"));
    await load();
    document.addEventListener("ashraay:language-change", () => {
      showScreen(currentScreen);
      $("identity").textContent = `${identity.preferred_username || identity.sub} · ${auth.roles().map(roleLabel).join(", ")}`;
      load().catch((error) => { $("error").textContent = error.message; });
    });
    setInterval(() => load().catch((error) => { $("error").textContent = error.message; }), 4000);
  }).catch((error) => {
    $("login-error").textContent = error.message;
    $("error").textContent = error.message;
    const button = $("login-signin");
    if (button) { button.disabled = false; $("login-signin-label").textContent = t("Sign in"); }
  });
}

// Citizen/volunteer accounts have no Command Center permissions, so they are pointed to the mobile app.
function signedIn() {
  if (!auth.isLocalSession() || auth.hasRole("incident-commander", "verifier", "platform-admin")) { startApp(); return; }
  auth.clearSession();
  const message = $("login-error");
  message.textContent = `${t("Signed in. Citizen and volunteer accounts use the ASHRAAY mobile app.")} `;
  const link = document.createElement("a");
  link.href = `${location.protocol}//${location.hostname}:5174/`;
  link.textContent = t("Open the mobile app");
  message.append(link);
}

if (auth.hasCallback()) {
  $("login-signin-label").textContent = t("Signing in…");
  $("login-signin").disabled = true;
  startApp();
} else {
  window.ashraayLogin.init({ onSignedIn: signedIn, onSso: startApp });
  document.querySelector('.login-roles [data-role="staff"]')?.click();
  if (auth.restoreSession()) signedIn();
}
