import { vi } from "vitest";

import type { RunProgress } from "#src/progress/run-progress.ts";

const noOp = vi.fn<() => void>();

export const NOOP_PROGRESS = {
	begin: vi.fn<RunProgress["begin"]>(() => noOp),
	describe: noOp,
	finish: noOp,
	interleave: vi.fn<RunProgress["interleave"]>((write) => {
		write();
	}),
	note: noOp,
	reveal: noOp,
} satisfies RunProgress;
