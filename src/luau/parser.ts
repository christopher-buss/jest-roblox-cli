import type { LuauParser } from "@isentinel/luau-ast/parser";
import { loadLuauParser } from "@isentinel/luau-ast/parser";

/** The in-process Luau parser, instantiated once at import. */
export const luauParser: LuauParser = loadLuauParser();
