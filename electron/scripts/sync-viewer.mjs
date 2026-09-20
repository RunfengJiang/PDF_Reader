// Copies the built pdf.js viewer (`build/generic`) into `electron/viewer`,
// so that both `npm start` and the packaged app load the very same files.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, "..");
const src = join(electronDir, "..", "build", "generic");
const dest = join(electronDir, "viewer");

if (!existsSync(src)) {
  console.error(
    `[sync-viewer] "${src}" not found.\n` +
      `Run "npx gulp generic" in the repository root first.`
  );
  process.exit(1);
}

try {
  rmSync(dest, { force: true, recursive: true });
} catch (error) {
  // The destination is simply overwritten below, when it cannot be removed.
  console.warn(`[sync-viewer] could not remove ${dest}: ${error.message}`);
}
cpSync(src, dest, { force: true, recursive: true });
console.log(`[sync-viewer] copied ${src} -> ${dest}`);
