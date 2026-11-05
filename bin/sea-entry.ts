import process from "node:process";

import { main } from "../src/cli.ts";

process.env["JEST_ROBLOX_SEA"] = "true";

void main();
