// Command Center dashboard: KPIs, incident queue, live map, public weather/air-quality data and 72h risk outlook.
(function (global) {
  const auth = global.ashraayAuth;
  const t = global.ashraayI18n.t;
  const html = auth.escapeHtml;
  const $ = (id) => document.getElementById(id);

  const CITIES = {
    bengaluru: { name: "Bengaluru", region: "Bangalore, KA", lat: 12.9716, lon: 77.5946 },
    kochi: { name: "Kochi", region: "Kochi, KL", lat: 9.9312, lon: 76.2673 },
    thiruvananthapuram: { name: "Thiruvananthapuram", region: "Thiruvananthapuram, KL", lat: 8.5241, lon: 76.9366 },
    chennai: { name: "Chennai", region: "Chennai, TN", lat: 13.0827, lon: 80.2707 },
    mumbai: { name: "Mumbai", region: "Mumbai, MH", lat: 19.076, lon: 72.8777 },
    delhi: { name: "New Delhi", region: "New Delhi, DL", lat: 28.6139, lon: 77.209 },
    kolkata: { name: "Kolkata", region: "Kolkata, WB", lat: 22.5726, lon: 88.3639 }
  };
  const WEATHER_REFRESH_MS = 60 * 1000;
  const GEOCODE_KEY = "ashraay.geocode";

  let cityId = localStorage.getItem("ashraay.dashboard.city");
  if (!CITIES[cityId]) cityId = "bengaluru";
  let lastState = null;
  let weather = null;
  let air = null;
  let weatherError = "";
  let weatherTimer;
  let queueFilter = "all";
  let queueSearch = "";
  let aiFilter = "all";
  let aiIndex = 0;
  let aiModifyId = null;
  const aiEdits = {};
  let hrIndex = 0;
  let aiSelectedId = null;
  let hrSelectedId = null;
  let aiAuditOpen = null;
  let map;
  let markerLayer;
  let baseLayers;
  const geocodeCache = JSON.parse(localStorage.getItem(GEOCODE_KEY) || "{}");
  const geocodeQueue = [];
  let geocoding = false;

  const city = () => CITIES[cityId];
  const tf = (key, ...args) => t(key).replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match);
  const LOCALES = { en: "en-IN", hi: "hi-IN", ta: "ta-IN", ml: "ml-IN", kn: "kn-IN" };
  const cityName = (item = city()) => t(item.name);
  function renderCityLabels() {
    $("db-city").innerHTML = Object.entries(CITIES).map(([id, item]) => `<option value="${id}">${html(cityName(item))}</option>`).join("");
    $("db-city").value = cityId;
    $("db-weather-city").textContent = cityName();
  }
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function ago(time) {
    const seconds = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
    if (seconds < 60) return t("just now");
    if (seconds < 3600) return tf("{0} min ago", Math.round(seconds / 60));
    if (seconds < 86400) return tf("{0} hr ago", Math.round(seconds / 3600));
    return tf("{0} days ago", Math.round(seconds / 86400));
  }

  // ---------- icons ----------
  const svg = (body, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    flood: '<path d="M2 18c2 0 2-1.5 4-1.5S8 18 10 18s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M4 13 12 6l8 7"/><path d="M6 12v3M18 12v3"/>',
    "heavy-rain": '<path d="M7 15a4 4 0 1 1 1-7.9A5 5 0 0 1 18 9a3 3 0 0 1 0 6z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    landslide: '<path d="M3 20h18L14 8l-4 6-3-3z"/><circle cx="16" cy="5" r="1.5"/>',
    other: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16h.01"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M22 20c0-2.8-1.8-4.6-4-5.2"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>',
    team: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.2"/><circle cx="19" cy="10" r="2.2"/><path d="M7 20c0-3 2.2-5 5-5s5 2 5 5M1.5 19c0-2.2 1.6-3.8 3.5-3.8M22.5 19c0-2.2-1.6-3.8-3.5-3.8"/>',
    warn: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>',
    leaf: '<path d="M5 19c0-8 6-14 15-14 0 9-6 15-14 15"/><path d="M5 19 13 11"/>',
    waves: '<path d="M2 8c2 0 2-1.5 4-1.5S8 8 10 8s2-1.5 4-1.5S16 8 18 8s2-1.5 4-1.5M2 13c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5M2 18c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>'
  };
  const icon = (name, cls) => svg(ICONS[name] || ICONS.other, cls);
  function weatherIcon(code, cls = "") {
    const cloud = '<path d="M7 17a4 4 0 1 1 1-7.9A5 5 0 0 1 18 11a3 3 0 0 1 0 6z"/>';
    if (code === 0) return svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', `wx sun ${cls}`);
    if (code <= 3) return svg('<circle cx="8" cy="8" r="3"/><path d="M8 2v1M2 8h1M3.8 3.8l.7.7"/>' + cloud, `wx ${cls}`);
    if (code === 45 || code === 48) return svg('<path d="M4 9h16M2 13h20M4 17h16"/>', `wx ${cls}`);
    if (code >= 95) return svg(cloud + '<path d="m12 14-2 4h3l-2 4"/>', `wx storm ${cls}`);
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return svg('<path d="M7 14a4 4 0 1 1 1-7.9A5 5 0 0 1 18 8a3 3 0 0 1 0 6z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>', `wx rain ${cls}`);
    return svg(cloud, `wx ${cls}`);
  }
  function weatherLabel(code) {
    if (code === 0) return "Clear sky";
    if (code <= 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code >= 51 && code <= 57) return "Drizzle";
    if (code === 61 || code === 80) return "Light rain";
    if (code === 63 || code === 81) return "Moderate rain";
    if (code === 65 || code === 82) return "Heavy rain";
    if (code >= 71 && code <= 77) return "Snow";
    if (code >= 95) return "Thunderstorm";
    return "Cloudy";
  }

  // ---------- data shaping ----------
  function incidentType(incident, state) {
    const report = state.reports.find((item) => incident.reportIds?.includes(item.id));
    return report?.incidentType || "flood";
  }
  function reportCoords(reports) {
    const located = reports.find((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
    return located ? [located.latitude, located.longitude] : null;
  }
  const bucket = (status) => ({
    received: "unreviewed", needs_review: "unreviewed",
    verified: "progress", field_check_requested: "progress",
    resolved: "resolved", dismissed: "resolved"
  })[status] || "progress";

  function queueItems(state) {
    const items = state.incidents.map((incident) => {
      const reports = state.reports.filter((item) => incident.reportIds?.includes(item.id));
      return {
        key: incident.id,
        reportId: reports[0]?.id,
        title: incident.summary,
        landmark: incident.landmark,
        type: incidentType(incident, state),
        severity: incident.status === "dismissed" ? "low" : incident.severity === "high" ? "high" : "medium",
        status: incident.status,
        bucket: bucket(incident.status),
        time: incident.time,
        coords: reportCoords(reports),
        people: incident.reportedPeople
      };
    });
    for (const report of state.reports) {
      if (report.incidentId || report.status !== "received") continue;
      items.push({
        key: report.id, reportId: report.id, title: report.description, landmark: report.landmark,
        type: report.incidentType || "flood", severity: report.people > 0 ? "high" : "medium",
        status: "received", bucket: "unreviewed", time: report.time || report.receivedAt,
        coords: reportCoords([report]), people: report.people
      });
    }
    return items.sort((a, b) => new Date(b.time) - new Date(a.time));
  }

  // ---------- KPIs ----------
  function renderKpis(state, items) {
    const active = items.filter((item) => item.bucket !== "resolved");
    const hourAgo = Date.now() - 3600000;
    const newLastHour = active.filter((item) => new Date(item.time).getTime() >= hourAgo).length;
    const checkins = state.checkins || [];
    const count = (status) => checkins.filter((item) => item.status === status).length;
    const needHelp = count("need_help");
    const reportedPeople = active.reduce((sum, item) => sum + (item.people || 0), 0);
    const teams = (state.resources || []).filter((item) => item.kind === "response-team");
    const busyTeams = new Set((state.reservations || [])
      .filter((item) => ["held", "committed"].includes(item.status)).map((item) => item.resourceId));
    const activeTeams = teams.filter((item) => busyTeams.has(item.id) || item.status !== "available").length;

    $("db-kpi-incidents").textContent = active.length;
    $("db-kpi-incidents-n").textContent = tf("+{0} in the last hour", newLastHour);
    $("db-kpi-help").textContent = reportedPeople + needHelp;
    $("db-kpi-help-n").textContent = tf("{0} check-ins need help", needHelp);
    $("db-kpi-safe").textContent = count("safe");
    $("db-kpi-safe-n").textContent = tf("{0}% of check-ins", pct(count("safe"), checkins.length));
    $("db-kpi-teams").textContent = activeTeams;
    $("db-kpi-teams-n").textContent = tf("of {0} teams deployed", teams.length);
  }

  // ---------- queue ----------
  function renderQueue(items) {
    const counts = { all: items.length, unreviewed: 0, progress: 0, resolved: 0 };
    items.forEach((item) => { counts[item.bucket] += 1; });
    document.querySelectorAll("#db-queue-tabs [data-filter]").forEach((button) => {
      button.querySelector("b").textContent = counts[button.dataset.filter];
      button.setAttribute("aria-selected", String(button.dataset.filter === queueFilter));
    });
    const needle = queueSearch.toLowerCase();
    const shown = items.filter((item) =>
      (queueFilter === "all" || item.bucket === queueFilter) &&
      (!needle || `${item.title} ${item.landmark}`.toLowerCase().includes(needle))
    );
    const canDecide = auth.hasRole("incident-commander", "verifier");
    $("db-queue").innerHTML = shown.length ? shown.slice(0, 8).map((item) => {
      const decidable = canDecide && item.bucket === "unreviewed" && item.reportId;
      return `
      <li>
        <div class="db-q">
          <span class="db-q-ic sev-${item.severity}">${icon(item.type)}</span>
          <span class="db-q-body"><b>${html(item.title)}</b><small>${html(item.landmark)}</small></span>
          <span class="db-q-meta"><small>${html(ago(item.time))}</small><span class="db-sev sev-${item.severity}">${html(t(item.severity === "medium" ? "Medium" : item.severity === "high" ? "High" : "Low"))}</span></span>
        </div>
        ${decidable ? `<div class="db-q-actions"><button type="button" data-action="report-approve" data-id="${html(item.reportId)}">${html(t("Approve"))}</button><button type="button" class="danger" data-action="report-discard" data-id="${html(item.reportId)}">${html(t("Discard"))}</button></div>` : ""}
        ${auth.hasRole("incident-commander") && item.reportId && item.bucket !== "resolved" ? `<div class="db-q-actions"><button type="button" data-action="report-response" data-id="${html(item.reportId)}">${html(t("Send to Response"))}</button></div>` : ""}
      </li>`;
    }).join("")
      : `<li class="db-empty">${html(t(items.length ? "No incidents match this filter." : "No incident reports yet."))}</li>`;
  }

  // ---------- map ----------
  function ensureMap() {
    if (map || !global.L || !$("db-map")) return Boolean(map);
    const L = global.L;
    baseLayers = {
      map: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
      }),
      satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, attribution: "Imagery &copy; Esri"
      }),
      terrain: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        maxZoom: 17, attribution: "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap"
      })
    };
    map = L.map("db-map", { zoomControl: true, layers: [baseLayers.map] }).setView([city().lat, city().lon], 11);
    L.control.scale({ metric: true, imperial: false }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    document.querySelectorAll("#db-map-layers [data-layer]").forEach((button) => {
      button.addEventListener("click", () => {
        Object.values(baseLayers).forEach((layer) => map.removeLayer(layer));
        baseLayers[button.dataset.layer].addTo(map);
        document.querySelectorAll("#db-map-layers [data-layer]").forEach((other) =>
          other.setAttribute("aria-pressed", String(other === button)));
      });
    });
    $("db-map-full").addEventListener("click", () => {
      $("db-map-card").classList.toggle("db-full");
      setTimeout(() => map.invalidateSize(), 50);
    });
    return true;
  }

  // Free-text landmarks are resolved with the public OpenStreetMap Nominatim geocoder (cached, 1 request/second).
  function geocode(landmark) {
    const key = `${cityId}:${landmark.toLowerCase()}`;
    if (key in geocodeCache) return geocodeCache[key];
    if (!geocodeQueue.some((item) => item.key === key)) geocodeQueue.push({ key, landmark });
    pumpGeocoder();
    return null;
  }
  async function pumpGeocoder() {
    if (geocoding || !geocodeQueue.length) return;
    geocoding = true;
    const { key, landmark } = geocodeQueue.shift();
    try {
      const query = new URLSearchParams({ q: `${landmark}, ${city().name}, India`, format: "json", limit: "1" });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, { headers: { Accept: "application/json" } });
      const found = response.ok ? await response.json() : [];
      geocodeCache[key] = found[0] ? [Number(found[0].lat), Number(found[0].lon)] : false;
      localStorage.setItem(GEOCODE_KEY, JSON.stringify(geocodeCache));
      if (found[0] && lastState) renderMap(queueItems(lastState));
    } catch (error) {
      console.warn("Geocoding failed", error);
    }
    setTimeout(() => { geocoding = false; pumpGeocoder(); }, 1100);
  }

  function renderMap(items) {
    if (!ensureMap()) return;
    const L = global.L;
    markerLayer.clearLayers();
    const showConfirmed = $("db-show-confirmed").checked;
    const showUnconfirmed = $("db-show-unconfirmed").checked;
    let placed = 0;
    for (const item of items) {
      if (item.bucket === "resolved") continue;
      const confirmed = item.status === "verified";
      if (confirmed ? !showConfirmed : !showUnconfirmed) continue;
      const coords = item.coords || geocode(item.landmark);
      if (!coords) continue;
      placed += 1;
      const marker = L.marker(coords, {
        icon: L.divIcon({
          className: "",
          html: `<span class="db-pin sev-${item.severity}${confirmed ? " confirmed" : " unconfirmed"}">${icon(item.type)}</span>`,
          iconSize: [30, 38], iconAnchor: [15, 36], popupAnchor: [0, -32]
        }),
        title: item.title,
        zIndexOffset: confirmed ? 1000 : 0
      });
      const popup = document.createElement("div");
      popup.className = "db-pop";
      const decidable = item.bucket === "unreviewed" && item.reportId && auth.hasRole("incident-commander", "verifier");
      popup.innerHTML = `<b>${html(item.title)}</b><small>${html(item.landmark)} · ${html(ago(item.time))}</small><span><span class="db-sev sev-${item.severity}">${html(t(item.severity === "high" ? "High" : "Medium"))}</span> <span class="db-sev ${confirmed ? "st-safe" : "st-at_risk"}">${html(t(confirmed ? "Confirmed" : "Awaiting confirmation"))}</span></span>${decidable ? `<div class="db-q-actions"><button type="button" data-action="report-approve" data-id="${html(item.reportId)}">${html(t("Approve"))}</button><button type="button" class="danger" data-action="report-discard" data-id="${html(item.reportId)}">${html(t("Discard"))}</button></div>` : ""}`;
      marker.bindPopup(popup);
      if (confirmed && item.severity === "high") L.circle(coords, { radius: 600, color: "#D93025", weight: 1, fillOpacity: 0.12 }).addTo(markerLayer);
      marker.addTo(markerLayer);
    }
    if ($("db-show-checkins").checked) {
      const colors = { safe: "#1E9E5A", at_risk: "#E08A0B", need_help: "#D93025" };
      const labels = { safe: "Safe", at_risk: "At Risk", need_help: "Need Help" };
      for (const checkin of lastState?.checkins || []) {
        if (!Number.isFinite(checkin.latitude) || !Number.isFinite(checkin.longitude) || !colors[checkin.status]) continue;
        placed += 1;
        const dot = L.circleMarker([checkin.latitude, checkin.longitude], {
          radius: 8, color: "#fff", weight: 2, fillColor: colors[checkin.status], fillOpacity: 0.95
        });
        const source = checkin.locationSource === "gps"
          ? `${t("GPS location")}${checkin.accuracyM != null ? ` · ±${Math.round(checkin.accuracyM)} m` : ""}`
          : t("Pin placed on map");
        const popup = document.createElement("div");
        popup.className = "db-pop";
        popup.innerHTML = `<b>${html(t("Check-in"))}: ${html(t(labels[checkin.status]))}</b><small>${html(checkin.landmark)} · ${html(ago(checkin.time))}</small><small>${html(source)}</small>`;
        dot.bindPopup(popup);
        dot.addTo(markerLayer);
      }
    }
    $("db-map-note").textContent = placed ? "" : t("No incidents with a known location for the selected filters.");
  }

  // ---------- weather (Open-Meteo, no API key) ----------
  async function loadWeather() {
    const { lat, lon } = city();
    const forecast = new URLSearchParams({
      latitude: lat, longitude: lon, timezone: "auto", forecast_days: "4",
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,weather_code,visibility,precipitation_probability",
      hourly: "temperature_2m,precipitation,precipitation_probability,wind_gusts_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
    });
    const quality = new URLSearchParams({ latitude: lat, longitude: lon, current: "us_aqi,pm2_5,pm10" });
    try {
      const [weatherResponse, airResponse] = await Promise.all([
        fetch(`https://api.open-meteo.com/v1/forecast?${forecast}`),
        fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${quality}`).catch(() => null)
      ]);
      if (!weatherResponse.ok) throw new Error(`Weather service returned ${weatherResponse.status}`);
      weather = await weatherResponse.json();
      air = airResponse?.ok ? await airResponse.json() : null;
      weatherError = "";
    } catch (error) {
      weatherError = error instanceof TypeError ? t("Weather service unreachable (no internet?).") : error.message;
    }
    renderWeather();
    renderRisk();
  }

  function hourlyFromNow() {
    if (!weather) return [];
    const hourly = weather.hourly;
    const nowIso = weather.current.time.slice(0, 13);
    const start = Math.max(0, hourly.time.findIndex((time) => time.slice(0, 13) === nowIso));
    return hourly.time.slice(start, start + 73).map((time, offset) => ({
      time, rain: hourly.precipitation[start + offset] || 0,
      chance: hourly.precipitation_probability[start + offset] || 0,
      gust: hourly.wind_gusts_10m[start + offset] || 0,
      temp: hourly.temperature_2m[start + offset]
    }));
  }

  function aqiBand(value) {
    if (value == null) return { label: "Unavailable", cls: "" };
    if (value <= 50) return { label: "Good", cls: "ok" };
    if (value <= 100) return { label: "Moderate", cls: "mid" };
    if (value <= 150) return { label: "Unhealthy for sensitive groups", cls: "mid" };
    if (value <= 200) return { label: "Unhealthy", cls: "bad" };
    return { label: "Very unhealthy", cls: "bad" };
  }

  function renderWeather() {
    const box = $("db-weather");
    if (!weather) {
      box.innerHTML = `<p class="db-empty">${html(weatherError || t("Loading weather…"))}</p>`;
      $("db-alert").className = "db-alert";
      $("db-alert-title").textContent = t("Weather alerts");
      $("db-alert-text").textContent = weatherError || t("Loading weather…");
      return;
    }
    const current = weather.current;
    const days = weather.daily.time.map((day, index) => ({
      label: index === 0 ? t("Today") : new Date(`${day}T00:00`).toLocaleDateString(LOCALES[global.ashraayI18n.language] || "en-IN", { weekday: "short" }),
      code: weather.daily.weather_code[index],
      min: Math.round(weather.daily.temperature_2m_min[index]),
      max: Math.round(weather.daily.temperature_2m_max[index])
    }));
    const next24 = hourlyFromNow().slice(0, 24);
    const rain24 = next24.reduce((sum, hour) => sum + hour.rain, 0);
    const flood = rain24 >= 64.5 ? ["High", "bad"] : rain24 >= 15 ? ["Medium", "mid"] : ["Low", "ok"];
    const aqi = air?.current?.us_aqi;
    const band = aqiBand(aqi);
    box.innerHTML = `
      <div class="db-wx-now">
        <div class="db-wx-main">${weatherIcon(current.weather_code, "big")}<div><div class="db-temp">${Math.round(current.temperature_2m)}<sup>°C</sup></div>
          <b>${html(t(weatherLabel(current.weather_code)))}</b><small>${html(tf("Feels like {0}°C", Math.round(current.apparent_temperature)))}</small></div></div>
        <dl class="db-wx-facts">
          <dt>${html(t("Humidity"))}</dt><dd>${Math.round(current.relative_humidity_2m)}%</dd>
          <dt>${html(t("Pressure"))}</dt><dd>${Math.round(current.pressure_msl)} hPa</dd>
          <dt>${html(t("Wind speed"))}</dt><dd>${Math.round(current.wind_speed_10m)} km/h</dd>
          <dt>${html(t("Rain chance"))}</dt><dd>${Math.round(current.precipitation_probability ?? next24[0]?.chance ?? 0)}%</dd>
          <dt>${html(t("Visibility"))}</dt><dd>${current.visibility != null ? `${Math.round(current.visibility / 1000)} km` : "-"}</dd>
        </dl>
      </div>
      <ol class="db-days">${days.map((day) => `<li><b>${html(day.label)}</b>${weatherIcon(day.code)}<small>${day.min}° / ${day.max}°</small></li>`).join("")}</ol>
      <div class="db-env">
        <div class="db-env-c ${band.cls}">${icon("leaf")}<div><small>${html(t("Air quality"))}</small><b>${html(t(band.label))}</b><small>${aqi != null ? `US AQI ${Math.round(aqi)}${air.current.pm2_5 != null ? ` · PM2.5 ${Math.round(air.current.pm2_5)}` : ""}` : ""}</small></div></div>
        <div class="db-env-c ${flood[1]}">${icon("waves")}<div><small>${html(t("Flood risk"))}</small><b>${html(t(flood[0]))}</b><small>${html(tf("{0} mm rain in next 24 h", Math.round(rain24)))}</small></div></div>
      </div>
      <p class="db-src">${html(tf("Source: Open-Meteo · updated {0} local time", current.time.slice(11, 16)))}</p>`;

    // Severe weather banner, using IMD-style thresholds on the next 24 hours.
    const heavyHour = next24.findIndex((hour) => hour.rain >= 7.5);
    const maxGust = Math.max(0, ...next24.map((hour) => hour.gust));
    const maxTemp = Math.max(...next24.map((hour) => hour.temp));
    let alert = null;
    if (rain24 >= 64.5 || heavyHour >= 0) {
      alert = heavyHour > 0
        ? tf("Heavy rainfall expected in the next {0} hours ({1} mm) in {2}.", heavyHour, Math.round(rain24), cityName())
        : tf("Heavy rainfall expected in the next 24 hours ({0} mm) in {1}.", Math.round(rain24), cityName());
    } else if (maxGust >= 60) alert = tf("Strong wind gusts up to {0} km/h expected in {1}.", Math.round(maxGust), cityName());
    else if (maxTemp >= 40) alert = tf("Heat wave conditions: {0}°C expected in {1}.", Math.round(maxTemp), cityName());
    $("db-alert").className = `db-alert ${alert ? "severe" : "calm"}`;
    $("db-alert-title").textContent = t(alert ? "Severe Weather Alert" : "No severe weather");
    $("db-alert-text").textContent = alert || tf("No severe weather expected in the next 24 hours in {0}.", cityName());
  }

  // ---------- 72h risk outlook ----------
  function riskSeries() {
    const hours = hourlyFromNow();
    if (hours.length < 2) return null;
    const sumWindow = (index, span) => hours.slice(Math.max(0, index - span + 1), index + 1).reduce((sum, hour) => sum + hour.rain, 0);
    const points = [];
    let cumulative = 0;
    hours.forEach((hour, index) => {
      cumulative += hour.rain;
      if (index % 3) return;
      points.push({
        h: index,
        flood: clamp((sumWindow(index, 24) / 115.6) * 100, 0, 100),
        storm: clamp(((hour.gust - 20) / 70) * 100, 0, 100),
        landslide: clamp((sumWindow(index, 72) / 200) * 100, 0, 100),
        heat: clamp(((hour.temp - 32) / 13) * 100, 0, 100),
        rain: cumulative
      });
    });
    return points;
  }

  function lineChart(points, series, { max, height = 150, ticks }) {
    const width = 420;
    const pad = { l: 46, r: 8, t: 8, b: 22 };
    const lastH = points[points.length - 1].h || 1;
    const x = (h) => pad.l + (h / lastH) * (width - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
    const grid = ticks.map(([value, label]) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(value)}" y2="${y(value)}" class="g"/><text x="${pad.l - 6}" y="${y(value) + 4}" text-anchor="end">${html(label)}</text>`).join("");
    const xs = [0, 6, 12, 24, 48, 72].filter((h) => h <= lastH).map((h) => `<text x="${x(h)}" y="${height - 4}" text-anchor="middle">${h ? `${h}h` : html(t("Now"))}</text>`).join("");
    const lines = series.map(({ key, color }) => {
      const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.h).toFixed(1)},${y(point[key]).toFixed(1)}`).join("");
      return `<path d="${path}" stroke="${color}" fill="none" stroke-width="2"/>`;
    }).join("");
    return `<svg viewBox="0 0 ${width} ${height}" class="db-chart" role="img">${grid}${xs}${lines}</svg>`;
  }

  function renderRisk() {
    const simulated = lastState?.hazardSimInputs?.[cityId];
    if (simulated) {
      $("db-threat").innerHTML = `<p class="db-empty">${html(t("Simulated hazard prediction"))}</p>
        <ul class="db-ins"><li><span>${html(t("Flood risk index"))}</span><b>${html(simulated.floodRiskPct)}%</b></li>
        <li><span>${html(t("Reservoir"))}</span><b>${html(simulated.reservoirFillPct)}%</b></li></ul>`;
      $("db-insights").innerHTML = `<ul class="db-ins"><li><span>${html(tf("Rain, next {0} h", 24))}</span><b>${html(simulated.rain24Mm)} mm</b></li>
        <li><span>${html(t("Model run"))}</span><b>${html(timeOf(simulated.updatedAt))}</b></li></ul>`;
      $("db-impact").innerHTML = `<p class="db-empty">${html(t("Simulation only - not an official forecast."))}</p>`;
      return;
    }
    const points = riskSeries();
    const threat = $("db-threat");
    const insights = $("db-insights");
    const impact = $("db-impact");
    if (!points) {
      const message = `<p class="db-empty">${html(weatherError || t("Loading forecast…"))}</p>`;
      threat.innerHTML = message;
      insights.innerHTML = message;
      impact.innerHTML = message;
      return;
    }
    const series = [
      { key: "flood", label: "Flood", color: "#1E6FE0" },
      { key: "storm", label: "Storm", color: "#7B4FD0" },
      { key: "landslide", label: "Landslide", color: "#E39B1B" },
      { key: "heat", label: "Heat", color: "#D93025" }
    ];
    threat.innerHTML = `<ul class="db-legend">${series.map((item) => `<li><i style="background:${item.color}"></i>${html(t(item.label))}</li>`).join("")}</ul>${lineChart(points, series, { max: 100, ticks: [[100, t("High")], [50, t("Moderate")], [0, t("Low")]] })}`;

    const hours = hourlyFromNow();
    const rain72 = hours.reduce((sum, hour) => sum + hour.rain, 0);
    const peakRain24 = Math.max(...points.map((point) => point.flood)) * 1.156;
    const maxGust = Math.max(...hours.map((hour) => hour.gust));
    const maxTemp = Math.max(...hours.map((hour) => hour.temp));
    const level = (value, high, mid) => (value >= high ? "High" : value >= mid ? "Moderate" : "Low");
    const list = [
      { text: tf("Rainfall over the next 72 hours: {0} mm", Math.round(rain72)), level: level(rain72, 115, 35) },
      { text: tf("Peak 24-hour rainfall ~{0} mm - urban flooding risk in low-lying areas", Math.round(peakRain24)), level: level(peakRain24, 64.5, 15) },
      { text: tf("Wind gusts may reach {0} km/h", Math.round(maxGust)), level: level(maxGust, 60, 40) },
      { text: t("Landslide risk on hill slopes from accumulated rain"), level: level(rain72, 200, 75) },
      { text: tf("Maximum temperature {0}°C", Math.round(maxTemp)), level: level(maxTemp, 40, 36) }
    ].sort((a, b) => ["High", "Moderate", "Low"].indexOf(a.level) - ["High", "Moderate", "Low"].indexOf(b.level));
    insights.innerHTML = `<ul class="db-ins">${list.map((item) => `<li class="lv-${item.level.toLowerCase()}">${icon(item.level === "Low" ? "shield" : "warn")}<span>${html(item.text)}</span><b>${html(t(item.level))}</b></li>`).join("")}</ul>`;

    const items = lastState ? queueItems(lastState).filter((item) => item.bucket !== "resolved") : [];
    const checkins = lastState?.checkins || [];
    const atRisk = items.reduce((sum, item) => sum + (item.people || 0), 0)
      + checkins.filter((item) => item.status !== "safe").length;
    const areas = new Set(items.map((item) => item.landmark.toLowerCase())).size;
    const floodPeak = Math.max(...points.map((point) => point.flood));
    const infra = floodPeak >= 66 ? "High" : floodPeak >= 33 ? "Medium" : "Low";
    impact.innerHTML = `
      <div class="db-impact-kpis">
        <div>${icon("people")}<b>${atRisk}</b><small>${html(t("People at risk (reported)"))}</small></div>
        <div>${icon("alert")}<b>${areas}</b><small>${html(t("Affected areas"))}</small></div>
        <div>${icon("team")}<b>${html(t(infra))}</b><small>${html(t("Infrastructure impact"))}</small></div>
      </div>
      <ul class="db-legend"><li><i style="background:#1E6FE0"></i>${html(t("Cumulative rain (mm)"))}</li><li><i style="background:#E39B1B"></i>${html(t("Flood risk index"))}</li></ul>
      ${(() => {
        const maxRain = Math.max(10, Math.ceil(points[points.length - 1].rain / 10) * 10);
        const scaled = points.map((point) => ({ ...point, floodScaled: (point.flood / 100) * maxRain }));
        return lineChart(scaled, [{ key: "rain", color: "#1E6FE0" }, { key: "floodScaled", color: "#E39B1B" }], { max: maxRain, height: 120, ticks: [[maxRain, `${maxRain}`], [maxRain / 2, `${maxRain / 2}`], [0, "0"]] });
      })()}`;
  }

  // ---------- check-ins ----------
  function renderCheckins(state) {
    const checkins = state.checkins || [];
    const count = (status) => checkins.filter((item) => item.status === status).length;
    const tiles = [["safe", "Safe", "shield"], ["at_risk", "At Risk", "warn"], ["need_help", "Need Help", "alert"]];
    $("db-checkin-tiles").innerHTML = tiles.map(([status, label, name]) =>
      `<div class="db-ct ${status}">${icon(name)}<b>${count(status)}</b><small>${html(t(label))}</small><small>${pct(count(status), checkins.length)}%</small></div>`).join("");
    const recent = checkins.slice(-6).reverse();
    $("db-checkin-list").innerHTML = recent.length ? recent.map((item) => `
      <li><i class="dot ${item.status}"></i><span>${html(item.landmark || t("Location withheld"))}</span>
      <span class="db-sev st-${item.status}">${html(t({ safe: "Safe", at_risk: "At Risk", need_help: "Need Help" }[item.status] || item.status))}</span>
      <small>${html(ago(item.time))}</small></li>`).join("")
      : `<li class="db-empty">${html(t("No check-ins yet."))}</li>`;
  }

  // ---------- Hazard Intelligence + Hazard Response tiles ----------
  // Both tiles read state.hazardAlerts from the backend. Each alert carries a `tier`
  // (extreme / severe / moderate / minor) set by the Hazard Intelligence Agent; older alerts
  // without it fall back to the legacy high/medium/low severity.
  const TIERS = ["extreme", "severe", "moderate", "minor"];
  const TIER_LABEL = { extreme: "Extreme", severe: "Severe", moderate: "Moderate", minor: "Minor" };
  const HAZARD_LABEL = { flood: "Flood", waterlogging: "Waterlogging", wind: "Strong wind", heat: "Heat", landslide: "Landslide", storm: "Storm", citizen: "Citizen reports" };
  const STAGES = ["Predicted", "Approved", "Planned", "Plan approved", "In field", "Closed"];
  const HZ_ICONS = {
    flood: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    rain: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 14v6M8 14v6M12 16v6"/>',
    dam: '<path d="M3 20h18"/><path d="M5 20V8l4-2v14"/><path d="M9 10c2 0 2 1.5 4 1.5s2-1.5 4-1.5 2 1.5 4 1.5"/><path d="M9 15c2 0 2 1.5 4 1.5s2-1.5 4-1.5 2 1.5 4 1.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    evacuate: '<circle cx="13" cy="4" r="2"/><path d="m7 21 3-7 3 2v5"/><path d="M6 12l3-4 4 1 3 3h3"/><path d="m10 14-3 1"/>',
    shelter: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-7h6v7"/>',
    team: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5"/><path d="M16 4a3 3 0 0 1 0 6M21 20c0-2.5-1.6-4.3-4-4.8"/>',
    pump: '<path d="M4 20h16"/><rect x="6" y="9" width="8" height="11" rx="1"/><path d="M14 13h3a2 2 0 0 1 2 2v1"/><path d="M10 9V5h4"/>',
    traffic: '<rect x="8" y="3" width="8" height="18" rx="2"/><circle cx="12" cy="8" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="16" r="1.4"/>',
    alert: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21h14v-3H5z"/><path d="M12 2v2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    escalate: '<path d="M7 17 17 7M8 7h9v9"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    gauge: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18h20"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5"/>',
    boat: '<path d="M2 20c2 1 4 1 6 0s4-1 6 0 4 1 6 0"/><path d="M4 16l1.5-5h13L20 16"/><path d="M12 4v7M12 4l5 4h-5"/>',
    wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
    heat: '<path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"/>'
  };
  const ico = (name, cls = "") => `<svg class="hzi-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HZ_ICONS[name] || HZ_ICONS.alert}</svg>`;
  const hazardIcon = (type) => ({ flood: "flood", waterlogging: "flood", wind: "wind", heat: "heat", landslide: "dam", citizen: "team" }[type] || "alert");

  // Volunteer replies to a dispatched alert (every active volunteer is asked; location is not used).
  function volunteerReplies(alert) {
    const requests = (lastState?.volunteerRequests || []).filter((item) => item.hazardAlertId === alert.id);
    const count = (status) => requests.filter((item) => item.status === status).length;
    return { asked: requests.length, accepted: count("accepted"), declined: count("declined"), waiting: count("pending"), expired: count("expired") };
  }
  function dispatchLine(alert) {
    if (!alert.dispatchedAt) return "";
    const v = volunteerReplies(alert);
    const users = alert.citizenNotice?.recipients ?? 0;
    const replies = (lastState?.volunteerRequests || []).filter((item) =>
      item.hazardAlertId === alert.id && ["accepted", "declined"].includes(item.status));
    return `<p class="hzi-dispatch">${ico("alert")}<span>${html(tf("Sent to all {0} registered users", users))} · ${html(tf("{0} volunteers asked", v.asked))}: <b class="hzi-acc">${html(tf("{0} accepted", v.accepted))}</b> · ${html(tf("{0} declined", v.declined))} · ${html(tf("{0} waiting", v.waiting))}</span></p>
      ${replies.length ? `<ul class="hzi-audit">${replies.map((request) => `<li>${html(request.volunteerName)}: ${html(t(request.status === "accepted" ? "Available for this alert" : "Not available for this alert"))}</li>`).join("")}</ul>` : ""}`;
  }
  function agentUpdateLine(alert) {
    const u = alert.agentUpdate;
    if (!u) return "";
    return `<p class="hzi-agent-upd" title="${html(t(u.text))}">${ico("refresh")}<span><b>${html(tf("Agent update {0}", timeOf(u.at)))}:</b> ${html(t(u.text))} ${html(t(u.recommendation))}</span></p>`;
  }
  const actionIcon = (action) => {
    if (action.icon && HZ_ICONS[action.icon]) return action.icon;
    const text = `${action.label || ""}`.toLowerCase();
    if (/evacuat/.test(text)) return "evacuate";
    if (/dam|reservoir|release/.test(text)) return "dam";
    if (/shelter/.test(text)) return "shelter";
    if (/pump/.test(text)) return "pump";
    if (/traffic|divers/.test(text)) return "traffic";
    if (/crew|team|volunteer/.test(text)) return "team";
    return "alert";
  };
  const tierLabel = (tier) => t(TIER_LABEL[tier] || tier);
  // Agent-generated alerts may have no title; fall back to "<hazard> risk in <place>".
  const alertTitle = (alert) => (alert.title ? t(alert.title) : tf("{0} risk in {1}", t(HAZARD_LABEL[alert.hazardType] || "Hazard"), t(alert.place || "")));

  function hazardTier(alert) {
    if (TIERS.includes(alert.tier)) return alert.tier;
    const conf = alert.confidencePct ?? 0;
    if (alert.severity === "high") return conf >= 80 ? "extreme" : "severe";
    if (alert.severity === "medium") return "moderate";
    return "minor";
  }
  const tierRank = (alert) => TIERS.indexOf(hazardTier(alert));
  const byPriority = (a, b) => Number(Boolean(a.demoSeed)) - Number(Boolean(b.demoSeed))
    || tierRank(a) - tierRank(b)
    || String(b.signalUpdatedAt || b.createdAt || "").localeCompare(a.signalUpdatedAt || a.createdAt || "");
  function timeOf(iso) {
    if (!iso) return "";
    const lang = global.ashraayI18n.language;
    return new Date(iso).toLocaleTimeString(LOCALES[lang] || "en-IN", { hour: "2-digit", minute: "2-digit" });
  }
  // Alerts the dashboard tiles show: everything for the selected city that is not rejected, ignored or resolved.
  // Every alert in the system, whatever its location: the Location picker never filters or ranks
  // hazard alerts (it only drives the map, weather and risk outlook).
  function activeAlerts(state) {
    return (state.hazardAlerts || []).filter((alert) =>
      alert.approvalStatus !== "rejected"
      && !["ignored", "resolved"].includes(alert.status)).sort(byPriority);
  }

  // Response stage 0-5 and status, worked out from the backend fields.
  function responseInfo(alert) {
    const steps = alert.responsePlan || [];
    const done = steps.length && steps.every((step) => step.status === "completed");
    if (alert.approvalStatus === "awaiting_approval") return { stage: 0, key: "awaiting", label: "Awaiting your approval" };
    if (alert.approvalStatus === "escalated") return { stage: 0, key: "escalated", label: "Escalated" };
    if (alert.approvalStatus !== "approved") return { stage: 0, key: "monitoring", label: "Monitoring" };
    if (done) return { stage: 5, key: "completed", label: "Completed" };
    if (steps.some((step) => ["in_field", "awaiting_confirmation", "completed"].includes(step.status))) return { stage: 4, key: "action", label: "In action" };
    if (steps.some((step) => step.status === "awaiting_volunteer")) return { stage: 3, key: "review", label: "Waiting for volunteer acceptance" };
    if (steps.some((step) => step.status === "awaiting_approval")) return { stage: 2, key: "review", label: "Plan ready for review" };
    return { stage: 1, key: "review", label: "Plan ready for review" };
  }

  const pill = (tier, text = tierLabel(tier)) => `<span class="hzi-sev ${tier}">${html(text)}</span>`;
  const dot = (tier) => `<i class="hzi-dot ${tier}" aria-hidden="true"></i>`;
  const navButtons = (kind, index, total) => `<span class="hzi-pager">
      <button type="button" class="hzi-round" data-${kind}-nav="prev" ${index <= 0 ? "disabled" : ""} aria-label="${html(t("Previous"))}">${ico("left")}</button>
      <b>${index + 1} / ${total}</b>
      <button type="button" class="hzi-round" data-${kind}-nav="next" ${index >= total - 1 ? "disabled" : ""} aria-label="${html(t("Next"))}">${ico("right")}</button>
    </span>`;

  function metric(icon, label, value, sub, extra = "") {
    return `<li><span class="hzi-ml">${ico(icon)}${html(label)}</span><b>${html(value)}</b>${sub ? `<small>${html(sub)}</small>` : ""}${extra}</li>`;
  }

  // ----- Hazard Intelligence -----
  function intelAlertCard(alert, index, total) {
    const tier = hazardTier(alert);
    const modifying = aiModifyId === alert.id;
    const actions = aiEdits[alert.id] || alert.recommendedActions || [];
    const confPct = alert.confidencePct ?? 0;
    const window = alert.floodWindowHours ? `${String(alert.floodWindowHours).replace("-", "–")} h` : "–";
    const rainLabel = tf("Rain, next {0} h", alert.rainWindowHours || 24);
    const monitoring = !alert.approvalStatus;
    return `
      <article class="hzi-card tier-${tier}" data-alert-id="${html(alert.id)}">
        <div class="hzi-card-top">
          ${pill(tier, tierLabel(tier).toUpperCase())}
          <span class="hzi-tag">${ico(hazardIcon(alert.hazardType))}${html(t(HAZARD_LABEL[alert.hazardType] || "Hazard"))}</span>
          <span class="hzi-tag">${ico("pin")}${html(t(alert.area || alert.place))}</span>
          ${navButtons("ai", index, total)}
        </div>
        <h3 class="hzi-title">${html(alertTitle(alert))}</h3>
        <p class="hzi-summary">${html(t(alert.summary || (alert.reasons || [])[0] || ""))}</p>
        ${agentUpdateLine(alert)}
        <ul class="hzi-metrics">
          ${alert.hazardType === "citizen" ? `
          ${metric("team", t("People reported"), String(alert.peopleReported ?? 0), t("Citizen app"))}
          ${metric("alert", t("Need help now"), String(alert.checkinsNeedHelp ?? 0), t("Check-ins"))}
          ${metric("clock", t("Open reports"), String(alert.openIncidents ?? 0), "")}` : `
          ${metric("rain", rainLabel, `${Math.round(alert.rainMm ?? alert.rain24Mm ?? 0)} mm`, t(alert.rainSource || ""))}
          ${metric("dam", t("Upstream reservoir"), tf("{0}% full", Math.round(alert.reservoirFillPct || 0)), t(alert.reservoirSource || ""))}
          ${metric("clock", t("Flood window"), window, alert.floodPeak ? tf("Peak {0}", alert.floodPeak) : "")}`}
          ${metric("target", t("Confidence"), (confPct / 100).toFixed(2), "", `<span class="hzi-bar"><i style="width:${Math.max(0, Math.min(100, confPct))}%"></i></span>`)}
        </ul>
        ${monitoring ? `<p class="hzi-note">${ico("check")}${html(t("No action needed. The agent keeps monitoring and plans only if this rises to Moderate."))}</p>` : `
        <p class="hzi-rec-h"><b>${html(t("Recommended actions"))}</b> <span>${html(t("for the Hazard Response Agent"))}</span></p>
        ${modifying ? `<p class="hzi-hint">${html(t("Edit each action, then approve to send the plan to the Hazard Response Agent."))}</p>` : ""}
        <ul class="hzi-recs hz-rec">
          ${actions.map((action) => `<li>
              <span class="hzi-rec-ic">${ico(actionIcon(action))}</span>
              ${modifying
                ? `<input type="text" class="hz-rec-label" value="${html(action.label || "")}" aria-label="${html(t("Action"))}"><input type="text" class="hz-rec-detail" value="${html(action.detail || "")}" aria-label="${html(t("Detail"))}">`
                : `<span class="hzi-rec-t">${html(t(action.label || ""))}</span><span class="hzi-rec-m">${html(t(action.detail || ""))}</span>`}
            </li>`).join("")}
        </ul>`}
        ${alert.approvalStatus === "awaiting_approval" ? `
        <div class="hzi-actions">
          <button type="button" class="hzi-btn pri" data-action="hazard-approve" data-id="${html(alert.id)}" title="${html(t("Approve & send to Hazard Response"))}">${ico("check")}${html(t("Approve & send"))}</button>
          <button type="button" class="hzi-btn" data-ai-modify="${html(alert.id)}">${ico("pencil")}${html(t(modifying ? "Save changes" : "Modify"))}</button>
          <button type="button" class="hzi-btn" data-action="hazard-reject" data-id="${html(alert.id)}">${ico("x")}${html(t("Reject"))}</button>
          <button type="button" class="hzi-btn" data-action="hazard-escalate" data-id="${html(alert.id)}">${ico("escalate")}${html(t("Escalate"))}</button>
        </div>` : ""}
        ${alert.approvalStatus === "escalated" ? `<p class="hzi-note escalated">${ico("escalate")}${html(t("Escalated to senior command. Waiting for their decision."))}</p>` : ""}
      </article>`;
  }

  function intelApprovedCard(alert, index, total) {
    const tier = hazardTier(alert);
    const info = responseInfo(alert);
    const steps = alert.responsePlan || [];
    const timeline = [
      ["Predicted", alert.createdAt, true],
      ["You approved", alert.approvedAt, true],
      ["Plan approved", alert.planApprovedAt, Boolean(alert.planApprovedAt)],
      [info.stage >= 5 ? "Closed" : "In field", null, info.stage >= 5]
    ];
    const current = timeline.findIndex((item) => !item[2]);
    const audit = aiAuditOpen === alert.id;
    return `
      <article class="hzi-card approved" data-alert-id="${html(alert.id)}">
        <div class="hzi-card-top">
          ${pill(tier, tierLabel(tier).toUpperCase())}
          <span class="hzi-tag">${ico("pin")}${html(t(alert.area || alert.place))}</span>
          <span class="hzi-okpill">${ico("check")}${html(tf("Approved · rev {0}", alert.revision || 1))}</span>
          ${navButtons("ai", index, total)}
        </div>
        <h3 class="hzi-title">${html(t(info.stage >= 5 ? "Response completed" : "Hazard Response Agent is acting"))}</h3>
        <p class="hzi-summary">${html(alertTitle(alert))}. ${html(tf("Approved at {0}; progress is tracked in the Hazard Response tile.", timeOf(alert.approvedAt)))}</p>
        ${dispatchLine(alert)}
        ${agentUpdateLine(alert)}
        <ol class="hzi-steps">
          ${timeline.map(([label, at, done], i) => `<li class="${done ? "done" : i === current ? "now" : ""}">
              <span class="hzi-step-dot">${done ? ico("check") : i === current ? ico("refresh") : ""}</span>
              <b>${html(t(label))}</b><small>${html(at ? timeOf(at) : done ? t("now") : i === current ? t(info.stage >= 4 ? "now" : "next") : "")}</small>
            </li>`).join("")}
        </ol>
        <p class="hzi-rec-h"><b>${html(t("Actions under way"))}</b></p>
        <ul class="hzi-recs hzi-under">
          ${steps.map((step) => `<li><span class="hzi-rec-ic hzi-ic-teal">${ico(actionIcon(step))}</span><span class="hzi-rec-t">${html(t(step.label))}</span><span class="hzi-rec-m prog">${html(step.progress ? t(step.progress) : t(STEP_LABEL[step.status] || step.status))}</span></li>`).join("")}
        </ul>
        ${audit ? `<ul class="hzi-audit">${(alert.decisionLog || []).map((entry) => `<li><b>${html(t(DECISION_LABEL[entry.action] || entry.action))}</b> · ${html(timeOf(entry.at))} · ${html(tf("rev {0}", entry.revision || 1))}</li>`).join("") || `<li>${html(t("No decisions recorded yet."))}</li>`}</ul>` : ""}
        <div class="hzi-actions">
          <button type="button" class="hzi-btn" data-hr-open="${html(alert.id)}">${ico("refresh")}${html(t("View plan progress"))}</button>
          <button type="button" class="hzi-btn" data-ai-audit="${html(alert.id)}" aria-expanded="${audit}">${ico("shield")}${html(t(audit ? "Hide audit trail" : "Open audit trail"))}</button>
        </div>
      </article>`;
  }

  function intelAllClear(state) {
    const outlook = (state.hazardOutlook || {})[cityId];
    const dash = "–";
    return `
      <div class="hzi-clear">
        <span class="hzi-clear-ic">${ico("shield")}</span>
        <h3>${html(tf("No hazard warnings for {0}", cityName()))}</h3>
        <p>${html(t("The Hazard Intelligence Agent found no flood, rain, wind or heat risk right now. You will see new predictions here first."))}</p>
      </div>
      <ul class="hzi-metrics clear">
        ${metric("rain", tf("Rain, next {0} h", outlook?.rainWindowHours || 24), outlook ? `${Math.round(outlook.rainMm)} mm` : dash, outlook ? t(outlook.rainMm < 64.5 ? "Below watch level" : "Above watch level") : "")}
        ${metric("dam", t("Reservoir"), outlook ? tf("{0}% full", outlook.reservoirFillPct) : dash, outlook ? t(outlook.reservoirFillPct < 80 ? "Normal range" : "High") : "")}
        ${metric("gauge", t("Flood risk index"), outlook ? `${outlook.floodRiskPct}%` : dash, outlook ? t(outlook.floodRiskPct < 50 ? "Low" : "Elevated") : "")}
        ${metric("clock", t("Model run"), outlook ? timeOf(outlook.modelRunAt) : dash, outlook ? tf("Next run {0}", timeOf(outlook.nextRunAt)) : t("Waiting for the first agent run"))}
      </ul>`;
  }

  // Keep the severity chips on one line: drop the tier names (dot + count stay) when they do not fit.
  function fitFilters() {
    const bar = $("db-ai-filters");
    bar.classList.remove("compact");
    if (bar.clientWidth && bar.scrollWidth > bar.clientWidth + 1) bar.classList.add("compact");
  }

  function renderAgentIntel(state) {
    const all = activeAlerts(state);
    const counts = Object.fromEntries(TIERS.map((tier) => [tier, all.filter((item) => hazardTier(item) === tier).length]));
    const pending = (item) => item.approvalStatus === "awaiting_approval" || item.approvalStatus === "escalated";
    const awaiting = all.filter(pending).length;
    const badge = $("db-ai-count");
    if (!all.length) {
      badge.className = "hzi-badge green";
      badge.innerHTML = `<i></i>${html(t("All clear"))}`;
    } else if (awaiting) {
      const worst = hazardTier(all.find(pending));
      badge.className = `hzi-badge ${worst === "extreme" ? "red" : worst === "severe" ? "amber" : "blue"}`;
      badge.innerHTML = `<i></i>${html(tf("{0} active alerts", all.length))}`;
    } else if (all.some((alert) => alert.approvalStatus === "approved")) {
      badge.className = "hzi-badge teal";
      badge.innerHTML = `<i></i>${html(t("Sent to Hazard Response"))}`;
    } else {
      badge.className = "hzi-badge green";
      badge.innerHTML = `<i></i>${html(t("Monitoring"))}`;
    }
    $("db-ai-filters").innerHTML = ["all", ...TIERS].map((tier) => {
      const count = tier === "all" ? all.length : counts[tier];
      const label = tier === "all" ? t("All") : tierLabel(tier);
      return `<button type="button" role="tab" aria-selected="${String(tier === aiFilter)}" data-tier="${tier}" title="${html(label)}" aria-label="${html(`${label} ${count}`)}">${tier === "all" ? "" : dot(tier)}<span class="hzi-fl">${html(label)}</span><b>${count}</b></button>`;
    }).join("") + `<span class="hzi-sort" title="${html(t("High → low"))}" aria-label="${html(t("High → low"))}">${ico("filter")}</span>`;
    fitFilters();
    const filtered = aiFilter === "all" ? all : all.filter((item) => hazardTier(item) === aiFilter);
    const body = $("db-ai-body");
    if (!all.length) { body.innerHTML = intelAllClear(state); return; }
    if (!filtered.length) {
      body.innerHTML = `<p class="hzi-empty">${html(tf("No {0} alerts for {1}.", tierLabel(aiFilter), cityName()))}</p>`;
      return;
    }
    if (filtered.some((item) => !item.demoSeed) && filtered.find((item) => item.id === aiSelectedId)?.demoSeed) {
      aiSelectedId = null;
      aiIndex = 0;
    }
    if (aiSelectedId) {
      const at = filtered.findIndex((item) => item.id === aiSelectedId);
      if (at >= 0) aiIndex = at;
    }
    if (aiIndex >= filtered.length) aiIndex = 0;
    const alert = filtered[aiIndex];
    aiSelectedId = alert.id;
    body.innerHTML = alert.approvalStatus === "approved"
      ? intelApprovedCard(alert, aiIndex, filtered.length)
      : intelAlertCard(alert, aiIndex, filtered.length);
  }

  // ----- Hazard Response -----
  const STEP_LABEL = { pending: "Starts after approval", awaiting_approval: "Plan ready for review", awaiting_volunteer: "Waiting for volunteer acceptance", in_field: "In progress", awaiting_confirmation: "Awaiting citizen confirmation", completed: "Done" };
  const RESPONSE_NEED_LABEL = { safe: "Safe", shelter: "Shelter", preposition: "Preposition", rescue: "Rescue", boat: "Boat", other: "Other assistance" };
  const DECISION_LABEL = { approve: "Approved", reject: "Rejected", escalate: "Escalated", modify: "Modified" };
  const STATUS_CLASS = { awaiting: "amber", escalated: "purple", monitoring: "grey", completed: "green", action: "blue", review: "purple" };

  function tracker(info) {
    const closed = info.stage >= 5;
    return `<span class="hzr-track" aria-label="${html(tf("Step {0} of 6", info.stage + 1))}">
        <span class="hzr-dots">${STAGES.map((_, i) => `${i ? `<i class="hzr-line ${i <= info.stage || closed ? "done" : ""}"></i>` : ""}<i class="hzr-pt ${i < info.stage || closed ? "done" : i === info.stage ? "now" : ""}"></i>`).join("")}</span>
        <small><b>${html(t(STAGES[info.stage]))}</b> · ${html(tf("step {0} of 6", info.stage + 1))}</small>
      </span>`;
  }

  function responseCard(alert, index, total) {
    const tier = hazardTier(alert);
    const info = responseInfo(alert);
    const plan = alert.responsePlan || [];
    const rows = plan.length ? plan : (alert.recommendedActions || []).map((action) => ({ ...action, status: alert.approvalStatus === "awaiting_approval" ? "pending" : "monitor" }));
    return `
      <article class="hzr-card tier-${tier}">
        <div class="hzr-top">
          ${dot(tier)}
          <span class="hzr-name"><b>${html(alertTitle(alert))}</b><small>${ico("pin")}${html(t(alert.place))} · <em class="${tier}">${html(tierLabel(tier))}</em></small></span>
          <span class="hzr-side">${tracker(info)}
          <span class="hzr-end"><span class="hzr-status ${STATUS_CLASS[info.key]}">${html(t(info.label))}</span>
          <button type="button" class="hzi-round go ${tier}" data-hr-nav="next" ${index >= total - 1 ? "disabled" : ""} aria-label="${html(t("Next alert"))}">${ico("right")}</button></span></span>
        </div>
        ${rows.some((step) => ["pending", "awaiting_approval"].includes(step.status)) && !alert.responseCompletedAt ? `<div class="hzi-actions"><button type="button" class="hzi-btn pri" data-action="hazard-plan-dispatch" data-hazard-id="${html(alert.id)}">${html(t("Send all tasks to field"))}</button></div>` : ""}
        ${(alert.responseChoices || []).length ? `<p class="hzi-note">${html(t("Citizen assistance choices"))}: ${html(alert.responseChoices.map((choice) => t(RESPONSE_NEED_LABEL[choice.need] || choice.need)).join(", "))}</p>` : ""}
        ${rows.length ? `<ul class="hzr-acts">${rows.map((step) => {
          const label = step.status === "monitor" ? "" : t(STEP_LABEL[step.status] || step.status);
          let control = "";
          if (step.id && step.status === "in_field" && !step.taskId) control = `<button type="button" class="hzi-btn xs" data-action="hazard-plan-complete" data-hazard-id="${html(alert.id)}" data-step-id="${html(step.id)}">${html(t("Mark complete"))}</button>`;
          const task = (lastState?.tasks || []).find((item) => item.id === step.taskId);
          if (task?.completionPhoto) control += `<details class="hzr-evidence" data-evidence="${html(task.id)}:photo"><summary>${html(t("Completion photo"))}</summary><img src="${html(task.completionPhoto)}" alt="${html(t("Completion photo"))}"></details>`;
          if (task?.completionVoice) control += `<details class="hzr-evidence" data-evidence="${html(task.id)}:voice"><summary>${html(t("Completion voice note"))}</summary><audio controls preload="none" src="${html(task.completionVoice)}"></audio></details>`;
          if (task?.completionNote) control += `<p>${html(task.completionNote)}</p>`;
          const confirmations = task?.status === "awaiting_confirmation"
            ? ` ${task.confirmationCount}/${task.confirmationTotal}` : "";
          return `<li>${ico(actionIcon(step))}<span class="hzr-a">${html(t(step.label || ""))}</span><span class="hzr-r"><span class="hzr-m">${html(t(step.progress || step.detail || ""))}</span>${label ? `<span class="hzr-s ${step.status}"><i></i>${html(label + confirmations)}</span>` : ""}${control}</span></li>`;
        }).join("")}</ul>` : `<p class="hzi-note">${ico("check")}${html(t("No action needed. The agent keeps monitoring and plans only if this rises to Moderate."))}</p>`}
        ${dispatchLine(alert)}
      </article>`;
  }

  function responseStandingBy(state) {
    const resources = state.resources || [];
    const ready = (kind) => resources.filter((item) => item.kind === kind && item.status === "available");
    const shelters = ready("shelter");
    const beds = shelters.reduce((sum, item) => sum + (item.capacity || 0), 0);
    return `
      <div class="hzi-clear">
        <span class="hzi-clear-ic">${ico("check")}</span>
        <h3>${html(t("Nothing to coordinate"))}</h3>
        <p>${html(t("The Hazard Response Agent starts planning as soon as you approve a hazard alert. Resources below are ready."))}</p>
      </div>
      <ul class="hzi-metrics clear">
        ${metric("team", t("Response teams"), tf("{0} ready", ready("response-team").length), "")}
        ${metric("shelter", t("Shelters"), tf("{0} · {1} beds", shelters.length, beds), "")}
        ${metric("boat", t("Rescue boats"), tf("{0} ready", ready("boat").length), "")}
        ${metric("alert", t("Alert channels"), tf("{0} channels", 3), "SMS · WhatsApp · push")}
      </ul>`;
  }

  function renderHazardResponse(state) {
    const alerts = activeAlerts(state).filter((alert) =>
      alert.approvalStatus === "approved" && (!alert.demoSeed || alert.dispatchedAt));
    const infos = alerts.map(responseInfo);
    const steps = alerts.flatMap((alert) => alert.responsePlan || []);
    const running = infos.filter((info) => info.key === "action").length;
    const counts = [
      ["In action", running, "blue"],
      ["Awaiting approval", steps.filter((step) => ["pending", "awaiting_approval"].includes(step.status)).length, "amber"],
      ["Actions in field", steps.filter((step) => step.status === "in_field").length, "teal"],
      ["Completed", steps.filter((step) => step.status === "completed").length, "green"]
    ];
    $("db-hr-counts").innerHTML = counts.map(([label, value, tone]) => `<li class="${tone}"><b>${value}</b><span>${html(t(label))}</span></li>`).join("");
    const badge = $("db-hr-badge");
    if (!alerts.length) { badge.className = "hzi-badge green"; badge.innerHTML = `<i></i>${html(t("Standing by"))}`; }
    else { badge.className = "hzi-badge blue"; badge.innerHTML = `<i></i>${html(tf(running === 1 ? "{0} plan running" : "{0} plans running", running))}`; }
    const body = $("db-hr-body");
    const openEvidence = new Set([...body.querySelectorAll("details[data-evidence][open]")].map((item) => item.dataset.evidence));
    if (!alerts.length) { body.innerHTML = responseStandingBy(state); return; }
    if (alerts.some((item) => !item.demoSeed) && alerts.find((item) => item.id === hrSelectedId)?.demoSeed) {
      hrSelectedId = null;
      hrIndex = 0;
    }
    if (hrSelectedId) {
      const at = alerts.findIndex((item) => item.id === hrSelectedId);
      if (at >= 0) hrIndex = at;
    }
    if (hrIndex >= alerts.length) hrIndex = 0;
    hrSelectedId = alerts[hrIndex].id;
    const next = alerts.filter((_, i) => i !== hrIndex).slice(0, 2);
    body.innerHTML = `
      <div class="hzr-sub"><b title="${html(t("High → low"))}">${html(t("Response by alert"))}</b>${navButtons("hr", hrIndex, alerts.length)}</div>
      ${responseCard(alerts[hrIndex], hrIndex, alerts.length)}
      ${next.length ? `<p class="hzr-next-h">${html(t("Up next"))}</p>
      <ul class="hzr-next">${next.map((alert) => {
        const info = responseInfo(alert);
        const tier = hazardTier(alert);
        return `<li><button type="button" data-hr-open="${html(alert.id)}">${dot(tier)}<b>${html(alertTitle(alert))}</b><small>${html(t(alert.place))} · ${html(tierLabel(tier))}</small><span class="hzr-status ${STATUS_CLASS[info.key]}">${html(t(info.label))}</span><span class="hzi-round sm">${ico("right")}</span></button></li>`;
      }).join("")}</ul>` : ""}
      <span class="hzr-pages" aria-hidden="true">${alerts.map((_, i) => `<i class="${i === hrIndex ? "on" : ""}"></i>`).join("")}</span>`;
    body.querySelectorAll("details[data-evidence]").forEach((item) => { item.open = openEvidence.has(item.dataset.evidence); });
  }

  // ---------- public API ----------
  function render(state) {
    lastState = state;
    const items = queueItems(state);
    renderKpis(state, items);
    renderQueue(items);
    renderCheckins(state);
    renderMap(items);
    renderAgentIntel(state);
    renderHazardResponse(state);
    renderRisk();
  }

  function setCity(id) {
    if (!CITIES[id]) return;
    cityId = id;
    localStorage.setItem("ashraay.dashboard.city", id);
    document.dispatchEvent(new CustomEvent("ashraay:city-change", { detail: { id } }));
    $("db-city").value = id;
    $("db-weather-city").textContent = cityName();
    weather = null;
    air = null;
    renderWeather();
    renderRisk();
    if (map) map.setView([city().lat, city().lon], 11);
    if (lastState) {
      renderMap(queueItems(lastState));
      aiIndex = 0; hrIndex = 0; aiSelectedId = null; hrSelectedId = null;
      renderAgentIntel(lastState);
      renderHazardResponse(lastState);
    }
    loadWeather();
  }

  function init() {
    renderCityLabels();
    $("db-city").addEventListener("change", (event) => setCity(event.target.value));
    $("db-queue-view-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      document.querySelectorAll("#db-queue-view-tabs [data-view]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === button)));
      $("db-queue-view-incidents").hidden = button.dataset.view !== "incidents";
      $("db-queue-view-checkins").hidden = button.dataset.view !== "checkins";
    });
    $("db-queue-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      queueFilter = button.dataset.filter;
      if (lastState) renderQueue(queueItems(lastState));
    });
    $("db-queue-search").addEventListener("input", (event) => {
      queueSearch = event.target.value.trim();
      if (lastState) renderQueue(queueItems(lastState));
    });
    ["db-show-confirmed", "db-show-unconfirmed", "db-show-checkins"].forEach((id) => $(id).addEventListener("change", () => {
      if (lastState) renderMap(queueItems(lastState));
    }));
    $("db-ai-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tier]");
      if (!button) return;
      aiFilter = button.dataset.tier;
      aiIndex = 0;
      aiSelectedId = null;
      if (lastState) renderAgentIntel(lastState);
    });
    $("db-ai-body").addEventListener("click", (event) => {
      const nav = event.target.closest("[data-ai-nav]");
      if (nav) {
        aiIndex += nav.dataset.aiNav === "next" ? 1 : -1;
        aiSelectedId = null;
        if (lastState) renderAgentIntel(lastState);
        return;
      }
      const open = event.target.closest("[data-hr-open]");
      if (open) {
        hrSelectedId = open.dataset.hrOpen;
        if (lastState) renderHazardResponse(lastState);
        $("db-hazard-response-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      const auditBtn = event.target.closest("[data-ai-audit]");
      if (auditBtn) {
        aiAuditOpen = aiAuditOpen === auditBtn.dataset.aiAudit ? null : auditBtn.dataset.aiAudit;
        if (lastState) renderAgentIntel(lastState);
        return;
      }
      const modifyBtn = event.target.closest("[data-ai-modify]");
      if (!modifyBtn) return;
      const id = modifyBtn.dataset.aiModify;
      if (aiModifyId === id) {
        const card = modifyBtn.closest(".hzi-card");
        aiEdits[id] = [...card.querySelectorAll(".hz-rec li")].map((row) => ({
          label: row.querySelector(".hz-rec-label").value.trim(),
          detail: row.querySelector(".hz-rec-detail").value.trim()
        }));
        aiModifyId = null;
      } else {
        aiModifyId = id;
      }
      if (lastState) renderAgentIntel(lastState);
    });
    $("db-hr-body").addEventListener("click", (event) => {
      const nav = event.target.closest("[data-hr-nav]");
      const open = event.target.closest("[data-hr-open]");
      if (!nav && !open) return;
      if (open) hrSelectedId = open.dataset.hrOpen;
      else { hrIndex += nav.dataset.hrNav === "next" ? 1 : -1; hrSelectedId = null; }
      if (lastState) renderHazardResponse(lastState);
    });
    if (global.ResizeObserver) new ResizeObserver(() => fitFilters()).observe($("db-agent-intel-card"));
    document.addEventListener("ashraay:language-change", () => {
      renderCityLabels();
      renderWeather();
      renderRisk();
      if (lastState) render(lastState);
    });
    renderWeather();
    renderRisk();
    loadWeather();
    clearInterval(weatherTimer);
    weatherTimer = setInterval(loadWeather, WEATHER_REFRESH_MS);
  }

  function shown() {
    if (ensureMap()) setTimeout(() => map.invalidateSize(), 0);
  }

  // Latest rain/flood/landslide readings for the selected city, reused by the hazard-prediction agent.
  function currentRisk() {
    const simulated = lastState?.hazardSimInputs?.[cityId];
    if (simulated) return { rain24Mm: simulated.rain24Mm, floodRiskPct: simulated.floodRiskPct, landslideRiskPct: 0 };
    const points = riskSeries();
    if (!points) return null;
    const hours = hourlyFromNow();
    const rain24 = hours.slice(0, 24).reduce((sum, hour) => sum + hour.rain, 0);
    return {
      rain24Mm: Math.round(rain24),
      floodRiskPct: Math.round(points[0]?.flood ?? 0),
      landslideRiskPct: Math.round(points[0]?.landslide ?? 0)
    };
  }

  global.ashraayDashboard = {
    init, render, shown, setCity, cities: CITIES,
    currentCity: () => ({ id: cityId, ...city() }),
    currentRisk,
    hazardActionOverride: (id) => aiEdits[id] || null
  };
})(window);
