import * as vscode from "vscode";
import { TextmodeViewerProvider } from "./viewerProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new TextmodeViewerProvider(context);

  // The same provider backs both the default (scene extensions) and the
  // opt-in (ambiguous .bin/.txt/.asc/.msg) custom-editor registrations.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("kaleidotron.textmode", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider("kaleidotron.textmode.opt", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    // Raster images: a crisp, pixel-perfect viewer (nearest-neighbour zoom,
    // ruler, pan) — decoded natively by the webview, no wasm needed.
    vscode.window.registerCustomEditorProvider("kaleidotron.image", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    // PCX / PSD / XCF / Aseprite / IFF / TGA / TIFF / QOI / … — decoded by the wasm.
    vscode.window.registerCustomEditorProvider("kaleidotron.graphics", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    // TTF/OTF, FON/FNT/PSF/.fXX bitmap fonts, TheDraw .tdf — a rendered preview.
    vscode.window.registerCustomEditorProvider("kaleidotron.font", provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  // Scene extensions open in the default viewer; the ambiguous ones use the
  // opt-in registration (so `vscode.openWith` targets the matching viewType).
  const SCENE = new Set([
    "ans", "nfo", "diz", "ice", "cia", "xb", "xbin", "tnd", "idf", "adf", "seq", "pet",
  ]);
  const extOf = (uri: vscode.Uri) =>
    (/\.([^.\\/]+)$/.exec(uri.fsPath)?.[1] ?? "").toLowerCase();

  context.subscriptions.push(
    // Palette / keybinding: act on the focused viewer.
    vscode.commands.registerCommand("kaleidotron.toggleFont9px", () =>
      provider.relayCommand("toggleFont9px")
    ),
    vscode.commands.registerCommand("kaleidotron.savePng", () =>
      provider.relayCommand("savePng")
    ),
    // These accept an optional URI (Explorer / editor-title context menu) and
    // fall back to the focused viewer when invoked from the palette.
    vscode.commands.registerCommand(
      "kaleidotron.openExternally",
      (uri?: vscode.Uri) =>
        uri ? vscode.env.openExternal(uri) : provider.relayCommand("openExternally")
    ),
    vscode.commands.registerCommand(
      "kaleidotron.openInKaleidotron",
      (uri?: vscode.Uri) =>
        uri ? provider.launchKaleidotron(uri) : provider.relayCommand("openInKaleidotron")
    ),
    vscode.commands.registerCommand(
      "kaleidotron.openInViewer",
      (uri?: vscode.Uri) => {
        if (!uri) return;
        const vt = SCENE.has(extOf(uri))
          ? "kaleidotron.textmode"
          : "kaleidotron.textmode.opt";
        vscode.commands.executeCommand("vscode.openWith", uri, vt);
      }
    )
  );
}

export function deactivate() {}
