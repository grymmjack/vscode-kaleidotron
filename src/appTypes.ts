import * as cp from "node:child_process";

/** ext (lowercase, no dot) → kaleidotron decoder group ("image-crate", "audio", "code", …). */
export type AppTypes = Map<string, string>;

/** Snapshot of `kaleidotron --list-extensions` (group → exts), used when the installed
 *  app predates that flag or can't be run. Regenerate from that
 *  command's output after adding a decoder to kaleidotron. */
const FALLBACK: Record<string, string> = {
  "pcx": "pcx",
  "bsave": "bsv bsave",
  "ilbm": "iff ilbm lbm",
  "aseprite": "aseprite ase",
  "psd": "psd",
  "xcf": "xcf",
  "svg": "svg",
  "font": "ttf otf ttc otc",
  "tdf": "tdf",
  "fon": "fon fnt psf f08 f09 f10 f11 f12 f13 f14 f15 f16 f17 f18 f19 f20",
  "amiga-font": "font 2c 4c 8c 16c 32c 64c 128c 256c",
  "xmind": "xmind",
  "ansi": "ans asc nfo diz ice cia txt ace hyp doc dox me 1st now msg cap inf grp fyi pcb",
  "xbin": "xb xbin",
  "tundra": "tnd",
  "rexpaint": "xp",
  "idf": "idf",
  "adf": "adf",
  "petscii": "seq pet petscii",
  "petmate": "petmate",
  "rip": "rip",
  "bin": "bin",
  "pdf": "pdf ai",
  "eps": "eps epsf epsi ps",
  "audio": "mp3 wav wave ogg oga flac ape mka voc au snd aiff aif aifc m4a aac opus wma ra mid " +
    "midi rmi xm it s3m mod rad mtm 669 far okt stm ult med amf mptm",
  "code": "rs c cpp cc cxx h hpp hh hxx inc ino m mm java cs go swift kt kts scala dart php " +
    "php3 php4 php5 hlsl glsl shader gdshader js jsx mjs cjs ts tsx json5 py pyw gd pl pm " +
    "rb sh bash zsh yaml yml toml ini cfg conf r jl ex exs coffee tcl ps1 cmake mk lua " +
    "pas pp dpr dpk lpr lfm dfm pascal f for f77 f90 f95 f03 ftn d nim nims zig cr hs lhs " +
    "erl hrl fs fsi fsx ml mli clj cljs cljc edn scm ss lisp lsp el rkt sql graphql gql " +
    "proto groovy gradle sol elm purs hx hxml v sv svh vhd vhdl re rei res resi vala bat " +
    "cmd awk sed fish nu tf tfvars hcl ron vim ahk adb ads cob cbl pde bas bm bi vb vbs " +
    "qb frm asm s nasm a51 css scss sass less html htm htmlx xhtml xml xaml vue svelte " +
    "json jsonc ipynb md markdown log bbs text csv tsv env gitignore properties rst",
  "mesh3d": "obj stl ply gltf glb dae",
  "mtl": "mtl",
  "blend": "blend blend1",
  "video": "mp4 m4v mkv webm mov avi wmv flv mpg mpeg mts m2ts ogv 3gp m3u8 mpd",
  "image-crate": "png gif bmp jpg jpeg webp web tga tif tiff ppm pgm pbm pnm qoi ico cur hdr dds exr " +
    "ff draw",
  "archive": "zip 7z rar lha lzh tar arj arc zoo ha uc2 sqz tgz tbz xrns xrni",
};

function fallback(): AppTypes {
  const m: AppTypes = new Map();
  for (const [group, exts] of Object.entries(FALLBACK)) {
    for (const e of exts.split(" ")) m.set(e, group);
  }
  return m;
}

let current: AppTypes = fallback();

/** Ask the kaleidotron app which types it opens (`--list-extensions`), falling back to
 *  the built-in snapshot. The result is also kept for `appTypeGroup`. */
export function loadAppTypes(exe: string): Promise<AppTypes> {
  return new Promise((resolve) => {
    cp.execFile(exe, ["--list-extensions"], { timeout: 5000 }, (err, stdout) => {
      const m: AppTypes = new Map();
      if (!err) {
        for (const line of stdout.split("\n")) {
          const [ext, group] = line.trim().split("\t");
          if (ext && group) m.set(ext.toLowerCase(), group);
        }
      }
      current = m.size ? m : fallback();
      resolve(current);
    });
  });
}

/** The decoder group kaleidotron uses for this extension, if it opens it at all. */
export function appTypeGroup(ext: string): string | undefined {
  return current.get(ext.toLowerCase());
}
