/* Weather: State -> District -> Ward forecast, 2-day / 5-day, ward-wise and district-wise outlook. */
App.register("weather", (function () {
  const { STATUS, RANK, RAIN, RAINK, rainCat, esc, fmt, mm, ago, wxPill, wxIcon, icon, flash } = FFS;
  const $ = App.$;
  let span = 2, cur = { state: "Karnataka", dist: "Bengaluru Urban", ward: "W-BENGALURU-URBAN-BELLANDUR" };

  const tree = () => App.meta.weather_tree;
  const worstOf = (days, n) => days.slice(0, n).reduce((s, d) => (RANK[d.status] > RANK[s] ? d.status : s), "normal");
  const cellHtml = (d) => { const c = RAINK[d.rain_cat]; const extra = RANK[d.status] > RANK[FFS.wxStatusFromRain(d.rain_mm)] ? `box-shadow:inset 0 0 0 2px ${STATUS[d.status].color}` : "";
    return `<span class="cell" style="background:${c.color};color:${c.fg};${extra}" title="${esc(c.label)}${d.reasons ? " · " + esc(d.reasons.join(", ")) : ""}">${mm(d.rain_mm)}<small>${c.short}</small></span>`; };

  function init() {
    App.$$("#w-span button").forEach((b) => (b.onclick = () => { span = +b.dataset.n; App.$$("#w-span button").forEach((x) => x.classList.toggle("on", x === b)); render(); }));
    $("#w-state").onchange = () => { cur.state = $("#w-state").value; cur.dist = Object.keys(tree()[cur.state]).sort()[0]; cur.ward = null; render(); };
    $("#w-dist").onchange = () => { cur.dist = $("#w-dist").value; cur.ward = null; render(); };
    $("#w-ward").onchange = () => { cur.ward = $("#w-ward").value; render(); };
    $("#w-scale1").innerHTML = RAIN.slice(1).map((r) => `<span><i class="sq" style="background:${r.color}"></i>${r.short}</span>`).join("");
  }

  function selectors() {
    const t = tree();
    if (!t[cur.state]) cur.state = Object.keys(t).sort()[0];
    if (!t[cur.state][cur.dist]) cur.dist = Object.keys(t[cur.state]).sort()[0];
    const wards = t[cur.state][cur.dist];
    if (!cur.ward || !wards.some((w) => w.id === cur.ward)) cur.ward = wards[0].id;
    $("#w-state").innerHTML = Object.keys(t).sort().map((s) => App.opt(s, `${s} (${Object.values(t[s]).flat().length})`, s === cur.state)).join("");
    $("#w-dist").innerHTML = Object.keys(t[cur.state]).sort().map((d) => App.opt(d, `${d} (${t[cur.state][d].length})`, d === cur.dist)).join("");
    $("#w-ward").innerHTML = wards.map((w) => App.opt(w.id, w.name, w.id === cur.ward)).join("");
    $("#w-sim").href = `#/simulator?tab=rain&ward=${encodeURIComponent(cur.ward)}`;
  }

  function render(evt = {}, params = {}) {
    if (evt.kind === "route" && params.ward) {
      const a = App.area(params.ward);
      if (a) cur = { state: a.state, dist: a.district, ward: a.id };
    }
    selectors();
    const a = App.area(cur.ward);
    if (!a) return;
    wardCard(a);
    const inDist = App.snap.areas.filter((x) => x.state === cur.state && x.district === cur.dist);
    distCard(inDist);
    wardTable(inDist);
    stateTable();
    if (evt.kind === "weather" && (evt.target_id === a.id || !evt.target_id)) { flash($("#w-wardcard")); }
  }

  function wardCard(a) {
    const st = worstOf(a.days, span);
    const days = a.days.slice(0, span).map((d, i) => {
      const c = RAINK[d.rain_cat];
      return `<div class="day" style="--c:${STATUS[d.status].color}">
        <div><div class="dl">${App.dayLabel(i)}${d.src === "sim" ? ' <span class="src sim" style="margin-left:4px;vertical-align:2px">simulated</span>' : ""}</div><div class="dd">${i < 2 ? App.dayDate(i) : "Day " + (i + 1) + " of 5"}</div>
        <div class="wi">${wxIcon(d.icon, span === 2 ? 60 : 44)}<div><div class="rain">${mm(d.rain_mm)}<small> mm</small></div></div></div>
        <div class="cond">${App.condText(d) !== c.label ? esc(App.condText(d)) : ""}</div>
        <span class="pill" style="background:${c.color};color:${c.fg};${c.k === "no_rain" ? "border:1px solid #dfe6ee" : ""}">${c.label}</span></div>
        <div><div class="rows"><span>Chance of rain</span><span>${d.chance}%</span><span>Max / min</span><span>${d.tmax.toFixed(0)}° / ${d.tmin.toFixed(0)}°C</span>
          <span>Wind · gusts</span><span>${d.wind_kmh.toFixed(0)} · ${d.gust_kmh.toFixed(0)} km/h</span><span>Humidity</span><span>${d.humidity}%</span></div>
        <div class="why" style="color:${d.status === "normal" ? "#1f7a45" : FFS.statusInk(d.status)}">${d.status === "normal" ? "● Green · no warning" : "● " + STATUS[d.status].wx + " · " + esc((d.reasons || []).join(", "))}</div></div>
      </div>`;
    }).join("");
    $("#w-wardcard").innerHTML = `<div class="hd"><div style="min-width:0"><h2 style="font-size:19px">${esc(a.name)}</h2>
      <div class="sub">${a.area_kind === "ward" ? "Ward / area" : "District forecast point"} · ${esc(a.district)}, ${esc(a.state)} · updated ${ago(a.updated_at)} <span class="src ${a.source}">${a.source}</span></div></div>
      <div class="sp" style="text-align:right">${wxPill(st)}<div class="sub" style="margin-top:4px">worst of next ${span} days</div></div></div>
      <div class="days n${span}">${days}</div>
      ${span === 2 ? `<div class="hd" style="margin-top:16px"><h2 style="font-size:13.5px">5-day outlook</h2><span class="sub">click for full 5-day view</span></div>
      <div class="mini5">${a.days.map((d, i) => { const c = RAINK[d.rain_cat]; return `<button data-i="${i}" style="border-left:4px solid ${STATUS[d.status].color}">${wxIcon(d.icon, 30)}<span style="min-width:0"><small>${esc(App.dayLabel(i))}</small><b>${mm(d.rain_mm)} mm</b><small>${c.short} · ${d.tmax.toFixed(0)}°</small></span></button>`; }).join("")}</div>` : ""}`;
    App.$$("#w-wardcard .mini5 button").forEach((b) => (b.onclick = () => $('#w-span button[data-n="5"]').click()));
  }

  function distCard(list) {
    const n = App.snap.dates.length;
    const perDay = Array.from({ length: n }, (_, i) => list.reduce((m, a) => (a.days[i].rain_mm > m.rain ? { rain: a.days[i].rain_mm, a } : m), { rain: 0, a: null }));
    const peak = perDay.reduce((m, x, i) => (x.rain > m.rain ? { ...x, i } : m), { rain: -1 });
    const hot = list.filter((a) => RANK[worstOf(a.days, span)] >= 2).length;
    const yellow = list.filter((a) => worstOf(a.days, span) === "above_normal").length;
    const max = Math.max(80, ...perDay.map((x) => x.rain));
    $("#w-distcard").innerHTML = `<div class="hd"><h2>${esc(cur.dist)}</h2><span class="sub">district summary</span></div>
      <div class="stats" style="margin-top:10px">
        <div class="stat"><span>${list.length > 1 ? "Wards" : "Forecast points"}</span><b>${list.length}</b></div>
        <div class="stat"><span>Orange / Red · ${span} d</span><b style="color:${hot ? "#d7263d" : "inherit"}">${hot}</b></div>
        <div class="stat"><span>Yellow · ${span} d</span><b>${yellow}</b></div>
        <div class="stat"><span>Peak rain · 5 d</span><b>${mm(peak.rain)} mm</b></div>
      </div>
      <div class="sub" style="margin-top:10px">${peak.a && peak.rain > 0 ? `Peak: <b>${esc(peak.a.name)}</b>, ${App.dayLabel(peak.i)}` : "No rain expected in the next 5 days."}</div>
      <div class="bars" aria-label="Highest rain per day">${perDay.map((x) => { const c = rainCat(x.rain); return `<div><span class="num">${mm(x.rain)}</span><i style="height:${Math.max(2, (x.rain / max) * 92)}%;background:${c.k === "no_rain" ? "#dfe6ee" : c.color}"></i></div>`; }).join("")}</div>
      <div class="barlab">${App.snap.dates.map((d, i) => `<span>${i === 0 ? "Today" : new Date(d.date + "T00:00:00").toLocaleDateString([], { weekday: "short" })}</span>`).join("")}</div>
      <div class="sub" style="margin-top:4px">Highest rain (mm) of any ward per day</div>`;
  }

  function wardTable(list) {
    $("#w-wards-title").textContent = `Ward-wise outlook · ${cur.dist}`;
    const head = `<thead><tr><th>Ward / area</th>${App.snap.dates.map((d, i) => `<th>${esc(d.label)}<small>${i < 2 ? FFS.fmtDate(d.date) : ""}</small></th>`).join("")}<th>Next ${span} days</th></tr></thead>`;
    const rows = list.slice().sort((x, y) => RANK[worstOf(y.days, span)] - RANK[worstOf(x.days, span)] || RANK[y.status] - RANK[x.status] || y.max_rain_mm - x.max_rain_mm || x.name.localeCompare(y.name)).map((a) =>
      `<tr data-id="${a.id}" class="${a.id === cur.ward ? "sel" : ""}"><td>${esc(a.name)}</td>${a.days.map(cellHtml).map((c) => `<td>${c}</td>`).join("")}<td>${wxPill(worstOf(a.days, span), true)}</td></tr>`).join("");
    $("#w-wards").innerHTML = head + `<tbody>${rows}</tbody>`;
    App.$$("#w-wards tbody tr").forEach((tr) => (tr.onclick = () => { cur.ward = tr.dataset.id; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  }

  function stateTable() {
    $("#w-state-title").textContent = `District-wise outlook · ${cur.state}`;
    const t = tree()[cur.state];
    const rows = Object.keys(t).sort().map((dist) => {
      const list = App.snap.areas.filter((a) => a.state === cur.state && a.district === dist);
      const days = App.snap.dates.map((_, i) => list.reduce((m, a) => (RANK[a.days[i].status] > RANK[m.status] || (RANK[a.days[i].status] === RANK[m.status] && a.days[i].rain_mm > m.rain_mm) ? a.days[i] : m), list[0].days[i]));
      return { dist, list, days, st: list.reduce((s, a) => (RANK[worstOf(a.days, span)] > RANK[s] ? worstOf(a.days, span) : s), "normal") };
    }).sort((x, y) => RANK[y.st] - RANK[x.st] || x.dist.localeCompare(y.dist));
    const head = `<thead><tr><th>District</th>${App.snap.dates.map((d) => `<th>${esc(d.label)}</th>`).join("")}<th>Next ${span} days</th></tr></thead>`;
    $("#w-dists").innerHTML = head + "<tbody>" + rows.map((r) => `<tr data-d="${esc(r.dist)}" class="${r.dist === cur.dist ? "sel" : ""}"><td>${esc(r.dist)} <span class="muted" style="font-weight:500">· ${r.list.length} ${r.list.length > 1 ? "wards" : "point"}</span></td>${r.days.map((d) => `<td>${cellHtml(d)}</td>`).join("")}<td>${wxPill(r.st, true)}</td></tr>`).join("") + "</tbody>";
    App.$$("#w-dists tbody tr").forEach((tr) => (tr.onclick = () => { cur.dist = tr.dataset.d; cur.ward = null; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  }

  return { init, render };
})());
