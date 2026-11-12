// People & Check-ins screen: latest status per person, map, history, staff status actions and gated contact access.
(function (global) {
  const auth = global.ashraayAuth;
  const t = global.ashraayI18n.t;
  const html = auth.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const tf = (key, ...args) => t(key).replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match);

  const PAGE_SIZE = 10;
  const STATUS = {
    safe: { label: "Safe", color: "#1E9E5A" },
    at_risk: { label: "At Risk", color: "#E08A0B" },
    need_help: { label: "Need Help", color: "#D93025" }
  };
  const DEFAULT_CENTER = [12.9716, 77.5946];

  let people = [];
  let volunteers = [];
  let tab = "live";
  let search = "";
  let page = 1;
  let selectedId = null;
  let detailTab = "details";
  let map;
  let layer;
  let fitted = false;
  const contacts = new Map();

  // Coordinates are turned into a place name with the public OpenStreetMap Nominatim reverse geocoder (cached, 1 request/second).
  const PLACE_KEY = "ashraay.reverseGeocode";
  const places = JSON.parse(localStorage.getItem(PLACE_KEY) || "{}");
  const placeQueue = [];
  let placeBusy = false;
  const coordKey = (item) => `${item.latitude.toFixed(4)},${item.longitude.toFixed(4)}`;
  function placeOf(item) {
    if (!Number.isFinite(item?.latitude) || !Number.isFinite(item?.longitude)) return null;
    const key = coordKey(item);
    if (key in places) return places[key] || null;
    if (!placeQueue.some((entry) => entry.key === key)) placeQueue.push({ key, latitude: item.latitude, longitude: item.longitude });
    pumpPlaces();
    return null;
  }
  async function pumpPlaces() {
    if (placeBusy || !placeQueue.length) return;
    placeBusy = true;
    const { key, latitude, longitude } = placeQueue.shift();
    try {
      const query = new URLSearchParams({ lat: latitude, lon: longitude, format: "json", zoom: "17", addressdetails: "1" });
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${query}`, { headers: { Accept: "application/json" } });
      const address = response.ok ? (await response.json()).address || {} : {};
      const local = address.road || address.neighbourhood || address.suburb || address.quarter || address.village;
      const area = address.suburb && address.suburb !== local ? address.suburb : address.city_district;
      const city = address.city || address.town || address.village || address.county;
      places[key] = [local, area, city].filter((part, index, all) => part && all.indexOf(part) === index).slice(0, 3).join(", ");
      localStorage.setItem(PLACE_KEY, JSON.stringify(places));
      if (places[key]) { renderList(); renderDetail(); renderMap(); }
    } catch (error) {
      console.warn("Reverse geocoding failed", error);
    }
    setTimeout(() => { placeBusy = false; pumpPlaces(); }, 1100);
  }
  const locationText = (item) => placeOf(item) || item.landmark;

  const statusLabel = (status) => t(STATUS[status]?.label || status);
  const pill = (status) => `<span class="db-sev st-${html(status)}">${html(statusLabel(status))}</span>`;
  const displayName = (person) => person?.name || person?.maskedPhone || t("Unregistered person");
  const initials = (person) => (person?.name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const selected = () => people.find((person) => person.personId === selectedId) || null;
  const hasCoords = (item) => Number.isFinite(item?.latitude) && Number.isFinite(item?.longitude);
  function ago(time) {
    const seconds = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
    if (seconds < 60) return t("just now");
    if (seconds < 3600) return tf("{0} min ago", Math.round(seconds / 60));
    if (seconds < 86400) return tf("{0} hr ago", Math.round(seconds / 3600));
    return tf("{0} days ago", Math.round(seconds / 86400));
  }

  function filtered() {
    const needle = search.toLowerCase();
    return people.filter((person) =>
      (tab === "at_risk" ? person.status === "at_risk" : tab === "need_help" ? person.status === "need_help" : true) &&
      (!needle || `${displayName(person)} ${locationText(person)} ${person.landmark} ${person.maskedPhone || ""}`.toLowerCase().includes(needle))
    );
  }

  // ---------- KPIs and 24h trend ----------
  function renderKpis() {
    const total = people.length;
    const count = (status) => people.filter((person) => person.status === status).length;
    for (const status of Object.keys(STATUS)) {
      $(`pc-kpi-${status}`).textContent = count(status);
      $(`pc-kpi-${status}-n`).textContent = tf("{0}% of total", total ? Math.round((count(status) / total) * 100) : 0);
    }
    const all = people.flatMap((person) => person.history);
    const now = Date.now();
    const lastDay = all.filter((item) => now - new Date(item.time) < 86400000).length;
    const dayBefore = all.filter((item) => { const age = now - new Date(item.time); return age >= 86400000 && age < 172800000; }).length;
    $("pc-kpi-total").textContent = all.length;
    $("pc-kpi-total-n").textContent = dayBefore
      ? tf("{0}% from yesterday", `${lastDay >= dayBefore ? "+" : ""}${Math.round(((lastDay - dayBefore) / dayBefore) * 100)}`)
      : tf("{0} in the last 24 hours", lastDay);
    renderTrend(all);
  }

  function renderTrend(all) {
    const width = 420, height = 110, pad = { l: 26, r: 6, t: 6, b: 18 };
    const buckets = 12;
    const start = Date.now() - 86400000;
    const series = Object.fromEntries(Object.keys(STATUS).map((status) => [status, new Array(buckets).fill(0)]));
    for (const item of all) {
      const index = Math.floor((new Date(item.time) - start) / 7200000);
      if (index >= 0 && index < buckets && series[item.status]) series[item.status][index] += 1;
    }
    const max = Math.max(2, ...Object.values(series).flat());
    const x = (index) => pad.l + (index / (buckets - 1)) * (width - pad.l - pad.r);
    const y = (value) => pad.t + (1 - value / max) * (height - pad.t - pad.b);
    const grid = [0, Math.round(max / 2), max].map((value) => `<line class="g" x1="${pad.l}" x2="${width - pad.r}" y1="${y(value)}" y2="${y(value)}"/><text x="${pad.l - 4}" y="${y(value) + 3}" text-anchor="end">${value}</text>`).join("");
    const labels = [0, 3, 6, 9, 11].map((index) => {
      const time = new Date(start + (index + 1) * 7200000);
      return `<text x="${x(index)}" y="${height - 3}" text-anchor="middle">${String(time.getHours()).padStart(2, "0")}:00</text>`;
    }).join("");
    const lines = Object.entries(series).map(([status, values]) =>
      `<path d="${values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("")}" stroke="${STATUS[status].color}" fill="none" stroke-width="2"/>` +
      values.map((value, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="2" fill="${STATUS[status].color}"/>`).join("")
    ).join("");
    $("pc-trend").innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="db-chart" role="img" aria-label="${html(t("Check-in Trend (Last 24 Hours)"))}">${grid}${labels}${lines}</svg>`;
  }

  // ---------- list ----------
  function renderList() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages);
    $("pc-count").textContent = `(${rows.length})`;
    $("pc-rows").innerHTML = rows.length ? rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((person) => `
      <tr class="${person.personId === selectedId ? "sel" : ""}" data-person="${html(person.personId)}" tabindex="0">
        <td><i class="dot ${html(person.status)}"></i> ${html(displayName(person))}${person.escalated ? ` <span class="db-sev sev-high">${html(t("Escalated"))}</span>` : ""}</td>
        <td>${pill(person.status)}</td>
        <td>${hasCoords(person)
          ? `<span class="pc-loc" title="${html(t(person.locationSource === "gps" ? "GPS location" : "Pin placed on map"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 22s7-7.4 7-13a7 7 0 0 0-14 0c0 5.6 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg></span> ${html(placeOf(person) || `${person.latitude.toFixed(4)}, ${person.longitude.toFixed(4)}`)}`
          : html(person.landmark)}</td>
        <td class="nw">${html(ago(person.lastCheckIn))}</td>
        <td aria-hidden="true">&rsaquo;</td>
      </tr>`).join("")
      : `<tr><td colspan="5" class="db-empty">${html(t(people.length ? "No people match this filter." : "No check-ins yet."))}</td></tr>`;
    const first = rows.length ? (page - 1) * PAGE_SIZE + 1 : 0;
    $("pc-page-info").textContent = tf("Showing {0}-{1} of {2}", first, Math.min(page * PAGE_SIZE, rows.length), rows.length);
    $("pc-pages").innerHTML = pages > 1
      ? Array.from({ length: pages }, (_, index) => `<button type="button" data-page="${index + 1}" aria-current="${index + 1 === page}">${index + 1}</button>`).join("")
      : "";
  }

  // ---------- map ----------
  function ensureMap() {
    if (map || !global.L || !$("pc-map")) return Boolean(map);
    map = global.L.map("pc-map").setView(DEFAULT_CENTER, 11);
    global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
    layer = global.L.layerGroup().addTo(map);
    return true;
  }

  function renderMap() {
    if (!ensureMap()) return;
    const L = global.L;
    map.invalidateSize();
    layer.clearLayers();
    const filter = $("pc-map-status").value;
    const shown = people.filter((person) => hasCoords(person) && (filter === "all" || person.status === filter) && $(`pc-show-${person.status}`)?.checked !== false);
    for (const person of shown) {
      const marker = L.circleMarker([person.latitude, person.longitude], {
        radius: person.personId === selectedId ? 11 : 8,
        color: "#fff", weight: 2, fillColor: STATUS[person.status]?.color || "#5B6B7B", fillOpacity: 0.95
      });
      const popup = document.createElement("div");
      popup.className = "db-pop";
      popup.innerHTML = `<b>${html(displayName(person))}</b><span>${pill(person.status)}</span><small>${html(locationText(person))} · ${html(ago(person.lastCheckIn))}</small><button type="button" data-person="${html(person.personId)}">${html(t("View Details"))}</button>`;
      marker.bindPopup(popup);
      marker.addTo(layer);
    }
    if (!fitted && shown.length) {
      fitted = true;
      map.fitBounds(L.latLngBounds(shown.map((person) => [person.latitude, person.longitude])).pad(0.3), { maxZoom: 14 });
    }
    $("pc-map-note").textContent = people.length && !people.some(hasCoords)
      ? t("No check-ins have a GPS or map-pin location yet.")
      : "";
  }

  // ---------- person details ----------
  function renderDetail() {
    const person = selected();
    $("pc-detail").hidden = !person;
    $("pc-detail-empty").hidden = Boolean(person);
    renderAccess();
    if (!person) return;
    $("pc-avatar").textContent = initials(person);
    $("pc-name").innerHTML = `${html(displayName(person))} ${pill(person.status)}`;
    $("pc-place").textContent = locationText(person);
    $("pc-last").textContent = `${t("Last check-in")}: ${ago(person.lastCheckIn)}`;
    document.querySelectorAll("#pc-detail-tabs [data-detail]").forEach((button) =>
      button.setAttribute("aria-selected", String(button.dataset.detail === detailTab)));
    const contact = contacts.get(person.personId);
    let body = "";
    if (detailTab === "details") {
      body = `<h3>${html(t("Contact Information"))}</h3>${contact
        ? `<p><a href="tel:${html(contact.phone.replace(/\s/g, ""))}">${html(contact.phone)}</a><br><a href="mailto:${html(contact.email)}">${html(contact.email)}</a></p>`
        : `<p class="muted small">${html(t("Contact details are protected. Use Citizen Data Access below to view them."))}</p>`}
        <h3>${html(t("Additional Information"))}</h3>
        <dl class="pc-facts">
          <dt>${html(t("Account type"))}</dt><dd>${html(t(person.accountType === "volunteer" ? "Volunteer" : person.accountType === "citizen" ? "Citizen" : person.accountType || "Unknown"))}</dd>
          <dt>${html(t("Masked phone"))}</dt><dd>${html(person.maskedPhone || "-")}</dd>
          <dt>${html(t("Check-ins"))}</dt><dd>${person.history.length}</dd>
          <dt>${html(t("Escalated"))}</dt><dd>${html(t(person.escalated ? "Yes" : "No"))}</dd>
        </dl>`;
    } else if (detailTab === "location") {
      body = `<dl class="pc-facts">
          <dt>${html(t("Place (from map)"))}</dt><dd>${hasCoords(person) ? html(placeOf(person) || t("Looking up…")) : html(t("Not shared"))}</dd>
          <dt>${html(t("Typed landmark"))}</dt><dd>${html(person.landmark)}</dd>
          <dt>${html(t("Coordinates"))}</dt><dd>${hasCoords(person) ? `${person.latitude.toFixed(5)}, ${person.longitude.toFixed(5)}` : html(t("Not shared"))}</dd>
          <dt>${html(t("Source"))}</dt><dd>${html(t(person.locationSource === "gps" ? "GPS location" : person.locationSource === "map" ? "Pin placed on map" : "Landmark only"))}${person.accuracyM != null ? ` · ±${Math.round(person.accuracyM)} m` : ""}</dd>
        </dl>${hasCoords(person) ? `<button type="button" class="db-link" data-focus-map>${html(t("Show on map"))}</button>` : ""}`;
    } else {
      body = `<ol class="pc-history">${person.history.map((item) => `
          <li>${pill(item.status)} <small>${html(ago(item.time))} · ${html(item.landmark)}</small>${item.source === "staff" ? `<small class="muted">${html(t("Updated by staff"))}: ${html(item.note || "")}</small>` : ""}</li>`).join("")}</ol>`;
    }
    $("pc-detail-body").innerHTML = body;
    const canAct = auth.hasRole("incident-commander");
    $("pc-actions").hidden = !canAct;
    $("pc-send-response").disabled = !person || !["at_risk", "need_help"].includes(person.status);
  }

  function renderAccess() {
    const person = selected();
    $("pc-access-who").textContent = person
      ? `${t("Selected person")}: ${displayName(person)}`
      : t("Select a person from the list to request their contact details.");
    $("pc-access-form").querySelector("button").disabled = !person;
  }

  // ---------- volunteers & activity ----------
  function renderVolunteers() {
    const byArea = new Map();
    for (const volunteer of volunteers) {
      if (volunteer.status === "withdrawn" || volunteer.status === "rejected") continue;
      const area = volunteer.area || t("Unknown");
      const row = byArea.get(area) || { total: 0, available: 0 };
      row.total += 1;
      if (volunteer.status === "verified" && volunteer.available) row.available += 1;
      byArea.set(area, row);
    }
    $("pc-volunteers").innerHTML = byArea.size
      ? [...byArea.entries()].sort((a, b) => b[1].total - a[1].total).map(([area, row]) =>
        `<tr><td>${html(area)}</td><td>${row.total}</td><td class="ok-text">${row.available}</td></tr>`).join("")
      : `<tr><td colspan="3" class="db-empty">${html(t("No volunteers registered yet."))}</td></tr>`;
  }

  function renderActivity() {
    const events = people.flatMap((person) => person.history.map((item) => ({ person, item })))
      .sort((a, b) => new Date(b.item.time) - new Date(a.item.time)).slice(0, 8);
    $("pc-activity").innerHTML = events.length ? events.map(({ person, item }) => `
      <li><i class="dot ${html(item.status)}"></i><span>${html(item.source === "staff"
        ? tf("{0} marked as", displayName(person))
        : tf("{0} checked in as", displayName(person)))} ${pill(item.status)}</span><small>${html(ago(item.time))}</small></li>`).join("")
      : `<li class="db-empty">${html(t("No check-ins yet."))}</li>`;
  }

  function renderAll() {
    renderKpis();
    renderList();
    renderMap();
    renderDetail();
    renderVolunteers();
    renderActivity();
  }

  // ---------- data ----------
  async function refresh(state) {
    if (!auth.hasRole("incident-commander", "verifier")) return;
    volunteers = state?.volunteers || volunteers;
    people = await auth.request("/people");
    if (selectedId && !selected()) selectedId = null;
    renderAll();
  }

  async function act(status, escalate) {
    const person = selected();
    if (!person) return;
    const reason = prompt(t("Record the reason for this status change (at least 5 characters):"));
    if (!reason || reason.trim().length < 5) return;
    await auth.postJson(`/people/${encodeURIComponent(person.personId)}/status`, { status, escalate, reason: reason.trim() });
    await refresh();
  }

  function exportCsv() {
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [["Name", "Masked phone", "Status", "Place (from map)", "Typed landmark", "Latitude", "Longitude", "Location source", "Last check-in", "Escalated"]]
      .concat(filtered().map((person) => [person.name || "", person.maskedPhone || "", person.status, placeOf(person) || "", person.landmark,
        person.latitude ?? "", person.longitude ?? "", person.locationSource || "", person.lastCheckIn, person.escalated]));
    const blob = new Blob([lines.map((line) => line.map(quote).join(",")).join("\r\n")], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ashraay-checkins-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function select(personId) {
    selectedId = personId;
    detailTab = "details";
    renderList();
    renderMap();
    renderDetail();
  }

  function init(onChange) {
    $("pc-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button) return;
      document.querySelectorAll("#pc-tabs [data-tab]").forEach((other) => other.setAttribute("aria-selected", String(other === button)));
      if (button.dataset.tab === "volunteers") { $("pc-volunteers-card").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      if (button.dataset.tab === "access") { $("pc-access-card").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      tab = button.dataset.tab;
      page = 1;
      renderList();
    });
    $("pc-search").addEventListener("input", (event) => { search = event.target.value.trim(); page = 1; renderList(); });
    $("pc-pages").addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (button) { page = Number(button.dataset.page); renderList(); }
    });
    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-person]");
      if (target && target.closest('[data-screen="people"]')) select(target.dataset.person);
      if (event.target.closest("[data-focus-map]") && selected()) {
        map?.setView([selected().latitude, selected().longitude], 16);
        $("pc-map").scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    $("pc-rows").addEventListener("keydown", (event) => {
      const row = event.target.closest("[data-person]");
      if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(row.dataset.person); }
    });
    $("pc-detail-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-detail]");
      if (button) { detailTab = button.dataset.detail; renderDetail(); }
    });
    $("pc-detail-close").addEventListener("click", () => select(null));
    $("pc-map-status").addEventListener("change", renderMap);
    Object.keys(STATUS).forEach((status) => $(`pc-show-${status}`).addEventListener("change", renderMap));
    $("pc-export").addEventListener("click", exportCsv);
    const guard = (fn) => async () => {
      $("error").textContent = "";
      try { await fn(); } catch (error) { $("error").textContent = error.message; }
    };
    $("pc-mark-safe").addEventListener("click", guard(() => act("safe", false)));
    $("pc-mark-risk").addEventListener("click", guard(() => act("at_risk", false)));
    $("pc-escalate").addEventListener("click", guard(() => act("need_help", true)));
    $("pc-send-response").addEventListener("click", guard(async () => {
      const person = selected();
      if (!person) return;
      const button = $("pc-send-response");
      button.disabled = true;
      try {
        await auth.postJson(`/people/${encodeURIComponent(person.personId)}/response`, {});
        await onChange();
      } finally {
        button.disabled = !["at_risk", "need_help"].includes(selected()?.status);
      }
    }));
    $("pc-access-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const person = selected();
      const form = event.currentTarget;
      const status = $("pc-access-status");
      if (!person) return;
      status.textContent = "";
      try {
        const contact = await auth.postJson(`/people/${encodeURIComponent(person.personId)}/contact`, {
          password: form.elements.password.value,
          reason: form.elements.reason.value.trim()
        });
        contacts.set(person.personId, contact);
        form.reset();
        detailTab = "details";
        renderDetail();
        status.textContent = t("Access granted. This access has been recorded in the audit trail.");
      } catch (error) {
        form.elements.password.value = "";
        status.textContent = t(error.message);
      }
    });
    document.addEventListener("ashraay:language-change", renderAll);
  }

  function shown() {
    if (ensureMap()) setTimeout(() => map.invalidateSize(), 0);
  }

  // Unlocked contact details are kept only in memory and dropped when leaving the screen.
  function hidden() {
    contacts.clear();
  }

  global.ashraayPeople = { init, refresh, shown, hidden };
})(window);
