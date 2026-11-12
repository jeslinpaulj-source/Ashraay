/* Rivers & dams: sortable station / reservoir tables with detail and chart. */
App.register("rivers", (function () {
  const { STATUS, RANK, ORDER, esc, fmt, fmtTime, ago, pill, api, levelChart, flash } = FFS;
  const $ = App.$;
  let kind = "station", sortKey = "status", sortDir = -1, sel = null;
  const F = { state: "", basin: "", q: "", status: "" };

  function init() {
    const S = App.snap;
    const states = [...new Set(S.stations.map((s) => s.state).concat(S.reservoirs.map((r) => r.state)))].sort();
    const basins = [...new Set(S.stations.map((s) => s.basin).concat(S.reservoirs.map((r) => r.basin)))].sort();
    $("#r-state").insertAdjacentHTML("beforeend", states.map((s) => App.opt(s, s)).join(""));
    $("#r-basin").insertAdjacentHTML("beforeend", basins.map((s) => App.opt(s, s)).join(""));
    $("#r-state").onchange = (e) => { F.state = e.target.value; table(); };
    $("#r-basin").onchange = (e) => { F.basin = e.target.value; table(); };
    $("#r-q").oninput = (e) => { F.q = e.target.value.trim().toLowerCase(); table(); };
    App.$$("#r-kind button").forEach((b) => (b.onclick = () => { kind = b.dataset.k; sortKey = "status"; sortDir = -1; App.$$("#r-kind button").forEach((x) => x.classList.toggle("on", x === b)); table(); }));
  }

  function render(evt = {}, params = {}) {
    if (evt.kind === "route" && (params.station || params.dam)) {
      kind = params.station ? "station" : "reservoir"; sel = { kind, id: params.station || params.dam };
      App.$$("#r-kind button").forEach((x) => x.classList.toggle("on", x.dataset.k === kind));
    }
    table(evt);
    if (sel && (evt.kind === "route" || evt.target_id === sel.id || ["reset", "poll", "resync", "scenario", "weather"].includes(evt.kind))) detail(evt.target_id === sel.id);
  }

  function rows() {
    const list = kind === "station" ? App.snap.stations : App.snap.reservoirs;
    return list.filter((r) => (!F.state || r.state === F.state) && (!F.basin || r.basin === F.basin) && (!F.status || r.status === F.status) &&
      (!F.q || `${r.name} ${r.river} ${r.district} ${r.state}`.toLowerCase().includes(F.q)));
  }

  function table(evt = {}) {
    const st = kind === "station";
    $("#r-title").textContent = st ? "River level stations" : "Dams / reservoirs";
    const base = (st ? App.snap.stations : App.snap.reservoirs).filter((r) => (!F.state || r.state === F.state) && (!F.basin || r.basin === F.basin));
    $("#r-filt").innerHTML = [["", "All"]].concat(ORDER.map((s) => [s, st ? STATUS[s].label : { normal: "Normal", above_normal: "≥ 80%", severe: "≥ 90%", extreme: "At FRL" }[s]])).map(([k, t]) =>
      `<button class="fchip ${F.status === k ? "on" : ""}" data-s="${k}">${k ? `<span class="dot" style="background:${STATUS[k].color};width:8px;height:8px"></span>` : ""}${t} <b>${k ? base.filter((r) => r.status === k).length : base.length}</b></button>`).join("");
    App.$$("#r-filt button").forEach((b) => (b.onclick = () => { F.status = b.dataset.s; table(); }));
    const cols = st
      ? [["name", "Station · river"], ["district", "Location"], ["warning_level", "Warning", 1], ["danger_level", "Danger", 1], ["hfl", "HFL", 1], ["current_level", "Current", 1], ["forecast_level", "Forecast", 1], ["status", "Situation"], ["updated_at", "Updated"]]
      : [["name", "Dam · river"], ["district", "Location"], ["frl", "FRL", 1], ["current_level", "Current", 1], ["storage_pct", "Storage", 1], ["inflow_cumecs", "In / out (cumecs)", 1], ["status", "Status"], ["updated_at", "Updated"]];
    const list = rows().sort((a, b) => {
      let x = a[sortKey], y = b[sortKey];
      if (sortKey === "status") { x = RANK[a.status] * 1000 + (st ? a.above_danger_by : a.storage_pct); y = RANK[b.status] * 1000 + (st ? b.above_danger_by : b.storage_pct); }
      return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
    });
    if (!sel || sel.kind !== kind || !list.some((r) => r.id === sel.id)) { sel = list.length ? { kind, id: list[0].id } : null; if (sel) setTimeout(() => detail(false), 0); }
    $("#r-sub").textContent = `${list.length} shown · levels in metres · click a header to sort`;
    const TR = { rising: "↑", falling: "↓", steady: "→" };
    const tone = (s) => (s === "normal" ? "inherit" : s === "above_normal" ? "#8a6500" : STATUS[s].color);
    $("#r-tbl").innerHTML = `<thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? "n" : ""}">${l}${sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
      list.map((r) => `<tr data-id="${r.id}" class="${sel && sel.id === r.id ? "sel" : ""}">${cols.map(([k, , n]) => {
        let v;
        if (k === "name") v = `<b>${esc(r.name)}</b><div class="sub">${esc(r.river)}</div>`;
        else if (k === "district") v = `${esc(r.district)}<div class="sub">${esc(r.state)}</div>`;
        else if (k === "status") v = pill(r.status, st ? null : { normal: "Normal", above_normal: "≥ 80%", severe: "≥ 90%", extreme: "At / above FRL" }[r.status]);
        else if (k === "updated_at") v = `${fmtTime(r[k])}<div><span class="src ${r.source}">${r.source === "simulation" ? "simulated" : "seed"}</span></div>`;
        else if (k === "storage_pct") v = `<b style="color:${tone(r.status)}">${fmt(r[k], 0)}%</b>`;
        else if (k === "inflow_cumecs") v = `${fmt(r.inflow_cumecs, 0)} / ${fmt(r.outflow_cumecs, 0)}`;
        else if (k === "current_level") v = `<b style="color:${tone(st ? r.status_current : r.status)}">${fmt(r[k])}</b>${st ? ` <span class="muted" title="${r.trend}">${TR[r.trend] || ""}</span>` : ""}`;
        else if (k === "forecast_level") v = `<span style="color:${tone(r.status_forecast)}">${fmt(r[k])}</span>`;
        else v = n ? fmt(r[k]) : esc(r[k]);
        return `<td class="${n ? "n" : ""}">${v}</td>`;
      }).join("")}</tr>`).join("") + "</tbody>";
    App.$$("#r-tbl th").forEach((th) => (th.onclick = () => { const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : (["name", "river", "district", "state", "trend"].includes(k) ? 1 : -1); sortKey = k; table(); }));
    App.$$("#r-tbl tbody tr").forEach((tr) => (tr.onclick = () => { sel = { kind, id: tr.dataset.id }; App.$$("#r-tbl tbody tr").forEach((x) => x.classList.toggle("sel", x === tr)); detail(false); }));
    $("#r-scroll").style.maxHeight = "calc(100vh - 290px)";
    if (evt.target_id) flash($(`#r-tbl tr[data-id="${evt.target_id}"]`));
  }

  async function detail(doFlash) {
    const st = sel.kind === "station";
    let d;
    try { d = await api(`/api/${st ? "stations" : "reservoirs"}/${sel.id}`); } catch (e) { return; }
    const el = $("#r-detail");
    el.innerHTML = `<div class="hd"><div style="flex:1;min-width:0"><h2 style="font-size:18px">${esc(d.name)}</h2><div class="sub">${esc(d.river)} · ${esc(d.basin)} basin · ${esc(d.district)}, ${esc(d.state)}</div></div>${pill(d.status, st ? null : d.status_label)}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin:12px 0 2px;flex-wrap:wrap"><span class="big">${fmt(d.current_level)} m</span><span class="sub">${st ? (d.above_danger_by >= 0 ? "+" : "") + fmt(d.above_danger_by) + " m vs danger level" : fmt(d.storage_pct, 1) + "% live storage (approx.)"}</span></div>
      <div class="sub">Updated ${fmtTime(d.updated_at)} (${ago(d.updated_at)}) <span class="src ${d.source}">${d.source}</span></div>
      <div class="chart" id="r-chart" style="margin:12px 0"></div>
      <div class="stats">${st ? `<div class="stat"><span>Warning level</span><b style="color:#8a6500">${fmt(d.warning_level)} m</b></div><div class="stat"><span>Danger level</span><b style="color:#d7263d">${fmt(d.danger_level)} m</b></div><div class="stat"><span>Highest flood level</span><b style="color:#7b1fa2">${fmt(d.hfl)} m</b></div><div class="stat" title="Forecast for ${esc(fmtTime(d.forecast_for))}"><span>Forecast level</span><b>${fmt(d.forecast_level)} m</b></div>`
        : `<div class="stat"><span>Full reservoir level (FRL)</span><b style="color:#d7263d">${fmt(d.frl)} m</b></div><div class="stat"><span>${d.below_frl_by < 0 ? "Above" : "Below"} FRL by</span><b>${fmt(Math.abs(d.below_frl_by))} m</b></div><div class="stat"><span>Min. draw-down (MDDL)</span><b>${fmt(d.mddl)} m</b></div><div class="stat"><span>Live storage (MCM)</span><b>${fmt(d.live_storage_mcm, 0)} / ${fmt(d.live_capacity_mcm, 0)}</b></div><div class="stat"><span>Inflow (cumecs)</span><b>${fmt(d.inflow_cumecs, 0)}</b></div><div class="stat"><span>Outflow (cumecs)</span><b>${fmt(d.outflow_cumecs, 0)}</b></div>`}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn sm pri" id="r-sim">Simulate this ${st ? "station" : "dam"}</button><button class="btn sm" id="r-map">Show on dashboard map</button></div>`;
    levelChart($("#r-chart"), st ? { history: d.history, forecast: { ts: d.forecast_for, level: d.forecast_level }, lines: [{ v: d.hfl, label: "HFL", color: "#7b1fa2", dash: 1 }, { v: d.danger_level, label: "Danger", color: "#d7263d" }, { v: d.warning_level, label: "Warning", color: "#c99400" }] }
      : { history: d.history, lines: [{ v: d.frl, label: "FRL", color: "#d7263d" }, { v: d.mddl, label: "MDDL", color: "#6b7d8f", dash: 1 }] });
    $("#r-sim").onclick = () => App.go("simulator", st ? { tab: "river", station: d.id } : { tab: "dam", dam: d.id });
    $("#r-map").onclick = () => App.go("dashboard", { select: d.id });
    if (doFlash) flash(el);
  }

  return { init, render };
})());
