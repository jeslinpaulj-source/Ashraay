/* Dashboard: KPIs, unified map (rain points + rivers + dams), alerts, warnings, details. */
App.register("dashboard", (function () {
  const { STATUS, RANK, RAIN, RAINK, rainCat, esc, fmt, mm, fmtTime, ago, pill, wxPill, icon, wxIcon, api, flash, levelChart } = FFS;
  const $ = App.$;
  let map = null, mode = "h48", tab = "alerts", typeF = "all", sel = null;
  const L = { rain: true, river: true, dam: true, alertsOnly: false, state: "", q: "" };

  const modeLabel = () => mode === "h48" ? "next 48 h" : mode === "d5" ? "next 5 days" : `${App.dayLabel(mode)}${mode > 1 ? "" : " · " + App.dayDate(mode)}`;
  function areaWin(a) {
    const idx = mode === "h48" ? [0, 1] : mode === "d5" ? [0, 1, 2, 3, 4] : [mode];
    let best = null;
    for (const i of idx) {
      const d = a.days[i]; if (!d) continue;
      if (!best || RANK[d.status] > RANK[best.d.status] || (RANK[d.status] === RANK[best.d.status] && d.rain_mm > best.d.rain_mm)) best = { i, d };
    }
    const status = idx.reduce((s, i) => (a.days[i] && RANK[a.days[i].status] > RANK[s] ? a.days[i].status : s), "normal");
    return { status, day: best.i, d: best.d, rain: best.d.rain_mm };
  }
  const txt = (it) => `${it.name} ${it.district} ${it.state} ${it.river || ""}`.toLowerCase();
  const inScope = (it) => (!L.state || it.state === L.state) && (!L.q || txt(it).includes(L.q));

  function init() {
    $("#d-rainleg").innerHTML = RAIN.map((r) => `<div><span class="sq" style="background:${r.color};${r.k === "no_rain" ? "border:1px solid #c5d0db" : ""}"></span>${r.label}<span class="muted" style="margin-left:auto">${r.k === "no_rain" ? "0" : r.k === "extremely_heavy" ? "≥ 204.5" : "≥ " + r.lo}</span></div>`).join("") +
      `<div class="sub" style="margin-top:4px">Heavy = Yellow, very heavy = Orange, extremely heavy = Red warning. Strong wind / heat can also raise the colour.</div>`;
    const states = [...new Set(App.snap.areas.map((a) => a.state).concat(App.snap.stations.map((s) => s.state)))].sort();
    $("#d-state").insertAdjacentHTML("beforeend", states.map((s) => App.opt(s, s)).join(""));
    $("#d-state").onchange = (e) => { L.state = e.target.value; render(); };
    $("#d-q").oninput = (e) => { L.q = e.target.value.trim().toLowerCase(); render(); };
    $("#d-lRain").onchange = (e) => { L.rain = e.target.checked; render(); };
    $("#d-lRiver").onchange = (e) => { L.river = e.target.checked; render(); };
    $("#d-lDam").onchange = (e) => { L.dam = e.target.checked; render(); };
    $("#d-lAlert").onchange = (e) => { L.alertsOnly = e.target.checked; render(); };
    App.$$("#d-tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.t)));
    map = new MiniMap($("#d-map"), {
      onSelect: (m) => select(m.kind, m.id, false),
      tooltip: tooltip,
      onTileError: () => { if (!map.useTiles) return; $("#d-base button[data-b=vector]").click(); $("#d-attrib").textContent = "Street map unavailable (no internet) — showing offline map"; },
    });
    fetch("/assets/geo/basemap.json").then((r) => r.json()).then((g) => map.setGeo(g));
    App.$$("#d-base button").forEach((b) => (b.onclick = () => {
      App.$$("#d-base button").forEach((x) => x.classList.toggle("on", x === b));
      const osm = b.dataset.b === "osm"; map.setTiles(osm);
      $("#d-attrib").textContent = osm ? "© OpenStreetMap contributors" : "Basemap: Natural Earth (simplified, indicative boundaries)";
    }));
    $("#d-zin").onclick = () => map.zoomBy(1);
    $("#d-zout").onclick = () => map.zoomBy(-1);
    $("#d-zfit").onclick = () => map.fitIndia();
  }

  function setTab(t) {
    tab = t;
    App.$$("#d-tabs button").forEach((x) => x.classList.toggle("on", x.dataset.t === t));
    ["alerts", "warnings", "detail"].forEach((k) => $("#d-tab-" + k).classList.toggle("hidden", k !== t));
  }

  function tooltip(m) {
    const it = App.find(m.kind, m.id); if (!it) return "";
    const where = `<span class="muted">${esc(it.area_kind === "ward" ? it.district + ", " : "")}${esc(it.state)}</span>`;
    if (m.kind === "area") {
      const w = areaWin(it), c = rainCat(w.rain);
      return `<b>${esc(it.name)}</b>${where}<div style="margin:6px 0">${wxPill(w.status, true)} <span class="muted">${esc(modeLabel())}</span></div>
        <div>${App.dayLabel(w.day)}: <b style="display:inline">${mm(w.rain)} mm</b> · ${c.label}</div>`;
    }
    if (m.kind === "station") return `<b>${esc(it.name)}</b><span class="muted">${esc(it.river)} · ${esc(it.district)}, ${esc(it.state)}</span><div style="margin:6px 0">${pill(it.status)}</div><div>Level <b style="display:inline">${fmt(it.current_level)} m</b> · danger ${fmt(it.danger_level)}</div>`;
    return `<b>${esc(it.name)}</b><span class="muted">${esc(it.river)} · ${esc(it.district)}, ${esc(it.state)}</span><div style="margin:6px 0">${pill(it.status, it.status_label)}</div><div><b style="display:inline">${fmt(it.storage_pct, 0)}% full</b> · ${fmt(it.current_level)} m (FRL ${fmt(it.frl)})</div>`;
  }

  function render(evt = {}, params = {}) {
    const S = App.snap;
    if (evt.kind === "tick") return kpis();
    if (evt.kind === "route" && params.select) { const it = App.area(params.select) || App.station(params.select) || App.reservoir(params.select); if (it) { sel = { kind: it.kind, id: it.id }; setTab("detail"); setTimeout(() => map.flyTo(it.lon, it.lat, it.area_kind === "ward" ? 10.5 : 6.5), 50); } }
    // day chips
    const counts = (i) => { const c = S.summary.areas_per_day[i]; return c.extreme + c.severe; };
    const short = (iso) => new Date(iso + "T00:00:00").toLocaleDateString([], { day: "2-digit", month: "short" });
    const wd = (iso) => new Date(iso + "T00:00:00").toLocaleDateString([], { weekday: "long" });
    const chips = [["h48", "48 hours", "worst case", S.summary.areas_2d.extreme + S.summary.areas_2d.severe], ["d5", "5 days", "worst case", S.summary.areas_5d.extreme + S.summary.areas_5d.severe]]
      .concat(S.dates.map((d, i) => [i, i < 2 ? d.label : wd(d.date), short(d.date), counts(i)]));
    $("#d-days").innerHTML = chips.map(([k, t, s, n]) => `<button data-k="${k}" class="${String(mode) === String(k) ? "on" : ""}">${n ? `<span class="cnt" style="background:#f07c00" title="Orange/Red areas">${n}</span>` : ""}${esc(t)}<small>${esc(s)}</small></button>`).join("");
    App.$$("#d-days button").forEach((b) => (b.onclick = () => { mode = /^\d$/.test(b.dataset.k) ? +b.dataset.k : b.dataset.k; render(); }));
    $("#d-mapnote").textContent = `Rain forecast · ${modeLabel()}`;
    kpis();

    // markers
    const ms = [];
    if (L.rain) for (const a of S.areas) {
      const w = areaWin(a); const c = rainCat(w.rain);
      const col = RANK[w.status] > RANK[FFS.wxStatusFromRain(w.rain)] ? STATUS[w.status].color : c.color;
      ms.push({ id: a.id, kind: "area", name: a.name, lat: a.lat, lon: a.lon, status: w.status, color: col, stroke: w.rain ? "#fff" : "#9fb0c0",
        rank: RANK[w.status] + Math.min(w.rain, 400) / 1000, hidden: !inScope(a) || (L.alertsOnly && w.status === "normal") });
    }
    if (L.river) for (const s of S.stations) ms.push({ id: s.id, kind: "station", name: s.name, lat: s.lat, lon: s.lon, status: s.status, rank: RANK[s.status] + 0.5, hidden: !inScope(s) || (L.alertsOnly && s.status === "normal") });
    if (L.dam) for (const r of S.reservoirs) ms.push({ id: r.id, kind: "reservoir", name: r.name, lat: r.lat, lon: r.lon, status: r.status, rank: RANK[r.status] + 0.6, hidden: !inScope(r) || (L.alertsOnly && r.status === "normal") });
    map.setMarkers(ms);
    map.select(sel && sel.id);
    if (evt.target_id) map.pulse(evt.target_id);

    alerts(evt);
    warnings();
    if (sel && (evt.kind === "route" || evt.target_id === sel.id || ["reset", "poll", "resync", "weather", "scenario"].includes(evt.kind))) detail(evt.target_id === sel.id);
  }

  function kpis() {
    const S = App.snap;
    let red = 0, orange = 0;
    for (const a of S.areas) { const st = areaWin(a).status; if (st === "extreme") red++; else if (st === "severe") orange++; }
    const riv = S.summary.stations.extreme + S.summary.stations.severe;
    const dams = S.reservoirs.filter((r) => r.storage_pct >= 90).length;
    const mon = S.monitor;
    const k = [
      ["red", red, "Red weather areas", modeLabel(), "#d7263d", "#fde4e7", "cloudrain"],
      ["orange", orange, "Orange weather areas", modeLabel(), "#e06f00", "#ffe9d3", "cloudrain"],
      ["river", riv, "Rivers above danger", `of ${S.summary.station_total} stations`, "#b0182b", "#fde4e7", "waves"],
      ["dam", dams, "Dams ≥ 90% full", `of ${S.summary.reservoir_total} reservoirs`, "#1f6fb2", "#e8f1fb", "dam"],
      ["warn", S.warnings.length, "Active warnings", "automatic + manual", "#0b2a4a", "#e6ebf1", "alert"],
      ["mon", mon.online ? "Online" : "Offline", "Monitor (watch agent)", mon.online ? `${mon.watching ?? 0} alerts watched` : "double-click monitor.bat", mon.online ? "#1f7a45" : "#6b7d8f", mon.online ? "#e6f5ec" : "#eef2f6", "radar"],
    ];
    $("#d-kpis").innerHTML = k.map(([id, n, l, sub, c, bg, ic]) => `<div class="card kpi" data-k="${id}" role="button" tabindex="0" title="${esc(l + " · " + sub)}"><div class="ic" style="background:${bg}">${icon(ic, 20, c)}</div><div style="min-width:0"><b style="color:${c}">${n}</b><span>${esc(l)}</span><em>${esc(sub)}</em></div></div>`).join("");
    App.$$("#d-kpis .kpi").forEach((el) => (el.onclick = () => {
      const id = el.dataset.k;
      if (id === "warn") return setTab("warnings");
      if (id === "mon") return App.go("monitor");
      typeF = id === "red" || id === "orange" ? "rain" : id === "river" ? "river" : "dam";
      setTab("alerts"); alerts();
    }));
  }

  function alertItems() {
    const S = App.snap, out = [];
    for (const a of S.areas) { const w = areaWin(a); if (w.status !== "normal") out.push({ kind: "area", type: "rain", it: a, status: w.status, w, score: w.rain }); }
    for (const s of S.stations) if (s.status !== "normal") out.push({ kind: "station", type: "river", it: s, status: s.status, score: s.above_danger_by });
    for (const r of S.reservoirs) if (r.status !== "normal") out.push({ kind: "reservoir", type: "dam", it: r, status: r.status, score: r.storage_pct });
    return out.filter((x) => inScope(x.it)).sort((a, b) => RANK[b.status] - RANK[a.status] || (a.type === b.type ? b.score - a.score : a.type.localeCompare(b.type)));
  }

  function alerts(evt = {}) {
    const all = alertItems();
    const n = { all: all.length, rain: 0, river: 0, dam: 0 }; all.forEach((x) => n[x.type]++);
    $("#d-acount").textContent = `(${all.length})`;
    $("#d-afilt").innerHTML = [["all", "All"], ["rain", "Weather"], ["river", "Rivers"], ["dam", "Dams"]].map(([k, t]) => `<button class="fchip ${typeF === k ? "on" : ""}" data-f="${k}">${t} <b>${n[k]}</b></button>`).join("");
    App.$$("#d-afilt button").forEach((b) => (b.onclick = () => { typeF = b.dataset.f; alerts(); }));
    const list = all.filter((x) => typeF === "all" || x.type === typeF).slice(0, 200);
    const ICON = { rain: ["cloudrain", "#e8f1fb", "#1f6fb2"], river: ["waves", "#e6f4f2", "#2a8c82"], dam: ["dam", "#eef0fb", "#4f5d9e"] };
    $("#d-alerts").innerHTML = list.length ? list.map((x) => {
      const it = x.it, [ic, bg, fg] = ICON[x.type];
      let sub, val;
      if (x.type === "rain") { sub = `${it.area_kind === "ward" ? it.district + " · " : ""}${it.state} · ${App.dayLabel(x.w.day)}`; val = `${mm(x.w.rain)} mm<small>${STATUS[x.status].wx}</small>`; }
      else if (x.type === "river") { sub = `${it.river} · ${it.district}, ${it.state}`; val = `${fmt(it.current_level)} m<small>${it.above_danger_by >= 0 ? "+" : ""}${fmt(it.above_danger_by)} vs danger</small>`; }
      else { sub = `${it.river} · ${it.district}, ${it.state}`; val = `${fmt(it.storage_pct, 0)}%<small>${it.below_frl_by < 0 ? "above FRL" : fmt(it.below_frl_by) + " m below FRL"}</small>`; }
      return `<div class="item ${sel && sel.id === it.id ? "sel" : ""}" data-id="${it.id}" data-kind="${x.kind}">
        <span class="bar" style="background:${STATUS[x.status].color}"></span><span class="ti" style="background:${bg}">${icon(ic, 16, fg)}</span>
        <div style="min-width:0"><b>${esc(it.name)}</b><small>${esc(sub)}</small></div><div class="lv">${val}</div></div>`;
    }).join("") : `<div class="empty">${icon("check", 22, "#2e9e5b")}<br>No alerts for these filters.</div>`;
    App.$$("#d-alerts .item").forEach((el) => (el.onclick = () => select(el.dataset.kind, el.dataset.id, true)));
    if (evt.target_id) flash($(`#d-alerts [data-id="${evt.target_id}"]`));
  }

  function warnings() {
    const ws = App.snap.warnings.slice().sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.created_at.localeCompare(a.created_at));
    $("#d-wcount").textContent = `(${ws.length})`;
    $("#d-tab-warnings").innerHTML = ws.length ? ws.map((w) => `<div class="warn" style="--c:${STATUS[w.severity].color}" data-id="${esc(w.target_id)}" data-kind="${esc(w.target_type)}">
      <b>${esc(w.title)}</b><p>${esc(w.message)}</p><div class="meta">${pill(w.severity, w.target_type === "area" ? STATUS[w.severity].wx : null)}<span>${w.origin === "manual" ? "Issued manually" : "Automatic"}</span><span>· ${ago(w.created_at)}</span></div></div>`).join("")
      : '<div class="empty">No active warnings.</div>';
    App.$$("#d-tab-warnings .warn").forEach((el) => (el.onclick = () => { if (el.dataset.id && App.find(el.dataset.kind, el.dataset.id)) select(el.dataset.kind, el.dataset.id, true); }));
  }

  async function select(kind, id, fly) {
    sel = { kind, id };
    const it = App.find(kind, id);
    if (fly && it) map.flyTo(it.lon, it.lat, kind === "area" && it.area_kind === "ward" ? 10.5 : 6.5);
    map.select(id); setTab("detail");
    App.$$("#d-alerts .item").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
    await detail(false);
  }

  async function detail(doFlash) {
    const el = $("#d-tab-detail");
    if (sel.kind === "area") {
      const a = App.area(sel.id); if (!a) return;
      el.innerHTML = `<div class="hd"><div style="flex:1;min-width:0"><h2 style="font-size:17px">${esc(a.name)}</h2><div class="sub">${a.area_kind === "ward" ? "Ward · " + esc(a.district) + ", " : "District forecast point · "}${esc(a.state)}</div></div>${wxPill(a.status, true)}</div>
        <div class="sub" style="margin:6px 0 10px">Worst of 5 days · updated ${ago(a.updated_at)} <span class="src ${a.source}">${a.source}</span></div>
        <div class="list">${a.days.map((d, i) => { const c = RAINK[d.rain_cat]; return `<div class="item" style="cursor:default;grid-template-columns:4px 40px minmax(0,1fr) auto"><span class="bar" style="background:${STATUS[d.status].color}"></span>${wxIcon(d.icon, 36)}<div style="min-width:0"><b>${App.dayLabel(i)}${i < 2 ? ` <span class="muted" style="font-weight:500">${App.dayDate(i)}</span>` : ""}</b><small>${esc(App.condText(d))} · ${d.tmax.toFixed(0)}° / ${d.tmin.toFixed(0)}° · gust ${d.gust_kmh.toFixed(0)} km/h</small></div><div class="lv">${mm(d.rain_mm)} mm<small><span style="color:${FFS.rainInk(c)}">${c.short}</span></small></div></div>`; }).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn sm" id="d-openwx">Open in Weather →</button><button class="btn sm pri" id="d-simwx">Simulate rain here</button></div>`;
      $("#d-openwx").onclick = () => App.go("weather", { ward: a.id });
      $("#d-simwx").onclick = () => App.go("simulator", { tab: "rain", ward: a.id });
    } else {
      const st = sel.kind === "station";
      let d;
      try { d = await api(`/api/${st ? "stations" : "reservoirs"}/${sel.id}`); } catch (e) { return; }
      el.innerHTML = `<div class="hd"><div style="flex:1;min-width:0"><h2 style="font-size:17px">${esc(d.name)}</h2><div class="sub">${st ? "River station" : "Dam / reservoir"} · ${esc(d.river)} · ${esc(d.district)}, ${esc(d.state)}</div></div>${pill(d.status, st ? null : d.status_label)}</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin:12px 0 2px;flex-wrap:wrap"><span class="big">${fmt(d.current_level)} m</span><span class="sub">${st ? (d.above_danger_by >= 0 ? "+" : "") + fmt(d.above_danger_by) + " m vs danger level" : fmt(d.storage_pct, 0) + "% live storage (approx.)"}</span></div>
        <div class="sub">Updated ${fmtTime(d.updated_at)} (${ago(d.updated_at)}) <span class="src ${d.source}">${d.source}</span></div>
        <div class="chart" style="margin:10px 0" id="d-chart"></div>
        <dl class="kv">${st ? `<dt>Warning level</dt><dd>${fmt(d.warning_level)} m</dd><dt>Danger level</dt><dd>${fmt(d.danger_level)} m</dd><dt>Highest flood level</dt><dd>${fmt(d.hfl)} m</dd><dt>Forecast</dt><dd>${fmt(d.forecast_level)} m · ${fmtTime(d.forecast_for)}</dd><dt>Trend</dt><dd>${esc(d.trend)}</dd>`
          : `<dt>Full reservoir level (FRL)</dt><dd>${fmt(d.frl)} m</dd><dt>Min. draw-down (MDDL)</dt><dd>${fmt(d.mddl)} m</dd><dt>${d.below_frl_by < 0 ? "Above" : "Below"} FRL by</dt><dd>${fmt(Math.abs(d.below_frl_by))} m</dd><dt>Live storage</dt><dd>${fmt(d.live_storage_mcm, 0)} / ${fmt(d.live_capacity_mcm, 0)} MCM</dd><dt>Inflow / outflow</dt><dd>${fmt(d.inflow_cumecs, 0)} / ${fmt(d.outflow_cumecs, 0)} cumecs</dd>`}</dl>
        <div style="margin-top:12px"><button class="btn sm pri" id="d-simrv">Simulate this ${st ? "station" : "dam"}</button></div>`;
      levelChart($("#d-chart"), st ? { history: d.history, forecast: { ts: d.forecast_for, level: d.forecast_level }, lines: [{ v: d.hfl, label: "HFL", color: "#7b1fa2", dash: 1 }, { v: d.danger_level, label: "Danger", color: "#d7263d" }, { v: d.warning_level, label: "Warning", color: "#c99400" }] }
        : { history: d.history, lines: [{ v: d.frl, label: "FRL", color: "#d7263d" }, { v: d.mddl, label: "MDDL", color: "#6b7d8f", dash: 1 }] });
      $("#d-simrv").onclick = () => App.go("simulator", st ? { tab: "river", station: d.id } : { tab: "dam", dam: d.id });
    }
    if (doFlash) flash(el);
  }

  return { init, render };
})());
