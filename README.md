# Kaleidotron — Scene, Pixel, Font & Music Viewer

Native, **pixel-perfect** VS Code viewers + players for the formats that never had
good editor support — ANSI/scene art, exotic raster, fonts, and chiptune/tracker
music — powered by [kaleidotron](https://github.com/grymmjack/kaleidotron)'s Rust
decoders compiled to **WebAssembly**.

> **Self-contained.** All decoding/synthesis runs in a bundled `.wasm` (or the
> browser). Kaleidotron the desktop app does **not** need to be installed — the
> optional *Open in Kaleidotron* button just hands a file to it if you have it.

## Supported formats

### 🅰 Text-mode / scene art
| Format | Extensions | Notes |
| --- | --- | --- |
| ANSI / ASCII | `.ans .nfo .diz .cia` · `.asc .msg`¹ | CP437, SGR/iCE, 24-bit, 9-dot VGA cell |
| XBIN | `.xb .xbin` | embedded font + palette |
| Raw BIN | `.bin`¹ | SAUCE width |
| TundraDraw | `.tnd` | 24-bit truecolour |
| iCE Draw | `.idf .ice` | |
| Artworx | `.adf` | |
| PETSCII | `.seq .pet` | Commodore C64 font + VIC-II palette |
| petmate | `.petmate` | nurpax/petmate JSON PETSCII |
| RIPscript | `.rip` | 640×350 EGA vector (BGI) |

### 🖼 Pixel / raster art (decoded by the wasm)
| Format | Extensions |
| --- | --- |
| PCX · PSD · GIMP XCF | `.pcx` · `.psd` · `.xcf` |
| Aseprite | `.ase .aseprite` |
| Amiga IFF / ILBM | `.iff .ilbm .lbm` |
| TGA · TIFF · QOI | `.tga` · `.tiff .tif` · `.qoi` |
| PNM · farbfeld | `.pnm .ppm .pgm .pbm` · `.ff` |
| QB64 / BASIC BSAVE | `.bsv .bsave` |

### 🌆 Standard images & vector (decoded by the browser)
| Format | Extensions |
| --- | --- |
| PNG · JPEG · GIF | `.png` · `.jpg .jpeg` · `.gif` |
| WebP · BMP · ICO · AVIF | `.webp` · `.bmp` · `.ico` · `.avif` |
| SVG | `.svg` |

### 🔤 Fonts (rendered preview — custom sample text + full glyph grid)
| Format | Extensions |
| --- | --- |
| TrueType / OpenType | `.ttf .otf .ttc .otc` |
| Bitmap (Windows / PC Screen / Fontraption) | `.fon .fnt .psf .f08`…`.f20` |
| TheDraw | `.tdf` |

### 🎵 Audio & music (waveform + transport)
| Format | Extensions | Engine |
| --- | --- | --- |
| Compressed / PCM audio | `.mp3 .wav .ogg .oga .flac .m4a .aac .opus .weba .aif .aiff` | browser (Web Audio) |
| Tracker modules | `.xm .s3m .it` · `.mod`¹ | xmrs (wasm) |
| RAD (Reality Adlib Tracker) | `.rad` | OPL3 FM (wasm) |
| MIDI | `.mid .midi .kar .rmi` | rustysynth + a SoundFont² (wasm) |

¹ Registered **opt-in** (right-click → *Reopen Editor With…*) to avoid hijacking
common extensions (`.bin`, `.txt`, `.mod`↔`go.mod`, `.asc`, `.msg`). Everything
else opens by default.
² MIDI needs a General MIDI SoundFont — set `kaleidotron.soundfontPath`, else a
system `.sf2` is auto-detected (a small font like TimGM6mb loads fastest).

## Features

- **Pixel-perfect crisp zoom** — snaps to whole device-pixels-per-source-pixel, so
  it stays sharp at any zoom / DPI / VS Code UI-zoom.
- Display-scaled **quick-zoom presets**, **type-to-zoom**, persisted **Fit** (fits
  the whole image), **Center**, **Ruler** (character cells / pixels), middle-drag
  pan, Ctrl+wheel zoom.
- **9-dot VGA cell** toggle, **background colour** picker.
- Rich **status bar**: format · font W×H · cols×rows · colours · pixels · zoom · SAUCE credits · iCE.
- **Font viewer**: custom sample text + a **🎲 random pangram** button, with the full
  character grid shown below.
- **Audio/music player**: waveform, play/pause/stop, click-to-seek, loop, volume.
- **Save as PNG**, configurable **Open in…** menu (+ PATH auto-detect of PabloDraw
  / Moebius / IcyDraw / GIMP / Aseprite), **Open in Kaleidotron**.
- Per-format **file icons** (language icons; work with Seti and other themes that
  honour them) + an optional bundled icon theme.

Rendering has **exact parity with kaleidotron**, including its limits (e.g. an XCF
version the `xcf` crate can't read won't open here either).

## Settings

- `kaleidotron.background` — viewer background (`black` / `editor`) when no toolbar colour is picked.
- `kaleidotron.kaleidotronPath` — kaleidotron executable for *Open in Kaleidotron* (blank = auto-detect).
- `kaleidotron.externalTools` — programs for the *Open in…* menu.
- `kaleidotron.soundfontPath` — General MIDI `.sf2` for MIDI playback.

**Tip:** for single-click = preview tab / double-click = pinned, enable VS Code's
`workbench.editor.enablePreview` (it applies to these viewers too).

## How it works

```
kaleidotron workspace                        vscode-kaleidotron (this repo)
├─ crates/kaleidotron-textmode      ← the egui-free decoders + font/audio renderers
└─ crates/kaleidotron-textmode-wasm  →  media/kaleidotron_textmode.wasm  (bundled)
     (no-bindgen C ABI)                       webview: wasm → RGBA / PCM → <canvas> / Web Audio
```

## Building from source

Bundles a prebuilt `.wasm`. To rebuild it: `rustup target add wasm32-unknown-unknown`,
check out kaleidotron side-by-side, then `npm install && npm run build`. **F5** to run.

## License

MIT © Rick Christy (grymmjack). Decoders shared with kaleidotron (MIT). Scene-art
parsing via Mike Krüger's `icy_parser_core` + `retrofont`; tracker/RAD/MIDI via
`xmrs` / a public-domain OPL3 port / `rustysynth`.
