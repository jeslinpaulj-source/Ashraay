// Command Center hazard prediction + volunteer dispatch: Agent 1 (predict), Agent 2 (consolidate), Agent 3 (dispatch).
(function (global) {
  const auth = global.ashraayAuth;
  const t = global.ashraayI18n.t;
  const html = auth.escapeHtml;
  const $ = (id) => document.getElementById(id);

  const STATUS_LABEL = {
    pending: "Awaiting analysis",
    analysed: "Analysed - ready to check volunteers",
    dispatched: "Sent to all users and volunteers",
    resolved: "Volunteers confirmed",
    volunteers_exhausted: "Sent to all users and volunteers",
    ignored: "Ignored"
  };

  // The feed ranks every source in the ASHRAAY Hazard Simulator (ashraay-sim).
  let simFeed = null;
  let simFeedError = "";
  let autoRun = { running: false, scans: 0 };
  let renderedAutoRun = "";

  async function refreshSimFeed() {
    try {
      const payload = await auth.request("/simulator/sim-feed");
      if (JSON.stringify(payload) === JSON.stringify(simFeed)) return;
      simFeed = payload;
      simFeedError = "";
    } catch (error) {
      simFeed = null;
      simFeedError = error.message || "The ASHRAAY Hazard Simulator is not reachable.";
    }
    renderSimNote();
  }

  async function refreshAutoRun() {
    try {
      const status = await auth.request("/hazards/auto-run");
      if (JSON.stringify(status) === renderedAutoRun) return;
      autoRun = status;
      renderedAutoRun = JSON.stringify(status);
    } catch (error) {
      $("error").textContent = error.message;
      return;
    }
    renderAutoRunButton();
  }

  function renderAutoRunButton() {
    const button = $("db-hazard-scan");
    if (!button) return;
    const running = !!autoRun.running;
    button.textContent = t(running ? "Stop agents" : "Start Agents 1, 2 & 3");
    button.classList.toggle("pri", !running);
    button.classList.toggle("danger", running);
    button.dataset.action = running ? "hazard-auto-stop" : "hazard-auto-start";
    const status = $("db-hazard-run-status");
    if (!status) return;
    if (!running) {
      status.innerHTML = autoRun.stoppedAt
        ? `<p class="muted small">${autoRun.scans} ${html(t("new simulator input(s) scanned before agents stopped."))}</p>`
        : "";
      return;
    }
    const problem = autoRun.lastError
      ? ` <span class="hz-pill extreme">${html(autoRun.lastError)}</span>`
      : "";
    const last = autoRun.lastTickAt ? new Date(autoRun.lastTickAt).toLocaleTimeString() : "–";
    const simNote = autoRun.simulatorNote ? `<br><span class="muted">${html(t("Hazard Simulator"))}: ${html(autoRun.simulatorNote)}</span>` : "";
    status.innerHTML = `<p class="muted small"><b>${html(t("Agents are live."))}</b> ${html(t("Every 10 seconds they check the Event Simulator, the Hazard Simulator and new citizen reports, then update the alerts and recommendations on the Dashboard."))} ${html(t("Last check"))}: ${html(last)} · ${autoRun.scans} ${html(t("new alert(s) raised"))} · ${autoRun.updates || 0} ${html(t("update(s)"))}.${problem}${simNote}</p>`;
  }

  function renderSimNote() {
    const box = $("db-hazard-sim-note");
    if (!box) return;
    if (!simFeed) {
      box.innerHTML = `<p class="muted small">${html(t(simFeedError || "Waiting for the ASHRAAY Hazard Simulator…"))}</p>`;
      return;
    }
    const source = simFeed.source;
    if (!source) {
      box.innerHTML = `<p class="muted small">${html(t("The simulator is reachable, but its snapshot has no usable sources."))}</p>`;
      return;
    }
    const counts = simFeed.sourceCounts || {};
    const sources = (simFeed.sources || [])
      .map((item) => `<li>${html(item.name || item.id)} <span class="muted">(${html(item.kind || "source")}, ${html(item.place || "")})</span> - ${html(item.status || "")}</li>`)
      .join("");
    box.innerHTML = `<p class="muted small">${html(t("Simulator-wide scan"))}: ${counts.areas || 0} ${html(t("areas"))}, ${counts.stations || 0} ${html(t("river gauges"))}, ${counts.reservoirs || 0} ${html(t("reservoirs"))}. ${html(t("Highest-risk source"))}: ${html(source.name || source.id)} (${html(source.place || "")}). ${html(t("Peak forecast"))} ${simFeed.rainMm} mm / ${simFeed.rainWindowHours} h; ${html(t("Flood risk"))} ${simFeed.floodRiskPct}%; ${html(t("Reservoir"))} ${simFeed.reservoirFillPct}%.</p>
      <ul class="hz-sources">${sources}</ul>`;
  }

  function card(alert) {
    const tierText = { extreme: "Extreme", severe: "Severe", moderate: "Moderate", minor: "Minor" }[alert.tier];
    const severityLabel = t(tierText || alert.severity.charAt(0).toUpperCase() + alert.severity.slice(1));
    const statusText = t(
      alert.dispatchedAt ? "Sent to all users and volunteers"
        : alert.approvalStatus === "awaiting_approval" ? "Waiting for a decision on the Dashboard"
        : alert.approvalStatus === "approved" ? "Approved"
        : alert.approvalStatus === "escalated" ? "Escalated"
        : !alert.approvalStatus ? "Monitoring"
        : STATUS_LABEL[alert.status] || alert.status
    );
    const reasons = (alert.reasons || []).map((reason) => `<li>${html(reason)}</li>`).join("");
    const consolidated = alert.consolidated ? `<ul class="hz-stats">
        <li>${html(t("Incidents reported"))}<b>${alert.consolidated.totalIncidents}</b></li>
        <li>${html(t("Approved/verified"))}<b>${alert.consolidated.approvedIncidents}</b></li>
        <li>${html(t("Pending review"))}<b>${alert.consolidated.pendingReviewIncidents}</b></li>
        <li>${html(t("People reported affected"))}<b>${alert.consolidated.peopleReported}</b></li>
        <li>${html(t("Check-ins needing help"))}<b>${alert.consolidated.checkinsNeedHelp}</b></li>
        <li>${html(t("Volunteers needed"))}<b>${alert.volunteersNeeded ?? "-"}</b></li>
      </ul>` : "";
    const accepted = (alert._acceptedCount ?? 0);
    const a3 = alert.agent3;
    const agent3Block = a3 ? `<ul class="hz-stats hz-agent3">
        <li>${html(t("Volunteer tasks assigned"))}<b>${a3.tasksAssigned}</b></li>
        <li>${html(t("Check-ins answered"))}<b>${a3.checkinsAnswered}</b></li>
        <li>${html(t("Incident reports triaged"))}<b>${a3.incidentsTriaged}</b></li>
        <li>${html(t("Citizen alert published"))}<b>${a3.notice ? t("Yes") : t("No")}</b></li>
      </ul>` : "";
    const replies = alert._replies || { accepted: 0, declined: 0, pending: 0, asked: 0 };
    const dispatched = alert.dispatchedAt
      ? `<p class="muted small">${html(t("Sent to all registered users"))} (${alert.citizenNotice?.recipients ?? 0}) · ${html(t("Volunteers asked"))}: ${replies.asked} · ${html(t("accepted"))} ${replies.accepted} · ${html(t("declined"))} ${replies.declined} · ${html(t("waiting"))} ${replies.pending}</p>`
      : "";
    // Decisions (approve/dispatch, modify, reject, escalate) happen only on the Dashboard.
    const actions = [`<button type="button" class="btn" data-go="dashboard">${t("Decide on the Dashboard")}</button>`];
    return `<div class="hz-card">
      <div class="hz-head"><span class="hz-pill ${html({ extreme: "high", severe: "high", moderate: "medium", minor: "low" }[alert.tier] || alert.severity)}">${html(severityLabel)}</span><b>${html(alert.place)}</b>${alert.llmAssisted ? `<span class="hz-pill sim">${html(t("AI-assisted"))}</span>` : ""}<span class="hz-pill status">${html(statusText)}</span></div>
      <ul class="hz-reasons">${reasons}</ul>
      ${consolidated}
      ${agent3Block}
      ${dispatched}
      <div class="hz-actions">${actions.join("")}</div>
    </div>`;
  }

  function render(state) {
    const box = $("db-hazard-list");
    if (!box) return;
    const alerts = [...(state.hazardAlerts || [])];
    if (!alerts.length) {
      box.innerHTML = `<p class="hz-empty">${html(t("No hazards detected yet. The live agents check every 10 seconds for new simulator inputs and citizen reports."))}</p>`;
      return;
    }
    const requests = state.volunteerRequests || [];
    for (const alert of alerts) {
      const mine = requests.filter((item) => item.hazardAlertId === alert.id);
      alert._acceptedCount = mine.filter((item) => item.status === "accepted").length;
      alert._replies = {
        asked: mine.length,
        accepted: alert._acceptedCount,
        declined: mine.filter((item) => item.status === "declined").length,
        pending: mine.filter((item) => item.status === "pending").length
      };
    }
    alerts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    box.innerHTML = alerts.map(card).join("");
  }

  function init() {
    refreshSimFeed();
    refreshAutoRun();
    setInterval(refreshSimFeed, 10000);
    setInterval(refreshAutoRun, 5000);
    $("db-city")?.addEventListener("change", () => {
      refreshSimFeed();
    });
  }

  global.ashraayHazard = { init, render, refreshAutoRun };
})(window);
