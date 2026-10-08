import assert from "node:assert";

import type { LuauSpan } from "./ast-types.ts";
import { createCompilerWasmRuntime } from "./compiler-wasm-runtime.ts";
import type { CompilerWasmRuntime } from "./compiler-wasm-runtime.ts";

/** The optimization or debug setting accepted by the Luau compiler. */
export type LuauCompileLevel = 0 | 1 | 2;

/** Settings for one compilation and its optional bytecode listing. */
export interface LuauCompileOptions {
	/**
	 * Also return the compiler's bytecode text with code and remarks, as
	 * `luau-compile --remarks --text` prints it.
	 */
	bytecodeText?: boolean;
	/** The amount of debug information retained in the bytecode. */
	debugLevel: LuauCompileLevel;
	/** The optimization setting passed to the compiler. */
	optimizationLevel: LuauCompileLevel;
}

/** Resource usage recorded for one compiled function. */
export interface LuauFrameStatistics {
	/** The source region, with one-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** The maximum register count allocated to this function. */
	maxRegisters: number;
	/** The highest count of simultaneously live locals. */
	peakLocals: number;
	/** The number of captured variables used by this function. */
	upvalueCount: number;
}

/** A compilation diagnostic and the source region that caused it. */
export interface LuauCompileError {
	/**
	 * The local variable named by a register-limit diagnostic, when available.
	 */
	localName?: string | undefined;
	/** The source region, with one-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** The diagnostic text returned by the compiler. */
	message: string;
}

/** A rejected compilation with its first diagnostic. */
export interface LuauCompileFailure {
	/** The first diagnostic rejecting this compilation. */
	error: LuauCompileError;
	/** Whether the parse or compilation succeeded. */
	ok: false;
}

/** Compiled function statistics and an optional bytecode listing. */
export interface LuauCompileSuccess {
	/** The optional bytecode listing with compiler remarks. */
	bytecodeText?: string;
	/** Resource usage for each compiled function. */
	frames: Array<LuauFrameStatistics>;
	/** Whether the parse or compilation succeeded. */
	ok: true;
}

/** The success or diagnostic returned by a compilation. */
export type LuauCompileResult = LuauCompileFailure | LuauCompileSuccess;

/** The typed compilation surface over the embedded backend. */
export interface LuauCompiler {
	/** Compile source with explicit optimization and debug settings. */
	compile: (source: string, options: LuauCompileOptions) => LuauCompileResult;
}

let cachedCompiler: LuauCompiler | undefined;

/**
 * Instantiate and cache the separate wasm build of the official Luau
 * compiler.
 * @param runtime - The backend for an uncached instance; omit it to use the shared wasm instance.
 * @returns The shared compiler, or a fresh instance over the supplied runtime.
 */
export function loadLuauCompiler(runtime?: CompilerWasmRuntime): LuauCompiler {
	if (runtime !== undefined) {
		return createLuauCompiler(runtime);
	}

	cachedCompiler ??= createLuauCompiler(createCompilerWasmRuntime());
	return cachedCompiler;
}

function isRecord(value: JSONValue | undefined): value is JSONObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLuauSpan(value: JSONValue | undefined): value is JSONValue & LuauSpan {
	return (
		isRecord(value) &&
		typeof value["beginColumn"] === "number" &&
		typeof value["beginLine"] === "number" &&
		typeof value["endColumn"] === "number" &&
		typeof value["endLine"] === "number"
	);
}

function isCompileError(value: JSONValue | undefined): value is JSONValue & LuauCompileError {
	return (
		isRecord(value) &&
		isLuauSpan(value["location"]) &&
		typeof value["message"] === "string" &&
		(value["localName"] === undefined || typeof value["localName"] === "string")
	);
}

function isFrameStatistics(value: JSONValue | undefined): value is JSONValue & LuauFrameStatistics {
	return (
		isRecord(value) &&
		isLuauSpan(value["location"]) &&
		typeof value["maxRegisters"] === "number" &&
		typeof value["peakLocals"] === "number" &&
		typeof value["upvalueCount"] === "number"
	);
}

function isCompileSuccess(value: JSONObject): boolean {
	return (
		Array.isArray(value["frames"]) &&
		value["frames"].every(isFrameStatistics) &&
		(value["bytecodeText"] === undefined || typeof value["bytecodeText"] === "string")
	);
}

function isLuauCompileResult(value: JSONValue): value is JSONValue & LuauCompileResult {
	if (!isRecord(value)) {
		return false;
	}

	return value["ok"] === true
		? isCompileSuccess(value)
		: value["ok"] === false && isCompileError(value["error"]);
}

/**
 * Decode compiler payloads through the supplied runtime.
 *
 * @param runtime - The compiler backend for this instance.
 * @returns An independent compiler over the backend.
 */
function createLuauCompiler(runtime: CompilerWasmRuntime): LuauCompiler {
	return {
		compile(source, { bytecodeText = false, debugLevel, optimizationLevel }) {
			const parsed: JSONValue = JSON.parse(
				runtime.compileWithStatistics({
					bytecodeText,
					debugLevel,
					optimizationLevel,
					source,
				}),
			);
			assert(
				isLuauCompileResult(parsed),
				"compiler wasm returned an unrecognized JSON shape",
			);
			return parsed;
		},
	};
}
