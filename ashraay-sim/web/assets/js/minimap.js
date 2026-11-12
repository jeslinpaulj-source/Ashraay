/* MiniMap: dependency-free canvas map (Web Mercator).
   Offline vector basemap (bundled GeoJSON) + optional OpenStreetMap tiles when online.
   Marker kinds: station (circle), reservoir (triangle), area (rounded square = weather point). */
(function () {
  const TILE = 256;
  const lon2x = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
  const lat2y = (lat, z) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
  };
  const x2lon = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
  const y2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z); return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

  class MiniMap {
    constructor(host, opts = {}) {
      this.host = host; this.opts = opts;
      this.canvas = document.createElement("canvas");
      this.canvas.setAttribute("aria-label", "Map of India with forecast points, river stations and dams");
      host.prepend(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.tip = document.createElement("div"); this.tip.className = "tip hidden"; host.appendChild(this.tip);
      this.zoom = 4.3; this.center = { lon: 82.0, lat: 22.8 };
      this.geo = null; this.markers = []; this.selected = null; this.hover = null;
      this.pulses = new Map(); this.tiles = new Map(); this.useTiles = false; this.fitted = false;
      this.tileUrl = opts.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
      this.w = 100; this.h = 100;
      this._bind();
      new ResizeObserver(() => this._resize()).observe(host);
    }
    setGeo(g) { this.geo = g; this.draw(); }
    setMarkers(m) { this.markers = m; this.draw(); }
    setTiles(on) { this.useTiles = on; this.draw(); }
    select(id) { this.selected = id; this.draw(); }
    pulse(id) { this.pulses.set(id, performance.now()); this._anim(); }
    fitIndia() {
      this.center = { lon: 82.0, lat: 22.8 };
      this.zoom = Math.max(3.4, Math.min(5.2, Math.log2(Math.min(this.w / 1.05, this.h / 1.3) / 256 * 360 / 32)));
      this.fitted = true; this.draw();
    }
    flyTo(lon, lat, z) { this.center = { lon, lat }; this.zoom = Math.max(this.zoom, z || 6); this.draw(); }
    zoomBy(d, px, py) {
      const nz = Math.max(3, Math.min(13, this.zoom + d));
      if (px == null) { px = this.w / 2; py = this.h / 2; }
      const ll = this.toLL(px, py);
      this.zoom = nz;
      const mx = lon2x(ll.lon, nz), my = lat2y(ll.lat, nz);
      this.center = { lon: x2lon(mx - (px - this.w / 2), nz), lat: y2lat(my - (py - this.h / 2), nz) };
      this.draw();
    }
    _cpx() { return { x: lon2x(this.center.lon, this.zoom), y: lat2y(this.center.lat, this.zoom) }; }
    toPx(lon, lat) { const c = this._cpx(); return { x: lon2x(lon, this.zoom) - c.x + this.w / 2, y: lat2y(lat, this.zoom) - c.y + this.h / 2 }; }
    toLL(px, py) { const c = this._cpx(); return { lon: x2lon(c.x + px - this.w / 2, this.zoom), lat: y2lat(c.y + py - this.h / 2, this.zoom) }; }

    _resize() {
      const r = this.host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (r.width < 10 || r.height < 10) return;             // hidden view
      this.w = r.width; this.h = r.height;
      this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
      this.canvas.style.height = this.h + "px";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.fitted) this.fitIndia(); else this.draw();
    }

    _bind() {
      const cv = this.canvas; let drag = null, moved = false;
      cv.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, c: this._cpx() }; moved = false; cv.setPointerCapture(e.pointerId); cv.classList.add("drag"); });
      cv.addEventListener("pointermove", (e) => {
        const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          this.center = { lon: x2lon(drag.c.x - dx, this.zoom), lat: y2lat(drag.c.y - dy, this.zoom) };
          this.tip.classList.add("hidden"); this.draw(); return;
        }
        const m = this._hit(px, py);
        if ((m && m.id) !== (this.hover && this.hover.id)) { this.hover = m; this.draw(); }
        if (m) {
          this.tip.innerHTML = this.opts.tooltip ? this.opts.tooltip(m) : m.id;
          this.tip.classList.remove("hidden");
          const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
          this.tip.style.left = Math.max(6, Math.min(px + 14, this.w - tw - 6)) + "px";
          this.tip.style.top = Math.max(6, Math.min(py - th - 10, this.h - th - 6)) + "px";
          cv.style.cursor = "pointer";
        } else { this.tip.classList.add("hidden"); cv.style.cursor = ""; }
      });
      cv.addEventListener("pointerup", (e) => {
        cv.classList.remove("drag");
        const r = cv.getBoundingClientRect();
        if (drag && !moved) { const m = this._hit(e.clientX - r.left, e.clientY - r.top); if (m && this.opts.onSelect) this.opts.onSelect(m); }
        drag = null;
      });
      cv.addEventListener("pointerleave", () => { this.tip.classList.add("hidden"); this.hover = null; this.draw(); });
      cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); this.zoomBy(e.deltaY < 0 ? 0.5 : -0.5, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
      cv.addEventListener("dblclick", (e) => { const r = cv.getBoundingClientRect(); this.zoomBy(1, e.clientX - r.left, e.clientY - r.top); });
    }

    _r() { return this.zoom < 5 ? 5.5 : this.zoom < 7 ? 7 : 8.5; }
    _hit(px, py) {
      let best = null, bd = this._r() + 6;
      for (const m of this.markers) {
        if (m.hidden) continue;
        const p = this.toPx(m.lon, m.lat), d = Math.hypot(p.x - px, p.y - py);
        if (d <= bd || (d === bd && best && (m.rank || 0) > (best.rank || 0))) { bd = d; best = m; }
      }
      return best;
    }

    _anim() {
      if (this._raf) return;
      const loop = () => {
        this._draw();
        const now = performance.now();
        for (const [k, t] of this.pulses) if (now - t > 4000) this.pulses.delete(k);
        this._raf = this.pulses.size ? requestAnimationFrame(loop) : null;
      };
      this._raf = requestAnimationFrame(loop);
    }

    _tile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      let t = this.tiles.get(key);
      if (!t) {
        t = { img: new Image(), ok: false };
        t.img.crossOrigin = "anonymous";
        t.img.onload = () => { t.ok = true; this.draw(); };
        t.img.onerror = () => { t.err = true; if (this.opts.onTileError) this.opts.onTileError(); };
        t.img.src = this.tileUrl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
        this.tiles.set(key, t);
        if (this.tiles.size > 600) this.tiles.delete(this.tiles.keys().next().value);
      }
      return t;
    }

    draw() {
      if (this._pending) return;
      this._pending = true;
      requestAnimationFrame(() => { this._pending = false; this._draw(); });
    }

    _draw() {
      const g = this.ctx, W = this.w, H = this.h;
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#cfe3f3"; g.fillRect(0, 0, W, H);
      if (this.geo) {
        for (const f of this.geo.features) {
          const india = f.properties.india;
          g.beginPath();
          const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
          for (const poly of polys) for (const ring of poly) ring.forEach(([lo, la], i) => { const p = this.toPx(lo, la); i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); });
          g.fillStyle = india ? "#fbfaf4" : "#e9ebe4"; g.fill("evenodd");
          g.strokeStyle = india ? "#8a9aab" : "#b9c2bb"; g.lineWidth = india ? 1.2 : 0.8; g.stroke();
        }
      }
      if (this.useTiles) {
        const z = Math.max(0, Math.min(18, Math.round(this.zoom)));
        const sc = 2 ** (this.zoom - z), c = this._cpx(), n = 2 ** z;
        const ox = c.x / sc - W / 2 / sc, oy = c.y / sc - H / 2 / sc;
        for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H / sc) / TILE); ty++) {
          if (ty < 0 || ty >= n) continue;
          for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W / sc) / TILE); tx++) {
            const t = this._tile(z, ((tx % n) + n) % n, ty);
            if (t.ok) g.drawImage(t.img, (tx * TILE - ox) * sc, (ty * TILE - oy) * sc, TILE * sc + 0.5, TILE * sc + 0.5);
          }
        }
      }
      const ms = this.markers.filter((m) => !m.hidden).sort((a, b) => (a.rank || 0) - (b.rank || 0));
      const now = performance.now(), r = this._r();
      const labels = [];
      for (const m of ms) {
        const p = this.toPx(m.lon, m.lat);
        if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
        const col = m.color || FFS.STATUS[m.status].color;
        const t0 = this.pulses.get(m.id);
        if (t0) {
          const k = ((now - t0) % 1000) / 1000;
          g.beginPath(); g.arc(p.x, p.y, r + 4 + k * 18, 0, 7);
          g.strokeStyle = `rgba(31,111,178,${1 - k})`; g.lineWidth = 3; g.stroke();
        }
        if (m.status === "extreme" || m.status === "severe") {
          g.beginPath(); g.arc(p.x, p.y, r + 5, 0, 7); g.fillStyle = FFS.STATUS[m.status].color + "33"; g.fill();
        }
        g.beginPath();
        if (m.kind === "reservoir") {
          const s = r + 2;
          g.moveTo(p.x, p.y - s); g.lineTo(p.x + s, p.y + s * 0.8); g.lineTo(p.x - s, p.y + s * 0.8); g.closePath();
          g.fillStyle = col; g.fill(); g.lineWidth = 2; g.strokeStyle = "#1f6fb2"; g.stroke();
        } else if (m.kind === "area") {
          const s = r * 0.95;
          if (g.roundRect) g.roundRect(p.x - s, p.y - s, s * 2, s * 2, 3); else g.rect(p.x - s, p.y - s, s * 2, s * 2);
          g.fillStyle = col; g.fill(); g.lineWidth = 1.5; g.strokeStyle = m.stroke || "#ffffff"; g.stroke();
        } else {
          g.arc(p.x, p.y, r, 0, 7); g.fillStyle = col; g.fill(); g.lineWidth = 2; g.strokeStyle = "#fff"; g.stroke();
        }
        if (m.id === this.selected || (this.hover && m.id === this.hover.id)) {
          g.beginPath(); g.arc(p.x, p.y, r + 7, 0, 7); g.lineWidth = 2.5; g.strokeStyle = "#0b2a4a"; g.stroke();
        }
        if (this.zoom >= 8 || (this.zoom >= 6 && (m.rank || 0) >= 2) || m.id === this.selected) labels.push({ m, p });
      }
      g.font = "600 11px Segoe UI, system-ui, sans-serif"; g.lineWidth = 3; g.lineJoin = "round";
      const boxes = [];
      for (const { m, p } of labels.reverse()) {     // highest rank first
        const tw = g.measureText(m.name).width, bx = { x: p.x + r + 5, y: p.y - 7, w: tw, h: 14 };
        if (boxes.some((b) => bx.x < b.x + b.w && bx.x + bx.w > b.x && bx.y < b.y + b.h && bx.y + bx.h > b.y)) continue;
        boxes.push(bx);
        g.strokeStyle = "rgba(255,255,255,.92)"; g.strokeText(m.name, bx.x, p.y + 4);
        g.fillStyle = "#14263a"; g.fillText(m.name, bx.x, p.y + 4);
      }
    }
  }
  window.MiniMap = MiniMap;
})();
