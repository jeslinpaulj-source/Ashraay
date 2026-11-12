/* Monitor: status of monitor.py and the log of alerts it reported. */
App.register("monitor", (function () {
  const { esc, api, icon, ago, flash } = FFS;
  const $ = App.$;
  let filt = "all", last = null;

  function init() {}

  async function render(evt = {}) {
    let data;
    try { data = await api("/api/monitor"); } catch (e) { return; }
    last = data;
    const s = data.status;
    $("#m-status").innerHTML = `<div class="monstat"><div class="ring" style="background:${s.online ? "#e6f5ec" : "#eef2f6"}">${icon("radar", 24, s.online ? "#1f7a45" : "#6b7d8f")}</div>
      <div style="min-width:0"><h2 style="font-size:17px;color:${s.online ? "#1f7a45" : "#3d5368"}">${s.online ? "Monitor is running" : "Monitor is not running"}</h2>
      <div class="sub">${s.online ? `Last heartbeat ${s.last_seen_sec}s ago · watching ${s.watching ?? 0} alert(s)` : s.last_seen_sec != null ? `Last seen ${Math.round(s.last_seen_sec)} s ago` : "No heartbeat received yet — start monitor.bat"}</div></div></div>
      ${s.online ? `<dl class="kv" style="margin-top:12px"><dt>Computer</dt><dd>${esc(s.host || "–")}</dd><dt>Process id</dt><dd>${esc(s.pid || "–")}</dd><dt>Started</dt><dd>${esc((s.started_at || "").replace("T", " "))}</dd><dt>Levels reported</dt><dd>${s.min_level === "WATCH" ? "WATCH, HIGH, EXTREME" : "HIGH, EXTREME"}</dd></dl>
      <div class="sub" style="margin-top:10px">Log file: <code>${esc(s.log_file || "")}</code></div>` : ""}`;
    const ev = data.events;
    const n = { all: ev.length, EXTREME: 0, HIGH: 0, WATCH: 0, CLEARED: 0 };
    ev.forEach((e) => (n[e.level] = (n[e.level] || 0) + 1));
    $("#m-count").textContent = `${ev.length} line(s), newest first`;
    $("#m-filt").innerHTML = ["all", "EXTREME", "HIGH", "WATCH", "CLEARED"].filter((k) => k === "all" || n[k]).map((k) => `<button class="fchip ${filt === k ? "on" : ""}" data-f="${k}">${k === "all" ? "All" : k} <b>${n[k]}</b></button>`).join("");
    App.$$("#m-filt button").forEach((b) => (b.onclick = () => { filt = b.dataset.f; render({ kind: "filter" }); }));
    const list = ev.filter((e) => filt === "all" || e.level === filt);
    const KIND = { rain: "Weather", river: "River", dam: "Dam", warning: "Warning" };
    $("#m-tbl").innerHTML = `<thead><tr><th>Time</th><th>Change</th><th>Level</th><th>Type</th><th>Name</th><th>Place</th><th>Details</th></tr></thead><tbody>` +
      (list.length ? list.map((e, i) => `<tr data-i="${i}"><td class="num">${esc(new Date(e.ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</td>
        <td><b>${esc(e.change.replace(/_/g, " "))}</b></td><td><span class="lvl ${esc(e.level)}">${esc(e.level)}</span></td><td>${esc(KIND[e.kind] || e.kind)}</td>
        <td style="white-space:normal;min-width:160px"><b>${esc(e.name)}</b></td><td>${esc(e.place)}</td><td style="white-space:normal;min-width:260px" class="sub">${esc((e.detail && e.detail.summary) || "")}</td></tr>`).join("")
        : `<tr><td colspan="7"><div class="empty">${ev.length ? "No lines for this filter." : "Nothing reported yet. Start <code>monitor.bat</code>, then change something in the Simulator."}</div></td></tr>`) + "</tbody>";
    if (evt.kind === "monitor") flash($("#m-tbl tbody tr"));
  }

  return { init, render };
})());
