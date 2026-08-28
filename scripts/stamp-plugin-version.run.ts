import path from "node:path";
import process from "node:process";
import url from "node:url";

import { stampPluginVersion } from "./stamp-plugin-version.ts";

// Entrypoint only: `build:plugin` runs this before rojo so the stamp is in the
// tree the `.rbxm` is built from. The work itself lives beside it, where it can
// be tested against a memfs volume.
const PACKAGE_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
process.stdout.write(`stamped plugin version ${stampPluginVersion(PACKAGE_ROOT)}\n`);
