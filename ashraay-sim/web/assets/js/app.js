/* App shell: router, shared state, live updates. Views register themselves with App.register(). */
window.App = (function () {
  const { api, liveFeed, toast, clock, icon, RANK } = FFS;
  const NAV = [
    ["dashboard", "Dashboard", "dash"], ["weather", "Weather", "cloudrain"], ["rivers", "Rivers & dams", "waves"],
    ["simulator", "Simulator", "sliders"], ["monitor", "Monitor", "radar"],
  ];
  const PATHS = { simulate: "simulator", simulator: "simulator", reservoir: "simulator", weather: "weather", rivers: "rivers", monitor: "monitor", dashboard: "dashboard" };
  const A = { snap: null, meta: null, views: {}, inited: {}, current: null, params: {} };
  const $ = (s, r = document) => r.querySelector(s);
  A.$ = $;
  A.$$ = (s, r = document) => [...r.querySelectorAll(s)];
  A.register = (name, v) => (A.views[name] = v);

  // ---------- lookups ----------
  A.area = (id) => A.snap && A.snap.areas.find((a) => a.id === id);
  A.station = (id) => A.snap && A.snap.stations.find((s) => s.id === id);
  A.reservoir = (id) => A.snap && A.snap.reservoirs.find((r) => r.id === id);
  A.find = (kind, id) => (kind === "area" ? A.area(id) : kind === "station" ? A.station(id) : A.reservoir(id));
  A.dayLabel = (i) => (A.snap && A.snap.dates[i] ? A.snap.dates[i].label : `Day ${i + 1}`);
  A.dayDate = (i) => (A.snap && A.snap.dates[i] ? FFS.fmtDate(A.snap.dates[i].date) : "");
  A.condText = (d) => d.icon === "storm" ? "Thunderstorm with rain" : ["rain", "heavy_rain", "drizzle"].includes(d.icon)
    ? FFS.RAINK[d.rain_cat].label : ({ cloud: "Cloudy", partly: "Partly cloudy", sun: "Mostly sunny" })[d.icon];
  A.opt = (v, t, sel) => `<option value="${FFS.esc(v)}" ${sel ? "selected" : ""}>${FFS.esc(t)}</option>`;
  A.result = (el, ok, html) => { el.innerHTML = `<div class="result ${ok ? "ok" : "err"}" role="status">${html}</div>`; };

  // ---------- routing ----------
  function parse() {
    let h = location.hash.replace(/^#\/?/, "");
    if (!h) h = PATHS[location.pathname.replace(/^\/|\/$/g, "")] || "dashboard";
    const [name, q] = h.split("?");
    const params = Object.fromEntries(new URLSearchParams(q || ""));
    if (!h.includes("?") && location.pathname.replace(/^\//, "") === "reservoir") params.tab = "dam";
    return { name: A.views[name] ? name : "dashboard", params };
  }
  A.go = (name, params) => {
    const q = params ? "?" + new URLSearchParams(params).toString() : "";
    const h = "#/" + name + q;
    if (location.hash === h) route(); else location.hash = h;
  };
  function show(name) {
    const changed = A.current !== name;
    A.current = name;
    A.$$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === name));
    A.$$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "v-" + name));
    document.title = `${NAV.find((n) => n[0] === name)[1]} · ASHRAAY Hazard Simulator`;
    if (!A.snap) return;
    const v = A.views[name];
    if (!A.inited[name]) { v.init(); A.inited[name] = true; }
    v.render({ kind: "route" }, A.params);
    if (changed) window.scrollTo(0, 0);
  }
  function route() { const r = parse(); A.params = r.params; show(r.name); }

  function navBadges() {
    const s = A.snap.summary;
    const hot = s.areas_5d.extreme + s.areas_5d.severe + s.stations.extreme + s.stations.severe + s.reservoirs.extreme + s.reservoirs.severe;
    const b = $("#nav-badge-dashboard"); b.textContent = hot; b.classList.toggle("hidden", !hot);
    const m = $("#nav-badge-monitor"); m.style.background = A.snap.monitor.online ? "#3ddc84" : "#9aa9b8";
    m.title = A.snap.monitor.online ? "Monitor online" : "Monitor not running";
  }

  async function load(evt) {
    A.snap = await api("/api/snapshot");
    if (!A.meta || (evt && (evt.kind === "reset" || evt.kind === "rollover"))) A.meta = await api("/api/meta");
    navBadges();
    const v = A.views[A.current];
    if (!A.inited[A.current]) { v.init(); A.inited[A.current] = true; v.render({ kind: "route" }, A.params); }
    else v.render(evt || { kind: "load" }, A.params);
  }
  A.reload = load;

  A.start = function () {
    $("#nav").innerHTML = NAV.map(([k, t, ic]) => `<a href="#/${k}" data-v="${k}">${icon(ic, 15)}<span class="t">${t}</span>${k === "dashboard" ? `<span class="badge hidden" id="nav-badge-dashboard"></span>` : ""}${k === "monitor" ? `<i id="nav-badge-monitor" style="width:8px;height:8px;border-radius:50%;background:#9aa9b8;display:inline-block"></i>` : ""}</a>`).join("");
    clock($("#clock"));
    window.addEventListener("hashchange", route);
    const r = parse(); A.params = r.params; A.current = r.name; show(r.name);
    load().catch((e) => toast("Could not load data: " + e.message, "err"));
    let pending = null, queued = null;
    liveFeed((evt) => {
      if (evt.message && evt.kind !== "monitor") toast(evt.message);
      // coalesce bursts of events into one reload
      queued = evt;
      if (pending) return;
      pending = (async () => {
        while (queued) { const e = queued; queued = null; try { await load(e); } catch (er) { toast("Refresh failed: " + er.message, "err"); } }
        pending = null;
      })();
    }, $("#live"));
    // monitor heartbeat status changes without events: refresh badge every 15 s
    setInterval(async () => {
      try { const m = await api("/api/monitor"); if (A.snap) { A.snap.monitor = m.status; navBadges(); if (A.current === "monitor" || A.current === "dashboard") A.views[A.current].render({ kind: "tick" }, A.params); } } catch (e) { /* offline */ }
    }, 15000);
  };
  return A;
})();
