import { fromAny } from "@total-typescript/shoehorn";

import type { ChildProcessRunner } from "#src/utils/child-process.ts";
import { luteExecFile, type LuteExecFileOptions } from "#test/helpers/lute-exec-file.ts";

export function createLuteChildProcess(options: LuteExecFileOptions): ChildProcessRunner {
	return fromAny({ execFile: luteExecFile(options) });
}
