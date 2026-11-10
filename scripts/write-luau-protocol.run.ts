import path from "node:path";
import url from "node:url";

import { LUAU_PROTOCOL_MODULE, renderLuauProtocol } from "../src/protocol/luau-module.ts";
import { nodeFileSystem } from "../src/utils/file-system.ts";

const PACKAGE_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
nodeFileSystem.writeFileSync(path.join(PACKAGE_ROOT, LUAU_PROTOCOL_MODULE), renderLuauProtocol());
