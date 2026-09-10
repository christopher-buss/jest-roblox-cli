// cspell:ignore protoflags upvals
// Build the official Luau parser and compiler as separate wasm artifacts, then
// embed each as a base64 TypeScript module. Parser consumers therefore keep
// loading only the parser while compiler consumers opt into the larger binary.
//
// Reproducibility contract: with the pinned emsdk and Luau versions below, the
// output is byte-identical across machines. CI rebuilds and fails on any diff
// against the committed modules (see wasm-verify in ci.yaml), so a Luau or
// emsdk bump must rerun this script and commit the results.
//
// Requirements: `em++` on PATH (or $EMXX pointing at it) and `git`.
// Usage: node build-wasm.ts [luau-source-dir]
//   With no argument, clones Luau at the pinned tag into a temp dir.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LUAU_TAG = "0.731";
const EMSDK_VERSION = "6.0.8";

const EMCC_VERSION = /^emcc \D*(\d+\.\d+\.\d+)/;

const WASM_DIRECTORY = import.meta.dirname;
const PARSER_WASM_ARTIFACT = "luau-parser.wasm";
const COMPILER_WASM_ARTIFACT = "luau-compiler.wasm";
const PARSER_EMBEDDED_MODULE = path.join(WASM_DIRECTORY, "..", "src", "luau-parser-wasm.ts");
const COMPILER_EMBEDDED_MODULE = path.join(WASM_DIRECTORY, "..", "src", "luau-compiler-wasm.ts");
const COMPILER_SOURCE_NAME = "Compiler.cpp";

const AST_EXPR_INSTANTIATE_WRITER = `    void write(class AstExprInstantiate* node)
    {
        writeNode(
            node,
            "AstExprInstantiate",
            [&]()
            {
                PROP(expr);
                PROP(typeArguments);
            }
        );
    }

`;
const AST_EXPR_INSTANTIATE_VISITOR = `    bool visit(class AstExprInstantiate* node) override
    {
        write(node);
        return false;
    }

`;

const EMXX = process.env["EMXX"] ?? "em++";

interface LuauCheckout {
	directory: string;
	/**
	 * The temp root to remove afterwards, absent when the caller supplied a
	 * checkout.
	 */
	temporaryRoot: string | undefined;
}

interface EmbeddedArtifact {
	artifact: string;
	description: Array<string>;
	exportName: string;
	modulePath: string;
}

interface WasmBuild {
	artifact: string;
	exportedFunctions: string;
	includeDirectories: Array<string>;
	sources: Array<string>;
}

const COMPILER_INSTRUMENTATION = [
	{
		needle: "namespace Luau\n{\n",
		replacement: [
			"namespace Luau",
			"{",
			"void recordFrameStart(const Location& location);",
			"void recordPeakLocals(size_t localCount);",
			"void recordFrameEnd(unsigned int maxRegisters, size_t upvalueCount);",
			"",
		].join("\n"),
	},
	{
		needle: "        RegScope rs(this);\n\n        bool self",
		replacement:
			"        RegScope rs(this);\n        recordFrameStart(func->location);\n\n        bool self",
	},
	{
		needle: "        localStack.push_back(local);\n",
		replacement:
			"        localStack.push_back(local);\n        recordPeakLocals(localStack.size());\n",
	},
	{
		needle: "        bytecode.endFunction(uint8_t(stackSize), uint8_t(upvals.size()), protoflags, costModel);",
		replacement: [
			"        recordFrameEnd(stackSize, upvals.size());",
			"        bytecode.endFunction(uint8_t(stackSize), uint8_t(upvals.size()), protoflags, costModel);",
		].join("\n"),
	},
] satisfies Array<{ needle: string; replacement: string }>;

function capture(command: string, args: Array<string>): string {
	return execFileSync(command, args, { encoding: "utf8", windowsHide: true });
}

function assertEmscriptenVersion(): void {
	const [banner = ""] = capture(EMXX, ["--version"]).split("\n", 1);
	const [, found] = EMCC_VERSION.exec(banner) ?? [];
	if (found !== EMSDK_VERSION) {
		throw new Error(`emscripten ${EMSDK_VERSION} required, found ${found ?? banner}`);
	}
}

function checkoutLuau(): LuauCheckout {
	const provided = process.argv[2];
	if (provided !== undefined) {
		return { directory: provided, temporaryRoot: undefined };
	}

	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luau-"));
	const directory = path.join(temporaryRoot, "luau");
	execFileSync(
		"git",
		[
			"clone",
			"--depth",
			"1",
			"--branch",
			LUAU_TAG,
			"https://github.com/luau-lang/luau",
			directory,
		],
		{ stdio: "inherit", windowsHide: true },
	);

	return { directory, temporaryRoot };
}

// readdir order is filesystem-dependent, and link order decides the layout of
// the wasm. Sorting is what keeps the output byte-identical across machines.
function cppSources(sourceDirectory: string): Array<string> {
	return fs
		.readdirSync(sourceDirectory)
		.filter((entry) => entry.endsWith(".cpp"))
		.sort()
		.map((entry) => path.join(sourceDirectory, entry));
}

function insertBefore(source: string, anchor: string, insertion: string): string {
	const index = source.indexOf(anchor);
	if (!source.includes(anchor) || source.slice(index + anchor.length).includes(anchor)) {
		throw new Error(`expected one AstJsonEncoder anchor: ${anchor.trim()}`);
	}

	return `${source.slice(0, index)}${insertion}${source.slice(index)}`;
}

// Luau 0.731 has no AstExprInstantiate encoder override, so its generic visitor
// concatenates that node's children into invalid JSON.
function patchAstJsonEncoder(luauSource: string, temporaryRoot: string): string {
	const filePath = path.join(temporaryRoot, "AstJsonEncoder.cpp");
	const encoderPath = path.join(luauSource, "Analysis/src/AstJsonEncoder.cpp");
	const upstream = fs.readFileSync(encoderPath, "utf8");

	const withWriter = insertBefore(
		upstream,
		"    void write(class AstExprIndexName* node)",
		AST_EXPR_INSTANTIATE_WRITER,
	);
	const patched = insertBefore(
		withWriter,
		"    bool visit(class AstExprIndexName* node) override",
		AST_EXPR_INSTANTIATE_VISITOR,
	);

	fs.writeFileSync(filePath, patched);
	return filePath;
}

function compileWasm(wasmBuild: WasmBuild): void {
	execFileSync(
		EMXX,
		[
			"-O2",
			"-std=c++17",
			"-DNDEBUG",
			"-fwasm-exceptions",
			...wasmBuild.includeDirectories.map((directory) => `-I${directory}`),
			...wasmBuild.sources,
			"--no-entry",
			"-sALLOW_MEMORY_GROWTH=1",
			"-sSTACK_SIZE=1048576",
			`-sEXPORTED_FUNCTIONS=${wasmBuild.exportedFunctions}`,
			"-o",
			wasmBuild.artifact,
		],
		{ cwd: WASM_DIRECTORY, stdio: "inherit", windowsHide: true },
	);
}

function compileParser(luauSource: string, astJsonEncoder: string): void {
	compileWasm({
		artifact: PARSER_WASM_ARTIFACT,
		exportedFunctions:
			"_parse_to_json,_parse_to_cst_json,_inject_cst_fault,_free_result,_malloc,_free",
		includeDirectories: ["Ast", "Common", "Analysis"].map((part) => {
			return path.join(luauSource, part, "include");
		}),
		sources: [
			...cppSources(path.join(luauSource, "Ast", "src")),
			astJsonEncoder,
			path.join(luauSource, "Common", "src", "StringUtils.cpp"),
			"wrapper.cpp",
		],
	});
}

function replaceExactlyOnce(source: string, needle: string, replacement: string): string {
	const first = source.indexOf(needle);
	if (first === -1 || source.includes(needle, first + needle.length)) {
		throw new Error(
			`expected one compiler instrumentation point for ${JSON.stringify(needle)}`,
		);
	}

	return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function instrumentCompiler(luauSource: string, temporaryRoot: string): string {
	const upstreamPath = path.join(luauSource, "Compiler", "src", COMPILER_SOURCE_NAME);
	let source = fs.readFileSync(upstreamPath, "utf8");
	for (const { needle, replacement } of COMPILER_INSTRUMENTATION) {
		source = replaceExactlyOnce(source, needle, replacement);
	}

	const instrumentedPath = path.join(temporaryRoot, COMPILER_SOURCE_NAME);
	fs.writeFileSync(instrumentedPath, source);
	return instrumentedPath;
}

function compileCompiler(luauSource: string, instrumentedCompiler: string): void {
	const compilerSources = cppSources(path.join(luauSource, "Compiler", "src")).filter(
		(source) => path.basename(source) !== COMPILER_SOURCE_NAME,
	);
	compileWasm({
		artifact: COMPILER_WASM_ARTIFACT,
		exportedFunctions: "_compile_with_statistics,_free_result,_malloc,_free",
		includeDirectories: ["Ast", "Bytecode", "Common", "Compiler"].flatMap((part) => [
			path.join(luauSource, part, "include"),
			...(part === "Compiler" ? [path.join(luauSource, part, "src")] : []),
		]),
		sources: [
			...cppSources(path.join(luauSource, "Ast", "src")),
			...cppSources(path.join(luauSource, "Bytecode", "src")),
			...cppSources(path.join(luauSource, "Common", "src")),
			...compilerSources,
			instrumentedCompiler,
			"compiler-wrapper.cpp",
		],
	});
}

function embed({ artifact, description, exportName, modulePath }: EmbeddedArtifact): void {
	const header = [
		"// Generated by wasm/build-wasm.ts — do not edit.",
		...description.map((line) => `// ${line}`),
		"",
		`export const ${exportName} =`,
	].join("\n");

	const base64 = fs.readFileSync(artifact).toString("base64");
	fs.writeFileSync(modulePath, `${header}\n\t"${base64}";\n`);
}

function reportDigest(filePath: string, label: string): void {
	const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	process.stdout.write(`${digest}  ${label}\n`);
}

function embedArtifacts(): void {
	embed({
		artifact: path.join(WASM_DIRECTORY, PARSER_WASM_ARTIFACT),
		description: [
			"The official Luau parser (see wasm/wrapper.cpp), embedded so every",
			"consumer bundle carries it without runtime asset resolution.",
		],
		exportName: "luauParserWasmBase64",
		modulePath: PARSER_EMBEDDED_MODULE,
	});
	embed({
		artifact: path.join(WASM_DIRECTORY, COMPILER_WASM_ARTIFACT),
		description: [
			"The official Luau compiler (see wasm/compiler-wrapper.cpp), kept",
			"separate so parser consumers do not load compiler code.",
		],
		exportName: "luauCompilerWasmBase64",
		modulePath: COMPILER_EMBEDDED_MODULE,
	});
}

function reportArtifacts(): void {
	for (const [artifact, modulePath] of [
		[PARSER_WASM_ARTIFACT, PARSER_EMBEDDED_MODULE],
		[COMPILER_WASM_ARTIFACT, COMPILER_EMBEDDED_MODULE],
	] satisfies Array<[string, string]>) {
		const artifactPath = path.join(WASM_DIRECTORY, artifact);
		reportDigest(artifactPath, artifact);
		reportDigest(modulePath, path.relative(WASM_DIRECTORY, modulePath));
	}
}

function buildAll(luauSource: string, patchedSourceRoot: string): void {
	const tag = capture("git", ["-C", luauSource, "describe", "--tags"]).trim();
	if (tag !== LUAU_TAG) {
		throw new Error(`Luau checkout is ${tag}, pin is ${LUAU_TAG}`);
	}

	compileParser(luauSource, patchAstJsonEncoder(luauSource, patchedSourceRoot));
	compileCompiler(luauSource, instrumentCompiler(luauSource, patchedSourceRoot));
	embedArtifacts();
	reportArtifacts();
}

function build(): void {
	assertEmscriptenVersion();
	const luau = checkoutLuau();
	const patchedSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luau-wasm-sources-"));
	try {
		buildAll(luau.directory, patchedSourceRoot);
	} finally {
		fs.rmSync(patchedSourceRoot, { force: true, recursive: true });
		if (luau.temporaryRoot !== undefined) {
			fs.rmSync(luau.temporaryRoot, { force: true, recursive: true });
		}

		for (const artifact of [PARSER_WASM_ARTIFACT, COMPILER_WASM_ARTIFACT]) {
			fs.rmSync(path.join(WASM_DIRECTORY, artifact), { force: true });
		}
	}
}

try {
	build();
} catch (err) {
	console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
