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
  let isAudio = false; // audio (mp3/wav/ogg/flac/…) via Web Audio
  let isFont = false; // font preview (TTF/OTF/FON/…/TDF) with sample/grid controls
  let isPalette = false; // palette swatch grid (.gpl/.pal/.act/.aco/.hex)
  let autoplay = false; // start audio/music automatically on open
  let copyFormat = "hex"; // palette swatch copy format: hex | rgb | hsv
  let mime = "";
  // Web Audio state
  let actx = null, abuf = null, asrc = null, again = null;
  let aplaying = false, aoffset = 0, astart = 0, apeaks = null, araf = 0;

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
  const viewctl = el("viewctl");
  const audioctl = el("audioctl");
  const wave = /** @type {HTMLCanvasElement} */ (el("wave"));
  const aplay = el("aplay");
  const aloopBox = /** @type {HTMLInputElement} */ (el("aloop"));
  const atime = el("atime");
  const avol = /** @type {HTMLInputElement} */ (el("avol"));
  const aautoplay = /** @type {HTMLInputElement} */ (el("aautoplay"));
  const fontctl = el("fontctl");
  const ftext = /** @type {HTMLInputElement} */ (el("ftext"));
  const palctl = el("palctl");
  const palgrid = el("palgrid");
  const palinfo = el("palinfo");

  // Pangrams + typography sayings for the 🎲 Random button (pangrams exercise
  // every letter — ideal for a font preview).
  const PHRASES = [
    "The quick brown fox jumps over the lazy dog",
    "Pack my box with five dozen liquor jugs",
    "How vexingly quick daft zebras jump!",
    "Sphinx of black quartz, judge my vow",
    "The five boxing wizards jump quickly",
    "Jackdaws love my big sphinx of quartz",
    "Waltz, bad nymph, for quick jigs vex",
    "Glib jocks quiz nymph to vex dwarf",
    "Bright vixens jump; dozy fowl quack",
    "Quick zephyrs blow, vexing daft Jim",
    "Two driven jocks help fax my big quiz",
    "Five quacking zephyrs jolt my wax bed",
    "The jay, pig, fox, zebra and my wolves quack!",
    "Crazy Fredrick bought many very exquisite opal jewels",
    "We promptly judged antique ivory buckles for the next prize",
    "A wizard's job is to vex chumps quickly in fog",
    "Watch Jeopardy!, Alex Trebek's fun TV quiz game",
    "Amazingly few discotheques provide jukeboxes",
    "The wizard quickly jinxed the gnomes before they vaporized",
    "Woven silk pyjamas exchanged for blue quartz",
    "Grumpy wizards make toxic brew for the evil queen and jack",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789 !@#$%^&*()-=+",
    "Handgloves",
    "Type is a beautiful group of letters, not a group of beautiful letters",
    "The details are not the details; they make the design",
    "Typography is what language looks like",
    "Good design is as little design as possible",
    "White space is to be regarded as an active element",
  ];
  const rulerTop = /** @type {HTMLCanvasElement} */ (el("rulerTop"));
  const rulerLeft = /** @type {HTMLCanvasElement} */ (el("rulerLeft"));

  const RT = 18; // top-ruler thickness (px)
  const RL = 36; // left-ruler thickness (px)

  async function loadWasm() {
    if (wasm) return;
    const resp = await fetch(window.__WASM_URI__);
    const buf = await resp.arrayBuffer();
    // The module carries a few wasm-bindgen imports (pulled transitively by
    // retrofont→zip→getrandom/time) that are never called on the decode path.
    // Provide no-op stubs so the no-bindgen module instantiates.
    const stub = new Proxy({}, {
      get: (_, n) => {
        const s = String(n);
        if (s.includes("throw")) return () => { throw new Error("wasm throw"); };
        if (s.includes("grow")) return () => 0;
        return () => {};
      },
    });
    const imports = new Proxy({}, { get: () => stub });
    const { instance } = await WebAssembly.instantiate(buf, imports);
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

  /** Render a font: the sample (font name, or custom text) on top + the full
   *  glyph grid below (mode 2). Empty text → the font's name. */
  async function decodeFont() {
    if (!isFont) return;
    await loadWasm();
    const ex = wasm.exports;
    const ptr = ex.input_ptr(fileBytes.length);
    mem().set(fileBytes, ptr);
    const enc = new TextEncoder().encode(ftext.value);
    const tp = ex.text_ptr(enc.length);
    mem().set(enc, tp);
    if (!ex.decode_font(extCode, 2)) {
      statusEl.textContent = "Could not render this font.";
      return;
    }
    const w = ex.out_w(), h = ex.out_h(), len = ex.out_len(), optr = ex.out_ptr();
    if (!w || !h) {
      statusEl.textContent = "Nothing to render.";
      return;
    }
    const bytes = new Uint8ClampedArray(mem().subarray(optr, optr + len));
    natW = w; natH = h; src.width = w; src.height = h;
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
    // RIP (9), raster (10–19) and font previews (21–23) are pixel graphics;
    // petmate (20) is a C64 cell grid.
    return isImage || isSvg || (extCode >= 9 && extCode !== 20);
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

  // ---- palette viewer ----
  const hex2 = (v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0");
  function rgb2hex(r, g, b) {
    return ("#" + hex2(r) + hex2(g) + hex2(b)).toUpperCase();
  }
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: Math.round(h), s: Math.round((mx ? d / mx : 0) * 100), v: Math.round(mx * 100) };
  }
  function fmtColor(c, fmt) {
    if (fmt === "rgb") return `rgb(${c.r}, ${c.g}, ${c.b})`;
    if (fmt === "hsv") { const h = rgb2hsv(c.r, c.g, c.b); return `hsv(${h.h}, ${h.s}%, ${h.v}%)`; }
    return rgb2hex(c.r, c.g, c.b);
  }
  function parseGpl(t) {
    let name = "", colors = [];
    for (const line of t.split(/\r?\n/)) {
      if (/^GIMP Palette/i.test(line)) continue;
      const nm = line.match(/^Name:\s*(.+)/i);
      if (nm) { name = nm[1].trim(); continue; }
      if (line.startsWith("#") || !line.trim()) continue;
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/);
      if (m) colors.push({ r: +m[1], g: +m[2], b: +m[3], name: (m[4] || "").trim() });
    }
    return { name, colors };
  }
  function parseJasc(t) {
    const lines = t.split(/\r?\n/), colors = [];
    for (let i = 3; i < lines.length; i++) {
      const m = lines[i].trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) colors.push({ r: +m[1], g: +m[2], b: +m[3] });
    }
    return { name: "JASC palette", colors };
  }
  function parseHexList(t) {
    const colors = [];
    for (const line of t.split(/\r?\n/)) {
      const m = line.trim().match(/^#?([0-9a-f]{6})\b/i);
      if (m) colors.push({ r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) });
    }
    return { name: "Hex list", colors };
  }
  function parseRawRGB(bytes, count, name) {
    const colors = [];
    const n = Math.min(count, Math.floor(bytes.length / 3));
    for (let i = 0; i < n; i++) colors.push({ r: bytes[i * 3], g: bytes[i * 3 + 1], b: bytes[i * 3 + 2] });
    return { name, colors };
  }
  function parseRiff(bytes) {
    const colors = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      const sz = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
      const start = i + 8;
      if (id === "data") {
        const count = bytes[start + 2] | (bytes[start + 3] << 8);
        let p = start + 4;
        for (let c = 0; c < count && p + 3 <= bytes.length; c++) {
          colors.push({ r: bytes[p], g: bytes[p + 1], b: bytes[p + 2] });
          p += 4;
        }
        break;
      }
      i = start + sz + (sz & 1);
    }
    return { name: "RIFF palette", colors };
  }
  function parseAco(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.byteLength < 4) return { name: "Adobe Color", colors: [] };
    const count = dv.getUint16(2); // v1 count
    const colors = [];
    let p = 4;
    for (let i = 0; i < count && p + 10 <= dv.byteLength; i++) {
      const cs = dv.getUint16(p), w = dv.getUint16(p + 2), x = dv.getUint16(p + 4), y = dv.getUint16(p + 6);
      p += 10;
      if (cs === 0) colors.push({ r: Math.round(w / 257), g: Math.round(x / 257), b: Math.round(y / 257) });
      else if (cs === 2) { // CMYK (stored inverted)
        const c = 1 - w / 65535, m = 1 - x / 65535, ye = 1 - y / 65535, k = 1 - dv.getUint16(p - 2) / 65535;
        colors.push({ r: Math.round(255 * (1 - c) * (1 - k)), g: Math.round(255 * (1 - m) * (1 - k)), b: Math.round(255 * (1 - ye) * (1 - k)) });
      } else colors.push({ r: 0, g: 0, b: 0 });
    }
    return { name: "Adobe Color", colors };
  }
  function parsePalette(bytes, ext) {
    const t = new TextDecoder("latin1").decode(bytes);
    if (ext === "gpl") return parseGpl(t);
    if (ext === "hex") return parseHexList(t);
    if (ext === "aco") return parseAco(bytes);
    if (ext === "act") {
      const count = bytes.length >= 770 ? (bytes[768] << 8) | bytes[769] : 256;
      return parseRawRGB(bytes, count || 256, "Adobe Color Table");
    }
    // .pal — JASC text, RIFF binary, or raw 768.
    if (/^JASC-PAL/.test(t)) return parseJasc(t);
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return parseRiff(bytes);
    if (bytes.length >= 768) return parseRawRGB(bytes, Math.floor(bytes.length / 3), "Palette");
    return parseJasc(t);
  }
  function renderPalette() {
    const ext = (format || "").toLowerCase();
    const parsed = parsePalette(fileBytes, ext) || { name: "", colors: [] };
    const colors = parsed.colors;
    palgrid.textContent = "";
    colors.forEach((c, i) => {
      const hsv = rgb2hsv(c.r, c.g, c.b);
      const sw = document.createElement("div");
      sw.className = "sw";
      sw.style.background = rgb2hex(c.r, c.g, c.b);
      sw.title =
        `${i}: ${rgb2hex(c.r, c.g, c.b)}  ·  rgb(${c.r}, ${c.g}, ${c.b})  ·  ` +
        `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)` + (c.name ? "  ·  " + c.name : "");
      sw.onclick = () => {
        vscode.postMessage({ type: "copy", text: fmtColor(c, copyFormat) });
        sw.classList.add("copied");
        setTimeout(() => sw.classList.remove("copied"), 350);
      };
      palgrid.appendChild(sw);
    });
    palinfo.textContent = (parsed.name ? parsed.name + "  ·  " : "") + `${colors.length} colors`;
    statusEl.textContent = `${format}  ·  ${parsed.name || "palette"}  ·  ${colors.length} colors  ·  click a swatch to copy ${copyFormat.toUpperCase()}`;
    statusEl.title = statusEl.textContent;
  }
  function updateCopyButtons() {
    for (const b of document.querySelectorAll("#palctl .cpf"))
      b.classList.toggle("on", b.getAttribute("data-f") === copyFormat);
  }
  function showPaletteUI() {
    viewctl.style.display = "none";
    audioctl.style.display = "none";
    fontctl.style.display = "none";
    content.style.display = "none";
    wave.style.display = "none";
    rulerTop.style.display = "none";
    rulerLeft.style.display = "none";
    palctl.style.display = "";
    palgrid.style.display = "block";
    updateCopyButtons();
  }

  // ---- audio player (Web Audio) ----
  function fmtTime(s) {
    s = Math.max(0, s || 0);
    return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  }
  function curAudioPos() {
    if (!abuf) return 0;
    let p = aplaying ? actx.currentTime - astart : aoffset;
    if (aloopBox.checked && abuf.duration > 0)
      p = ((p % abuf.duration) + abuf.duration) % abuf.duration;
    return Math.max(0, Math.min(abuf.duration, p));
  }
  function computePeaks(buf, cols) {
    cols = cols || 2000;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const block = Math.max(1, Math.floor(ch0.length / cols));
    const peaks = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      let mx = 0;
      const s = c * block, e = Math.min(ch0.length, s + block);
      for (let i = s; i < e; i++) {
        let v = Math.abs(ch0[i]);
        if (ch1) { const v2 = Math.abs(ch1[i]); if (v2 > v) v = v2; }
        if (v > mx) mx = v;
      }
      peaks[c] = mx;
    }
    return peaks;
  }
  function layoutWave() {
    const dpr = window.devicePixelRatio || 1;
    wave.style.width = stage.clientWidth + "px";
    wave.style.height = stage.clientHeight + "px";
    wave.width = Math.round(stage.clientWidth * dpr);
    wave.height = Math.round(stage.clientHeight * dpr);
  }
  function drawWave() {
    if (!apeaks || !abuf) return;
    const dpr = window.devicePixelRatio || 1;
    const c = wave.getContext("2d");
    const W = wave.width, H = wave.height, mid = H / 2, n = apeaks.length;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = bgColor || "#0b0e14";
    c.fillRect(0, 0, W, H);
    const pos = abuf.duration > 0 ? curAudioPos() / abuf.duration : 0;
    const bw = Math.max(1, W / n);
    for (let i = 0; i < n; i++) {
      const x = (i / n) * W;
      const a = apeaks[i] * (H * 0.45);
      c.fillStyle = i / n <= pos ? "#3fb950" : "#4b5566";
      c.fillRect(x, mid - a, Math.ceil(bw), Math.max(1, a * 2));
    }
    c.fillStyle = "#ffffff";
    c.fillRect(Math.floor(pos * W), 0, Math.max(1, Math.round(dpr)), H);
  }
  function updateATime() {
    if (abuf) atime.textContent = fmtTime(curAudioPos()) + " / " + fmtTime(abuf.duration);
  }
  function updateAudioStatus() {
    if (!abuf) return;
    statusEl.textContent =
      `${format}  ·  ${abuf.numberOfChannels}ch  ·  ` +
      `${Math.round(abuf.sampleRate / 100) / 10} kHz  ·  ${fmtTime(abuf.duration)}`;
    statusEl.title = statusEl.textContent;
  }
  function rafTick() {
    cancelAnimationFrame(araf);
    const loop = () => {
      if (!isAudio) return;
      drawWave();
      updateATime();
      if (aplaying) araf = requestAnimationFrame(loop);
    };
    araf = requestAnimationFrame(loop);
  }
  function startSource(offset) {
    asrc = actx.createBufferSource();
    asrc.buffer = abuf;
    asrc.loop = aloopBox.checked;
    asrc.connect(again);
    asrc.onended = () => {
      if (!aloopBox.checked && aplaying) {
        aplaying = false; aoffset = 0; aplay.textContent = "▶";
        drawWave(); updateATime();
      }
    };
    const off = ((offset % abuf.duration) + abuf.duration) % abuf.duration;
    asrc.start(0, off);
    astart = actx.currentTime - off;
    aplaying = true; aplay.textContent = "⏸";
    rafTick();
  }
  function audioToggle() {
    if (!abuf) return;
    if (actx.state === "suspended") actx.resume();
    if (aplaying) {
      aoffset = curAudioPos();
      try { asrc.stop(); } catch {}
      aplaying = false; aplay.textContent = "▶";
    } else startSource(aoffset);
  }
  function audioStop() {
    try { if (asrc) asrc.stop(); } catch {}
    aplaying = false; aoffset = 0; aplay.textContent = "▶";
    drawWave(); updateATime();
  }
  function showAudioUI() {
    isAudio = true;
    viewctl.style.display = "none";
    audioctl.style.display = "";
    content.style.display = "none";
    rulerTop.style.display = "none";
    rulerLeft.style.display = "none";
    wave.style.display = "block";
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!actx) actx = new AC();
    if (!again) {
      again = actx.createGain();
      again.gain.value = (avol.value | 0) / 100;
      again.connect(actx.destination);
    }
  }
  function finishAudio() {
    apeaks = computePeaks(abuf);
    aoffset = 0; aplaying = false; aplay.textContent = "▶";
    layoutWave(); drawWave(); updateATime(); updateAudioStatus();
    if (autoplay) audioToggle(); // start (browser autoplay policy may defer to a click)
  }
  function audioRewind() {
    aoffset = 0;
    if (aplaying) { try { asrc.stop(); } catch {} startSource(0); }
    else { drawWave(); updateATime(); }
  }
  async function decodeAudio() {
    showAudioUI();
    try {
      const ab = fileBytes.buffer.slice(
        fileBytes.byteOffset,
        fileBytes.byteOffset + fileBytes.byteLength
      );
      abuf = await actx.decodeAudioData(ab);
    } catch (e) {
      statusEl.textContent = "Could not decode this audio.";
      return;
    }
    finishAudio();
  }
  /** Shared path: run a wasm synth (`call` invokes decode_tracker/rad/midi),
   *  then build an AudioBuffer from the rendered PCM. */
  async function decodeWasmAudio(call) {
    showAudioUI();
    await loadWasm();
    const ex = wasm.exports;
    const ptr = ex.input_ptr(fileBytes.length);
    mem().set(fileBytes, ptr);
    if (!call(ex)) {
      statusEl.textContent = "Could not render this file.";
      return;
    }
    const rate = ex.audio_rate();
    const ch = ex.audio_channels();
    const inter = new Float32Array(mem().buffer, ex.audio_ptr(), ex.audio_len() / 4);
    const frames = Math.floor(inter.length / ch);
    abuf = actx.createBuffer(ch, frames, rate);
    for (let c = 0; c < ch; c++) {
      const cd = abuf.getChannelData(c);
      for (let i = 0; i < frames; i++) cd[i] = inter[i * ch + c];
    }
    finishAudio();
  }
  const decodeTracker = () => decodeWasmAudio((ex) => ex.decode_tracker());
  const decodeRad = () => decodeWasmAudio((ex) => ex.decode_rad());
  async function decodeMidi(sf2b64) {
    if (!sf2b64) {
      showAudioUI();
      statusEl.textContent =
        "No SoundFont found — set kaleidotron.soundfontPath to a .sf2 to play MIDI.";
      return;
    }
    const sf2 = b64ToBytes(sf2b64);
    await decodeWasmAudio((ex) => {
      const sp = ex.soundfont_ptr(sf2.length);
      mem().set(sf2, sp);
      return ex.decode_midi();
    });
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
      vscode.postMessage({ type: "persist", font9, zoom, center, ruler, fit, autoplay, bg: bgColor });
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
  // audio transport
  aplay.onclick = audioToggle;
  el("astop").onclick = audioStop;
  aloopBox.onchange = () => { if (asrc) asrc.loop = aloopBox.checked; };
  avol.oninput = () => { if (again) again.gain.value = (avol.value | 0) / 100; };
  wave.addEventListener("mousedown", (e) => {
    if (!abuf) return;
    const r = wave.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    aoffset = frac * abuf.duration;
    if (aplaying) { try { asrc.stop(); } catch {} startSource(aoffset); }
    else { drawWave(); updateATime(); }
  });
  window.addEventListener("keydown", (e) => {
    const t = document.activeElement && document.activeElement.tagName;
    if (!isAudio || t === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); audioToggle(); }
    else if (e.key === "Home") { e.preventDefault(); audioRewind(); }
  });
  // font controls: custom sample text + a random typography phrase
  let ftextT = 0;
  ftext.addEventListener("input", () => {
    clearTimeout(ftextT);
    ftextT = setTimeout(decodeFont, 200);
  });
  el("frandom").onclick = () => {
    ftext.value = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    decodeFont();
  };
  // palette copy-format buttons
  for (const b of palctl.querySelectorAll(".cpf")) {
    b.onclick = () => {
      copyFormat = b.getAttribute("data-f");
      updateCopyButtons();
      if (isPalette) renderPalette();
    };
  }
  // audio: auto-play preference
  aautoplay.onchange = () => {
    autoplay = aautoplay.checked;
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
    if (isAudio) { layoutWave(); drawWave(); return; }
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
      isFont = msg.kind === "font";
      isPalette = msg.kind === "palette";
      isAudio = ["audio", "tracker", "rad", "midi"].includes(msg.kind);
      autoplay = !!msg.autoplay;
      aautoplay.checked = autoplay;
      mime = msg.mime || "";
      sauce = isImage || isSvg || isAudio ? null : parseSauce(fileBytes);
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
      if (isPalette) {
        audioStop();
        showPaletteUI();
        renderPalette();
      } else if (isAudio) {
        palctl.style.display = "none";
        palgrid.style.display = "none";
        if (msg.kind === "tracker") await decodeTracker();
        else if (msg.kind === "rad") await decodeRad();
        else if (msg.kind === "midi") await decodeMidi(msg.sf2);
        else await decodeAudio();
      } else {
        // ensure the audio + palette UI are torn down + the view UI restored
        audioStop();
        audioctl.style.display = "none";
        palctl.style.display = "none";
        palgrid.style.display = "none";
        viewctl.style.display = "";
        wave.style.display = "none";
        content.style.display = "";
        fontctl.style.display = isFont ? "" : "none";
        if (isFont) {
          ftext.value = "";
          await decodeFont();
        } else if (isSvg) await decodeSvg();
        else if (isImage) await decodeImage();
        else { await loadWasm(); decodeAndRender(); }
        layoutRulers();
        if (fit) fitWidth();
        else if (savedZoom > 0) setZoom(savedZoom);
        else fitWidth();
      }
    } else if (msg.type === "command") {
      if (msg.name === "toggleFont9px") { font9box.checked = !font9box.checked; font9box.onchange(); }
      else if (msg.name === "savePng") savePng();
      else if (msg.name === "openExternally") vscode.postMessage({ type: "openExternally" });
      else if (msg.name === "openInKaleidotron") vscode.postMessage({ type: "openInKaleidotron" });
    }
  });

  vscode.postMessage({ type: "ready" });
})();
