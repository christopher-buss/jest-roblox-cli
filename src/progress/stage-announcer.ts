import type { SpanListener } from "../timing/orchestration-collector.ts";
import { PREPARE_COVERAGE_SPAN, ROJO_BUILD_SPAN } from "../timing/span-names.ts";
import type { RunProgress } from "./run-progress.ts";
import type { StageId } from "./stages.ts";

const SPAN_STAGES = new Map<string, StageId>([
	[PREPARE_COVERAGE_SPAN, "instrument"],
	[ROJO_BUILD_SPAN, "build"],
]);

/**
 * Turns span opens and closes into stage opens and closes.
 * @param progress - The run's stage reporter.
 * @returns Span open and close handlers that drive the matching stage.
 */
export function createStageAnnouncer(progress: RunProgress): SpanListener {
	const closers = new Map<StageId, () => void>();
	return {
		close: (name) => {
			const stage = SPAN_STAGES.get(name);
			if (stage !== undefined) {
				closers.get(stage)?.();
			}
		},
		open: (name) => {
			const stage = SPAN_STAGES.get(name);
			if (stage !== undefined) {
				closers.set(stage, progress.begin(stage));
			}
		},
	};
}
