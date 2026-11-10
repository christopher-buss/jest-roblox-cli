--!strict
-- Generated from src/protocol/ by scripts/write-luau-protocol.run.ts. Do not edit.
return {
	abandons = {
		Timeout = "timeout",
	},
	coverage = {
		global = "__jest_roblox_cov",
	},
	envelope = {
		batchGameOutputScope = "batch",
		entryKeySeparator = "::",
	},
	errorCodes = {
		InfiniteYield = "infinite-yield",
		JestNotFound = "jest-not-found",
		JestPathUnresolved = "jest-path-unresolved",
		NoProjects = "no-projects",
		ServiceNotFound = "service-not-found",
		Timeout = "timeout",
	},
	limits = {
		queueTtlSeconds = 600,
		resultBudgetBytes = 3400000,
		runTimeoutMs = 300000,
	},
	phases = {
		ResolveJest = "resolveJest",
		ResolveProjects = "resolveProjects",
		Run = "run",
		Staging = "staging",
	},
	runner = {
		keys = {
			"runnerCaptureGameOutput",
			"runnerCoverage",
			"runnerJobIndex",
			"runnerPerTestCoverage",
			"runnerTimeoutMs",
			"runnerTiming",
		},
	},
	stagedPlace = {
		nestedPinnedClasses = {
			StarterPlayer = {
				"StarterCharacterScripts",
				"StarterPlayerScripts",
			},
			Workspace = {
				"Terrain",
			},
		},
		runContextAttribute = "JestRunContextScripts",
		sharedPoolAttribute = "JestSharedPoolKey",
		sharedPoolName = "__shared",
		stageKey = "__pkg_stage",
	},
	studio = {
		defaultPort = 3001,
		frame = {
			hello = "hello",
			nilRelay = "nilRelay",
			nilReturn = "nilReturn",
			pluginReady = "pluginReady",
			results = "results",
			started = "started",
			versionMismatch = "version_mismatch",
		},
		nilRelayWaitSeconds = 60,
		pluginKeyModule = "pluginKey",
		pluginVersionModule = "version",
		portAttribute = "JEST_ROBLOX_PORT",
		protocolVersion = 12,
		runningWaitSeconds = 10,
		runTestsAction = "run_tests",
		sideChannelAttribute = "JestRobloxRunSideChannel",
		vmHostReadyAttribute = "JestRobloxVmHostReady",
	},
	timeoutFormat = "Timed out after %gs, aborting tests. Raise test.projectTimeout",
}
