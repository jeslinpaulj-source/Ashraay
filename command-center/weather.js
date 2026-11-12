// Weather & Environment screen: live public weather (Open-Meteo), air quality, river discharge (GloFAS) and rain radar (RainViewer).
(function (global) {
  const auth = global.ashraayAuth;
  const t = global.ashraayI18n.t;
  const html = auth.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const tf = (key, ...args) => t(key).replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match);
  const LOCALES = { en: "en-IN", hi: "hi-IN", ta: "ta-IN", ml: "ml-IN", kn: "kn-IN" };
  const locale = () => LOCALES[global.ashraayI18n.language] || "en-IN";
  const REFRESH_MS = 60 * 1000;

  // Approximate GloFAS sampling points for major rivers near each city (5 km model grid).
  const RIVERS = {
    bengaluru: [["Arkavathi River", 12.62, 77.41], ["Vrishabhavathi River", 12.86, 77.43], ["Dakshina Pinakini River", 12.78, 77.83]],
    kochi: [["Periyar River", 10.11, 76.35], ["Muvattupuzha River", 9.98, 76.58]],
    thiruvananthapuram: [["Karamana River", 8.48, 76.95], ["Neyyar River", 8.40, 77.08]],
    chennai: [["Adyar River", 13.01, 80.25], ["Cooum River", 13.07, 80.28]],
    mumbai: [["Mithi River", 19.07, 72.87], ["Ulhas River", 19.20, 73.13]],
    delhi: [["Yamuna River", 28.61, 77.25]],
    kolkata: [["Hooghly River", 22.57, 88.35]]
  };

  let weather = null;
  let air = null;
  let rivers = [];
  let radar = null;
  let lastError = "";
  let lastState = null;
  let map;
  let radarLayer;
  let timer;

  const city = () => global.ashraayDashboard.currentCity();
  const cityName = () => t(city().name);
  const round = (value) => (value == null || Number.isNaN(value) ? "-" : Math.round(value));
  const level = (value, high, mid) => (value >= high ? "High" : value >= mid ? "Moderate" : "Low");
  const badge = (name) => `<span class="db-sev ${name === "High" ? "sev-high" : name === "Moderate" || name === "Medium" || name === "Warning" ? "sev-medium" : "sev-low"}">${html(t(name))}</span>`;
  const hourLabel = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  function weatherLabel(code) {
    if (code === 0) return "Clear sky";
    if (code <= 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code >= 51 && code <= 57) return "Drizzle";
    if (code === 61 || code === 80) return "Light rain";
    if (code === 63 || code === 81) return "Moderate rain";
    if (code === 65 || code === 82) return "Heavy rain";
    if (code >= 95) return "Thunderstorm";
    return "Cloudy";
  }
  function icon(code) {
    const cloud = '<path d="M7 17a4 4 0 1 1 1-7.9A5 5 0 0 1 18 11a3 3 0 0 1 0 6z"/>';
    const svg = (body, cls) => `<svg class="wx ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    if (code === 0) return svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', "sun");
    if (code >= 95) return svg(`${cloud}<path d="m12 14-2 4h3l-2 4"/>`, "storm");
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return svg('<path d="M7 14a4 4 0 1 1 1-7.9A5 5 0 0 1 18 8a3 3 0 0 1 0 6z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>', "rain");
    return svg(cloud, "");
  }

  // ---------- data ----------
  async function load() {
    const { id, lat, lon } = city();
    const forecast = new URLSearchParams({
      latitude: lat, longitude: lon, timezone: "auto", past_days: "1", forecast_days: "5",
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,dew_point_2m,pressure_msl,wind_speed_10m,wind_gusts_10m,weather_code,visibility,uv_index,precipitation_probability",
      hourly: "temperature_2m,precipitation,precipitation_probability,weather_code,wind_gusts_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max"
    });
    const quality = new URLSearchParams({ latitude: lat, longitude: lon, timezone: "auto", current: "us_aqi,pm2_5,pm10", hourly: "us_aqi", forecast_days: "1" });
    try {
      const [weatherResponse, airResponse, radarResponse, ...riverResponses] = await Promise.all([
        fetch(`https://api.open-meteo.com/v1/forecast?${forecast}`),
        fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${quality}`).catch(() => null),
        fetch("https://api.rainviewer.com/public/weather-maps.json").catch(() => null),
        ...(RIVERS[id] || []).map(([, rLat, rLon]) => fetch(`https://flood-api.open-meteo.com/v1/flood?${new URLSearchParams({
          latitude: rLat, longitude: rLon, daily: "river_discharge,river_discharge_median", past_days: "2", forecast_days: "8"
        })}`).catch(() => null))
      ]);
      if (!weatherResponse.ok) throw new Error(`Weather service returned ${weatherResponse.status}`);
      weather = await weatherResponse.json();
      air = airResponse?.ok ? await airResponse.json() : null;
      radar = radarResponse?.ok ? await radarResponse.json() : null;
      rivers = await Promise.all((RIVERS[id] || []).map(async ([name], index) => {
        const response = riverResponses[index];
        return { name, daily: response?.ok ? (await response.json()).daily : null };
      }));
      lastError = "";
      grid = null;
      if (shelters?.failed) shelters = null;
    } catch (error) {
      lastError = error instanceof TypeError ? t("Weather service unreachable (no internet?).") : error.message;
    }
    renderAll();
  }

  function hoursFromNow() {
    const hourly = weather.hourly;
    const nowKey = weather.current.time.slice(0, 13);
    const start = Math.max(0, hourly.time.findIndex((time) => time.slice(0, 13) === nowKey));
    return hourly.time.map((time, index) => ({
      time, index,
      temp: hourly.temperature_2m[index], rain: hourly.precipitation[index] || 0,
      chance: hourly.precipitation_probability[index] || 0, code: hourly.weather_code[index], gust: hourly.wind_gusts_10m[index] || 0
    })).slice(start);
  }

  // ---------- KPIs ----------
  function renderKpis() {
    const current = weather.current;
    const hours = hoursFromNow();
    const next6 = hours.slice(0, 6);
    const next24 = hours.slice(0, 24);
    const yesterdayIndex = weather.hourly.time.findIndex((time) => time.slice(0, 13) === current.time.slice(0, 13)) - 24;
    const delta = yesterdayIndex >= 0 ? current.temperature_2m - weather.hourly.temperature_2m[yesterdayIndex] : null;
    const rainChance = Math.max(0, ...next6.map((hour) => hour.chance));
    const rain24 = next24.reduce((sum, hour) => sum + hour.rain, 0);
    const flood = level(rain24, 64.5, 15);
    const aqi = air?.current?.us_aqi;
    const stormHours = next24.filter((hour) => hour.code >= 95).length;
    $("wx-kpis").innerHTML = [
      ["sun", `${round(current.temperature_2m)}°C`, "Current Temperature", delta == null ? "" : tf("{0}°C from yesterday", `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`)],
      ["rain", `${round(rainChance)}%`, "Rainfall Probability", tf("{0} mm expected (next 6 hours)", next6.reduce((sum, hour) => sum + hour.rain, 0).toFixed(1))],
      ["flood", badge(flood), "Flood Risk Level", tf("{0} mm rain in next 24 h", round(rain24))],
      ["leaf", aqi != null ? round(aqi) : "-", "Air Quality Index", aqi != null ? html(t(aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" : aqi <= 150 ? "Unhealthy for sensitive groups" : "Unhealthy")) : ""],
      ["wind", `${round(current.wind_speed_10m)} km/h`, "Wind Speed", tf("Gusts up to {0} km/h", round(current.wind_gusts_10m))],
      ["bolt", stormHours, "Thunderstorm hours", t("in the next 24 hours")]
    ].map(([kind, value, label, note]) => `<div class="wx-kpi ${kind}"><span class="wx-kpi-ic">${kpiIcon(kind)}</span><div><b>${kind === "flood" ? value : html(String(value))}</b><span>${html(t(label))}</span><small>${kind === "leaf" ? note : html(note)}</small></div></div>`).join("");
  }
  function kpiIcon(kind) {
    const paths = {
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      rain: '<path d="M7 14a4 4 0 1 1 1-7.9A5 5 0 0 1 18 8a3 3 0 0 1 0 6z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
      flood: '<path d="M2 18c2 0 2-1.5 4-1.5S8 18 10 18s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M4 13 12 6l8 7"/>',
      leaf: '<path d="M5 19c0-8 6-14 15-14 0 9-6 15-14 15"/><path d="M5 19 13 11"/>',
      wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
      bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
  }

  // ---------- map ----------
  const layerOn = (name) => Boolean(document.querySelector(`#wx-map-card [data-layer="${name}"]`)?.checked);
  const baseLayer = () => document.querySelector('#wx-map-card [name="wx-base"]:checked')?.value || "radar";
  let overlay;
  let fieldLayer;
  let grid = null;
  let gridLoading = null;
  let shelters = null;
  let sheltersLoading = null;

  // 9x9 grid of sample points (~66 km square) around the city; values are interpolated into a smooth colour field.
  const GRID_N = 9;
  const GRID_HALF = 0.3;
  function gridPoints() {
    const { lat, lon } = city();
    const step = (GRID_HALF * 2) / (GRID_N - 1);
    const steps = Array.from({ length: GRID_N }, (_, index) => -GRID_HALF + index * step);
    return steps.flatMap((dLat) => steps.map((dLon) => [Number((lat + dLat).toFixed(4)), Number((lon + dLon).toFixed(4))]));
  }
  function loadGrid() {
    const cityId = city().id;
    if (grid?.cityId === cityId) return Promise.resolve();
    if (gridLoading) return gridLoading;
    const points = gridPoints();
    const coords = { latitude: points.map((point) => point[0]).join(","), longitude: points.map((point) => point[1]).join(",") };
    gridLoading = Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${new URLSearchParams({ ...coords, current: "temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover" })}`).then((response) => response.ok ? response.json() : null),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${new URLSearchParams({ ...coords, current: "us_aqi,pm2_5" })}`).then((response) => response.ok ? response.json() : null).catch(() => null)
    ]).then(([weatherGrid, airGrid]) => {
      grid = { cityId, points: points.map((point, index) => ({ point, weather: weatherGrid?.[index]?.current, air: airGrid?.[index]?.current })) };
    }).catch(() => {
      grid = { cityId, points: [] };
      $("wx-layer-note").textContent = t("Grid weather data unavailable.");
    })
      .finally(() => { gridLoading = null; renderMap(); });
    return gridLoading;
  }
  // Shelters, relief centres and emergency assembly points mapped in OpenStreetMap (via the public Overpass API).
  function loadShelters() {
    const cityId = city().id;
    if (shelters?.cityId === cityId) return Promise.resolve();
    if (sheltersLoading) return sheltersLoading;
    const { lat, lon } = city();
    const box = `${(lat - 0.2).toFixed(3)},${(lon - 0.2).toFixed(3)},${(lat + 0.2).toFixed(3)},${(lon + 0.2).toFixed(3)}`;
    const query = `[out:json][timeout:25];(nwr["emergency"="assembly_point"](${box});nwr["social_facility"="shelter"](${box});nwr["amenity"="community_centre"](${box}););out center 300;`;
    $("wx-layer-note").textContent = t("Loading shelters from OpenStreetMap…");
    sheltersLoading = fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(query)}`
    }).then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
      .then((data) => {
        shelters = { cityId, items: data.elements.map((element) => ({
          lat: element.lat ?? element.center?.lat, lon: element.lon ?? element.center?.lon,
          name: element.tags?.name || element.tags?.["name:en"] || "",
          kind: element.tags?.emergency === "assembly_point" ? "Assembly point" : element.tags?.social_facility === "shelter" ? "Shelter" : "Community centre"
        })).filter((item) => Number.isFinite(item.lat)) };
        $("wx-layer-note").textContent = "";
      })
      .catch(() => {
        shelters = { cityId, items: [], failed: true };
        $("wx-layer-note").textContent = t("Shelter data unavailable (OpenStreetMap service busy). Try again later.");
      })
      .finally(() => { sheltersLoading = null; renderMap(); });
    return sheltersLoading;
  }

  // Colour ramps: [value, [r, g, b, alpha 0-255]].
  const RAMPS = {
    temperature: [[16, [44, 123, 182, 170]], [20, [0, 166, 202, 170]], [24, [0, 204, 188, 170]], [27, [144, 235, 157, 170]], [30, [255, 255, 140, 175]], [33, [249, 208, 87, 180]], [35, [242, 158, 46, 185]], [37, [231, 104, 24, 190]], [40, [215, 25, 28, 195]]],
    wind: [[0, [224, 243, 248, 120]], [10, [171, 217, 233, 150]], [20, [116, 173, 209, 165]], [30, [69, 117, 180, 175]], [45, [253, 174, 97, 185]], [60, [215, 48, 39, 195]]],
    cloud: [[0, [120, 130, 145, 0]], [50, [120, 130, 145, 110]], [100, [90, 100, 115, 200]]],
    aqi: [[0, [0, 228, 0, 150]], [50, [255, 255, 0, 160]], [100, [255, 126, 0, 170]], [150, [255, 0, 0, 180]], [200, [143, 63, 151, 185]], [300, [126, 0, 35, 190]]]
  };
  const UNITS = { temperature: "°C", wind: "km/h", cloud: "%", aqi: "US AQI" };
  function rampColor(ramp, value) {
    if (value <= ramp[0][0]) return ramp[0][1];
    for (let index = 1; index < ramp.length; index++) {
      const [stop, color] = ramp[index];
      if (value <= stop) {
        const [prevStop, prev] = ramp[index - 1];
        const ratio = (value - prevStop) / (stop - prevStop);
        return prev.map((channel, i) => Math.round(channel + (color[i] - channel) * ratio));
      }
    }
    return ramp.at(-1)[1];
  }
  const rgba = (color) => `rgba(${color[0]},${color[1]},${color[2]},${(color[3] / 255).toFixed(2)})`;
  // Temperature colours are stretched over today's local range (min 6 °C wide) so city-scale differences show; the legend lists the real values.
  function activeRamp(kind) {
    const ramp = RAMPS[kind];
    if (kind !== "temperature" || !grid?.points.length) return ramp;
    const values = grid.points.map((sample) => sample.weather?.temperature_2m).filter((value) => value != null);
    if (!values.length) return ramp;
    let low = Math.floor(Math.min(...values)) - 1;
    let high = Math.ceil(Math.max(...values)) + 1;
    if (high - low < 6) { const mid = (high + low) / 2; low = Math.floor(mid - 3); high = Math.ceil(mid + 3); }
    return ramp.map(([, color], index) => [Number((low + ((high - low) * index) / (ramp.length - 1)).toFixed(1)), color.slice(0, 3).concat(200)]);
  }
  const fieldValue = (sample, kind) => kind === "temperature" ? sample.weather?.temperature_2m
    : kind === "wind" ? sample.weather?.wind_speed_10m
    : kind === "cloud" ? sample.weather?.cloud_cover
    : sample.air?.us_aqi;

  // Bilinear interpolation of the sample grid into a canvas image laid over the map.
  function fieldImage(kind) {
    const values = grid.points.map((sample) => fieldValue(sample, kind));
    if (values.some((value) => value == null)) return null;
    const size = 200;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const image = context.createImageData(size, size);
    const at = (row, col) => values[row * GRID_N + col];
    const ramp = activeRamp(kind);
    for (let py = 0; py < size; py++) {
      const fy = (1 - py / (size - 1)) * (GRID_N - 1);
      const row = Math.min(GRID_N - 2, Math.floor(fy));
      const dy = fy - row;
      for (let px = 0; px < size; px++) {
        const fx = (px / (size - 1)) * (GRID_N - 1);
        const col = Math.min(GRID_N - 2, Math.floor(fx));
        const dx = fx - col;
        const value = at(row, col) * (1 - dx) * (1 - dy) + at(row, col + 1) * dx * (1 - dy)
          + at(row + 1, col) * (1 - dx) * dy + at(row + 1, col + 1) * dx * dy;
        const color = rampColor(ramp, value);
        const offset = (py * size + px) * 4;
        image.data.set(color, offset);
      }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }
  const PIN_ICONS = {
    alert: '<path d="M12 7v6M12 16.5h.01" stroke-width="3"/>',
    flood: '<path d="M5 15c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1M7 11l5-4 5 4"/>',
    landslide: '<path d="M5 17h14l-5-8-3 4-2-2z"/>',
    rain: '<path d="M8 13a3 3 0 1 1 .8-5.9A4 4 0 0 1 16 8a2.5 2.5 0 0 1 0 5z"/><path d="M9 16l-1 2M13 16l-1 2"/>',
    house: '<path d="M6 12 12 7l6 5M8 11v6h8v-6"/>',
    drop: '<path d="M12 6s-4 4.6-4 7.5a4 4 0 0 0 8 0C16 10.6 12 6 12 6z"/>',
    person: '<circle cx="12" cy="9" r="2.5"/><path d="M8 17c0-2.5 1.8-4 4-4s4 1.5 4 4"/>'
  };
  const pin = (color, kind, size = 32) => global.L.divIcon({
    className: "", iconSize: [size, size * 1.25], iconAnchor: [size / 2, size * 1.2], popupAnchor: [0, -size * 1.05],
    html: `<span class="wx-pin" style="--c:${color};--s:${size}px"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PIN_ICONS[kind] || PIN_ICONS.alert}</svg></span>`
  });
  const popup = ({ color, title, place, detail, level: severity, action }) =>
    `<div class="wx-pop"><span class="wx-pop-ic" style="--c:${color}"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6M12 16.5h.01"/></svg></span>
      <div><b>${html(title)}</b>${place ? `<small>${html(place)}</small>` : ""}${detail ? `<small>${html(detail)}</small>` : ""}${action || ""}</div>${severity ? badge(severity) : ""}</div>`;

  function renderLegend() {
    const legend = $("wx-legend");
    const kind = baseLayer();
    if (RAMPS[kind]) {
      const ramp = activeRamp(kind);
      const min = ramp[0][0];
      const span = ramp.at(-1)[0] - min;
      const stops = ramp.map(([value, color]) => `${rgba([color[0], color[1], color[2], Math.max(color[3], 160)])} ${(((value - min) / span) * 100).toFixed(0)}%`).join(",");
      const ticks = [ramp[0], ramp[Math.floor(ramp.length / 2)], ramp.at(-1)].map(([value]) => `<i>${round(value)}</i>`).join("");
      const title = { temperature: "Temperature", wind: "Wind Speed", cloud: "Cloud Cover", aqi: "Air Quality" }[kind];
      legend.innerHTML = `<b>${html(t(title))} (${UNITS[kind]})</b><span class="wx-scale" style="background:linear-gradient(90deg,${stops})"></span><span class="wx-ticks">${ticks}</span>`;
    } else if (kind === "radar") {
      legend.innerHTML = `<b>${html(t("Rainfall Intensity"))}</b><span class="wx-scale" style="background:linear-gradient(90deg,#00d8c3,#00a0ff,#2ec53a,#f2e300,#ff9000,#ff2a00,#c8007c)"></span><span class="wx-ticks"><i>${html(t("Light"))}</i><i>${html(t("Moderate"))}</i><i>${html(t("Heavy"))}</i><i>${html(t("Extreme"))}</i></span>`;
    } else legend.innerHTML = "";
    legend.hidden = !legend.innerHTML;
    document.querySelectorAll("#wx-chips [data-chip]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.chip === kind)));
  }

  function ensureMap() {
    if (map || !global.L || !$("wx-map")) return Boolean(map);
    const L = global.L;
    map = L.map("wx-map", { zoomControl: false }).setView([city().lat, city().lon], 10);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ metric: true, imperial: false, position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    overlay = L.layerGroup().addTo(map);
    return true;
  }
  function renderMap() {
    if (!ensureMap()) return;
    const L = global.L;
    map.invalidateSize();
    renderLegend();
    const frame = radar?.radar?.past?.at(-1);
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
    if (frame && baseLayer() === "radar") {
      // RainViewer serves radar tiles up to zoom 7; Leaflet upscales beyond that. Colour scheme 4 is a rainbow scale.
      radarLayer = L.tileLayer(`${radar.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`, {
        opacity: 0.75, maxNativeZoom: 7, maxZoom: 19, attribution: "Radar &copy; RainViewer"
      }).addTo(map);
    }
    $("wx-radar-time").textContent = frame ? tf("Radar frame: {0}", new Date(frame.time * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })) : t("Radar unavailable");
    overlay.clearLayers();
    drawOverlays(L);
  }

  function drawOverlays(L) {
    const kind = baseLayer();
    if (fieldLayer) { map.removeLayer(fieldLayer); fieldLayer = null; }
    if (RAMPS[kind] && grid?.cityId !== city().id) loadGrid();
    if (RAMPS[kind] && grid?.cityId === city().id && grid.points.length) {
      const image = fieldImage(kind);
      const first = grid.points[0].point;
      const last = grid.points.at(-1).point;
      if (image) fieldLayer = L.imageOverlay(image, [first, last], { opacity: 0.85, interactive: false }).addTo(map);
      // Value labels on every other sample point so the field stays readable.
      grid.points.forEach((sample, index) => {
        const row = Math.floor(index / GRID_N);
        const col = index % GRID_N;
        if (row % 2 || col % 2) return;
        const value = fieldValue(sample, kind);
        if (value == null) return;
        const text = kind === "temperature" ? `${round(value)}°`
          : kind === "wind" ? `<i style="transform:rotate(${(sample.weather.wind_direction_10m + 180) % 360}deg)">&uarr;</i>${round(value)}`
          : kind === "cloud" ? `${round(value)}%` : `${round(value)}`;
        L.marker(sample.point, {
          icon: L.divIcon({ className: "", iconSize: null, html: `<span class="wx-val ${kind}">${text}</span>` }),
          interactive: false, keyboard: false
        }).addTo(overlay);
      });
    }

    if (layerOn("shelters")) {
      if (shelters?.cityId !== city().id) loadShelters();
      else {
        for (const item of shelters.items) {
          L.marker([item.lat, item.lon], { icon: pin(item.kind === "Community centre" ? "#4E9A6A" : "#2E8B57", "house", 24), title: item.name || t(item.kind) })
            .bindPopup(popup({ color: "#2E8B57", title: item.name || t(item.kind), place: t(item.kind), detail: "OpenStreetMap" }))
            .addTo(overlay);
        }
      }
    }

    if (layerOn("rivers")) {
      (RIVERS[city().id] || []).forEach(([name, rLat, rLon], index) => {
        const status = rivers[index] ? riverStatus(rivers[index]) : null;
        const color = !status ? "#8A99A8" : status.level === "High" ? "#D93025" : status.level === "Warning" ? "#E08A0B" : "#1E6FE0";
        L.marker([rLat, rLon], { icon: pin(color, "drop"), title: t(name) })
          .bindPopup(popup({
            color, title: t(name),
            place: status ? `${t("Discharge")}: ${status.now.toFixed(1)} m³/s ${status.trend}` : t("No data"),
            detail: t("Modelled river discharge (GloFAS) at approximate river points; not a gauge reading."),
            level: status?.level
          }))
          .addTo(overlay);
      });
    }

    if (!lastState) return;
    if (layerOn("checkins")) {
      const colors = { safe: "#1E9E5A", at_risk: "#E08A0B", need_help: "#D93025" };
      const labels = { safe: "Safe", at_risk: "At Risk", need_help: "Need Help" };
      for (const checkin of lastState.checkins || []) {
        if (!Number.isFinite(checkin.latitude) || !colors[checkin.status]) continue;
        L.marker([checkin.latitude, checkin.longitude], { icon: pin(colors[checkin.status], "person", 24) })
          .bindPopup(popup({ color: colors[checkin.status], title: `${t("Check-in")}: ${t(labels[checkin.status])}`, place: checkin.landmark, detail: new Date(checkin.time).toLocaleString(locale(), { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) }))
          .addTo(overlay);
      }
    }
    if (layerOn("incidents")) {
      for (const incident of lastState.incidents || []) {
        if (["resolved", "dismissed"].includes(incident.status)) continue;
        const report = (lastState.reports || []).find((item) => incident.reportIds?.includes(item.id) && Number.isFinite(item.latitude));
        if (!report) continue;
        const color = incident.severity === "high" ? "#D93025" : "#E08A0B";
        const kind = report.incidentType === "landslide" ? "landslide" : report.incidentType === "heavy-rain" ? "rain" : report.incidentType === "flood" ? "flood" : "alert";
        const decidable = ["received", "needs_review"].includes(incident.status) && auth.hasRole("incident-commander", "verifier");
        if (incident.severity === "high") L.circle([report.latitude, report.longitude], { radius: 800, color, weight: 1, fillOpacity: 0.12, interactive: false }).addTo(overlay);
        L.marker([report.latitude, report.longitude], { icon: pin(color, kind), title: incident.summary, zIndexOffset: 1000 })
          .bindPopup(popup({
            color, title: incident.summary, place: incident.landmark,
            detail: `${tf("{0} people reported", incident.reportedPeople ?? 0)} · ${new Date(incident.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}`,
            level: incident.severity === "high" ? "High" : "Moderate",
            action: decidable ? `<div class="db-q-actions"><button type="button" data-action="report-approve" data-id="${html(report.id)}">${html(t("Approve"))}</button><button type="button" class="danger" data-action="report-discard" data-id="${html(report.id)}">${html(t("Discard"))}</button></div>` : ""
          }), { minWidth: 240 })
          .addTo(overlay);
      }
    }
  }

  // ---------- current conditions, forecast ----------
  function renderConditions() {
    const current = weather.current;
    const cells = [
      ["Temperature", `${round(current.temperature_2m)}°C`],
      ["Humidity", `${round(current.relative_humidity_2m)}%`],
      ["Pressure", `${round(current.pressure_msl)} hPa`],
      ["PM2.5", air?.current?.pm2_5 != null ? `${round(air.current.pm2_5)} µg/m³` : "-"],
      ["PM10", air?.current?.pm10 != null ? `${round(air.current.pm10)} µg/m³` : "-"],
      ["UV Index", `${current.uv_index != null ? current.uv_index.toFixed(1) : "-"}`, current.uv_index >= 8 ? "High" : current.uv_index >= 6 ? "Moderate" : null],
      ["Visibility", current.visibility != null ? `${(current.visibility / 1000).toFixed(1)} km` : "-"],
      ["Dew Point", `${round(current.dew_point_2m)}°C`],
      ["Feels Like", `${round(current.apparent_temperature)}°C`]
    ];
    $("wx-cond-title").textContent = tf("Current Conditions - {0}", cityName());
    $("wx-updated").textContent = tf("Last updated: {0}", hourLabel(current.time));
    $("wx-conditions").innerHTML = cells.map(([label, value, flag]) =>
      `<div class="wx-cell"><small>${html(t(label))}</small><b>${html(value)}</b>${flag ? badge(flag) : ""}</div>`).join("");

    const daily = weather.daily;
    const today = weather.current.time.slice(0, 10);
    const days = daily.time.map((day, index) => ({ day, index })).filter(({ day }) => day >= today).slice(0, 5);
    $("wx-days").innerHTML = days.map(({ day, index }) => {
      const rain = daily.precipitation_sum[index] || 0;
      const gust = daily.wind_gusts_10m_max[index] || 0;
      const risk = rain >= 64.5 || gust >= 60 ? "High" : rain >= 15 || gust >= 45 ? "Moderate" : "Low";
      const date = new Date(`${day}T00:00`);
      return `<li><b>${html(day === today ? t("Today") : date.toLocaleDateString(locale(), { weekday: "short" }))}</b><small>${html(date.toLocaleDateString(locale(), { day: "numeric", month: "short" }))}</small>${icon(daily.weather_code[index])}<span>${round(daily.temperature_2m_min[index])}° / ${round(daily.temperature_2m_max[index])}°</span><small>${html(t(weatherLabel(daily.weather_code[index])))}</small><small>${round(rain)} mm · ${round(daily.precipitation_probability_max[index])}%</small>${badge(risk)}</li>`;
    }).join("");
    $("wx-hours").innerHTML = hoursFromNow().filter((_, index) => index % 2 === 0).slice(0, 8).map((hour, index) =>
      `<li><small>${html(index === 0 ? t("Now") : hourLabel(hour.time))}</small>${icon(hour.code)}<b>${round(hour.temp)}°</b><small>${round(hour.chance)}%</small></li>`).join("");
  }

  // ---------- alerts feed and insights ----------
  function alerts() {
    const hours = hoursFromNow().slice(0, 48);
    const list = [];
    const heavy = hours.find((hour) => hour.rain >= 7.5);
    if (heavy) list.push({ time: heavy.time, level: "High", title: "Heavy rainfall expected", detail: tf("{0} mm/h around {1}", heavy.rain.toFixed(1), hourLabel(heavy.time)) });
    const storm = hours.find((hour) => hour.code >= 95);
    if (storm) list.push({ time: storm.time, level: "Moderate", title: "Thunderstorm expected", detail: hourLabel(storm.time) });
    const gust = hours.reduce((max, hour) => (hour.gust > max.gust ? hour : max), { gust: 0 });
    if (gust.gust >= 45) list.push({ time: gust.time, level: gust.gust >= 60 ? "High" : "Moderate", title: "High wind speeds expected", detail: tf("Gusts up to {0} km/h", round(gust.gust)) });
    const aqiHours = air?.hourly?.us_aqi || [];
    const aqiPeak = Math.max(0, ...aqiHours.filter((value) => value != null));
    if (aqiPeak > 100) list.push({ time: weather.current.time, level: aqiPeak > 150 ? "High" : "Moderate", title: "Air quality deteriorating", detail: tf("US AQI up to {0} today", round(aqiPeak)) });
    for (const river of rivers) {
      const status = riverStatus(river);
      if (status && status.level !== "Normal") list.push({ time: weather.current.time, level: status.level === "High" ? "High" : "Moderate", title: "River level rising", detail: t(river.name) });
    }
    for (const incident of (lastState?.incidents || []).filter((item) => !["resolved", "dismissed"].includes(item.status)).slice(-5)) {
      list.push({ time: incident.time, level: incident.severity === "high" ? "High" : "Moderate", title: "Incident reported", detail: incident.landmark, reported: true });
    }
    return list.sort((a, b) => new Date(b.time) - new Date(a.time));
  }
  function renderAlerts() {
    const list = alerts();
    $("wx-alerts").innerHTML = list.length ? list.map((item) => `
      <li class="lv-${item.level.toLowerCase()}"><span class="wx-al-ic">${kpiIcon(item.reported ? "flood" : item.title.includes("wind") ? "wind" : item.title.includes("Thunder") ? "bolt" : item.title.includes("Air") ? "leaf" : "rain")}</span>
        <div><small>${html(item.reported ? new Date(item.time).toLocaleString(locale(), { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : hourLabel(item.time))}</small><b>${html(t(item.title))}</b><small>${html(item.detail)}</small></div>${badge(item.level)}</li>`).join("")
      : `<li class="db-empty">${html(t("No active weather alerts."))}</li>`;
    const hours = hoursFromNow();
    const next6 = hours.slice(0, 6);
    const rainChance = Math.max(0, ...next6.map((hour) => hour.chance));
    const rain6 = next6.reduce((sum, hour) => sum + hour.rain, 0);
    const rain24 = hours.slice(0, 24).reduce((sum, hour) => sum + hour.rain, 0);
    const rainPrev24 = weather.hourly.precipitation.slice(Math.max(0, hours[0].index - 24), hours[0].index).reduce((sum, value) => sum + (value || 0), 0);
    const windy = hours.slice(0, 24).filter((hour) => hour.gust >= 40);
    const insights = [
      { text: tf("{0}% chance of rain in {1} within 6 hours ({2} mm expected).", round(rainChance), cityName(), rain6.toFixed(1)), value: `${round(rainChance)}%`, label: "Probability", level: level(rainChance, 70, 40) },
      { text: rain24 > rainPrev24 * 1.2 && rain24 >= 5
        ? tf("Flood risk increasing: {0} mm forecast in the next 24 hours vs {1} mm in the last 24 hours.", round(rain24), round(rainPrev24))
        : tf("Flood risk stable: {0} mm forecast in the next 24 hours.", round(rain24)), value: t(level(rain24, 64.5, 15)), label: "Flood risk", level: level(rain24, 64.5, 15) },
      { text: windy.length
        ? tf("Strong winds expected between {0} and {1}.", hourLabel(windy[0].time), hourLabel(windy.at(-1).time))
        : t("No strong winds expected in the next 24 hours."), value: `${round(Math.max(0, ...hours.slice(0, 24).map((hour) => hour.gust)))}`, label: "km/h peak gust", level: windy.length ? "Moderate" : "Low" }
    ];
    $("wx-insights").innerHTML = insights.map((item) => `<li class="lv-${item.level.toLowerCase()}">${kpiIcon(item.level === "Low" ? "leaf" : "bolt")}<span>${html(item.text)}</span><div><b>${html(item.value)}</b><small>${html(t(item.label))}</small></div></li>`).join("");
  }

  // ---------- flood & rivers ----------
  function riverStatus(river) {
    const daily = river.daily;
    if (!daily?.river_discharge) return null;
    const today = daily.time.indexOf(weather?.current?.time.slice(0, 10));
    const index = today >= 0 ? today : 2;
    const now = daily.river_discharge[index];
    const yesterday = daily.river_discharge[index - 1];
    // Compare today's flow with the most likely (ensemble median) peak over the coming week.
    const peak = Math.max(...(daily.river_discharge_median || []).slice(index).filter((value) => value != null), now);
    if (now == null || !peak) return null;
    if (peak < 1) return { now, peak, percent: 100, level: "Normal", trend: "→" };
    const rise = now > 0 ? peak / now : 1;
    return {
      now, peak, percent: Math.round((now / peak) * 100),
      level: rise >= 1.5 ? "High" : rise >= 1.15 ? "Warning" : "Normal",
      trend: yesterday == null ? "→" : now > yesterday * 1.03 ? "↑" : now < yesterday * 0.97 ? "↓" : "→"
    };
  }
  function renderRivers() {
    $("wx-rivers").innerHTML = rivers.length ? rivers.map((river) => {
      const status = riverStatus(river);
      if (!status) return `<tr><td>${html(t(river.name))}</td><td colspan="4" class="muted">${html(t("No data"))}</td></tr>`;
      const color = status.level === "High" ? "#D93025" : status.level === "Warning" ? "#E08A0B" : "#1E9E5A";
      return `<tr><td>${html(t(river.name))}</td><td class="nw">${status.now.toFixed(1)} m³/s</td><td><span class="wx-bar"><i style="width:${status.percent}%;background:${color}"></i></span> ${status.percent}%</td><td>${badge(status.level)}</td><td class="wx-trend">${status.trend}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="db-empty">${html(t("No river gauges configured for this city."))}</td></tr>`;
  }
  function renderFlood() {
    const hours = hoursFromNow();
    const rain24 = hours.slice(0, 24).reduce((sum, hour) => sum + hour.rain, 0);
    const rows = [];
    const active = (lastState?.incidents || []).filter((item) => !["resolved", "dismissed"].includes(item.status));
    const byArea = new Map();
    for (const incident of active) {
      const row = byArea.get(incident.landmark) || { count: 0, high: false, latest: 0, verified: false };
      row.count += 1;
      row.high ||= incident.severity === "high";
      row.verified ||= incident.status === "verified";
      row.latest = Math.max(row.latest, new Date(incident.time).getTime());
      byArea.set(incident.landmark, row);
    }
    for (const [area, row] of byArea) {
      rows.push({
        area, risk: row.high ? "High" : "Medium",
        reason: `${tf("{0} active report(s)", row.count)}${row.verified ? ` · ${t("Confirmed")}` : ""}`,
        trend: Date.now() - row.latest < 3600000 ? "↑" : "→"
      });
    }
    rows.push({ area: cityName(), risk: level(rain24, 64.5, 15) === "Moderate" ? "Medium" : level(rain24, 64.5, 15), reason: tf("{0} mm rain in next 24 h", round(rain24)), trend: "→" });
    $("wx-flood").innerHTML = rows.map((row) => `<tr><td>${html(row.area)}</td><td>${badge(row.risk)}</td><td>${html(row.reason)}</td><td class="wx-trend">${row.trend}</td></tr>`).join("");
  }

  function renderAll() {
    $("wx-city").value = city().id;
    if (!weather) {
      const message = `<p class="db-empty">${html(lastError || t("Loading weather…"))}</p>`;
      ["wx-kpis", "wx-conditions", "wx-alerts", "wx-insights"].forEach((id) => { $(id).innerHTML = message; });
      return;
    }
    renderKpis();
    renderConditions();
    renderAlerts();
    renderRivers();
    renderFlood();
    renderMap();
    $("wx-source").textContent = lastError || t("Sources: Open-Meteo (weather, air quality, GloFAS river discharge), RainViewer (radar), OpenStreetMap.");
  }

  function situationReport() {
    if (!weather) return;
    const current = weather.current;
    const lines = [
      `ASHRAAY situation report - ${cityName()} - ${new Date().toLocaleString(locale())}`,
      "",
      `Temperature ${round(current.temperature_2m)}°C (feels ${round(current.apparent_temperature)}°C), humidity ${round(current.relative_humidity_2m)}%, wind ${round(current.wind_speed_10m)} km/h (gusts ${round(current.wind_gusts_10m)}), US AQI ${round(air?.current?.us_aqi)}`,
      "",
      "Alerts:",
      ...alerts().map((item) => `- [${item.level}] ${item.title}: ${item.detail}`),
      "",
      "Rivers:",
      ...rivers.map((river) => { const status = riverStatus(river); return `- ${river.name}: ${status ? `${status.now.toFixed(1)} m3/s, ${status.level}, trend ${status.trend}` : "no data"}`; }),
      "",
      `Active incidents: ${(lastState?.incidents || []).filter((item) => !["resolved", "dismissed"].includes(item.status)).length}`,
      `Check-ins needing help: ${(lastState?.checkins || []).filter((item) => item.status === "need_help").length}`,
      "",
      "Sources: Open-Meteo, GloFAS via Open-Meteo, RainViewer. Rule-based risk levels; not an official warning."
    ];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/plain" }));
    link.download = `ashraay-situation-${city().id}-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function init() {
    const select = $("wx-city");
    const fill = () => {
      select.innerHTML = Object.entries(global.ashraayDashboard.cities).map(([id, item]) => `<option value="${id}">${html(t(item.name))}</option>`).join("");
      select.value = city().id;
    };
    fill();
    select.addEventListener("change", () => global.ashraayDashboard.setCity(select.value));
    document.addEventListener("ashraay:city-change", () => {
      weather = null;
      renderAll();
      if (map) map.setView([city().lat, city().lon], 10);
      load();
    });
    $("wx-map-card").addEventListener("change", (event) => { if (event.target.matches("[data-layer], [name='wx-base']")) renderMap(); });
    $("wx-chips").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-chip]");
      if (chip) {
        const radio = document.querySelector(`#wx-map-card [name="wx-base"][value="${chip.dataset.chip}"]`);
        radio.checked = true;
        renderMap();
      } else if (event.target.closest("#wx-more")) {
        const panel = document.querySelector("#wx-map-card .wx-layers");
        panel.open = !panel.open;
      }
    });
    $("wx-full").addEventListener("click", () => {
      $("wx-map-card").classList.toggle("wx-fullscreen");
      setTimeout(() => map?.invalidateSize(), 50);
    });
    $("wx-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-target]");
      if (!button) return;
      document.querySelectorAll("#wx-tabs [data-target]").forEach((other) => other.setAttribute("aria-selected", String(other === button)));
      $(button.dataset.target).scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("wx-report").addEventListener("click", situationReport);
    document.addEventListener("ashraay:language-change", () => { fill(); renderAll(); });
  }

  function shown() {
    if (!timer) {
      load();
      timer = setInterval(load, REFRESH_MS);
    }
    if (ensureMap()) setTimeout(() => { map.invalidateSize(); renderMap(); }, 0);
  }

  function render(state) {
    lastState = state;
    if (weather) { renderAlerts(); renderFlood(); renderMap(); }
  }

  global.ashraayWeather = { init, shown, render };
})(window);
