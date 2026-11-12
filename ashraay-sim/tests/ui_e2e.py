"""Browser end-to-end test (optional - needs: pip install playwright && playwright install chromium).

    python tests/ui_e2e.py            # starts its own server on port 8765 + monitor, runs the scenario
"""
import json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("E2E_PORT", "8765"))
BASE = f"http://localhost:{PORT}"
CHROME = os.environ.get("E2E_CHROME")  # optional browser path
SHOTS = os.environ.get("E2E_SHOTS", os.path.join(ROOT, "tests", "shots"))
BELL = "W-BENGALURU-URBAN-BELLANDUR"

def wait_http(url, t=20):
    import urllib.request
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    end = time.time() + t
    while time.time() < end:
        try:
            op.open(url, timeout=2).read(); return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError("server did not start")

def main():
    os.makedirs(SHOTS, exist_ok=True)
    data = tempfile.mkdtemp(prefix="ashraay-e2e-")
    logs = os.path.join(data, "logs")
    env = dict(os.environ, FFS_DATA_DIR=data, PYTHONUNBUFFERED="1")
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--port", str(PORT)], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    mon = None
    errors, ok = [], []
    def check(name, cond):
        (ok if cond else errors).append(name); print(("PASS " if cond else "FAIL ") + name, flush=True)
    try:
        wait_http(BASE + "/api/health")
        # monitor writes its logs to a temp folder for the test
        code = f"import sys; sys.path.insert(0, r'{ROOT}'); import monitor; w = monitor.Watch('{BASE}', log_dir=r'{logs}', color=False); w.run()"
        mon = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with sync_playwright() as p:
            kw = {"args": ["--no-proxy-server"]}
            if CHROME: kw["executable_path"] = CHROME
            b = p.chromium.launch(**kw)
            ctx = b.new_context(viewport={"width": 1600, "height": 1000})
            pages = {}
            for name, url in [("dash", "/#/dashboard"), ("wx", f"/#/weather?ward={BELL}"), ("sim", "/#/simulator?tab=rain"), ("mon", "/#/monitor")]:
                pg = ctx.new_page()
                pg.on("pageerror", lambda e, n=name: errors.append(f"{n} pageerror: {e}"))
                pg.on("console", lambda m, n=name: errors.append(f"{n} console: {m.text}") if m.type == "error" and "ERR_NAME_NOT_RESOLVED" not in m.text and "status of 400" not in m.text else None)
                pg.goto(BASE + url); pages[name] = pg
            dash, wx, sim, monp = pages["dash"], pages["wx"], pages["sim"], pages["mon"]
            dash.wait_for_selector("#d-kpis .kpi"); wx.wait_for_selector("#w-wardcard .day"); sim.wait_for_selector("#s-r-quick button")
            time.sleep(4)   # let the monitor connect + heartbeat
            orange_before = int(dash.inner_text('#d-kpis .kpi[data-k="orange"] b'))
            check("weather page opens Bellandur", "Bellandur" in wx.inner_text("#w-wardcard h2"))
            # ---- 1. 15 cm rain tomorrow in Bellandur ----
            sim.click("#s-r-quick button >> nth=0")
            check("quick button sets 15 cm", sim.input_value("#s-r-rain") == "15" and sim.input_value("#s-r-unit") == "cm")
            check("preview shows Orange", "Orange" in sim.inner_text("#s-r-prev"))
            sim.click("#s-r-go"); sim.wait_for_selector("#s-r-res .result")
            check("rain submit ok", "150 mm" in sim.inner_text("#s-r-res"))
            expect(wx.locator("#w-wardcard .day >> nth=1")).to_contain_text("150", timeout=5000)
            check("weather page updated live (no reload)", True)
            expect(dash.locator('#d-kpis .kpi[data-k="orange"] b')).not_to_have_text(str(orange_before), timeout=5000)
            check("dashboard Orange KPI increased", int(dash.inner_text('#d-kpis .kpi[data-k="orange"] b')) == orange_before + 1)
            expect(dash.locator("#d-alerts")).to_contain_text("Bellandur", timeout=5000)
            check("dashboard alert list has Bellandur", True)
            expect(monp.locator("#m-tbl")).to_contain_text("Bellandur", timeout=8000)
            check("monitor page shows Bellandur line", "NEW" in monp.inner_text("#m-tbl"))
            check("monitor shows online", "running" in monp.inner_text("#m-status"))
            # ---- 2. dam above FRL ----
            sim.goto(BASE + "/#/simulator?tab=dam&dam=RSV-KRS"); sim.wait_for_selector("#s-d-quick button")
            time.sleep(0.5)
            check("dam deep link selects KRS", sim.input_value("#s-d-dam") == "RSV-KRS" and sim.input_value("#s-d-dist") == "Mandya")
            sim.click("#s-d-quick button >> nth=4"); sim.click("#s-d-go"); sim.wait_for_selector("#s-d-res .result")
            check("dam submit ok", "At / above FRL" in sim.inner_text("#s-d-res"))
            expect(dash.locator("#d-alerts")).to_contain_text("Krishna Raja Sagara", timeout=5000)
            check("dashboard shows KRS alert", True)
            # ---- 3. river to extreme ----
            sim.goto(BASE + "/#/simulator?tab=river&station=GNG-VNS"); sim.wait_for_selector("#s-v-quick button"); time.sleep(0.4)
            sim.click("#s-v-quick button >> nth=3"); sim.click("#s-v-go"); sim.wait_for_selector("#s-v-res .result")
            check("river submit ok (Extreme)", "Extreme" in sim.inner_text("#s-v-res"))
            # ---- 4. whole district 250 mm on day 3 ----
            sim.goto(BASE + "/#/simulator?tab=rain"); time.sleep(0.4)
            sim.click('#s-r-scope button[data-s="district"]'); sim.click("#s-r-strip div >> nth=2")
            sim.fill("#s-r-rain", "250"); sim.select_option("#s-r-unit", "mm")
            check("district preview shows Red + 21 areas", "Red" in sim.inner_text("#s-r-prev") and "21 areas" in sim.inner_text("#s-r-prev"))
            sim.click("#s-r-go"); sim.wait_for_selector("#s-r-res .result")
            dash.click('#d-days button[data-k="d5"]'); time.sleep(1.5)
            check("dashboard Red KPI >= 21 (5 days)", int(dash.inner_text('#d-kpis .kpi[data-k="red"] b')) >= 21)
            # ---- 5. validation ----
            sim.fill("#s-r-rain", "-5"); sim.click("#s-r-go"); sim.wait_for_selector("#s-r-res .result.err")
            check("negative rain rejected", "must be >= 0" in sim.inner_text("#s-r-res"))
            # ---- 6. custom warning ----
            sim.goto(BASE + "/#/simulator?tab=warning"); time.sleep(0.4)
            sim.fill("#s-w-title", "Flood warning - Bellandur"); sim.fill("#s-w-msg", "Move to safer places.")
            sim.click("#s-w-go"); sim.wait_for_selector("#s-w-res .result")
            dash.click('#d-tabs button[data-t="warnings"]')
            expect(dash.locator("#d-tab-warnings")).to_contain_text("Flood warning - Bellandur", timeout=5000)
            check("custom warning on dashboard", True)
            time.sleep(2)
            # ---- screenshots ----
            for v in ["dashboard", "weather", "rivers", "simulator", "monitor"]:
                dash.goto(BASE + f"/#/{v}" + (f"?ward={BELL}" if v == "weather" else "")); time.sleep(1.2)
                dash.screenshot(path=os.path.join(SHOTS, f"{v}.png"), full_page=True)
            # ---- 7. reset ----
            sim.goto(BASE + "/#/simulator?tab=rain"); time.sleep(0.3)
            sim.on("dialog", lambda d: d.accept())
            sim.click("#s-reset-alerts")
            expect(sim.locator("#s-reset-alerts-res .result.ok")).to_contain_text("seed alerts remain")
            time.sleep(3)
            b.close()
        lines = [json.loads(l) for l in open(os.path.join(logs, "alerts.jsonl"), encoding="utf-8")]
        ch = [(l["change"], l["level"], l["name"]) for l in lines]
        check("monitor log: Bellandur NEW HIGH", ("NEW", "HIGH", "Bellandur") in ch)
        check("monitor log: Bellandur UPGRADED EXTREME (district 250 mm)", ("UPGRADED", "EXTREME", "Bellandur") in ch)
        check("monitor log: KRS NEW EXTREME", ("NEW", "EXTREME", "Krishna Raja Sagara (KRS)") in ch)
        check("monitor log: Varanasi NEW EXTREME", any(c == ("NEW", "EXTREME", "Varanasi (Ganga)") for c in ch))
        check("monitor log: CLEARED after reset", any(c[0] == "CLEARED" and c[2] == "Bellandur" for c in ch))
        check("monitor text log written", os.path.getsize(os.path.join(logs, "monitor.log")) > 0)
    finally:
        if mon: mon.terminate()
        srv.terminate()
        time.sleep(0.5)
        shutil.rmtree(data, ignore_errors=True)
    print(f"\n{len(ok)} passed, {len(errors)} failed")
    for e in errors: print("  -", e)
    sys.exit(1 if errors else 0)

if __name__ == "__main__":
    main()
