import type { PollContext } from "#src/poll-diagnosis.ts";

export function makePollContext(overrides: Partial<PollContext> = {}): PollContext {
	return {
		bootProven: false,
		hasDefaultBudget: true,
		placeVersion: 7,
		pollBudgetMs: 46_000,
		recoveryPollBudgetMs: 46_000,
		ref: {
			placeId: "2",
			sessionId: "session",
			taskId: "task",
			universeId: "1",
			versionId: "7",
		},
		submittedState: "PROCESSING",
		timeoutSeconds: 1,
		...overrides,
	};
}
