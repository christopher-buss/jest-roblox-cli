import process from "node:process";

import { main } from "./cli.ts";

process.env["JEST_ROBLOX_SEA"] = "true";

void main();
