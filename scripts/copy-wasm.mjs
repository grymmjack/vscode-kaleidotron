// Copy the compiled kaleidotron-textmode WebAssembly module into media/ so it
// ships inside the VSIX. Builds the wasm first if it's missing.
//
// The wasm source lives in the sibling kaleidotron workspace. Override the
// location with KALEIDOTRON_DIR if the repos aren't side-by-side.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const kalDir = process.env.KALEIDOTRON_DIR
  ? resolve(process.env.KALEIDOTRON_DIR)
  : resolve(root, "..", "kaleidotron");

const wasmRel = "target/wasm32-unknown-unknown/release/kaleidotron_textmode_wasm.wasm";
const src = join(kalDir, wasmRel);
const destDir = join(root, "media");
const dest = join(destDir, "kaleidotron_textmode.wasm");

function buildWasm() {
  console.log(`[copy-wasm] building wasm in ${kalDir} …`);
  execSync(
    "cargo build -p kaleidotron-textmode-wasm --target wasm32-unknown-unknown --release",
    { cwd: kalDir, stdio: "inherit" }
  );
}

if (!existsSync(kalDir)) {
  console.error(
    `[copy-wasm] kaleidotron workspace not found at ${kalDir}.\n` +
      `Set KALEIDOTRON_DIR to its path, or check out the repos side-by-side.`
  );
  process.exit(1);
}

if (!existsSync(src)) buildWasm();
if (!existsSync(src)) {
  console.error(`[copy-wasm] wasm still missing at ${src} after build.`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(
  `[copy-wasm] ${dest} (${(statSync(dest).size / 1024).toFixed(0)} KiB)`
);
