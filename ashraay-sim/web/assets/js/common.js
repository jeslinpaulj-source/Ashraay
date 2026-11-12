/* Shared helpers: API client, live updates (SSE + polling fallback), formatting, icons, chart. */
(function () {
  const STATUS = {
    normal: { label: "Normal", wx: "Green", color: "#2e9e5b" },
    above_normal: { label: "Above Normal", wx: "Yellow", color: "#f2b705" },
    severe: { label: "Severe", wx: "Orange", color: "#f07c00" },
    extreme: { label: "Extreme", wx: "Red", color: "#d7263d" },
  };
  const ORDER = ["extreme", "severe", "above_normal", "normal"];
  const RANK = { normal: 0, above_normal: 1, severe: 2, extreme: 3 };
  const WXLABEL = { normal: "Green · no warning", above_normal: "Yellow · be aware", severe: "Orange · be prepared", extreme: "Red · take action" };
  // IMD 24-hour rainfall categories
  const RAIN = [
    { k: "no_rain", lo: 0, label: "No rain", short: "None", color: "#eef2f6", fg: "#6b7d8f" },
    { k: "very_light", lo: 0.1, label: "Very light rain", short: "Very light", color: "#d6e9f8", fg: "#2a5a85" },
    { k: "light", lo: 2.5, label: "Light rain", short: "Light", color: "#a9d0ef", fg: "#1d4b73" },
    { k: "moderate", lo: 15.6, label: "Moderate rain", short: "Moderate", color: "#4a90d0", fg: "#fff" },
    { k: "heavy", lo: 64.5, label: "Heavy rain", short: "Heavy", color: "#f2b705", fg: "#3d2c00" },
    { k: "very_heavy", lo: 115.6, label: "Very heavy rain", short: "Very heavy", color: "#f07c00", fg: "#fff" },
    { k: "extremely_heavy", lo: 204.5, label: "Extremely heavy rain", short: "Extremely heavy", color: "#d7263d", fg: "#fff" },
  ];
  const RAINK = Object.fromEntries(RAIN.map((r) => [r.k, r]));
  function statusInk(s) { return { normal: "#1f7a45", above_normal: "#9a7400", severe: "#c45f00", extreme: "#c41e33" }[s]; }
  function rainInk(c) { return { no_rain: "#6b7d8f", very_light: "#2a5a85", light: "#2a5a85", moderate: "#2f74c0", heavy: "#9a7400", very_heavy: "#c45f00", extremely_heavy: "#c41e33" }[c.k]; }
  function rainCat(mm) { let c = RAIN[0]; if (mm > 0) for (const r of RAIN.slice(1)) if (mm >= r.lo) c = r; return c; }
  function wxStatusFromRain(mm) { const k = rainCat(mm).k; return k === "extremely_heavy" ? "extreme" : k === "very_heavy" ? "severe" : k === "heavy" ? "above_normal" : "normal"; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmt(n, d = 2) { return n == null || isNaN(n) ? "–" : Number(n).toFixed(d); }
  function mm(n) { return n == null ? "–" : n >= 100 ? Math.round(n) + "" : (Math.round(n * 10) / 10) + ""; }
  function fmtTime(iso) {
    if (!iso) return "–";
    return new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function fmtDate(iso) { return new Date(iso + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" }); }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " d ago";
  }
  function pill(status, label) { return `<span class="pill s-${status}"><i></i>${esc(label || STATUS[status].label)}</span>`; }
  function wxPill(status, short) { return pill(status, short ? STATUS[status].wx : WXLABEL[status]); }

  /* ---------- icons (lucide-style strokes) ---------- */
  const P = {
    dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    cloudrain: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
    waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
    dam: '<path d="M3 20h18"/><path d="M5 20V8l4-2v14"/><path d="M9 10c2 0 2 1.5 4 1.5s2-1.5 4-1.5 2 1.5 4 1.5"/><path d="M9 15c2 0 2 1.5 4 1.5s2-1.5 4-1.5 2 1.5 4 1.5"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    wind: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
    therm: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
    drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  };
  function icon(name, size = 16, color = "currentColor", sw = 2) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
  }
  /* weather condition icons (filled, colourful) */
  function wxIcon(kind, size = 40) {
    const sun = '<circle cx="24" cy="22" r="8" fill="#f6b52e"/><g stroke="#f6b52e" stroke-width="2.5" stroke-linecap="round"><line x1="24" y1="6" x2="24" y2="9"/><line x1="24" y1="35" x2="24" y2="38"/><line x1="8" y1="22" x2="11" y2="22"/><line x1="37" y1="22" x2="40" y2="22"/><line x1="12.7" y1="10.7" x2="14.8" y2="12.8"/><line x1="33.2" y1="31.2" x2="35.3" y2="33.3"/><line x1="12.7" y1="33.3" x2="14.8" y2="31.2"/><line x1="33.2" y1="12.8" x2="35.3" y2="10.7"/></g>';
    const cloud = (c, dy = 0) => `<path transform="translate(0 ${dy})" d="M14 36h20a8 8 0 0 0 0-16 11 11 0 0 0-21 3A6.5 6.5 0 0 0 14 36z" fill="${c}"/>`;
    const drops = (n, c) => Array.from({ length: n }, (_, i) => `<line x1="${16 + i * 6}" y1="${39}" x2="${14 + i * 6}" y2="${45}" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`).join("");
    let s = "";
    if (kind === "sun") s = sun;
    else if (kind === "partly") s = `<g transform="translate(-5 -5) scale(.8)">${sun}</g>` + cloud("#dbe5ef", 2);
    else if (kind === "cloud") s = cloud("#b9c7d6", -2) + `<path d="M8 30h12" stroke="#fff" stroke-width="0"/>`;
    else if (kind === "drizzle") s = cloud("#b9c7d6", -6) + drops(2, "#4a90d0");
    else if (kind === "rain") s = cloud("#8fa3b8", -6) + drops(3, "#2f74c0");
    else if (kind === "heavy_rain") s = cloud("#5f7387", -6) + drops(4, "#1f5fa8");
    else if (kind === "storm") s = cloud("#4d5f72", -6) + '<path d="M25 30l-5 9h5l-3 8 9-11h-5l3-6z" fill="#f6b52e"/>' + drops(2, "#2f74c0");
    return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">${s}</svg>`;
  }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    const tok = localStorage.getItem("ffsSimToken");
    if (tok) headers["X-Sim-Token"] = tok;
    const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 401) {
      const t = prompt("This server needs a simulation token (FFS_SIM_TOKEN). Enter it:");
      if (t) { localStorage.setItem("ffsSimToken", t); return api(path, opts); }
    }
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  /* Live updates: Server-Sent Events, with automatic polling fallback. */
  function liveFeed(onEvent, indicator) {
    let version = -1, es = null, pollTimer = null, failTimer = null;
    const set = (cls, text) => { if (indicator) { indicator.className = "live " + cls; indicator.querySelector("span").textContent = text; } };
    function startPolling() {
      if (pollTimer) return;
      set("warn", "Live (polling)");
      pollTimer = setInterval(async () => {
        try {
          const v = (await api("/api/version")).version;
          if (version >= 0 && v !== version) onEvent({ kind: "poll", version: v });
          version = v;
        } catch (e) { set("", "Offline"); }
      }, 4000);
    }
    function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
    if (!window.EventSource) { startPolling(); return; }
    es = new EventSource("/api/stream");
    es.addEventListener("hello", (m) => {
      const v = JSON.parse(m.data).version;
      if (version >= 0 && v !== version) onEvent({ kind: "resync", version: v });
      version = v; stopPolling(); clearTimeout(failTimer); set("ok", "Live");
    });
    es.addEventListener("update", (m) => { const e = JSON.parse(m.data); version = e.version; onEvent(e); });
    es.onerror = () => { set("warn", "Reconnecting…"); clearTimeout(failTimer); failTimer = setTimeout(startPolling, 8000); };
  }

  function toast(msg, kind = "") {
    let box = document.querySelector(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast " + kind; t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 5000);
    while (box.children.length > 4) box.firstChild.remove();
  }
  function clock(el) {
    const tick = () => (el.textContent = new Date().toLocaleString([], { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick(); setInterval(tick, 1000);
  }
  function flash(el) { if (!el) return; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }

  /* SVG level chart: observed history, forecast, threshold lines. */
  function levelChart(el, o) {
    const W = 560, H = 220, L = 46, R = 96, T = 14, B = 26;
    const hist = (o.history || []).map((p) => ({ t: new Date(p.ts).getTime(), v: p.level }));
    if (!hist.length) { el.innerHTML = '<div class="muted">No history</div>'; return; }
    const fc = o.forecast && o.forecast.level != null ? { t: new Date(o.forecast.ts).getTime(), v: o.forecast.level } : null;
    const vals = hist.map((p) => p.v).concat(o.lines.map((l) => l.v)).concat(fc ? [fc.v] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max(0.3, (hi - lo) * 0.08); lo -= pad; hi += pad;
    const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, fc ? fc.t : 0, Date.now()) + 1;
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Water level chart">`;
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4, yy = y(v);
      s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#eef2f6"/><text x="${L - 6}" y="${yy + 4}" font-size="10" text-anchor="end" fill="#6b7d8f">${v.toFixed(1)}</text>`;
    }
    const step = 12 * 3600e3;
    for (let t = Math.ceil(t0 / step) * step; t < t1 - step / 3; t += step) {
      const d = new Date(t);
      s += `<text x="${x(t)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#6b7d8f">${d.toLocaleString([], { day: "2-digit", month: "short" })} ${String(d.getHours()).padStart(2, "0")}h</text>`;
    }
    const used = [];
    o.lines.forEach((l) => {
      const yy = y(l.v);
      let ty = yy + 4; while (used.some((u) => Math.abs(u - ty) < 12)) ty += 12; used.push(ty);
      s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${l.color}" stroke-width="1.5" ${l.dash ? 'stroke-dasharray="5 4"' : ""}/>`;
      s += `<text x="${W - R + 6}" y="${ty}" font-size="10.5" font-weight="700" fill="${l.color}">${l.label} ${l.v.toFixed(2)}</text>`;
    });
    const d = hist.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p.v).toFixed(1)).join(" ");
    s += `<path d="${d} L${x(hist[hist.length - 1].t)},${H - B} L${x(t0)},${H - B}Z" fill="rgba(31,111,178,.08)"/>`;
    s += `<path d="${d}" fill="none" stroke="#1f6fb2" stroke-width="2.2"/>`;
    const last = hist[hist.length - 1];
    if (fc) {
      s += `<path d="M${x(last.t)},${y(last.v)} L${x(fc.t)},${y(fc.v)}" stroke="#7b4fc9" stroke-width="2" stroke-dasharray="4 4" fill="none"/>`;
      s += `<circle cx="${x(fc.t)}" cy="${y(fc.v)}" r="4.5" fill="#fff" stroke="#7b4fc9" stroke-width="2"/>`;
    }
    s += `<circle cx="${x(last.t)}" cy="${y(last.v)}" r="5" fill="#1f6fb2" stroke="#fff" stroke-width="2"/>`;
    s += "</svg>";
    s += `<div class="sub" style="display:flex;gap:14px;margin-top:2px"><span><b style="color:#1f6fb2">━</b> Observed</span>${fc ? '<span><b style="color:#7b4fc9">┅</b> Forecast</span>' : ""}</div>`;
    el.innerHTML = s;
  }

  window.FFS = { STATUS, ORDER, RANK, WXLABEL, RAIN, RAINK, rainCat, rainInk, statusInk, wxStatusFromRain, esc, fmt, mm, fmtTime, fmtDate, ago, pill, wxPill, icon, wxIcon, api, liveFeed, toast, clock, flash, levelChart };
})();
