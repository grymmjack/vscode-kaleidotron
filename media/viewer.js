// @ts-check
// The Kaleidotron text-mode viewer webview: loads the wasm decoder, blits the
// decoded RGBA to a canvas, and handles zoom / pan / center / ruler / toolbar.
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {WebAssembly.Instance | null} */ let wasm = null;
  /** @type {Uint8Array | null} */ let fileBytes = null;
  let extCode = 0;
  let font9 = true;
  let zoom = 1; // logical scale (CSS px per source px); snapped in applyZoom
  let natW = 0;
  let natH = 0;
  let format = "";
  let colors = 0;
  let center = false;
  let ruler = false;
  let fit = false; // sticky "fit width on open" mode (remembered)
  let bgColor = ""; // custom background; empty = fall back to CSS (black/editor)
  let sauce = null; // parsed SAUCE record (font / credits / iCE), or null
  let isImage = false; // raster image (PNG/JPG/…) decoded natively, not via wasm
  let isSvg = false; // SVG rendered natively by the browser
  let mime = "";

  // Offscreen native-resolution canvas; the visible canvas is scaled from it to
  // an integer number of DEVICE pixels per source pixel (always-crisp nearest).
  const src = document.createElement("canvas");
  const srcCtx = /** @type {CanvasRenderingContext2D} */ (src.getContext("2d"));

  const el = (id) => /** @type {any} */ (document.getElementById(id));
  const canvas = /** @type {HTMLCanvasElement} */ (el("art"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const stage = el("stage");
  const content = el("content");
  const zoomInput = /** @type {HTMLInputElement} */ (el("zoom"));
  const statusEl = el("status");
  const font9box = /** @type {HTMLInputElement} */ (el("font9"));
  const centerBox = /** @type {HTMLInputElement} */ (el("center"));
  const rulerBox = /** @type {HTMLInputElement} */ (el("ruler"));
  const fitBox = /** @type {HTMLInputElement} */ (el("fit"));
  const bgBox = /** @type {HTMLInputElement} */ (el("bg"));
  const presets = el("presets");
  const rulerTop = /** @type {HTMLCanvasElement} */ (el("rulerTop"));
  const rulerLeft = /** @type {HTMLCanvasElement} */ (el("rulerLeft"));

  const RT = 18; // top-ruler thickness (px)
  const RL = 36; // left-ruler thickness (px)

  async function loadWasm() {
    if (wasm) return;
    const resp = await fetch(window.__WASM_URI__);
    const buf = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buf, {});
    wasm = instance;
  }
  function mem() {
    return new Uint8Array(
      /** @type {WebAssembly.Memory} */ (wasm.exports.memory).buffer
    );
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decodeAndRender() {
    if (!wasm || !fileBytes) return;
    const ex = wasm.exports;
    const ptr = /** @type {Function} */ (ex.input_ptr)(fileBytes.length);
    mem().set(fileBytes, ptr);
    const ok = /** @type {Function} */ (ex.decode_input)(extCode, font9 ? 1 : 0);
    if (!ok) {
      statusEl.textContent = "Could not decode this file.";
      return;
    }
    const w = ex.out_w();
    const h = ex.out_h();
    const len = ex.out_len();
    const optr = ex.out_ptr();
    const bytes = new Uint8ClampedArray(mem().subarray(optr, optr + len));
    natW = w;
    natH = h;
    src.width = w;
    src.height = h;
    srcCtx.putImageData(new ImageData(bytes, w, h), 0, 0);
    colors = countColors(bytes);
    applyZoom();
  }

  /** Count distinct opaque RGB values (for the status readout). */
  function countColors(bytes) {
    const seen = new Set();
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i + 3] === 0) continue;
      seen.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
      if (seen.size > 4096) return seen.size; // plenty; stop counting huge images
    }
    return seen.size;
  }

  /** Scale the native image onto the visible canvas at an INTEGER number of
   *  device pixels per source pixel — the only way nearest-neighbour stays crisp
   *  once the display's devicePixelRatio (resolution + VS Code UI zoom) is
   *  fractional. The user's logical zoom is snapped to the nearest such value. */
  function applyZoom() {
    if (!natW || !natH) return;
    const dpr = window.devicePixelRatio || 1;
    let devScale = zoom * dpr; // desired device px per source px
    const crisp = devScale >= 1;
    if (crisp) devScale = Math.round(devScale); // snap → integer → crisp
    zoom = devScale / dpr; // reflect the snap back into the logical zoom
    const devW = Math.max(1, Math.round(natW * devScale));
    const devH = Math.max(1, Math.round(natH * devScale));
    canvas.width = devW;
    canvas.height = devH;
    canvas.style.width = devW / dpr + "px";
    canvas.style.height = devH / dpr + "px";
    ctx.imageSmoothingEnabled = !crisp; // smooth only on heavy downscale
    ctx.clearRect(0, 0, devW, devH);
    ctx.drawImage(src, 0, 0, natW, natH, 0, 0, devW, devH);
    if (document.activeElement !== zoomInput)
      zoomInput.value = `${Math.round(zoom * 100)}%`;
    updateStatus();
    layoutRulers();
    persist();
  }

  /** Character-cell dimensions for the current format/font (for the ruler +
   *  the cols×rows readout). ANSI/scene = 8 or 9 (9px cell) × 16; PETSCII = 8×8. */
  // Graphics (raster images, SVG, RIPscript, and the wasm raster formats
  // PCX/PSD/XCF/…) → ruler/status in PIXELS, no character-cell or font concept.
  function isGraphics() {
    // RIP (9) + raster (10–19) are pixel graphics; petmate (20) is a C64 cell grid.
    return isImage || isSvg || (extCode >= 9 && extCode <= 19);
  }

  /** Render an SVG natively (browser vector rasteriser) into the source canvas. */
  async function decodeSvg() {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([fileBytes], { type: "image/svg+xml" }));
      const img = new Image();
      img.onload = () => {
        const iw = img.naturalWidth || 512;
        const ih = img.naturalHeight || 512;
        natW = iw;
        natH = ih;
        src.width = iw;
        src.height = ih;
        srcCtx.clearRect(0, 0, iw, ih);
        srcCtx.drawImage(img, 0, 0, iw, ih);
        URL.revokeObjectURL(url);
        try {
          colors = countColors(srcCtx.getImageData(0, 0, iw, ih).data);
        } catch {
          colors = 0;
        }
        applyZoom();
        resolve();
      };
      img.onerror = () => {
        statusEl.textContent = "Could not render this SVG.";
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });
  }
  function cellSize() {
    if (isGraphics()) return { w: 1, h: 1 }; // ruler counts pixels
    if (extCode === 7 || extCode === 8 || extCode === 20) return { w: 8, h: 8 }; // PETSCII / petmate (C64)
    return { w: font9 ? 9 : 8, h: 16 };
  }

  /** Decode a raster image natively (browser codec) into the source canvas. */
  async function decodeImage() {
    try {
      const blob = new Blob([fileBytes], { type: mime || undefined });
      const bmp = await createImageBitmap(blob);
      natW = bmp.width;
      natH = bmp.height;
      src.width = natW;
      src.height = natH;
      srcCtx.clearRect(0, 0, natW, natH);
      srcCtx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      colors = countColors(srcCtx.getImageData(0, 0, natW, natH).data);
      applyZoom();
    } catch (e) {
      statusEl.textContent = "Could not decode this image.";
    }
  }

  /** Parse a SAUCE record (last 128 bytes) for font name, credits and flags. */
  function parseSauce(bytes) {
    if (!bytes || bytes.length < 128) return null;
    const o = bytes.length - 128;
    if (String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3], bytes[o + 4]) !== "SAUCE")
      return null;
    const str = (start, len) => {
      let s = "";
      for (let i = 0; i < len; i++) {
        const c = bytes[o + start + i];
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.replace(/\s+$/, "");
    };
    return {
      title: str(7, 35),
      author: str(42, 20),
      group: str(62, 20),
      font: str(106, 22),
      ice: (bytes[o + 105] & 0x01) !== 0, // TFlags bit0 = non-blink / iCE colours
    };
  }

  function defaultFont() {
    return extCode === 7 || extCode === 8 || extCode === 20 ? "C64" : "IBM VGA";
  }

  function updateStatus() {
    if (!natW) return;
    const clr = `${colors}${colors > 4096 ? "+" : ""} colors`;
    if (isGraphics()) {
      statusEl.textContent = `${format}  ·  ${clr}  ·  ${natW}×${natH}px  ·  ${Math.round(zoom * 100)}%`;
      statusEl.title = statusEl.textContent;
      return;
    }
    const c = cellSize();
    const cols = Math.round(natW / c.w);
    const rows = Math.round(natH / c.h);
    const fontName = (sauce && sauce.font) || defaultFont();
    let s =
      `${format}  ·  ${fontName} ${c.w}×${c.h}  ·  ${cols}×${rows} cells  ·  ` +
      `${clr}  ·  ` +
      `${natW}×${natH}px  ·  ${Math.round(zoom * 100)}%`;
    if (sauce && (sauce.title || sauce.author || sauce.group)) {
      const cred = [
        sauce.title && `“${sauce.title}”`,
        sauce.author && `by ${sauce.author}`,
        sauce.group && `· ${sauce.group}`,
      ].filter(Boolean).join(" ");
      s += `   ✎ ${cred}`;
    }
    if (sauce && sauce.ice) s += "  ·  iCE";
    statusEl.textContent = s;
    statusEl.title = s;
  }

  function applyBg() {
    // Empty → clear inline style so CSS (black, or editor via data-bg) applies.
    stage.style.background = bgColor || "";
  }

  function setZoom(z) {
    zoom = Math.min(64, Math.max(0.05, z));
    applyZoom();
  }
  /** A manual zoom cancels the sticky Fit mode. */
  function clearFit() {
    if (fit) {
      fit = false;
      fitBox.checked = false;
    }
  }
  // Step to the next/previous INTEGER device scale (always crisp).
  function stepZoom(dir) {
    clearFit();
    const dpr = window.devicePixelRatio || 1;
    let k = Math.round(zoom * dpr);
    k = Math.max(1, k + (dir > 0 ? 1 : -1));
    setZoom(k / dpr);
  }
  function commitZoomInput() {
    clearFit();
    const v = parseFloat(zoomInput.value.replace(/[^\d.]/g, ""));
    if (!isNaN(v) && v > 0) setZoom(v / 100);
    else applyZoom();
  }
  // Fit the WHOLE image in the viewport — bounded by the limiting dimension, so
  // a tall narrow (e.g. 30×60) ANSI fits by height instead of overflowing. Uses
  // the largest crisp (integer device-scale) zoom that still fits.
  function fitWidth() {
    if (!natW || !natH) return;
    const dpr = window.devicePixelRatio || 1;
    const availW = stage.clientWidth - (ruler ? RL : 0) - 6;
    const availH = stage.clientHeight - (ruler ? RT : 0) - 6;
    const target = Math.min(availW / natW, availH / natH);
    const devScale = target * dpr;
    if (devScale >= 1) setZoom(Math.max(1, Math.floor(devScale)) / dpr); // crisp
    else setZoom(target); // heavy downscale (fits, smoothed)
  }
  /** Build the quick-zoom preset buttons for THIS display: integer device
   *  scales (always crisp), each labelled with the logical % it produces. */
  function buildPresets() {
    const dpr = window.devicePixelRatio || 1;
    presets.textContent = "";
    for (let k = 1; k <= 4; k++) {
      const pct = Math.round((k / dpr) * 100);
      const b = document.createElement("button");
      b.className = "zp";
      b.textContent = `${pct}%`;
      b.title = `${k}× device pixels (crisp)`;
      b.onclick = () => {
        clearFit();
        setZoom(k / dpr);
      };
      presets.appendChild(b);
    }
  }

  // ---- rulers ----
  function layoutRulers() {
    if (!ruler) {
      rulerTop.style.display = "none";
      rulerLeft.style.display = "none";
      content.style.padding = "0";
      return;
    }
    rulerTop.style.display = "block";
    rulerLeft.style.display = "block";
    content.style.paddingTop = RT + "px";
    content.style.paddingLeft = RL + "px";
    drawRulers();
  }
  function drawRulers() {
    if (!ruler || !natW) return;
    const dpr = window.devicePixelRatio || 1;
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    // Pin the ruler canvases to the visible viewport as content scrolls.
    rulerTop.style.transform = `translate(${stage.scrollLeft}px, ${stage.scrollTop}px)`;
    rulerLeft.style.transform = `translate(${stage.scrollLeft}px, ${stage.scrollTop}px)`;
    sizeRuler(rulerTop, vw, RT, dpr);
    sizeRuler(rulerLeft, RL, vh, dpr);
    const bg = cssVar("--vscode-editorWidget-background", "#252526");
    const fg = cssVar("--vscode-descriptionForeground", "#999");
    const cell = cellSize();

    // Base ticks on the canvas's ACTUAL on-screen position (relative to the
    // stage viewport) so they track the art through center / scroll / padding.
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const originX = cr.left - sr.left; // art top-left in viewport coords
    const originY = cr.top - sr.top;
    const sx = cr.width / natW; // displayed CSS px per source px (x)
    const sy = cr.height / natH;

    const nice = [1, 2, 4, 5, 8, 10, 16, 20, 25, 40, 50, 80, 100, 200];
    const pickStride = (cellPx, scl) => {
      for (const n of nice) if (n * cellPx * scl >= 40) return n;
      return nice[nice.length - 1];
    };
    const colStride = pickStride(cell.w, sx);
    const rowStride = pickStride(cell.h, sy);
    const tickCols = cell.w * sx >= 4;
    const tickRows = cell.h * sy >= 4;
    const cols = Math.round(natW / cell.w);
    const rows = Math.round(natH / cell.h);

    // top ruler (horizontal)
    const tctx = /** @type {CanvasRenderingContext2D} */ (rulerTop.getContext("2d"));
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, vw, RT);
    tctx.fillStyle = bg; tctx.fillRect(0, 0, vw, RT);
    tctx.font = "9px var(--vscode-font-family, monospace)";
    tctx.textBaseline = "top";
    for (let c = 0; c <= cols; c++) {
      const x = originX + c * cell.w * sx;
      if (x < RL - 1 || x > vw) continue;
      const major = c % colStride === 0;
      if (!major && !tickCols) continue;
      tctx.fillStyle = fg;
      tctx.fillRect(x, RT - (major ? 7 : 3), 1, major ? 7 : 3);
      if (major) tctx.fillText(String(c), x + 2, 2);
    }

    // left ruler (vertical)
    const lctx = /** @type {CanvasRenderingContext2D} */ (rulerLeft.getContext("2d"));
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, RL, vh);
    lctx.fillStyle = bg; lctx.fillRect(0, 0, RL, vh);
    lctx.font = "9px var(--vscode-font-family, monospace)";
    lctx.textBaseline = "middle";
    for (let r = 0; r <= rows; r++) {
      const y = originY + r * cell.h * sy;
      if (y < RT - 1 || y > vh) continue;
      const major = r % rowStride === 0;
      if (!major && !tickRows) continue;
      lctx.fillStyle = fg;
      lctx.fillRect(RL - (major ? 7 : 3), y, major ? 7 : 3, 1);
      if (major) lctx.fillText(String(r), 2, y);
    }
    // corner
    tctx.fillStyle = bg; tctx.fillRect(0, 0, RL, RT);
  }
  function sizeRuler(cv, w, h, dpr) {
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ---- persistence (debounced) ----
  let persistT = 0;
  function persist() {
    clearTimeout(persistT);
    persistT = setTimeout(() => {
      vscode.postMessage({ type: "persist", font9, zoom, center, ruler, fit, bg: bgColor });
    }, 250);
  }

  // ---- toolbar ----
  el("zoomIn").onclick = () => stepZoom(1);
  el("zoomOut").onclick = () => stepZoom(-1);
  fitBox.onchange = () => {
    fit = fitBox.checked;
    if (fit) fitWidth();
    persist();
  };
  el("savePng").onclick = savePng;
  el("openExt").onclick = () => vscode.postMessage({ type: "openMenu" });
  el("openKt").onclick = () => vscode.postMessage({ type: "openInKaleidotron" });
  zoomInput.addEventListener("focus", () => zoomInput.select());
  zoomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitZoomInput(); zoomInput.blur(); }
  });
  zoomInput.addEventListener("blur", commitZoomInput);
  font9box.onchange = () => {
    if (isGraphics()) return; // not applicable to images / RIP / raster
    font9 = font9box.checked;
    decodeAndRender();
    persist();
  };
  centerBox.onchange = () => {
    center = centerBox.checked;
    content.classList.toggle("centered", center);
    persist();
  };
  rulerBox.onchange = () => {
    ruler = rulerBox.checked;
    layoutRulers();
    persist();
  };
  bgBox.oninput = () => {
    bgColor = bgBox.value;
    applyBg();
    persist();
  };

  function savePng() {
    vscode.postMessage({ type: "savePng", data: src.toDataURL("image/png") });
  }

  // ---- Ctrl+wheel zoom (to cursor) ----
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const before = zoom;
    stepZoom(e.deltaY < 0 ? 1 : -1);
    const r = stage.getBoundingClientRect();
    const f = zoom / before;
    const cx = e.clientX - r.left + stage.scrollLeft;
    const cy = e.clientY - r.top + stage.scrollTop;
    stage.scrollLeft = cx * f - (e.clientX - r.left);
    stage.scrollTop = cy * f - (e.clientY - r.top);
  }, { passive: false });

  // ---- middle-click drag to pan ----
  let panning = false, panX = 0, panY = 0, startL = 0, startT = 0;
  stage.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    panning = true; panX = e.clientX; panY = e.clientY;
    startL = stage.scrollLeft; startT = stage.scrollTop;
    stage.classList.add("panning");
  });
  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    stage.scrollLeft = startL - (e.clientX - panX);
    stage.scrollTop = startT - (e.clientY - panY);
  });
  window.addEventListener("mouseup", () => {
    if (!panning) return;
    panning = false; stage.classList.remove("panning");
  });

  stage.addEventListener("scroll", () => { if (ruler) drawRulers(); });

  let lastDpr = window.devicePixelRatio;
  window.addEventListener("resize", () => {
    const dprChanged = window.devicePixelRatio !== lastDpr;
    if (dprChanged) { lastDpr = window.devicePixelRatio; buildPresets(); }
    if (fit) fitWidth();
    else if (dprChanged) applyZoom();
    else if (ruler) drawRulers();
  });

  // ---- host messages ----
  window.addEventListener("message", async (ev) => {
    const msg = ev.data;
    if (msg.type === "load") {
      fileBytes = b64ToBytes(msg.b64);
      isImage = msg.kind === "image";
      isSvg = msg.kind === "svg";
      mime = msg.mime || "";
      sauce = isImage || isSvg ? null : parseSauce(fileBytes);
      extCode = msg.extCode | 0;
      format = msg.format || "";
      font9 = !!msg.font9;
      center = !!msg.center;
      ruler = !!msg.ruler;
      fit = !!msg.fit;
      font9box.checked = font9;
      centerBox.checked = center;
      rulerBox.checked = ruler;
      fitBox.checked = fit;
      buildPresets();
      // The 9px-cell toggle only applies to text-mode art (not images/RIP).
      font9box.closest("label").style.display = isGraphics() ? "none" : "";
      content.classList.toggle("centered", center);
      el("title").textContent = msg.name || "";
      document.body.dataset.bg = msg.background || "black";
      bgColor = typeof msg.bg === "string" ? msg.bg : "";
      if (bgColor) bgBox.value = bgColor;
      applyBg();
      // decode first so natW/natH are known, then apply remembered zoom (or fit)
      const savedZoom = typeof msg.zoom === "number" ? msg.zoom : 0;
      if (isSvg) {
        await decodeSvg();
      } else if (isImage) {
        await decodeImage();
      } else {
        await loadWasm();
        decodeAndRender();
      }
      layoutRulers();
      if (fit) fitWidth();
      else if (savedZoom > 0) setZoom(savedZoom);
      else fitWidth();
    } else if (msg.type === "command") {
      if (msg.name === "toggleFont9px") { font9box.checked = !font9box.checked; font9box.onchange(); }
      else if (msg.name === "savePng") savePng();
      else if (msg.name === "openExternally") vscode.postMessage({ type: "openExternally" });
      else if (msg.name === "openInKaleidotron") vscode.postMessage({ type: "openInKaleidotron" });
    }
  });

  vscode.postMessage({ type: "ready" });
})();
