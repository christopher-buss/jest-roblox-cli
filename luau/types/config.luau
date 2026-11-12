--!strict
export type Backend = "auto" | "open-cloud" | "studio" | "studio-cli"

export type CoverageReporter =
	"clover"
	| "cobertura"
	| "html"
	| "html-spa"
	| "json"
	| "json-summary"
	| "lcov"
	| "lcovonly"
	| "none"
	| "teamcity"
	| "text"
	| "text-lcov"
	| "text-summary"

export type FormatterEntry = string | { string | { [string]: unknown } }

export type DisplayName = {
	name: string,
	color: string,
	[string]: never,
}

export type SnapshotFormatOptions = {
	callToJSON: boolean?,
	escapeRegex: boolean?,
	escapeString: boolean?,
	indent: number?,
	maxDepth: number?,
	min: boolean?,
	printBasicPrototype: boolean?,
	printFunctionName: boolean?,
	[string]: never,
}

export type CoverageThreshold = {
	branches: number?,
	functions: number?,
	lines: number?,
	statements: number?,
	[string]: never,
}

export type TypecheckConfig = {
	enabled: boolean?,
	exclude: { string }?,
	ignoreSourceErrors: boolean?,
	include: { string }?,
	only: boolean?,
	spawnTimeout: number?,
	tsconfig: string?,
	[string]: never,
}

export type ProjectTestConfig = {
	automock: boolean?,
	clearMocks: boolean?,
	displayName: string | DisplayName,
	exclude: { string }?,
	include: { string },
	injectGlobals: boolean?,
	mockDataModel: boolean?,
	outDir: string?,
	projectTimeout: number?,
	resetMocks: boolean?,
	resetModules: boolean?,
	restoreMocks: boolean?,
	root: string?,
	setupFiles: { string }?,
	setupFilesAfterEnv: { string }?,
	slowTestThreshold: number?,
	snapshotFormat: SnapshotFormatOptions?,
	snapshotSerializers: { string }?,
	testEnvironment: string?,
	testEnvironmentOptions: (string | { [string]: unknown })?,
	testMatch: { string }?,
	testPathIgnorePatterns: { string }?,
	testRegex: (string | { string })?,
	testTimeout: number?,
	typecheck: TypecheckConfig?,
	[string]: never,
}

export type InlineProjectConfig = {
	test: ProjectTestConfig,
	[string]: never,
}

export type GlobalTestConfig = {
	all: boolean?,
	automock: boolean?,
	bail: (boolean | number)?,
	changedSince: string?,
	ci: boolean?,
	clearCache: boolean?,
	clearMocks: boolean?,
	collectCoverage: boolean?,
	collectCoverageFrom: { string }?,
	coverage: boolean?,
	coverageCopyIgnorePatterns: { string }?,
	coverageDirectory: string?,
	coveragePathIgnorePatterns: { string }?,
	coverageReporters: { CoverageReporter }?,
	coverageThreshold: CoverageThreshold?,
	debug: boolean?,
	displayName: (string | DisplayName)?,
	env: string?,
	exclude: { string }?,
	expand: boolean?,
	globals: string?,
	include: { string }?,
	injectGlobals: boolean?,
	maxWorkers: (number | string)?,
	mockDataModel: boolean?,
	noStackTrace: boolean?,
	outDir: string?,
	passWithNoTests: boolean?,
	preset: string?,
	projects: { string | InlineProjectConfig }?,
	projectTimeout: number?,
	reporters: { string }?,
	resetMocks: boolean?,
	resetModules: boolean?,
	restoreMocks: boolean?,
	roots: { string }?,
	runInBand: boolean?,
	selectProjects: { string }?,
	setupFiles: { string }?,
	setupFilesAfterEnv: { string }?,
	showConfig: boolean?,
	silent: boolean?,
	slowTestThreshold: number?,
	snapshotFormat: SnapshotFormatOptions?,
	snapshotSerializers: { string }?,
	testEnvironment: string?,
	testEnvironmentOptions: (string | { [string]: unknown })?,
	testFailureExitCode: string?,
	testMatch: { string }?,
	testNamePattern: string?,
	testPathIgnorePatterns: { string }?,
	testPathPattern: string?,
	testRegex: (string | { string })?,
	testTimeout: number?,
	timers: string?,
	typecheck: TypecheckConfig?,
	updateSnapshot: boolean?,
	verbose: boolean?,
	[string]: never,
}

export type WorkspaceConfig = {
	exclude: { string }?,
	gameOutput: true?,
	outputFile: true?,
	packages: { string }?,
	root: string?,
	[string]: never,
}

export type Config = {
	backend: Backend?,
	bootProbeTimeout: number?,
	color: boolean?,
	coverageCache: boolean?,
	extends: (string | { string })?,
	forceRerunTriggers: { string }?,
	formatters: { FormatterEntry }?,
	gameOutput: (string | true)?,
	hiddenDesktop: boolean?,
	jestPath: string?,
	luauRoots: { string }?,
	outputFile: (string | true)?,
	parallel: ("auto" | number)?,
	placeFile: string?,
	placeId: string?,
	pluginsDirectory: string?,
	port: number?,
	rojoProject: string?,
	rootDir: string?,
	showLuau: boolean?,
	sourceMap: boolean?,
	studioPath: string?,
	test: GlobalTestConfig?,
	timeout: number?,
	universeId: string?,
	uploadCache: boolean?,
	workspace: WorkspaceConfig?,
	[string]: never,
}

local function defineConfig(config: Config): Config
	return config
end

return {
	defineConfig = defineConfig,
}
