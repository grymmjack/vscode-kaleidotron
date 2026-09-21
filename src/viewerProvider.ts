import * as vscode from "vscode";
import { Buffer } from "node:buffer";
import * as cp from "node:child_process";

/** Map a lowercased file extension to the wasm `decode_input` ext-code.
 *  Kept in sync with `ext_str` in kaleidotron-textmode-wasm/src/lib.rs. */
const EXT_CODE: Record<string, number> = {
  ans: 0, asc: 0, nfo: 0, diz: 0, ice: 0, cia: 0, msg: 0, txt: 0,
  xb: 1, xbin: 2, bin: 3, tnd: 4, idf: 5, adf: 6, seq: 7, pet: 8, rip: 9,
  // Raster formats decoded by the wasm (browser can't do these natively).
  pcx: 10, psd: 11, xcf: 12, ase: 13, aseprite: 13, iff: 14, ilbm: 14, lbm: 14,
  tga: 15, tiff: 16, tif: 16, qoi: 17, pnm: 18, ppm: 18, pgm: 18, pbm: 18, ff: 19,
  petmate: 20,
  // Font previews (rendered sample). TTF/OTF (21), raw bitmap (22), TheDraw (23).
  ttf: 21, otf: 21, ttc: 21, otc: 21,
  fon: 22, fnt: 22, psf: 22,
  f08: 22, f09: 22, f10: 22, f11: 22, f12: 22, f13: 22, f14: 22, f15: 22,
  f16: 22, f17: 22, f18: 22, f19: 22, f20: 22,
  tdf: 23,
};

/** Human-readable format name per ext-code (shown in the status bar). */
const FORMAT_NAME: Record<number, string> = {
  0: "ANSI", 1: "XBIN", 2: "XBIN", 3: "BIN", 4: "TundraDraw",
  5: "iCE Draw", 6: "Artworx", 7: "PETSCII", 8: "PETSCII", 9: "RIPscript",
  10: "PCX", 11: "PSD", 12: "GIMP XCF", 13: "Aseprite", 14: "IFF/ILBM",
  15: "TGA", 16: "TIFF", 17: "QOI", 18: "PNM", 19: "farbfeld", 20: "petmate",
  21: "Font", 22: "Bitmap font", 23: "TheDraw font",
};

/** Raster extensions the WEBVIEW decodes natively (browser codec, no wasm). */
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
]);
/** Raster/scene extensions the WASM decodes (kaleidotron's Rust decoders). */
const WASM_RASTER_EXTS = new Set([
  "pcx", "psd", "xcf", "ase", "aseprite", "iff", "ilbm", "lbm",
  "tga", "tiff", "tif", "qoi", "pnm", "ppm", "pgm", "pbm", "ff",
]);

class KtDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly bytes: Uint8Array
  ) {}
  dispose(): void {}
}

export class TextmodeViewerProvider
  implements vscode.CustomReadonlyEditorProvider<KtDocument>
{
  /** The most recently focused viewer panel + its document, for palette commands. */
  private active?: { panel: vscode.WebviewPanel; doc: KtDocument };

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<KtDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new KtDocument(uri, bytes);
  }

  async resolveCustomEditor(
    doc: KtDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    panel.webview.html = this.html(panel.webview);

    const track = () => {
      this.active = { panel, doc };
    };
    track();
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) track();
    });

    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg, doc));

    const ext = extname(doc.uri.fsPath);
    const isSvg = ext === "svg";
    const isImage = IMAGE_EXTS.has(ext);
    // svg + raster images → the browser decodes; everything else → the wasm.
    const kind = isSvg ? "svg" : isImage ? "image" : "textmode";
    const cfg = vscode.workspace.getConfiguration("kaleidotron");
    const gs = this.ctx.globalState;
    panel.webview.postMessage({
      type: "load",
      // VS Code's webview.postMessage does not reliably preserve a Uint8Array
      // (it can arrive as a plain object → an empty typed array). Base64 is the
      // portable transport; these files are small.
      b64: Buffer.from(doc.bytes).toString("base64"),
      kind,
      mime: isImage ? imageMime(ext) : isSvg ? "image/svg+xml" : "",
      extCode: EXT_CODE[ext] ?? 0,
      format: isSvg ? "SVG" : isImage ? ext.toUpperCase() : FORMAT_NAME[EXT_CODE[ext] ?? 0],
      font9: gs.get<boolean>("view.font9", true),
      background: cfg.get<string>("background", "black"),
      name: basename(doc.uri.fsPath),
      // Remembered view preferences (shared across files).
      zoom: gs.get<number>("view.zoom", 0),
      center: gs.get<boolean>("view.center", false),
      ruler: gs.get<boolean>("view.ruler", false),
      fit: gs.get<boolean>("view.fit", false),
      bg: gs.get<string>("view.bg", ""),
    });
  }

  /** Forward a palette/keybinding command to the focused viewer. */
  relayCommand(name: string): void {
    this.active?.panel.webview.postMessage({ type: "command", name });
  }

  private async onMessage(msg: any, doc: KtDocument): Promise<void> {
    switch (msg?.type) {
      case "savePng":
        await this.savePng(doc, msg.data as string);
        break;
      case "openExternally":
        await vscode.env.openExternal(doc.uri);
        break;
      case "openMenu":
        await this.openMenu(doc);
        break;
      case "openInKaleidotron":
        this.launchKaleidotron(doc.uri);
        break;
      case "persist":
        // Remembered view preferences, shared across files.
        if (typeof msg.font9 === "boolean")
          await this.ctx.globalState.update("view.font9", msg.font9);
        if (typeof msg.zoom === "number")
          await this.ctx.globalState.update("view.zoom", msg.zoom);
        if (typeof msg.center === "boolean")
          await this.ctx.globalState.update("view.center", msg.center);
        if (typeof msg.ruler === "boolean")
          await this.ctx.globalState.update("view.ruler", msg.ruler);
        if (typeof msg.fit === "boolean")
          await this.ctx.globalState.update("view.fit", msg.fit);
        if (typeof msg.bg === "string")
          await this.ctx.globalState.update("view.bg", msg.bg);
        break;
    }
  }

  /** The "Open in…" toolbar menu: user-configured external tools that match the
   *  file's extension, plus any known scene editors found on PATH, plus the OS
   *  default and a shortcut to the settings. */
  private async openMenu(doc: KtDocument): Promise<void> {
    const ext = extname(doc.uri.fsPath);
    const cfg = vscode.workspace.getConfiguration("kaleidotron");
    const configured = cfg.get<ExternalTool[]>("externalTools", []) ?? [];
    const matches = configured.filter((t) => {
      const exts = (t.extensions ?? []).map((e) =>
        e.toLowerCase().replace(/^\./, "")
      );
      return exts.length === 0 || exts.includes(ext);
    });

    type Item = vscode.QuickPickItem & {
      tool?: ExternalTool;
      os?: boolean;
      settings?: boolean;
    };
    const items: Item[] = [
      ...matches.map((t) => ({ label: t.name, description: t.command, tool: t })),
      ...detectSceneEditors(matches).map((t) => ({
        label: t.name,
        description: `${t.command} (detected on PATH)`,
        tool: t,
      })),
      { label: "$(globe) Open in default app", os: true },
      { label: "$(gear) Configure external tools…", settings: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Open ${basename(doc.uri.fsPath)} in…`,
    });
    if (!pick) return;
    if (pick.os) {
      await vscode.env.openExternal(doc.uri);
      return;
    }
    if (pick.settings) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "kaleidotron.externalTools"
      );
      return;
    }
    if (pick.tool) this.spawnTool(pick.tool, doc.uri);
  }

  private spawnTool(tool: ExternalTool, uri: vscode.Uri): void {
    const args = (tool.args && tool.args.length ? tool.args : ["${file}"]).map(
      (a) => a.replace(/\$\{file\}/g, uri.fsPath)
    );
    try {
      const child = cp.spawn(tool.command, args, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () =>
        vscode.window.showWarningMessage(
          `Could not launch '${tool.command}'. Check kaleidotron.externalTools.`
        )
      );
      child.unref();
    } catch {
      vscode.window.showWarningMessage(
        `Could not launch '${tool.command}'.`
      );
    }
  }

  private async savePng(doc: KtDocument, dataUrl: string): Promise<void> {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return;
    const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
    const stem = basename(doc.uri.fsPath).replace(/\.[^.]+$/, "");
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dirUri(doc.uri), `${stem}.png`),
      filters: { "PNG image": ["png"] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, buf);
    vscode.window.showInformationMessage(`Saved ${basename(target.fsPath)}`);
  }

  /** Launch the kaleidotron desktop app on a file (Explorer menu + toolbar).
   *  kaleidotron takes the file via `--open FILE` (full viewer, folder loaded so
   *  prev/next work), not as a bare positional argument. */
  launchKaleidotron(uri: vscode.Uri): void {
    const cfg = vscode.workspace.getConfiguration("kaleidotron");
    const exe = cfg.get<string>("kaleidotronPath")?.trim() || "kaleidotron";
    try {
      const child = cp.spawn(exe, ["--open", uri.fsPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        vscode.window.showWarningMessage(
          `Could not launch '${exe}'. Set kaleidotron.kaleidotronPath or add it to PATH.`
        );
      });
      child.unref();
    } catch {
      vscode.window.showWarningMessage(
        `Could not launch '${exe}'. Set kaleidotron.kaleidotronPath or add it to PATH.`
      );
    }
  }

  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const wasmUri = uri("kaleidotron_textmode.wasm");
    const scriptUri = uri("viewer.js");
    const styleUri = uri("viewer.css");
    const nonce = nonceStr();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      // 'wasm-unsafe-eval' lets the webview instantiate the .wasm module.
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      // fetch() of the .wasm resource URI.
      `connect-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="toolbar">
    <span id="title"></span>
    <span class="spacer"></span>
    <label class="tgl"><input type="checkbox" id="font9" /> 9px cell</label>
    <label class="tgl"><input type="checkbox" id="center" /> Center</label>
    <label class="tgl"><input type="checkbox" id="ruler" /> Ruler</label>
    <label class="tgl" title="Fit to width on open (remembered)"><input type="checkbox" id="fit" /> Fit</label>
    <label class="tgl" title="Background color"><input type="color" id="bg" value="#000000" /> BG</label>
    <button id="zoomOut" title="Zoom out (crisp steps)">−</button>
    <input id="zoom" class="zoominput" value="100%" title="Zoom — type a %% and press Enter" spellcheck="false" />
    <button id="zoomIn" title="Zoom in (crisp steps)">+</button>
    <span id="presets" title="Quick zoom — crisp levels for your display"></span>
    <button id="savePng" title="Save as PNG…">Save PNG</button>
    <button id="openExt" title="Open in default app">Open in…</button>
    <button id="openKt" title="Open in Kaleidotron">Kaleidotron</button>
  </div>
  <div id="stage">
    <div id="content"><canvas id="art"></canvas></div>
    <canvas id="rulerTop" class="ruler"></canvas>
    <canvas id="rulerLeft" class="ruler"></canvas>
  </div>
  <div id="status"></div>
  <script nonce="${nonce}">window.__WASM_URI__ = ${JSON.stringify(
      wasmUri.toString()
    )};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function extname(p: string): string {
  const m = /\.([^.\\/]+)$/.exec(p);
  return m ? m[1].toLowerCase() : "";
}
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
function imageMime(ext: string): string {
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  };
  return m[ext] ?? "application/octet-stream";
}
function dirUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, "..");
}
function nonceStr(): string {
  let s = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++)
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

interface ExternalTool {
  name: string;
  command: string;
  args?: string[];
  extensions?: string[];
}

/** Known scene/pixel editors; any found on PATH (and not already configured by
 *  the user) are offered in the "Open in…" menu automatically. */
const KNOWN_EDITORS: ExternalTool[] = [
  { name: "PabloDraw", command: "pablodraw" },
  { name: "Moebius", command: "moebius" },
  { name: "IcyDraw", command: "icy_draw" },
  { name: "GIMP", command: "gimp" },
  { name: "Aseprite", command: "aseprite" },
];

function detectSceneEditors(alreadyConfigured: ExternalTool[]): ExternalTool[] {
  const have = new Set(
    alreadyConfigured.map((t) => t.command.toLowerCase())
  );
  const finder = process.platform === "win32" ? "where" : "which";
  return KNOWN_EDITORS.filter((t) => {
    if (have.has(t.command.toLowerCase())) return false;
    try {
      cp.execFileSync(finder, [t.command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}
