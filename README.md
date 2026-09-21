# Kaleidotron — Text-mode, Scene & Pixel Art Viewer

Native, **pixel-perfect** VS Code viewers for the formats that never had good editor
support: **ANSI/ASCII, XBIN, BIN, TundraDraw, iCE Draw, Artworx, PETSCII, RIPscript**,
plus **PCX, PSD, GIMP XCF, Aseprite, IFF/ILBM, TGA, TIFF, QOI, PNM, farbfeld**, the
usual **PNG/JPG/GIF/WebP/BMP/ICO/AVIF**, and **SVG**.

The rendering is **authentic**: the text-mode and exotic-raster decoders are the exact
Rust decoders from [kaleidotron](https://github.com/grymmjack/kaleidotron) — the IBM VGA
ROM CP437 font, the ANSI-SGR-vs-VGA palette ordering, iCE colours, 24-bit ANSI, XBIN
character sets, the C64 font + VIC-II palette for PETSCII, the hand-rolled RIPscript BGI
rasteriser — **compiled to WebAssembly** and run inside the editor.

> **No dependency on kaleidotron.** The decoders are bundled in the extension as a
> `.wasm`; everything decodes and renders standalone. (The optional *Open in
> Kaleidotron* button just hands a file to the desktop app if you have it.)

## Features

- Opens supported files right in an editor tab (a custom editor).
- **Pixel-perfect crisp zoom** — snaps to a whole number of *device* pixels per source
  pixel, so it stays sharp at any zoom on any display / VS Code UI-zoom (no blur).
- **Quick-zoom presets** generated for *your* display (crisp levels), **type-to-zoom**,
  and a **Fit** mode that fits the whole image (persisted).
- **Ruler** in character cells (or pixels for graphics) that tracks the art,
  **Center**, **middle-click-drag pan**, scrollbars, Ctrl+wheel zoom-to-cursor.
- **9-dot VGA cell** toggle (authentic IBM PC width), **background colour** picker.
- Rich **status bar**: format · font W×H · cols×rows · colours · pixels · zoom, plus
  **SAUCE** credits (title / author / group) and an iCE indicator.
- **Save as PNG** (native resolution), **Open in…** menu (configurable external tools +
  auto-detected PabloDraw / Moebius / IcyDraw / GIMP / Aseprite on PATH), **Open in
  Kaleidotron**.
- Per-format **file icons** (language icons — work with icon themes that honour them,
  e.g. Seti) + an optional bundled **icon theme**.

## Supported formats

| Kind | Extensions |
| --- | --- |
| Text-mode / scene | `.ans .nfo .diz .cia .asc .msg` (ANSI/ASCII), `.xb .xbin` (XBIN), `.bin` (raw), `.tnd` (TundraDraw), `.idf .ice` (iCE Draw), `.adf` (Artworx), `.seq .pet` (PETSCII), `.rip` (RIPscript) |
| Exotic raster (wasm) | `.pcx .psd .xcf .ase .aseprite .iff .ilbm .lbm .tga .tiff .tif .qoi .pnm .ppm .pgm .pbm .ff` |
| Standard raster (browser) | `.png .jpg .jpeg .gif .webp .bmp .ico .avif` |
| Vector | `.svg` |

Scene + exotic-raster formats open by default. Ambiguous ones (`.bin .txt .asc .msg`)
and standard images/SVG are opt-in — right-click → **Reopen Editor With…**.

Format support has **exact parity with kaleidotron**, including its limits — e.g. a
GIMP `.xcf` that kaleidotron's `xcf` crate can't read (an unsupported version) won't
open here either.

## How it works

```
kaleidotron workspace                        vscode-kaleidotron (this repo)
├─ crates/kaleidotron-textmode      ← the egui-free decoders (ANSI/XBIN/PCX/PSD/…)
└─ crates/kaleidotron-textmode-wasm  →  media/kaleidotron_textmode.wasm  (bundled)
     (no-bindgen C ABI)                       webview: wasm → RGBA → <canvas>
```

The webview writes the file bytes into wasm memory, calls `decode_input`, and blits the
returned RGBA8 straight to a `<canvas>`. Standard images + SVG are decoded by the
browser. Because the decoders rasterise glyphs themselves, the pixels are authentic by
construction.

## Building from source

The extension bundles a prebuilt `.wasm`. To rebuild it you need the Rust
`wasm32-unknown-unknown` target and the sibling kaleidotron checkout:

```sh
rustup target add wasm32-unknown-unknown
git clone https://github.com/grymmjack/kaleidotron ../kaleidotron   # side-by-side
npm install
npm run build      # bundles the extension + builds & copies the wasm
```

`npm run watch` for iterative development, then **F5** (Run Extension). Set
`KALEIDOTRON_DIR` if the repos aren't side-by-side.

## Settings

- `kaleidotron.background` — viewer background (`black` or `editor`) when no custom
  colour is picked in the toolbar.
- `kaleidotron.kaleidotronPath` — path to the kaleidotron executable for *Open in
  Kaleidotron* (blank = auto-detect on PATH).
- `kaleidotron.externalTools` — programs for the *Open in…* menu.

## Roadmap

- Music formats (mp3/wav/ogg/flac + trackers), font-grid previews (TDF + Fontraption
  `.fXX`), pseudo-vector SVG re-render on zoom, baud-rate ANSImation playback.

## License

MIT © Rick Christy (grymmjack). Decoders shared with kaleidotron (MIT). PETSCII/RIP
parsing via Mike Krüger's `icy_parser_core` (MIT/Apache).
