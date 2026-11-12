// ASHRAAY Event Simulator: lets you push simulated weather/reservoir values that Agent 1
// (the Command Center's hazard predictor) uses instead of the live weather feed for a city.
(function () {
  const $ = (id) => document.getElementById(id);
  const API = window.ASHRAAY_API_BASE;

  // Keep in sync with the city list in command-center/dashboard.js.
  const CITIES = {
    bengaluru: "Bengaluru",
    kochi: "Kochi",
    thiruvananthapuram: "Thiruvananthapuram",
    chennai: "Chennai",
    mumbai: "Mumbai",
    delhi: "New Delhi",
    kolkata: "Kolkata"
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));

  function rewriteAppLinks() {
    document.querySelectorAll("a[data-port]").forEach((link) => {
      link.href = `${location.protocol}//${location.hostname}:${link.dataset.port}${link.dataset.path || "/"}`;
    });
  }

  function populateCities() {
    $("sim-city").innerHTML = Object.entries(CITIES)
      .map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`)
      .join("");
  }

  async function fetchJson(path, options) {
    const response = await fetch(`${API}${path}`, options);
    if (!response.ok) {
      const text = await response.text();
      let message = `Request failed (${response.status}).`;
      try {
        const payload = JSON.parse(text);
        if (typeof payload.detail === "string") message = payload.detail;
      } catch {
        if (text) message = text;
      }
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }

  function row(cityId, entry) {
    const updated = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : "-";
    return `<tr>
      <td>${escapeHtml(CITIES[cityId] || cityId)}</td>
      <td>${escapeHtml(entry.rain24Mm)}</td>
      <td>${escapeHtml(entry.floodRiskPct)}</td>
      <td>${escapeHtml(entry.reservoirFillPct)}</td>
      <td>${escapeHtml(updated)}</td>
      <td><button type="button" class="btn" data-clear="${escapeHtml(cityId)}">Clear</button></td>
    </tr>`;
  }

  async function refreshTable() {
    let data = {};
    try {
      data = await fetchJson("/simulator/hazard-inputs");
    } catch {
      data = {};
    }
    const entries = Object.entries(data || {});
    $("sim-rows").innerHTML = entries.map(([cityId, entry]) => row(cityId, entry)).join("");
    $("sim-empty").classList.toggle("hidden", entries.length > 0);
  }

  function showMessage(text, isError) {
    const box = $("sim-message");
    box.textContent = text;
    box.classList.toggle("error", Boolean(isError));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const body = {
      cityId: $("sim-city").value,
      rain24Mm: Number($("sim-rain").value),
      floodRiskPct: Number($("sim-flood").value),
      reservoirFillPct: Number($("sim-reservoir").value)
    };
    try {
      await fetchJson("/simulator/hazard-inputs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      showMessage(`Saved. Agent 1 will use these values for ${CITIES[body.cityId] || body.cityId} until cleared.`, false);
      await refreshTable();
    } catch (error) {
      showMessage(error.message, true);
    }
  }

  async function handleTableClick(event) {
    const button = event.target.closest("[data-clear]");
    if (!button) return;
    try {
      await fetchJson(`/simulator/hazard-inputs/${encodeURIComponent(button.dataset.clear)}`, { method: "DELETE" });
      await refreshTable();
    } catch (error) {
      showMessage(error.message, true);
    }
  }

  function init() {
    rewriteAppLinks();
    populateCities();
    $("sim-form").addEventListener("submit", handleSubmit);
    $("sim-rows").addEventListener("click", handleTableClick);
    refreshTable();
    setInterval(refreshTable, 10000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
