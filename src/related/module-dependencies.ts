import type {
	CstSuccess,
	RequireCall,
	RequireFileSystem,
	StringRequireResolver,
} from "@isentinel/luau-ast";
import { createStringRequireResolver, forEachCstNode, readRequireCall } from "@isentinel/luau-ast";
import type { LuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { RojoRequireResolver } from "./rojo-requires.ts";
import { createRojoRequireResolver } from "./rojo-requires.ts";

/** Reads the requires of one Luau module. */
export type DependencyReader = (file: string) => ModuleDependencies;

/** Inputs of {@link createReaderCache}. */
export interface ReaderOptions {
	/** File system the Luau modules are read from. */
	fileSystem: FileSystem;
	/** Parser that reads each module's requires. */
	parser: LuauParser;
	/** Normalized paths of the related files, which may be deleted modules. */
	relatedKeys: ReadonlyArray<string>;
}

/** The modules one Luau module requires, and whether any require is lost. */
interface ModuleDependencies {
	/** Paths of the required modules. */
	dependencies: ReadonlySet<string>;
	/**
	 * The module cannot be read, or holds a require that cannot be followed.
	 */
	isOpen: boolean;
}

interface ModuleReader {
	fileSystem: FileSystem;
	isDeletedModule: (file: string) => boolean;
	parser: LuauParser;
	resolve: StringRequireResolver;
	resolveRojo: RojoRequireResolver | undefined;
}

// Mirror luau-ast's require resolver: its module probes, and the alias config
// names it reads as config, not as modules.
const LUAU_MODULE = /\.luau?$/;
const MODULE_FORM = /(?:\/init)?\.luau?$/;
const MODULE_FORMS = [".luau", ".lua", "/init.luau", "/init.lua"];
const REQUIRE_CONFIG = ".config.luau";

/**
 * One dependency reader per Rojo project, each with its own cache. String
 * requires resolve on disk, and a related Luau module gone from disk still
 * resolves, unless another form of it is on disk. Instance-path and
 * `TS.import` requires resolve through the Rojo project.
 *
 * @param options - File system, parser and related files.
 * @returns The reader of a Rojo project, or of none.
 */
export function createReaderCache(
	options: ReaderOptions,
): (rojoProjectPath: string | undefined) => DependencyReader {
	const readers = new Map<string | undefined, DependencyReader>();
	return (rojoProjectPath) => {
		let reader = readers.get(rojoProjectPath);
		if (reader === undefined) {
			reader = createDependencyReader({ ...options, rojoProjectPath });
			readers.set(rojoProjectPath, reader);
		}

		return reader;
	};
}

function parseModule(
	{ fileSystem, parser }: ModuleReader,
	file: string,
): CstSuccess["root"] | undefined {
	if (!LUAU_MODULE.test(file) || !fileSystem.existsSync(file)) {
		return undefined;
	}

	const parsed = parser.parseCst({
		fileName: file,
		source: fileSystem.readFileSync(file, "utf-8"),
	});
	return parsed.ok ? parsed.root : undefined;
}

function resolveCall(
	reader: ModuleReader,
	{ call, file }: { call: RequireCall; file: string },
): string | undefined {
	switch (call.kind) {
		case "dynamic": {
			return undefined;
		}
		case "instance":
		case "ts-import":
		case "ts-package": {
			return reader.resolveRojo?.(file, call);
		}
		case "string": {
			const resolved = reader.resolve(file, call.path);
			return resolved.kind === "resolved" ? resolved.path : undefined;
		}
	}
}

function readDependencies(reader: ModuleReader, file: string): ModuleDependencies {
	if (reader.isDeletedModule(file)) {
		return { dependencies: new Set(), isOpen: false };
	}

	const root = parseModule(reader, file);
	const dependencies = new Set<string>();
	let isOpen = root === undefined;
	forEachCstNode(root, (node) => {
		const call = node.type === "Call" ? readRequireCall(node) : undefined;
		if (call === undefined) {
			return;
		}

		const resolved = resolveCall(reader, { call, file });
		if (resolved === undefined) {
			isOpen = true;
		} else {
			dependencies.add(resolved);
		}
	});
	return { dependencies, isOpen };
}

function createDeletedModuleCheck(
	fileSystem: FileSystem,
	relatedKeys: ReadonlyArray<string>,
): (file: string) => boolean {
	const modules = new Set(
		relatedKeys.filter(
			(key) => LUAU_MODULE.test(key) && path.posix.basename(key) !== REQUIRE_CONFIG,
		),
	);
	return (file) => {
		const key = normalizeWindowsPath(file);
		if (!modules.has(key)) {
			return false;
		}

		const target = key.replace(MODULE_FORM, "");
		return MODULE_FORMS.every((form) => !fileSystem.existsSync(target + form));
	};
}

function createDependencyReader({
	fileSystem,
	parser,
	relatedKeys,
	rojoProjectPath,
}: ReaderOptions & { rojoProjectPath: string | undefined }): DependencyReader {
	const isDeletedModule = createDeletedModuleCheck(fileSystem, relatedKeys);
	const requireFileSystem: RequireFileSystem = {
		existsSync: (file) => fileSystem.existsSync(file) || isDeletedModule(file),
		readFileSync: (file, encoding) => fileSystem.readFileSync(file, encoding),
	};
	const reader = {
		fileSystem,
		isDeletedModule,
		parser,
		resolve: createStringRequireResolver({ fileSystem: requireFileSystem, parser }),
		resolveRojo:
			rojoProjectPath === undefined
				? undefined
				: createRojoRequireResolver({ fileSystem, rojoProjectPath }),
	} satisfies ModuleReader;
	const cache = new Map<string, ModuleDependencies>();
	return (file) => {
		let dependencies = cache.get(file);
		if (dependencies === undefined) {
			dependencies = readDependencies(reader, file);
			cache.set(file, dependencies);
		}

		return dependencies;
	};
}
