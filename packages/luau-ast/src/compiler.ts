import assert from "node:assert";

import type { LuauSpan } from "./ast.ts";
import { createCompilerWasmRuntime } from "./compiler-wasm-runtime.ts";

export type LuauCompileLevel = 0 | 1 | 2;

export interface LuauCompileOptions {
	/**
	 * Also return the compiler's bytecode text with code and remarks, as
	 * `luau-compile --remarks --text` prints it.
	 */
	bytecodeText?: boolean;
	debugLevel: LuauCompileLevel;
	optimizationLevel: LuauCompileLevel;
}

export interface LuauFrameStatistics {
	location: LuauSpan;
	maxRegisters: number;
	peakLocals: number;
	upvalueCount: number;
}

export interface LuauCompileError {
	localName?: string | undefined;
	location: LuauSpan;
	message: string;
}

export interface LuauCompileFailure {
	error: LuauCompileError;
	ok: false;
}

export interface LuauCompileSuccess {
	bytecodeText?: string;
	frames: Array<LuauFrameStatistics>;
	ok: true;
}

export type LuauCompileResult = LuauCompileFailure | LuauCompileSuccess;

export interface LuauCompiler {
	compile: (source: string, options: LuauCompileOptions) => LuauCompileResult;
}

let cachedCompiler: LuauCompiler | undefined;

/**
 * Instantiate and cache the separate wasm build of the official Luau
 * compiler.
 */
export function loadLuauCompiler(): LuauCompiler {
	if (cachedCompiler === undefined) {
		const runtime = createCompilerWasmRuntime();
		cachedCompiler = {
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
