import type { JestResult, TestFileResult } from "#src/types/jest-result-types.ts";
import { utilsFileResult } from "#test/mocks/format-results.ts";

const EXEC_ERROR_FILE: TestFileResult = {
	failureMessage:
		"  \u25cf Test suite failed to run\n\n    ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183: ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1951: Require-by-string is not enabled for use inside Jest at this time.\n\n      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183 function requireModule\n      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestCircus:114\n",
	numFailingTests: 0,
	numPassingTests: 0,
	numPendingTests: 0,
	testFilePath: "shared/react/features/windows/__tests__/unit-menu-app.test",
	testResults: [],
};

export const EXEC_ERROR_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 0,
	numPendingTests: 0,
	numTotalTests: 0,
	startTime: 1700000000000,
	success: false,
	testResults: [EXEC_ERROR_FILE],
};

// The same shape an exec error takes, differing only in the `timedOut` flag —
// the whole of what the formatters are asked to tell apart, which is why the
// exec error's own `testFilePath` stays. The message is a real abandoned run's:
// its last-seen clause is the only thing naming a test in a report with no test
// results, so a formatter that trims to the first clause has dropped the answer.
export const TIMED_OUT_RESULT: JestResult = {
	...EXEC_ERROR_RESULT,
	testResults: [
		{
			...EXEC_ERROR_FILE,
			failureMessage:
				'Timed out after 60s, aborting tests. Raise test.projectTimeout. Last test seen: "wedge wedges without yielding" in ReplicatedStorage/PkgShared/wedge.spec (running for 52.3s)',
			timedOut: true,
		},
	],
};

export const MIXED_WITH_EXEC_ERROR_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 3,
	numPendingTests: 0,
	numTotalTests: 3,
	startTime: 1700000000000,
	success: false,
	testResults: [
		utilsFileResult(),
		{
			failureMessage:
				"  \u25cf Test suite failed to run\n\n    Require-by-string is not enabled for use inside Jest at this time.\n",
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "src/broken.spec.ts",
			testResults: [],
		},
	],
};

export const LOADSTRING_ERROR_RESULT: JestResult = {
	numFailedTests: 0,
	numPassedTests: 0,
	numPendingTests: 0,
	numTotalTests: 0,
	startTime: 1700000000000,
	success: false,
	testResults: [
		{
			failureMessage:
				"  \u25cf Test suite failed to run\n\n    loadstring() is not available\n",
			numFailingTests: 0,
			numPassingTests: 0,
			numPendingTests: 0,
			testFilePath: "ReplicatedStorage/Client/lib/test.spec",
			testResults: [],
		},
	],
};
