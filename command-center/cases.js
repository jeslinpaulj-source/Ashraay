(function (global) {
  "use strict";
  const auth = global.ashraayAuth;
  const t = (value) => global.ashraayI18n.t(value);
  const html = auth.escapeHtml;
  const text = (value) => html(t(value));
  let state;
  const statusText = (status) => ({
    received: t("Received"), needs_review: t("Under review"),
    field_check_requested: t("Field check requested"), verified: t("Verified"),
    dismissed: t("Dismissed"), consent_withdrawn: t("Consent withdrawn")
  }[status] || t(status));
  const fact = (label, value) => `<dt>${text(label)}</dt><dd>${html(value ?? "-")}</dd>`;
  function reportDetails(report) {
    return `<section class="evidence"><h3>${html(report.caseId)} · ${html(report.landmark)}</h3>
      <p>${html(report.description)}</p><dl class="case-facts">
      ${fact("Status", statusText(report.status))}${fact("Source", report.source)}
      ${fact("People needing help", report.people)}${fact("Incident type", report.incidentType)}
      ${fact("Requested needs", (report.needs || []).join(", ") || "-")}
      ${fact("Received at", report.time)}${fact("Consent", report.consentWithdrawnAt ? t("Withdrawn") : t(report.consent ? "Granted" : "Not granted"))}
      ${fact("Location", report.latitude != null && report.longitude != null ? `${report.latitude}, ${report.longitude}` : t("Not shared"))}
      </dl></section>`;
  }
  function incidentDetails(incident) {
    if (!incident) return `<p class="note">${text("Awaiting A1 processing. Evidence is not verified; help cannot be approved yet.")}</p>`;
    const reports = state.reports.filter((report) => incident.reportIds.includes(report.id));
    return `<h3>${html(incident.landmark)}</h3><dl class="case-facts">
      ${fact("Incident status", statusText(incident.status))}${fact("Severity", t(incident.severity))}
      ${fact("Confidence", `${Math.round(incident.confidence * 100)}%`)}
      ${fact("Confidence basis", incident.confidenceBasis)}
      </dl>${reports.map(reportDetails).join("")}`;
  }
  function factList(alert) {
    return `<dl class="case-facts">${fact("Area", alert.place)}${fact("Language", alert.language)}</dl>`;
  }
  function planEvidence(plan) {
    const incident = state.incidents.find((item) => item.id === plan.incidentId);
    const forecast = state.forecasts.find((item) => item.id === plan.sourceId);
    const holds = (state.reservations || []).filter((item) => item.planId === plan.planId && item.revision === plan.revision);
    return `<dl class="case-facts">${fact("Plan ID", plan.planId)}${fact("Revision", plan.revision)}
      ${fact("Status", t(plan.status))}${fact("Created at", plan.createdAt)}
      ${fact("Confidence", `${Math.round(plan.confidence * 100)}%`)}
      ${fact("Model version", plan.modelVersion)}${fact("Trace ID", plan.traceId)}
      ${fact("Evidence references", (plan.evidenceRefs || []).join(", "))}
      ${fact("Assumptions", (plan.assumptions || []).join(" "))}
      ${fact("Reserved resources", (plan.heldResources || []).join(", ") || "-")}
      ${fact("Unmet resources", (plan.unmetNeeds || []).join(", ") || "-")}</dl>
      ${holds.map((hold) => `<p>${html(hold.resourceName || hold.resourceId)} · ${html(hold.status)} · ${html(hold.expiresAt || "")}</p>`).join("")}
      ${incident ? incidentDetails(incident) : ""}
      ${forecast ? `<h3>${text("Forecast evidence")}</h3><dl class="case-facts">
        ${fact("Area", forecast.place)}${fact("Source", forecast.source)}
        ${fact("Rainfall (mm)", forecast.rainfallMm)}${fact("River level (m)", forecast.riverLevelM)}
        ${fact("Risk", t(forecast.risk))}${fact("Received at", forecast.time)}</dl>` : ""}
      ${plan.alert ? `<h3>${text("Alert message")}</h3><p>${html(plan.alert.message)}</p>${factList(plan.alert)}` : ""}
      ${plan.decision ? `<h3>${text("Recorded decision")}</h3><p>${html(plan.decision.action)} · ${html(plan.decision.reason)} · ${html(plan.decision.actor)} · ${html(plan.decision.time)}</p>` : ""}
      ${plan.status === "expired" ? `<p class="flag">${text("This plan expired. It cannot be approved; a current proposal is required.")}</p>` : ""}`;
  }
  function update(next) {
    state = next;
  }
  // No popups: incident review is decided directly from inline Approve/Discard buttons on the
  // Dashboard's incident list and the Decision Gate's review queue (see dashboard.js / app.js).
  // This module only keeps the read-only evidence-detail renderers those lists expand inline.
  global.ashraayCases = {
    update,
    planDetails: (plan) => `<details class="case-inline" data-case-key="plan-${html(plan.id)}"><summary>${text("Evidence and decision details")}</summary>${planEvidence(plan)}</details>`,
    reviewDetails: (review) => {
      const incident = state.incidents.find((item) => item.id === review.incidentId);
      return `<h3>${html(incident?.landmark || review.incidentId)}</h3><details class="case-inline" data-case-key="review-${html(review.id)}"><summary>${text("Evidence and decision details")}</summary>${incidentDetails(incident)}</details>`;
    }
  };
})(window);
