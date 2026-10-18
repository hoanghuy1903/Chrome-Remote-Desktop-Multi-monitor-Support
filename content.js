// CRD Multi-Monitor — content script for remotedesktop.google.com
//
// With "Show all displays", CRD receives one WebRTC video per remote monitor and
// paints each into its own <canvas>, side by side. We open one popup per remote
// monitor and play that monitor's MediaStream in it directly (no re-encoding).
// Input in a popup is mapped onto the matching canvas in the CRD tab and
// re-dispatched there as ordinary DOM events, which CRD forwards to the host.
//
// Older/other layouts that show a single stitched video are still handled by
// cropping that video into several regions (the "layout" settings).

(() => {
  'use strict';
  if (window.__crdMultiMonitor) return;
  window.__crdMultiMonitor = true;
  // Chrome can also inject this script into our own viewer popups (blank pages opened
  // from the CRD tab). They're driven from the CRD tab, so stay out of them.
  if (window.name.startsWith('crdmm_viewer_') || location.protocol === 'about:') return;

  const KEY = 'crdmm';
  const DEFAULTS = {
    layout: 'auto',      // single-video mode only: auto | columns | rows | custom
    count: 2,
    custom: '',
    fullscreen: true,
    keyboardLock: true,  // capture Win, Alt+Tab, Ctrl+W… in viewers (needs page fullscreen)
    mainDisplay: 0,      // remote display kept in the CRD tab itself (-1 = show all, like stock CRD)
    assignments: {},     // remote display index -> local display id ('none' = don't place)
    collapsed: false,
  };
  let settings = { ...DEFAULTS };
  let displays = [];
  const viewers = new Map(); // index -> viewer
  let panelHost = null;
  let ui = null;
  let panelHidden = false;

  // ---------------------------------------------------------------- helpers

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r); });
    } catch { resolve(null); }
  });
  const save = () => { try { chrome.storage.local.set({ [KEY]: settings }); } catch {} };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function deepAll(selector, root = document, out = []) {
    root.querySelectorAll(selector).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot && el !== panelHost) deepAll(selector, el.shadowRoot, out); });
    return out;
  }

  const isBig = (el) => { const r = el.getBoundingClientRect(); return r.width >= 50 && r.height >= 50; };
  const hasStream = (v) => !!(v.videoWidth && v.srcObject && typeof v.srcObject.getTracks === 'function');

  function srcSize(el) {
    if (!el) return null;
    if (el.tagName === 'VIDEO') return el.videoWidth && el.videoHeight ? { W: el.videoWidth, H: el.videoHeight } : null;
    return el.width && el.height ? { W: el.width, H: el.height } : null;
  }

  const capturedStreams = new WeakMap();
  function captureOf(el) {
    if (typeof el.captureStream !== 'function') return null;
    let s = capturedStreams.get(el);
    if (!s) {
      try { s = el.captureStream(60); } catch { s = null; }
      if (s) capturedStreams.set(el, s);
    }
    return s;
  }

  // Where the picture actually sits inside its element (videos letterbox by default).
  function contentRect(el) {
    const r = el.getBoundingClientRect();
    const sz = srcSize(el);
    if (!sz || getComputedStyle(el).objectFit === 'fill') return r;
    const s = Math.min(r.width / sz.W, r.height / sz.H);
    const w = sz.W * s, h = sz.H * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
  }

  // ---------------------------------------------------------------- remote displays

  // Pair each visible canvas with the hidden <video> that feeds it, by comparing
  // tiny thumbnails. DOM order alone isn't guaranteed to match.
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, nextId++); return ids.get(el); };
  let pairCache = { key: '', map: [], t: 0 };
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 32; thumbCanvas.height = 18;
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  const thumb = (el) => { thumbCtx.drawImage(el, 0, 0, 32, 18); return thumbCtx.getImageData(0, 0, 32, 18).data; };
  const thumbDiff = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return s;
  };

  function pairVideos(canvases, videos) {
    if (!videos.length) return canvases.map(() => null);
    const key = canvases.map(idOf).join(',') + '|' + videos.map(idOf).join(',');
    const now = performance.now();
    if (pairCache.key === key && now - pairCache.t < 5000) return pairCache.map;
    let map;
    try {
      const cs = canvases.map(thumb), vs = videos.map(thumb);
      const pairs = [];
      cs.forEach((c, i) => vs.forEach((v, j) => pairs.push([thumbDiff(c, v), i, j])));
      pairs.sort((a, b) => a[0] - b[0]);
      map = canvases.map(() => null);
      const used = new Set();
      for (const [, i, j] of pairs) {
        if (map[i] || used.has(j)) continue;
        map[i] = videos[j]; used.add(j);
      }
    } catch {
      map = canvases.map((_, i) => videos[i] || null);
    }
    pairCache = { key, map, t: now };
    return map;
  }

  // A "unit" is one remote display: the element showing it in the CRD tab (input
  // target), the stream to play in the viewer, the frame size and the crop rect.
  let unitCache = { t: 0, mode: null, list: [] };
  function getUnits() {
    const now = performance.now();
    if (now - unitCache.t < 400 && unitCache.list.every((u) => u.el.isConnected)) return unitCache;
    unitCache = { ...computeUnits(), t: now };
    return unitCache;
  }

  function computeUnits() {
    const canvases = deepAll('canvas').filter((c) => c.width && c.height && isBig(c));
    const videos = deepAll('video').filter(hasStream);

    if (canvases.length >= 2) {
      // Number displays left to right as CRD lays them out. Once the main-tab layout
      // stacks them on top of each other positions are meaningless, so the order is
      // remembered on the canvases and only re-measured (with our layout switched
      // off) when CRD creates new ones.
      if (canvases.every((c) => c.dataset.crdmmOrder)) {
        canvases.sort((a, b) => a.dataset.crdmmOrder - b.dataset.crdmmOrder);
      } else {
        if (layoutStyle) layoutStyle.disabled = true;
        canvases.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.left - rb.left || ra.top - rb.top;
        });
        canvases.forEach((c, i) => { c.dataset.crdmmOrder = String(i + 1); });
        if (layoutStyle) layoutStyle.disabled = false;
      }
      const pair = pairVideos(canvases, videos);
      return {
        mode: 'multi',
        list: canvases.map((c, i) => {
          const v = pair[i];
          const W = v ? v.videoWidth : c.width, H = v ? v.videoHeight : c.height;
          return { el: c, stream: v ? v.srcObject : captureOf(c), W, H, rect: { x: 0, y: 0, w: W, h: H } };
        }),
      };
    }

    // Single picture: the largest visible video or canvas.
    let src = null, best = 0;
    for (const el of [...canvases, ...deepAll('video').filter((v) => v.videoWidth && isBig(v))]) {
      const r = el.getBoundingClientRect();
      const score = r.width * r.height;
      if (score > best) { best = score; src = el; }
    }
    if (!src) return { mode: null, list: [] };
    let W, H, stream;
    if (src.tagName === 'VIDEO') {
      W = src.videoWidth; H = src.videoHeight;
      stream = hasStream(src) ? src.srcObject : captureOf(src);
    } else {
      const v = pairVideos([src], videos)[0];
      W = v ? v.videoWidth : src.width; H = v ? v.videoHeight : src.height;
      stream = v ? v.srcObject : captureOf(src);
    }
    return { mode: 'single', W, H, list: computeRects(W, H).map((rect) => ({ el: src, stream, W, H, rect })) };
  }

  function computeRects(W, H) {
    const n = clamp(parseInt(settings.count, 10) || 1, 1, 8);
    const cols = (k) => Array.from({ length: k }, (_, i) => {
      const x = Math.round((i * W) / k), x2 = Math.round(((i + 1) * W) / k);
      return { x, y: 0, w: x2 - x, h: H };
    });
    const rows = (k) => Array.from({ length: k }, (_, i) => {
      const y = Math.round((i * H) / k), y2 = Math.round(((i + 1) * H) / k);
      return { x: 0, y, w: W, h: y2 - y };
    });
    switch (settings.layout) {
      case 'columns': return cols(n);
      case 'rows': return rows(n);
      case 'custom': {
        const r = parseCustom(settings.custom, W, H);
        return r.length ? r : [{ x: 0, y: 0, w: W, h: H }];
      }
      default: {
        // Guess from aspect ratio, assuming ~16:9 monitors.
        const nc = Math.round(W / H / (16 / 9));
        const nr = Math.round(H / W / (9 / 16));
        if (nc >= 2) return cols(Math.min(nc, 8));
        if (nr >= 2) return rows(Math.min(nr, 8));
        return [{ x: 0, y: 0, w: W, h: H }];
      }
    }
  }

  function parseCustom(text, W, H) {
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((a) => (Array.isArray(a) ? { x: +a[0], y: +a[1], w: +a[2], h: +a[3] } : { x: +a.x, y: +a.y, w: +a.w, h: +a.h }))
        .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0)
        .map((r) => {
          const x = clamp(r.x, 0, W - 1), y = clamp(r.y, 0, H - 1);
          return { x, y, w: Math.min(r.w, W - x), h: Math.min(r.h, H - y) };
        });
    } catch { return []; }
  }

  function sortedDisplays() {
    return [...displays].sort((a, b) => a.bounds.left - b.bounds.left || a.bounds.top - b.bounds.top);
  }

  function displayFor(index) {
    const id = settings.assignments[index];
    if (id === 'none') return null;
    return displays.find((d) => d.id === id) || sortedDisplays()[index] || null;
  }

  // ---------------------------------------------------------------- main-tab layout
  //
  // CRD puts each display's canvas in its own cell of a CSS grid. To keep only one
  // display in the CRD tab, all cells are stacked in one cell sized to that display:
  // the chosen one visible on top, the others transparent underneath. The hidden
  // canvases keep their real size and position, so input aimed at them still works.

  let layoutStyle = null;
  let layoutActive = false;
  let layoutSig = '';
  let layoutGrid = null;

  function applyMainLayout() {
    const { mode, list } = getUnits();
    const idx = settings.mainDisplay;
    const containers = list.map((u) => u.el.parentElement);
    const grid = containers[0] && containers[0].parentElement;
    const ok = mode === 'multi' && idx >= 0 && idx < list.length && grid
      && containers.every((c) => c && c.parentElement === grid);

    const sig = ok ? JSON.stringify([idx, innerWidth, innerHeight, list[idx].W, list[idx].H, list.map((u) => idOf(u.el))]) : '';
    if (sig === layoutSig) return;
    layoutSig = sig;
    layoutActive = ok;
    if (layoutGrid && layoutGrid !== grid) layoutGrid.style.removeProperty('--cursor-image');
    layoutGrid = ok ? grid : null;
    if (!layoutStyle) {
      layoutStyle = document.createElement('style');
      layoutStyle.id = 'crdmm-layout';
      (document.head || document.documentElement).appendChild(layoutStyle);
    }
    if (!ok) { layoutStyle.textContent = ''; return; }

    containers.forEach((c, i) => { c.dataset.crdmmUnit = String(i); });
    grid.dataset.crdmmGrid = '';
    const m = list[idx];
    const s = Math.min(innerWidth / m.W, innerHeight / m.H);
    const w = (m.W * s).toFixed(2) + 'px', h = (m.H * s).toFixed(2) + 'px';
    layoutStyle.textContent = `
[data-crdmm-grid]{width:${w}!important;height:${h}!important;grid-template-columns:100%!important;grid-template-rows:100%!important}
[data-crdmm-unit]{grid-area:1/1/2/2!important;width:${w}!important;height:${h}!important;position:relative!important;z-index:1!important;opacity:0!important}
[data-crdmm-unit] canvas{width:${w}!important;height:${h}!important}
[data-crdmm-unit="${idx}"]{z-index:2!important;opacity:1!important}`;
    updateCursor();
  }

  // ---------------------------------------------------------------- remote cursor
  //
  // CRD shows the remote cursor as a CSS cursor: a --cursor-image variable holding
  // image-set(url(...) <R>x) <hotX> <hotY>, auto, where R = remote pixels per CSS pixel
  // for CRD's own canvas size. Wherever a display is drawn at another size (the
  // enlarged main-tab display, the popups) R and the hotspot are recomputed, or the
  // cursor comes out too small or too big. Popups don't get CRD's cursor at all, so
  // it's copied there, which also makes link hands, text beams etc. show up.

  let cursorHost = null;
  let cursorObserver = null;

  function findCursorHost() {
    if (cursorHost && cursorHost.isConnected) return cursorHost;
    const u = getUnits().list[0];
    let el = u && u.el;
    while (el && !(el.style && el.style.getPropertyValue('--cursor-image'))) el = el.parentElement;
    cursorHost = el || null;
    if (cursorObserver) cursorObserver.disconnect();
    if (cursorHost) {
      cursorObserver = new MutationObserver(updateCursor);
      cursorObserver.observe(cursorHost, { attributes: true, attributeFilter: ['style'] });
    }
    return cursorHost;
  }

  const CURSOR_RE = /^\s*image-set\(([\s\S]*\))\s+([\d.]+)x\)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*,\s*([\w-]+)\s*$/;

  // pxPerRemote: CSS pixels one remote pixel takes up where the cursor will be shown.
  function scaleCursor(value, pxPerRemote) {
    const m = CURSOR_RE.exec(value);
    if (!m || !(pxPerRemote > 0)) return value || 'auto';
    const res = +m[2], newRes = 1 / pxPerRemote;
    const k = res / newRes; // hotspot is in CSS px of the image at its resolution
    return `image-set(${m[1]} ${newRes}x) ${(+m[3] * k).toFixed(2)} ${(+m[4] * k).toFixed(2)}, ${m[5]}`;
  }

  function updateCursor() {
    const host = findCursorHost();
    if (!host) return;
    const value = host.style.getPropertyValue('--cursor-image');
    const { list } = getUnits();
    if (layoutGrid) {
      const m = list[settings.mainDisplay];
      const w = m && m.el.getBoundingClientRect().width;
      if (w) layoutGrid.style.setProperty('--cursor-image', scaleCursor(value, w / m.W));
    }
    for (const v of viewers.values()) v.setCursor && v.setCursor(value);
  }

  // ---------------------------------------------------------------- input
  //
  // CRD listens for mouse events on the document and for wheel/keyboard events on its
  // desktop container. It finds the remote display from the event target (a canvas
  // with data-stream-id) and the position from that canvas's on-screen rect, and does
  // not check isTrusted. So plain DOM events dispatched on a display's canvas reach
  // the host like real input, also for canvases hidden by the main-tab layout.

  // CRD's first input filter drops everything except clicks and drags while its
  // desktop doesn't have focus, and it loses focus as soon as the user clicks into a
  // viewer. So after each real blur, a focus event is replayed on the display's
  // container (the element CRD listens on) before the next forwarded input.
  let crdNeedsFocus = !document.hasFocus();
  window.addEventListener('blur', () => { crdNeedsFocus = true; });
  window.addEventListener('focus', () => { crdNeedsFocus = false; });
  function wakeCrd(el) {
    if (!crdNeedsFocus || !el.parentElement) return;
    crdNeedsFocus = false;
    el.parentElement.dispatchEvent(new FocusEvent('focus', { composed: true, view: window }));
  }

  const BUTTON_BITS = [1, 4, 2, 8, 16]; // MouseEvent.button -> MouseEvent.buttons bit
  const mods = (e) => ({ ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, altKey: !!e.altKey, metaKey: !!e.metaKey });

  function fireMouse(el, type, p, e, button = 0) {
    wakeCrd(el);
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: p.x, clientY: p.y, screenX: window.screenX + p.x, screenY: window.screenY + p.y,
      button, buttons: e.buttons, ...mods(e),
    }));
  }

  function fireWheel(el, p, e) {
    wakeCrd(el);
    el.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: p.x, clientY: p.y, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
      ...mods(e),
    }));
  }

  // CRD maps keys by KeyboardEvent.code (to USB codes), which survives re-dispatch.
  function fireKey(el, type, k, e) {
    wakeCrd(el);
    el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      key: k.key, code: k.code, location: k.location, repeat: !!k.repeat, ...mods(e),
    }));
  }

  // ---------------------------------------------------------------- drags across displays
  //
  // While a mouse button is held, the OS keeps sending the mouse to the window where
  // the press started. Dragging a remote window from the CRD tab onto a display shown
  // in a popup (or back) would therefore pin the remote cursor to the first display's
  // edge. Instead, the pointer's screen position is located on whichever surface shows
  // a display there, and the event is re-targeted to that display's canvas.

  // Screen position of a window's content area: exact from a real event (screenX -
  // clientX), estimated from the window frame until one arrives.
  const originFrom = (e) => ({ x: e.screenX - e.clientX, y: e.screenY - e.clientY });
  function estimateOrigin(w) {
    const border = (w.outerWidth - w.innerWidth) / 2;
    return { x: w.screenX + border, y: w.screenY + (w.outerHeight - w.innerHeight) - border };
  }
  let mainOrigin = null;
  for (const t of ['mousemove', 'mousedown', 'mouseup']) {
    window.addEventListener(t, (e) => { if (e.isTrusted) mainOrigin = originFrom(e); }, true);
  }

  // Every place a remote display is visible right now, in screen coordinates.
  function surfaces() {
    const { list } = getUnits();
    const out = [];
    const mo = mainOrigin || estimateOrigin(window);
    list.forEach((u, i) => {
      if (layoutActive && i !== settings.mainDisplay) return;
      const r = contentRect(u.el);
      // In single-video mode all units share one element; show each unit's crop.
      const fx = r.width / u.W, fy = r.height / u.H;
      out.push({ index: i, inTab: true,
        left: mo.x + r.left + u.rect.x * fx, top: mo.y + r.top + u.rect.y * fy, width: u.rect.w * fx, height: u.rect.h * fy });
    });
    for (const v of viewers.values()) {
      const u = list[v.index];
      if (v.win.closed || !v.geom || !u) continue;
      const o = v.origin || estimateOrigin(v.win);
      out.push({ index: v.index, inTab: false,
        left: o.x + v.geom.offX, top: o.y + v.geom.offY, width: u.rect.w * v.geom.s, height: u.rect.h * v.geom.s });
    }
    return out;
  }

  // Screen point -> { el, p } to dispatch on in the CRD tab, or null if no display is there.
  function locateOnScreen(sx, sy) {
    for (const s of surfaces()) {
      if (sx < s.left || sy < s.top || sx >= s.left + s.width || sy >= s.top + s.height) continue;
      const u = getUnits().list[s.index];
      const rx = u.rect.x + ((sx - s.left) / s.width) * u.rect.w;
      const ry = u.rect.y + ((sy - s.top) / s.height) * u.rect.h;
      const cr = contentRect(u.el);
      return { el: u.el, index: s.index, inTab: s.inTab, p: { x: cr.left + (rx / u.W) * cr.width, y: cr.top + (ry / u.H) * cr.height } };
    }
    return null;
  }

  // A real drag in the CRD tab that has left the tab's display for a popup's display.
  function redirectTabDrag(e) {
    if (!e.isTrusted || !viewers.size) return;
    if (e.type === 'mousemove' && !e.buttons) return;
    const t = locateOnScreen(e.screenX, e.screenY);
    if (!t || t.inTab) return; // still over the CRD tab: CRD handles it
    e.stopImmediatePropagation();
    e.preventDefault();
    fireMouse(t.el, e.type, t.p, e, e.button);
  }
  window.addEventListener('mousemove', redirectTabDrag, true);
  window.addEventListener('mouseup', redirectTabDrag, true);

  // ---------------------------------------------------------------- viewer windows

  const VIEWER_HTML = (n) => `<!doctype html><html><head><meta charset="utf-8">
<title>CRD · Màn hình ${n}</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;user-select:none}
#stage{position:fixed;inset:0;touch-action:none}
#clip{position:absolute;overflow:hidden;background:#000}
#v{position:absolute;object-fit:fill;pointer-events:none}
#msg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);max-width:70%;color:#ddd;
  font:14px/1.5 system-ui,sans-serif;text-align:center;padding:16px 20px;background:rgba(255,255,255,.08);
  border-radius:8px;display:none}
#tag{position:fixed;top:12px;left:12px;color:#fff;font:600 13px system-ui,sans-serif;
  background:rgba(26,115,232,.92);padding:6px 10px;border-radius:6px;transition:opacity .6s;pointer-events:none}
</style></head><body>
<div id="stage"><div id="clip"><video id="v" autoplay muted playsinline disablepictureinpicture></video></div></div>
<div id="msg"></div><div id="tag">Màn hình từ xa ${n}</div>
</body></html>`;

  function createViewer(index, win) {
    const doc = win.document;
    doc.open(); doc.write(VIEWER_HTML(index + 1)); doc.close();
    const $ = (id) => doc.getElementById(id);
    const v = $('v'), clip = $('clip'), stage = $('stage'), msg = $('msg');
    const viewer = { index, win, geom: null, sig: '', pressed: new Map(), buttons: 0, lastPoint: null };
    setTimeout(() => { $('tag').style.opacity = '0'; }, 2500);

    const showMsg = (t) => { msg.textContent = t; msg.style.display = 'block'; clip.style.display = 'none'; viewer.sig = ''; };
    const hideMsg = () => { msg.style.display = 'none'; clip.style.display = ''; };

    viewer.update = () => {
      const { list } = getUnits();
      const u = list[index];
      if (!u) {
        viewer.geom = null;
        showMsg(list.length
          ? `CRD hiện chỉ có ${list.length} màn hình. Đóng cửa sổ này hoặc đổi bố cục trong bảng điều khiển.`
          : 'Đang chờ hình từ Chrome Remote Desktop…');
        return;
      }
      if (!u.stream) { viewer.geom = null; showMsg('Không lấy được luồng video từ trang CRD.'); return; }
      if (v.srcObject !== u.stream) { v.srcObject = u.stream; v.play().catch(() => {}); }
      hideMsg();

      const { rect, W, H } = u;
      const vw = win.innerWidth, vh = win.innerHeight;
      const sig = [vw, vh, W, H, rect.x, rect.y, rect.w, rect.h].join(',');
      if (sig === viewer.sig) return;
      viewer.sig = sig;
      const s = Math.min(vw / rect.w, vh / rect.h);
      const offX = (vw - rect.w * s) / 2, offY = (vh - rect.h * s) / 2;
      Object.assign(clip.style, { left: offX + 'px', top: offY + 'px', width: rect.w * s + 'px', height: rect.h * s + 'px' });
      Object.assign(v.style, { left: -rect.x * s + 'px', top: -rect.y * s + 'px', width: W * s + 'px', height: H * s + 'px' });
      viewer.geom = { s, offX, offY };
      updateCursor();
    };
    viewer.setCursor = (value) => {
      if (viewer.geom) stage.style.cursor = scaleCursor(value, viewer.geom.s);
    };

    // Viewer coordinates -> CSS pixels in the CRD tab, on the element showing this display.
    const toMain = (cx, cy) => {
      const g = viewer.geom, u = getUnits().list[index];
      if (!g || !u) return null;
      const { rect, W, H } = u;
      const sx = clamp(rect.x + (cx - g.offX) / g.s, rect.x, rect.x + rect.w - 0.01);
      const sy = clamp(rect.y + (cy - g.offY) / g.s, rect.y, rect.y + rect.h - 0.01);
      const cr = contentRect(u.el);
      return { x: cr.left + (sx / W) * cr.width, y: cr.top + (sy / H) * cr.height };
    };

    const target = () => { const u = getUnits().list[index]; return u ? u.el : null; };

    // Keys like Win, Alt+Tab, Alt+F4 or Ctrl+W normally go to Windows or Chrome before
    // the page sees them. The Keyboard Lock API captures them, but only while the page
    // itself is fullscreen (requestFullscreen, not F11), which needs a click or key press.
    const lockKeys = () => {
      if (!settings.keyboardLock || doc.fullscreenElement) return;
      const kb = win.navigator.keyboard;
      doc.documentElement.requestFullscreen({ navigationUI: 'hide' })
        .then(() => (kb && kb.lock ? kb.lock() : null))
        .catch(() => {});
    };

    const onPointer = (e) => {
      if (e.isTrusted) viewer.origin = originFrom(e);
      let p = toMain(e.clientX, e.clientY), el = target();
      if (!p || !el) return;
      e.preventDefault();
      // Dragging out of this popup (it keeps the pointer captured): follow the pointer
      // onto the display under it, if any.
      const g = viewer.geom, u = getUnits().list[index];
      const outside = e.clientX < g.offX || e.clientY < g.offY
        || e.clientX >= g.offX + u.rect.w * g.s || e.clientY >= g.offY + u.rect.h * g.s;
      if (outside && (e.buttons || e.type === 'pointerup')) {
        const t = locateOnScreen(e.screenX, e.screenY);
        if (t && t.index !== index) { el = t.el; p = t.p; }
      }
      viewer.lastPoint = p;
      viewer.lastEl = el;
      if (e.type === 'pointerdown') {
        lockKeys();
        try { stage.setPointerCapture(e.pointerId); } catch {}
        win.focus();
        fireMouse(el, 'mousedown', p, e, e.button);
      } else if (e.type === 'pointerup') {
        fireMouse(el, 'mouseup', p, e, e.button);
      } else if (e.button >= 0) {
        // A second button pressed/released while another is held arrives as pointermove.
        fireMouse(el, e.buttons & (BUTTON_BITS[e.button] || 0) ? 'mousedown' : 'mouseup', p, e, e.button);
      } else {
        fireMouse(el, 'mousemove', p, e);
      }
      viewer.buttons = e.buttons;
    };
    stage.addEventListener('pointerdown', onPointer);
    stage.addEventListener('pointermove', onPointer);
    stage.addEventListener('pointerup', onPointer);
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => {
      const p = toMain(e.clientX, e.clientY), el = target();
      if (!p || !el) return;
      e.preventDefault();
      fireWheel(el, p, e);
    }, { passive: false });

    win.addEventListener('keydown', (e) => {
      if (e.key === 'F11') return; // leave fullscreen toggle to the browser
      e.preventDefault();
      if (e.key !== 'Escape') lockKeys();
      const el = target();
      if (!el) return;
      const k = { key: e.key, code: e.code, location: e.location, repeat: e.repeat };
      viewer.pressed.set(e.code, k);
      fireKey(el, 'keydown', k, e);
    }, true);
    win.addEventListener('keyup', (e) => {
      if (e.key === 'F11') return;
      e.preventDefault();
      const el = target();
      if (!el) return;
      viewer.pressed.delete(e.code);
      fireKey(el, 'keyup', { key: e.key, code: e.code, location: e.location }, e);
    }, true);
    // Losing focus mid-press would leave keys or buttons stuck on the remote machine.
    win.addEventListener('blur', () => {
      const el = target();
      if (el) {
        for (const k of viewer.pressed.values()) fireKey(el, 'keyup', k, {});
        if (viewer.buttons && viewer.lastPoint) {
          BUTTON_BITS.forEach((bit, button) => {
            if (viewer.buttons & bit) fireMouse(viewer.lastEl || el, 'mouseup', viewer.lastPoint, { buttons: 0 }, button);
          });
        }
      }
      viewer.pressed.clear();
      viewer.buttons = 0;
    });
    win.addEventListener('resize', () => { viewer.sig = ''; viewer.update(); });
    win.addEventListener('pagehide', () => { viewers.delete(index); afterViewersChanged(); });

    viewer.update();
    return viewer;
  }

  function afterViewersChanged() {
    renderPanel(true);
  }

  async function openViewer(index) {
    const existing = viewers.get(index);
    if (existing && !existing.win.closed) { existing.win.focus(); return true; }
    if (!getUnits().list.length) { toast('Chưa thấy hình. Hãy kết nối tới máy từ xa trước.'); return false; }

    const disp = displayFor(index);
    if (disp) await send({ type: 'expectViewer', bounds: disp.bounds, fullscreen: settings.fullscreen });
    const b = disp ? disp.bounds
      : { left: window.screenX + 40 * (index + 1), top: window.screenY + 40 * (index + 1), width: 1280, height: 720 };
    const win = window.open('', 'crdmm_viewer_' + index,
      `popup=yes,left=${b.left},top=${b.top},width=${b.width},height=${b.height}`);
    if (!win) {
      if (disp) send({ type: 'cancelExpect' });
      toast('Chrome đã chặn cửa sổ bật lên. Bấm biểu tượng chặn popup trên thanh địa chỉ → "Luôn cho phép".');
      return false;
    }
    viewers.set(index, createViewer(index, win));
    renderPanel(true);
    return true;
  }

  function closeViewer(index) {
    const v = viewers.get(index);
    viewers.delete(index);
    if (v && !v.win.closed) v.win.close();
    afterViewersChanged();
  }

  async function openAll() {
    const n = getUnits().list.length;
    if (!n) { toast('Chưa thấy hình. Hãy kết nối tới máy từ xa trước.'); return; }
    for (let i = 0; i < n; i++) {
      if (layoutActive && i === settings.mainDisplay) continue; // already shown in this tab
      if (!(await openViewer(i))) break;
    }
  }

  function closeAll() { for (const i of [...viewers.keys()]) closeViewer(i); }

  window.addEventListener('pagehide', closeAll);

  // ---------------------------------------------------------------- control panel

  const PANEL_CSS = `
:host{all:initial}
.panel{--bg:#fff;--fg:#202124;--muted:#5f6368;--line:#dadce0;--acc:#1a73e8;--acc-fg:#fff;--field:#f8f9fa;
  width:320px;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,"Segoe UI",sans-serif;
  border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);overflow:hidden}
@media (prefers-color-scheme:dark){.panel{--bg:#202124;--fg:#e8eaed;--muted:#9aa0a6;--line:#3c4043;--acc:#8ab4f8;--acc-fg:#202124;--field:#292a2d}}
header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:default}
.collapsed header{border-bottom:0}
.dot{width:8px;height:8px;border-radius:50%;background:#9aa0a6}.dot.on{background:#34a853}
b{font-weight:600}.sp{flex:1}
button{font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--acc)}
button.primary{background:var(--acc);color:var(--acc-fg);border-color:var(--acc)}
button.icon{padding:0;width:24px;height:24px;line-height:22px;text-align:center}
.body{padding:10px 12px;display:grid;grid-template-columns:minmax(0,1fr);gap:9px;max-height:70vh;overflow:auto}
.collapsed .body{display:none}
[hidden]{display:none!important}
.status{color:var(--muted)}
.status.warn{color:#e37400}
.row{display:flex;align-items:center;gap:8px;justify-content:space-between}
select,input,textarea{font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:6px;padding:4px 6px}
select{max-width:180px}
input[type=number]{width:60px}
textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:12px;resize:vertical}
.hint{color:var(--muted);font-size:12px}
.mon{border:1px solid var(--line);border-radius:8px;padding:8px;display:grid;gap:6px}
.mon .top{display:flex;justify-content:space-between;align-items:center}
.mon .dim{color:var(--muted);font-size:12px}
.mon select{max-width:none;flex:1;min-width:0;width:0}
.mon button{flex:none}
.check{display:flex;gap:6px;align-items:center}
.actions{display:flex;gap:8px}.actions button{flex:1}
.toast{background:#fce8e6;color:#a50e0e;border-radius:6px;padding:6px 8px;font-size:12px}
@media (prefers-color-scheme:dark){.toast{background:#5c2b29;color:#f6aea9}}
`;

  function buildPanel() {
    panelHost = document.createElement('div');
    panelHost.style.cssText = 'position:fixed;inset:auto 16px 16px auto;margin:0;padding:0;border:0;'
      + 'background:transparent;overflow:visible;z-index:2147483647;display:none';
    // A popover lives in the top layer, so the panel stays visible when CRD goes fullscreen.
    if (typeof panelHost.showPopover === 'function') panelHost.popover = 'manual';
    const root = panelHost.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PANEL_CSS}</style>
<div class="panel">
  <header><span class="dot"></span><b>CRD Multi-Monitor</b><span class="sp"></span>
    <button class="icon" id="collapse" title="Thu gọn / mở rộng">–</button>
    <button class="icon" id="hide" title="Ẩn (Alt+Shift+M)">×</button></header>
  <div class="body">
    <div class="status" id="status"></div>
    <label class="row" id="mainRow">Tab này hiển thị
      <select id="main"></select></label>
    <div id="toast" class="toast" hidden></div>
    <div id="layoutBox">
      <label class="row">Bố cục
        <select id="layout">
          <option value="auto">Tự động (theo tỉ lệ)</option>
          <option value="columns">Chia theo cột</option>
          <option value="rows">Chia theo hàng</option>
          <option value="custom">Tùy chỉnh (JSON)</option>
        </select></label>
      <label class="row" id="countRow">Số màn hình từ xa <input id="count" type="number" min="1" max="8"></label>
      <div id="customRow">
        <textarea id="custom" rows="3" placeholder="[[0,0,1920,1080],[1920,0,2560,1440]]"></textarea>
        <div class="hint">Mỗi phần tử là [x, y, rộng, cao] theo pixel của video nguồn.</div>
      </div>
    </div>
    <div id="list"></div>
    <label class="check"><input type="checkbox" id="fs"> Tự bật toàn màn hình khi mở</label>
    <label class="check"><input type="checkbox" id="kl"> Gửi cả phím hệ thống (Win, Alt+Tab, Alt+F4, Ctrl+W…)</label>
    <div class="hint" id="klHint">Bấm chuột hoặc gõ phím vào cửa sổ để bật. Cửa sổ sẽ vào toàn màn hình; giữ Esc để thoát.</div>
    <div class="actions"><button id="openAll" class="primary">Mở tất cả</button><button id="closeAll">Đóng tất cả</button></div>
    <div class="hint">Để "Mở tất cả" mở được nhiều cửa sổ cùng lúc, hãy cho phép cửa sổ bật lên (popup) cho trang này.</div>
  </div>
</div>`;
    const $ = (id) => root.getElementById(id);
    ui = {
      root, panel: root.querySelector('.panel'), dot: root.querySelector('.dot'),
      status: $('status'), toast: $('toast'), layoutBox: $('layoutBox'), layout: $('layout'),
      count: $('count'), countRow: $('countRow'), custom: $('custom'), customRow: $('customRow'),
      list: $('list'), fs: $('fs'), kl: $('kl'), klHint: $('klHint'), main: $('main'), mainRow: $('mainRow'), sig: '', mainSig: '',
    };
    $('collapse').onclick = () => { settings.collapsed = !settings.collapsed; save(); applyVisibility(); };
    $('hide').onclick = () => { panelHidden = true; applyVisibility(); };
    $('openAll').onclick = openAll;
    $('closeAll').onclick = closeAll;
    ui.layout.onchange = () => { settings.layout = ui.layout.value; save(); refreshAll(); };
    ui.count.onchange = () => { settings.count = clamp(parseInt(ui.count.value, 10) || 1, 1, 8); save(); refreshAll(); };
    ui.custom.oninput = () => { settings.custom = ui.custom.value; save(); refreshAll(); };
    ui.fs.onchange = () => { settings.fullscreen = ui.fs.checked; save(); };
    ui.main.onchange = () => { settings.mainDisplay = +ui.main.value; save(); refreshAll(); };
    ui.kl.onchange = () => { settings.keyboardLock = ui.kl.checked; ui.klHint.hidden = !ui.kl.checked; save(); };
    ui.list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-i]');
      if (!btn) return;
      const i = +btn.dataset.i;
      viewers.has(i) ? closeViewer(i) : openViewer(i);
    });
    ui.list.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-i]');
      if (!sel) return;
      settings.assignments = { ...settings.assignments, [sel.dataset.i]: sel.value };
      save();
    });
    // Keep keystrokes and clicks in the panel away from the remote session.
    for (const t of ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown', 'wheel']) {
      ui.panel.addEventListener(t, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(panelHost);
    syncFields();
  }

  function syncFields() {
    if (!ui) return;
    ui.layout.value = settings.layout;
    ui.count.value = settings.count;
    ui.custom.value = settings.custom;
    ui.fs.checked = settings.fullscreen;
    ui.kl.checked = settings.keyboardLock;
    ui.klHint.hidden = !settings.keyboardLock;
  }

  // Shown on session pages right away (so its status line explains what's missing),
  // elsewhere only once a remote picture appears.
  let seenSource = /\/session/.test(location.pathname);
  const isVisible = () => !!panelHost && !panelHidden && seenSource;
  function applyVisibility() {
    if (!panelHost) return;
    const show = isVisible();
    panelHost.style.display = show ? 'block' : 'none';
    if (panelHost.popover) {
      try {
        if (panelHost.matches(':popover-open')) panelHost.hidePopover();
        if (show) panelHost.showPopover();
      } catch {}
    }
    ui.panel.classList.toggle('collapsed', settings.collapsed);
  }
  // Re-raise the panel above a newly fullscreened element.
  document.addEventListener('fullscreenchange', applyVisibility);

  let toastTimer = 0;
  function toast(text) {
    if (!ui) return;
    seenSource = true; panelHidden = false; applyVisibility();
    ui.toast.textContent = text; ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 8000);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function renderPanel(force = false) {
    if (!ui) return;
    const { mode, list, W, H } = getUnits();
    if (list.length && !seenSource) { seenSource = true; applyVisibility(); }

    ui.dot.classList.toggle('on', list.length > 0);
    ui.layoutBox.hidden = mode !== 'single';
    ui.mainRow.hidden = mode !== 'multi';
    const mainSig = list.length + ':' + settings.mainDisplay;
    if (mode === 'multi' && mainSig !== ui.mainSig && ui.root.activeElement !== ui.main) {
      ui.mainSig = mainSig;
      ui.main.innerHTML = '<option value="-1">Tất cả màn hình (như CRD gốc)</option>'
        + list.map((_, i) => `<option value="${i}">Chỉ màn hình từ xa ${i + 1}</option>`).join('');
      ui.main.value = String(settings.mainDisplay < list.length ? settings.mainDisplay : -1);
    }
    ui.countRow.hidden = !(settings.layout === 'columns' || settings.layout === 'rows');
    ui.customRow.hidden = settings.layout !== 'custom';

    if (!mode) {
      ui.status.className = 'status warn';
      ui.status.textContent = 'Chưa thấy hình. Hãy kết nối tới máy từ xa.';
    } else if (mode === 'multi') {
      ui.status.className = 'status';
      ui.status.textContent = `CRD đang hiển thị ${list.length} màn hình từ xa.`;
    } else if (list.length === 1 && settings.layout === 'auto') {
      ui.status.className = 'status warn';
      ui.status.textContent = `Chỉ thấy 1 màn hình (${W}×${H}). Trong bảng bên của CRD, mục Displays, chọn "Show all displays".`;
    } else {
      ui.status.className = 'status';
      ui.status.textContent = `Một khung hình ${W}×${H}, chia thành ${list.length} màn hình.`;
    }

    const sig = JSON.stringify([list.map((u) => [u.W, u.H, u.rect]), displays.map((d) => d.id), [...viewers.keys()], settings.assignments, layoutActive && settings.mainDisplay]);
    if (!force && sig === ui.sig) return;
    if (ui.root.activeElement && ui.root.activeElement.tagName === 'SELECT') return; // don't yank an open dropdown
    ui.sig = sig;

    const sorted = sortedDisplays();
    ui.list.innerHTML = list.map((u, i) => {
      const cur = displayFor(i);
      const opts = [`<option value="none"${settings.assignments[i] === 'none' ? ' selected' : ''}>Không đặt vị trí</option>`]
        .concat(sorted.map((d, k) => {
          const label = `${k + 1}. ${d.name || 'Display'} ${d.bounds.width}×${d.bounds.height}${d.isPrimary ? ' (chính)' : ''}`;
          return `<option value="${esc(d.id)}"${cur && cur.id === d.id ? ' selected' : ''}>${esc(label)}</option>`;
        })).join('');
      const open = viewers.has(i);
      const inTab = layoutActive && i === settings.mainDisplay;
      const dim = (inTab ? 'ở tab này · ' : '')
        + (mode === 'multi' ? `${u.W}×${u.H}` : `${u.rect.w}×${u.rect.h} @ ${u.rect.x},${u.rect.y}`);
      return `<div class="mon"><div class="top"><b>Màn hình từ xa ${i + 1}</b><span class="dim">${dim}</span></div>
        <div class="row"><select data-i="${i}" title="Hiển thị trên màn hình nào của máy này">${opts}</select>
        <button data-i="${i}"${open ? '' : ' class="primary"'}>${open ? 'Đóng' : 'Mở'}</button></div></div>`;
    }).join('');
  }

  function refreshAll() {
    unitCache.t = 0;
    layoutSig = 'stale';
    applyMainLayout();
    for (const v of viewers.values()) { v.sig = ''; v.update(); }
    renderPanel(true);
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'togglePanel') return;
    if (isVisible()) {
      panelHidden = true;
    } else {
      seenSource = true;
      panelHidden = false;
      settings.collapsed = false;
      save();
    }
    applyVisibility(); renderPanel(true);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    settings = { ...DEFAULTS, ...changes[KEY].newValue };
    syncFields(); applyVisibility(); refreshAll();
  });

  async function loadDisplays() {
    const list = await send({ type: 'getDisplays' });
    if (Array.isArray(list)) displays = list;
  }

  async function init() {
    try {
      const stored = await chrome.storage.local.get(KEY);
      settings = { ...DEFAULTS, ...(stored[KEY] || {}) };
    } catch {}
    await loadDisplays();
    buildPanel();
    applyVisibility();
    applyMainLayout();
    renderPanel(true);
    window.addEventListener('resize', applyMainLayout);
    console.info('[CRD-MM] v1.1 sẵn sàng · màn hình cục bộ:', displays.length);

    let tick = 0;
    setInterval(() => {
      tick++;
      for (const [i, v] of viewers) {
        if (v.win.closed) { viewers.delete(i); afterViewersChanged(); continue; }
        v.update();
      }
      applyMainLayout();
      if (tick % 2 === 0) renderPanel();
      if (tick % 10 === 0) loadDisplays();
    }, 500);
  }

  init();
})();
