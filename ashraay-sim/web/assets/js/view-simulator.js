/* Simulator: one place to change rain forecasts, river levels, dam levels, basin scenarios, warnings, reset. */
App.register("simulator", (function () {
  const { STATUS, RANK, ORDER, RAINK, rainCat, esc, fmt, mm, ago, pill, wxPill, icon, api, toast } = FFS;
  const $ = App.$;
  const TABS = [
    ["rain", "Rain & weather", "ward / district / state", "cloudrain"], ["river", "River level", "one station", "waves"],
    ["dam", "Dam level", "state → district → dam", "dam"], ["basin", "Basin scenario", "many stations", "up"],
    ["warning", "Custom warning", "publish a message", "bell"], ["reset", "Reset", "back to seed data", "reset"],
  ];
  let tab = "rain";
  const R = { scope: "ward", state: "Karnataka", dist: "Bengaluru Urban", ward: "W-BENGALURU-URBAN-BELLANDUR", day: 1 };
  const V = { state: "", basin: "", id: null };
  const D = { state: "Karnataka", dist: "Mandya", id: "RSV-KRS" };
  let damView = null;

  const btnBusy = async (b, fn) => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } };

  function init() {
    $("#s-nav").innerHTML = TABS.map(([k, t, s, ic]) => `<button data-t="${k}"><span class="si">${icon(ic, 16, "#1f6fb2")}</span><span>${t}<small>${s}</small></span></button>`).join("");
    App.$$("#s-nav button").forEach((b) => (b.onclick = () => App.go("simulator", { tab: b.dataset.t })));
    initRain(); initRiver(); initDam(); initBasin(); initWarning(); initReset();
  }

  function setTab(t) {
    tab = TABS.some((x) => x[0] === t) ? t : "rain";
    App.$$("#s-nav button").forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
    App.$$("#s-body [data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
  }

  function render(evt = {}, params = {}) {
    if (evt.kind === "route") {
      setTab(params.tab || tab);
      if (params.ward) { const a = App.area(params.ward); if (a) Object.assign(R, { scope: "ward", state: a.state, dist: a.district, ward: a.id }); }
      if (params.station && App.station(params.station)) { V.id = params.station; V.state = ""; V.basin = ""; }
      if (params.dam) { const r = App.reservoir(params.dam); if (r) Object.assign(D, { state: r.state, dist: r.district, id: r.id }); }
      rainSelectors(); riverSelectors(true); damSelectors(true);
    } else {
      rainStrip(); rainPreview(); riverInfo(false); damInfo(false);
    }
    basinPreview();
    sideLists();
  }

  /* ======================= RAIN ======================= */
  function initRain() {
    App.$$("#s-r-scope button").forEach((b) => (b.onclick = () => { R.scope = b.dataset.s; rainSelectors(); }));
    $("#s-r-state").onchange = () => { R.state = $("#s-r-state").value; R.dist = null; R.ward = null; rainSelectors(); };
    $("#s-r-dist").onchange = () => { R.dist = $("#s-r-dist").value; R.ward = null; rainSelectors(); };
    $("#s-r-ward").onchange = () => { R.ward = $("#s-r-ward").value; rainSelectors(); };
    ["s-r-rain", "s-r-unit", "s-r-gust", "s-r-wind", "s-r-tmax"].forEach((id) => ($("#" + id).oninput = rainPreview));
    $("#s-r-unit").onchange = rainPreview;
    const Q = [["15 cm tomorrow", 1, 15, "cm"], ["Heavy · 80 mm", null, 80, "mm"], ["Very heavy · 150 mm", null, 150, "mm"], ["Extremely heavy · 250 mm", null, 250, "mm"], ["No rain · 0 mm", null, 0, "mm"]];
    $("#s-r-quick").innerHTML = Q.map(([t, d, v, u], i) => { const c = rainCat(u === "cm" ? v * 10 : v); return `<button class="btn" data-i="${i}"><span class="sq" style="background:${c.color};${c.k === "no_rain" ? "border:1px solid #c5d0db" : ""}"></span>${t}</button>`; }).join("");
    App.$$("#s-r-quick button").forEach((b) => (b.onclick = () => { const [, d, v, u] = Q[+b.dataset.i]; if (d != null) R.day = d; $("#s-r-rain").value = v; $("#s-r-unit").value = u; rainStrip(); rainPreview(); }));
    $("#s-r-go").onclick = (e) => btnBusy(e.currentTarget, submitRain);
  }

  function rainSelectors() {
    const t = App.meta.weather_tree;
    if (!t[R.state]) R.state = "Karnataka" in t ? "Karnataka" : Object.keys(t).sort()[0];
    if (!R.dist || !t[R.state][R.dist]) R.dist = Object.keys(t[R.state]).sort()[0];
    const wards = t[R.state][R.dist];
    if (!R.ward || !wards.some((w) => w.id === R.ward)) R.ward = wards[0].id;
    App.$$("#s-r-scope button").forEach((b) => b.classList.toggle("on", b.dataset.s === R.scope));
    $("#s-r-state").innerHTML = Object.keys(t).sort().map((s) => App.opt(s, s, s === R.state)).join("");
    $("#s-r-dist").innerHTML = Object.keys(t[R.state]).sort().map((d) => App.opt(d, `${d} (${t[R.state][d].length})`, d === R.dist)).join("");
    $("#s-r-ward").innerHTML = wards.map((w) => App.opt(w.id, w.name, w.id === R.ward)).join("");
    $("#s-r-distw").style.visibility = R.scope === "state" ? "hidden" : "visible";
    $("#s-r-wardw").style.visibility = R.scope === "ward" ? "visible" : "hidden";
    rainStrip(); rainPreview();
  }

  const scopeAreas = () => App.snap.areas.filter((a) => R.scope === "ward" ? a.id === R.ward : R.scope === "district" ? a.state === R.state && a.district === R.dist : a.state === R.state);
  const scopeLabel = () => R.scope === "ward" ? (App.area(R.ward) || {}).name : R.scope === "district" ? `${R.dist} district` : `${R.state} (state)`;

  function rainStrip() {
    const list = scopeAreas();
    if (!list.length) return;
    $("#s-r-strip").innerHTML = App.snap.dates.map((d, i) => {
      const x = list.reduce((m, a) => (a.days[i].rain_mm > m.rain_mm ? a.days[i] : m), list[0].days[i]);
      const c = RAINK[x.rain_cat];
      return `<div data-i="${i}" class="${i === R.day ? "on" : ""}" role="button" tabindex="0"><span class="muted">${esc(d.label)}</span><b>${mm(x.rain_mm)} mm</b><span class="muted">${list.length > 1 ? "max · " : ""}${c.short}</span><i style="background:${c.k === "no_rain" ? "#dfe6ee" : c.color}"></i></div>`;
    }).join("");
    App.$$("#s-r-strip div").forEach((el) => (el.onclick = () => { R.day = +el.dataset.i; rainStrip(); rainPreview(); }));
  }

  function rainValueMm() { const v = parseFloat($("#s-r-rain").value); return isNaN(v) ? null : v * ($("#s-r-unit").value === "cm" ? 10 : 1); }
  function rainPreview() {
    const v = rainValueMm();
    if (v == null || v < 0) { $("#s-r-prev").innerHTML = `<span class="muted">Enter a rain amount (0 or more).</span>`; return; }
    const c = rainCat(v);
    let st = FFS.wxStatusFromRain(v);
    const wind = parseFloat($("#s-r-wind").value), gust = parseFloat($("#s-r-gust").value), tmax = parseFloat($("#s-r-tmax").value);
    const g = !isNaN(gust) ? gust : !isNaN(wind) ? wind * 1.5 : 0;
    const gs = g >= 90 ? "extreme" : g >= 70 ? "severe" : g >= 50 ? "above_normal" : "normal";
    const ts = tmax >= 47 ? "extreme" : tmax >= 45 ? "severe" : tmax >= 42 ? "above_normal" : "normal";
    [gs, ts].forEach((s) => { if (RANK[s] > RANK[st]) st = s; });
    const n = scopeAreas().length;
    $("#s-r-prev").innerHTML = `<b>${esc(scopeLabel() || "")}</b><span class="muted">·</span><span>${esc(App.dayLabel(R.day))} ${esc(App.dayDate(R.day))}</span><span class="muted">→</span>
      <b class="num">${mm(v)} mm</b><span class="pill" style="background:${c.color};color:${c.fg}">${c.label}</span>${wxPill(st)}${n > 1 ? `<span class="muted">${n} areas</span>` : ""}`;
  }

  async function submitRain() {
    const body = { scope: R.scope, area_id: R.ward, state: R.state, district: R.dist, day: R.day, rain: $("#s-r-rain").value, unit: $("#s-r-unit").value,
      chance: $("#s-r-chance").value, tmax: $("#s-r-tmax").value, wind_kmh: $("#s-r-wind").value, gust_kmh: $("#s-r-gust").value,
      propagate: $("#s-r-prop").checked, note: $("#s-r-note").value };
    try {
      const r = await api("/api/sim/rain", { method: "POST", body });
      const st = r.area ? r.area.days[r.day].status : FFS.wxStatusFromRain(r.rain_mm);
      App.result($("#s-r-res"), true, `Saved: <b>${mm(r.rain_mm)} mm</b> (${esc(r.rain_cat_label)}) for <b>${esc(scopeLabel())}</b> on ${esc(r.date_label)} → ${wxPill(st, true)}${r.areas.length > 1 ? ` · ${r.areas.length} areas` : ""}${r.impacted.length ? ` · raised ${r.impacted.length} river/dam point(s) in the district` : ""} · <a href="#/weather?ward=${encodeURIComponent(r.areas[0])}">view forecast</a>`);
    } catch (e) { App.result($("#s-r-res"), false, esc(e.message)); }
  }

  /* ======================= RIVER ======================= */
  function initRiver() {
    $("#s-v-state").onchange = () => { V.state = $("#s-v-state").value; V.id = null; riverSelectors(true); };
    $("#s-v-basin").onchange = () => { V.basin = $("#s-v-basin").value; V.id = null; riverSelectors(true); };
    $("#s-v-st").onchange = () => { V.id = $("#s-v-st").value; riverInfo(true); };
    $("#s-v-lvl").oninput = riverPreview; $("#s-v-fc").oninput = riverPreview;
    $("#s-v-go").onclick = (e) => btnBusy(e.currentTarget, submitRiver);
  }
  function riverSelectors(reset) {
    const S = App.snap.stations;
    const states = [...new Set(S.map((s) => s.state))].sort(), basins = [...new Set(S.map((s) => s.basin))].sort();
    $("#s-v-state").innerHTML = App.opt("", "All states") + states.map((s) => App.opt(s, s, s === V.state)).join("");
    $("#s-v-basin").innerHTML = App.opt("", "All basins") + basins.map((s) => App.opt(s, s, s === V.basin)).join("");
    const list = S.filter((s) => (!V.state || s.state === V.state) && (!V.basin || s.basin === V.basin)).sort((a, b) => a.name.localeCompare(b.name));
    if (!V.id || !list.some((s) => s.id === V.id)) V.id = (list.find((s) => s.id === "GNG-PTN") || list[0] || {}).id;
    $("#s-v-st").innerHTML = list.map((s) => App.opt(s.id, `${s.name} — ${s.river} (${s.district})`, s.id === V.id)).join("");
    riverInfo(reset);
  }
  const classify = (v, s) => (v >= s.hfl ? "extreme" : v >= s.danger_level ? "severe" : v >= s.warning_level ? "above_normal" : "normal");
  function riverInfo(resetInputs) {
    const s = App.station(V.id); if (!s) { $("#s-v-info").innerHTML = '<div class="empty">No station matches.</div>'; return; }
    $("#s-v-info").innerHTML = `<div class="hd" style="margin-bottom:8px"><b style="font-size:15px">${esc(s.name)}</b>${pill(s.status)}<span class="src ${s.source}">${s.source}</span><span class="sp sub">updated ${ago(s.updated_at)}</span></div>
      <div class="stats" style="grid-template-columns:repeat(5,minmax(0,1fr))"><div class="stat"><span>Current</span><b>${fmt(s.current_level)}</b></div><div class="stat"><span>Forecast</span><b>${fmt(s.forecast_level)}</b></div>
      <div class="stat"><span>Warning</span><b style="color:#8a6500">${fmt(s.warning_level)}</b></div><div class="stat"><span>Danger</span><b style="color:#d7263d">${fmt(s.danger_level)}</b></div><div class="stat"><span>HFL</span><b style="color:#7b1fa2">${fmt(s.hfl)}</b></div></div>`;
    const q = [["normal", s.warning_level - 0.5], ["above_normal", (s.warning_level + s.danger_level) / 2], ["severe", (s.danger_level + s.hfl) / 2], ["extreme", s.hfl + 0.25]];
    $("#s-v-quick").innerHTML = q.map(([k, v]) => `<button class="btn" data-v="${v.toFixed(2)}"><span class="dot" style="background:${STATUS[k].color}"></span>${STATUS[k].label} · ${v.toFixed(2)} m</button>`).join("");
    App.$$("#s-v-quick button").forEach((b) => (b.onclick = () => { $("#s-v-lvl").value = b.dataset.v; $("#s-v-fc").value = (parseFloat(b.dataset.v) + 0.2).toFixed(2); riverPreview(); }));
    if (resetInputs) { $("#s-v-lvl").value = s.current_level.toFixed(2); $("#s-v-fc").value = ""; $("#s-v-res").innerHTML = ""; }
    riverPreview();
  }
  function riverPreview() {
    const s = App.station(V.id), v = parseFloat($("#s-v-lvl").value), f = parseFloat($("#s-v-fc").value);
    if (!s || isNaN(v)) { $("#s-v-prev").innerHTML = '<span class="muted">Enter a level.</span>'; return; }
    const a = classify(v, s), b = isNaN(f) ? a : classify(f, s), st = RANK[a] >= RANK[b] ? a : b;
    $("#s-v-prev").innerHTML = `<b>${esc(s.name)}</b><span class="muted">→</span><b class="num">${fmt(v)} m</b><span class="muted">${(v - s.danger_level >= 0 ? "+" : "") + fmt(v - s.danger_level)} vs danger</span>${pill(st)}`;
  }
  async function submitRiver() {
    try {
      const r = await api("/api/sim/station/" + V.id, { method: "POST", body: { level: $("#s-v-lvl").value, forecast_level: $("#s-v-fc").value, forecast_hours: $("#s-v-hrs").value, note: $("#s-v-note").value } });
      App.result($("#s-v-res"), true, `Saved: <b>${esc(r.station.name)}</b> at ${fmt(r.station.current_level)} m → ${pill(r.station.status)}${r.warning ? ` · warning #${r.warning} active` : " · no warning"} · <a href="#/rivers?station=${r.station.id}">view</a>`);
    } catch (e) { App.result($("#s-v-res"), false, esc(e.message)); }
  }

  /* ======================= DAM ======================= */
  const pctOf = (l, d) => (l <= d.mddl ? 0 : Math.min(1.2, (l - d.mddl) / (d.frl - d.mddl)) ** 1.6 * 100);
  const levelFor = (p, d) => d.mddl + (d.frl - d.mddl) * (p / 100) ** (1 / 1.6);
  const damCls = (l, d) => { const p = pctOf(l, d); return l >= d.frl ? "extreme" : p >= 90 ? "severe" : p >= 80 ? "above_normal" : "normal"; };
  const DLBL = { normal: "Normal", above_normal: "High storage (≥80%)", severe: "Very high (≥90%)", extreme: "At / above FRL" };
  function initDam() {
    $("#s-d-state").onchange = () => { D.state = $("#s-d-state").value; D.dist = null; D.id = null; damSelectors(true); };
    $("#s-d-dist").onchange = () => { D.dist = $("#s-d-dist").value; D.id = null; damSelectors(true); };
    $("#s-d-dam").onchange = () => { D.id = $("#s-d-dam").value; damInfo(true); };
    $("#s-d-slide").oninput = () => { $("#s-d-lvl").value = (+$("#s-d-slide").value).toFixed(2); gauge(); };
    $("#s-d-lvl").oninput = () => { $("#s-d-slide").value = $("#s-d-lvl").value; gauge(); };
    $("#s-d-go").onclick = (e) => btnBusy(e.currentTarget, submitDam);
  }
  function damSelectors(reset) {
    const t = App.meta.reservoir_tree;
    if (!t[D.state]) D.state = Object.keys(t).sort()[0];
    if (!D.dist || !t[D.state][D.dist]) D.dist = Object.keys(t[D.state]).sort()[0];
    const dams = t[D.state][D.dist];
    if (!D.id || !dams.some((d) => d.id === D.id)) D.id = dams[0].id;
    $("#s-d-state").innerHTML = Object.keys(t).sort().map((s) => App.opt(s, `${s} (${Object.values(t[s]).flat().length})`, s === D.state)).join("");
    $("#s-d-dist").innerHTML = Object.keys(t[D.state]).sort().map((d) => App.opt(d, d, d === D.dist)).join("");
    $("#s-d-dam").innerHTML = dams.map((d) => App.opt(d.id, d.name, d.id === D.id)).join("");
    damInfo(reset);
  }
  function damInfo(resetInputs) {
    const d = App.reservoir(D.id); if (!d) return;
    damView = d;
    $("#s-d-info").innerHTML = `<div class="hd" style="margin-bottom:8px"><b style="font-size:15px">${esc(d.name)}</b>${pill(d.status, d.status_label)}<span class="src ${d.source}">${d.source}</span><span class="sp sub">${esc(d.river)} · updated ${ago(d.updated_at)}</span></div>
      <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="stat"><span>Full level (FRL)</span><b style="color:#d7263d">${fmt(d.frl)} m</b></div><div class="stat"><span>Current level</span><b>${fmt(d.current_level)} m</b></div>
        <div class="stat"><span>${d.below_frl_by < 0 ? "Above" : "Below"} FRL by</span><b style="color:${d.below_frl_by < 0 ? "#d7263d" : "inherit"}">${fmt(Math.abs(d.below_frl_by))} m</b></div><div class="stat"><span>Live storage</span><b>${fmt(d.storage_pct, 1)}%</b></div>
        <div class="stat"><span>Min. draw-down</span><b>${fmt(d.mddl)} m</b></div><div class="stat"><span>Capacity</span><b>${fmt(d.live_capacity_mcm, 0)} MCM</b></div>
        <div class="stat"><span>Inflow</span><b>${fmt(d.inflow_cumecs, 0)} cumecs</b></div><div class="stat"><span>Outflow</span><b>${fmt(d.outflow_cumecs, 0)} cumecs</b></div></div>`;
    Object.assign($("#s-d-slide"), { min: (d.mddl - 5).toFixed(2), max: (d.frl + 3).toFixed(2) });
    const q = [["50% full", levelFor(50, d)], ["80%", levelFor(80, d)], ["90%", levelFor(90, d)], ["At FRL", d.frl], ["FRL + 0.5 m", d.frl + 0.5]];
    $("#s-d-quick").innerHTML = q.map(([t, v]) => `<button class="btn" data-v="${v.toFixed(2)}">${t} · ${v.toFixed(2)} m</button>`).join("");
    App.$$("#s-d-quick button").forEach((b) => (b.onclick = () => { $("#s-d-lvl").value = b.dataset.v; $("#s-d-slide").value = b.dataset.v; gauge(); }));
    if (resetInputs) {
      $("#s-d-in").value = Math.round(d.inflow_cumecs); $("#s-d-out").value = Math.round(d.outflow_cumecs); $("#s-d-note").value = ""; $("#s-d-res").innerHTML = "";
      $("#s-d-lvl").value = d.current_level.toFixed(2); $("#s-d-slide").value = d.current_level;
    }
    gauge();
  }
  function gauge() {
    const d = damView; if (!d) return;
    const nv = parseFloat($("#s-d-lvl").value), lo = d.mddl - 5, hi = d.frl + 3;
    const W = 560, H = 220, T = 14, B = 22, X0 = 110, X1 = 380;
    const y = (v) => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B);
    const cur = d.current_level, ns = isNaN(nv) ? null : damCls(nv, d);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reservoir gauge"><defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa3e0"/><stop offset="1" stop-color="#1f6fb2"/></linearGradient>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9aa9b8" stroke-width="2"/></pattern></defs>`;
    s += `<rect x="${X0}" y="${T}" width="${X1 - X0}" height="${H - T - B}" fill="#f3f6f9" rx="6"/>`;
    s += `<rect x="${X0}" y="${y(cur)}" width="${X1 - X0}" height="${H - B - y(cur)}" fill="url(#wg)"/>`;
    s += `<path d="M${X1},${T - 4} L${X1 + 16},${T - 4} L${X1 + 52},${H - B} L${X1},${H - B}Z" fill="url(#hatch)" stroke="#6b7d8f"/>`;
    s += `<line x1="${X0 - 10}" x2="${X1 + 52}" y1="${H - B}" y2="${H - B}" stroke="#6b7d8f" stroke-width="2"/>`;
    const line = (v, c, t, dash, right) => { const yy = y(v);
      return `<line x1="${X0 - 6}" x2="${X1}" y1="${yy}" y2="${yy}" stroke="${c}" stroke-width="2" ${dash ? 'stroke-dasharray="6 4"' : ""}/><text x="${right ? X1 + 60 : X0 - 10}" y="${yy + 4}" font-size="11.5" font-weight="700" fill="${c}" text-anchor="${right ? "start" : "end"}">${t}</text>`; };
    s += line(d.frl, "#d7263d", `FRL ${fmt(d.frl)}`, 0, 0);
    s += line(d.mddl, "#6b7d8f", `MDDL ${fmt(d.mddl)}`, 1, 0);
    s += `<text x="${(X0 + X1) / 2}" y="${Math.min(H - B - 8, y(cur) + 18)}" font-size="12.5" font-weight="700" fill="#fff" text-anchor="middle">Now ${fmt(cur)} m · ${fmt(d.storage_pct, 0)}%</text>`;
    if (ns) { const c = FFS.statusInk(ns); s += line(nv, c, `New ${fmt(nv)}`, 1, 1) + `<circle cx="${X1}" cy="${y(nv)}" r="5" fill="${c}" stroke="#fff" stroke-width="2"/>`; }
    $("#s-d-gauge").innerHTML = s + "</svg>";
    $("#s-d-prev").innerHTML = ns ? `<b>${esc(d.name)}</b><span class="muted">→</span><b class="num">${fmt(nv)} m</b><span class="muted">${fmt(pctOf(nv, d), 0)}% full</span>${pill(ns, DLBL[ns])}` : '<span class="muted">Enter a level.</span>';
  }
  async function submitDam() {
    try {
      const r = await api("/api/sim/reservoir/" + D.id, { method: "POST", body: { level: $("#s-d-lvl").value, inflow_cumecs: $("#s-d-in").value, outflow_cumecs: $("#s-d-out").value, note: $("#s-d-note").value } });
      App.result($("#s-d-res"), true, `Saved: <b>${esc(r.reservoir.name)}</b> at ${fmt(r.reservoir.current_level)} m (${fmt(r.reservoir.storage_pct, 0)}% full) → ${pill(r.reservoir.status, r.reservoir.status_label)}${r.warning ? ` · warning #${r.warning} active` : ""} · <a href="#/rivers?dam=${r.reservoir.id}">view</a>`);
      damInfo(false);
    } catch (e) { App.result($("#s-d-res"), false, esc(e.message)); }
  }

  /* ======================= BASIN ======================= */
  function initBasin() {
    $("#s-b-basin").innerHTML = App.meta.basins.map((b) => App.opt(b, b, b === "Ganga")).join("");
    $("#s-b-state").innerHTML = App.opt("", "All states") + [...new Set(App.snap.stations.map((s) => s.state))].sort().map((s) => App.opt(s, s)).join("");
    $("#s-b-delta").oninput = basinPreview; $("#s-b-basin").onchange = basinPreview; $("#s-b-state").onchange = basinPreview;
    $("#s-b-go").onclick = (e) => btnBusy(e.currentTarget, async () => {
      try { const r = await api("/api/sim/scenario", { method: "POST", body: { basin: $("#s-b-basin").value, state: $("#s-b-state").value, delta_m: $("#s-b-delta").value } });
        App.result($("#s-b-res"), true, `Scenario applied to ${r.changed.length} station(s).`); } catch (e) { App.result($("#s-b-res"), false, esc(e.message)); }
    });
  }
  function basinPreview() {
    if (!App.inited.simulator && !$("#s-b-basin").options.length) return;
    const dv = +$("#s-b-delta").value; $("#s-b-dv").textContent = (dv >= 0 ? "+" : "") + dv.toFixed(2) + " m";
    const list = App.snap.stations.filter((s) => s.basin === $("#s-b-basin").value && (!$("#s-b-state").value || s.state === $("#s-b-state").value));
    const after = list.filter((s) => s.current_level + dv >= s.danger_level).length, before = list.filter((s) => s.current_level >= s.danger_level).length;
    $("#s-b-prev").innerHTML = list.length ? `<b>${list.length}</b> station(s) will change · above danger level: <b>${before}</b> now → <b style="color:${after > before ? "#d7263d" : "inherit"}">${after}</b> after` : '<span class="muted">No stations in this basin / state.</span>';
  }

  /* ======================= WARNING ======================= */
  function initWarning() {
    const S = App.snap;
    $("#s-w-target").innerHTML = App.opt("area:", "General area (no specific point)") +
      `<optgroup label="Wards / forecast areas">${S.areas.map((a) => App.opt("area:" + a.id, `${a.name} — ${a.district}`)).join("")}</optgroup>` +
      `<optgroup label="River stations">${S.stations.map((s) => App.opt("station:" + s.id, `${s.name} (${s.river})`)).join("")}</optgroup>` +
      `<optgroup label="Dams / reservoirs">${S.reservoirs.map((r) => App.opt("reservoir:" + r.id, r.name)).join("")}</optgroup>`;
    $("#s-w-go").onclick = (e) => btnBusy(e.currentTarget, async () => {
      const [tt, tid] = $("#s-w-target").value.split(":");
      try { const r = await api("/api/sim/warnings", { method: "POST", body: { severity: $("#s-w-sev").value, target_type: tt, target_id: tid, title: $("#s-w-title").value, message: $("#s-w-msg").value } });
        App.result($("#s-w-res"), true, `Warning #${r.id} published.`); $("#s-w-title").value = ""; $("#s-w-msg").value = ""; } catch (e) { App.result($("#s-w-res"), false, esc(e.message)); }
    });
  }

  /* ======================= RESET ======================= */
  async function resetSeed(result) {
    if (!confirm("Restore ALL forecasts, river levels, dam levels and warnings to seed values? Custom changes will be removed. Some seed high/extreme alerts remain. Monitor history is kept.")) return;
    const buttons = [$("#s-x-reset"), $("#s-reset-alerts")];
    buttons.forEach((button) => { button.disabled = true; });
    result.innerHTML = "";
    try {
      await api("/api/sim/reset", { method: "POST", body: {} });
      await App.reload({ kind: "reset" });
      App.result(result, true, "Reset to seed data. Custom changes removed; seed alerts remain.");
    } catch (error) {
      App.result(result, false, esc(error.message));
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }
  function initReset() {
    $("#s-x-reset").onclick = () => resetSeed($("#s-x-res"));
    $("#s-reset-alerts").onclick = () => resetSeed($("#s-reset-alerts-res"));
    $("#s-x-clearmon").onclick = (e) => btnBusy(e.currentTarget, async () => {
      try { await api("/api/monitor/clear", { method: "POST", body: {} }); App.result($("#s-x-res"), true, "Monitor log cleared (the files in logs/ are kept)."); } catch (e) { App.result($("#s-x-res"), false, esc(e.message)); }
    });
  }

  /* ======================= side lists ======================= */
  async function sideLists() {
    const ws = App.snap.warnings.slice().sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.created_at.localeCompare(a.created_at));
    $("#s-wn").textContent = `${ws.length} active`;
    $("#s-warn").innerHTML = ws.length ? ws.map((w) => `<div class="warn" style="--c:${STATUS[w.severity].color}"><div style="display:flex;gap:8px;align-items:flex-start"><b style="flex:1;min-width:0">${esc(w.title)}</b><button class="btn sm" data-clear="${w.id}">Clear</button></div>
      <p>${esc(w.message)}</p><div class="meta">${pill(w.severity, w.target_type === "area" ? STATUS[w.severity].wx : null)}<span>#${w.id} · ${w.origin} · ${ago(w.created_at)}</span></div></div>`).join("") : '<div class="empty">No active warnings.</div>';
    App.$$("#s-warn [data-clear]").forEach((b) => (b.onclick = () => btnBusy(b, async () => { try { await api(`/api/sim/warnings/${b.dataset.clear}/clear`, { method: "POST", body: {} }); } catch (e) { toast(e.message, "err"); } })));
    let rows = [];
    try { rows = await api("/api/audit"); } catch (e) { return; }
    const LBL = { simulate_rain: "Rain", simulate_station: "River", simulate_reservoir: "Dam", scenario: "Basin", create_warning: "Warning", clear_warning: "Cleared", reset: "Reset" };
    $("#s-audit").innerHTML = rows.length ? rows.slice(0, 60).map((r) => {
      const d = r.detail || {};
      let t = `<b>${LBL[r.action] || r.action}</b>${r.target_id ? " · " + esc(r.target_id) : r.action === "create_warning" ? " · general area" : ""}`;
      if (r.action === "simulate_rain") t += ` · ${mm(d.rain_mm)} mm on ${d.date ? esc(FFS.fmtDate(d.date)) : ""}${d.areas > 1 ? ` (${d.areas} areas)` : ""}`;
      if (d.from != null) t += ` · ${fmt(d.from)} → ${fmt(d.to)} m`;
      if (d.delta_m != null) t += ` · ${d.delta_m > 0 ? "+" : ""}${fmt(d.delta_m)} m on ${d.stations.length}`;
      if (d.title) t += ` · ${esc(d.title)}`;
      return `<div><span class="muted num" style="white-space:nowrap">${new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span>${t}</span></div>`;
    }).join("") : '<div class="empty">No simulation activity yet.</div>';
  }

  return { init, render };
})());
