import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { ResolvedConfig } from "../config/schema.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import { createSnapshotPathResolver } from "../snapshot/path-resolver.ts";
import type { RojoProject } from "../types/rojo.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import { formatBanner } from "../utils/banner.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { replacePrefix } from "../utils/tsconfig-mapping.ts";

/** Snapshot write tallies for one batch. */
export interface SnapshotWriteCounts {
	/** Snapshots the Luau run asked to write. */
	attempted: number;
	/** Snapshots that could not be written. */
	failed: number;
	/** Snapshots written to disk. */
	written: number;
}

/** Inputs for `writeSnapshots`. */
export interface WriteSnapshotsOptions {
	/** Resolved config of the project. */
	config: ResolvedConfig;
	/** File system to write to; defaults to Node's. */
	fileSystem?: FileSystem | undefined;
	/** Snapshot contents keyed by virtual path. */
	snapshotWrites: SnapshotWrites;
	/** Mappings that translate output paths back to source paths. */
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}

type SnapshotPathResolver = ReturnType<typeof createSnapshotPathResolver>;

/**
 * Where a virtual snapshot path lands: the resolver, and the tree it lands in.
 */
interface SnapshotDestination {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	resolver: SnapshotPathResolver;
}

/**
 * The project's Rojo project file: the configured one resolved against
 * `config.rootDir`, else the one found there.
 * @param config - Supplies `rojoProject` and `rootDir`.
 * @param fileSystem - File system to search.
 * @returns The absolute path, or undefined when none is configured or found.
 */
export function resolveRojoProjectFile(
	config: ResolvedConfig,
	fileSystem: FileSystem,
): string | undefined {
	const configured = config.rojoProject ?? findRojoProject(config.rootDir, fileSystem);
	return configured === undefined ? undefined : path.resolve(config.rootDir, configured);
}

/**
 * Write every snapshot the Luau run asked for back to its TypeScript source
 * location. Resolver construction is the fragile half — a missing, unreadable,
 * malformed, or unresolvable rojo project all mean "no snapshot can land", and
 * every one of those counts the whole batch as failed.
 *
 * @param options - Config, snapshots and tsconfig mappings.
 * @returns Attempted, written and failed counts.
 */
export function writeSnapshots({
	config,
	fileSystem = nodeFileSystem,
	snapshotWrites,
	tsconfigMappings,
}: WriteSnapshotsOptions): SnapshotWriteCounts {
	const attempted = Object.keys(snapshotWrites).length;

	const resolver = createSnapshotResolver({ config, fileSystem, tsconfigMappings });
	if (resolver === undefined) {
		return { attempted, failed: attempted, written: 0 };
	}

	const { failed, written } = writeResolvedSnapshots({
		config,
		fileSystem,
		resolver,
		snapshotWrites,
	});

	logSnapshotWriteSummary({ attempted, failed, silent: config.silent, written });

	return { attempted, failed, written };
}

/**
 * Find the rojo project file in a directory.
 * @param rootDirectory - Directory to search.
 * @param fileSystem - File system to read.
 * @returns `default.project.json` when present, else the first `*.project.json`, else undefined.
 */
function findRojoProject(
	rootDirectory: string,
	fileSystem: FileSystem = nodeFileSystem,
): string | undefined {
	const defaultPath = path.join(rootDirectory, "default.project.json");
	if (fileSystem.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fileSystem.readdirSync(rootDirectory);
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	return projectFile !== undefined ? path.join(rootDirectory, projectFile) : undefined;
}

function resolveRojoProjectPath(
	fileSystem: FileSystem,
	config: ResolvedConfig,
): string | undefined {
	const rojoProjectPath = resolveRojoProjectFile(config, fileSystem);
	if (rojoProjectPath === undefined || !fileSystem.existsSync(rojoProjectPath)) {
		process.stderr.write("Warning: Cannot write snapshots - no rojo project found\n");
		return undefined;
	}

	return rojoProjectPath;
}

function warnRojoParseFailure(rojoProjectPath: string, err: unknown): void {
	process.stderr.write(
		formatBanner({
			body: [
				color.red(`Failed to parse rojo project: ${errorMessage(err)}`),
				`  ${color.dim("File:")} ${rojoProjectPath}`,
			],
			level: "warn",
			title: "Snapshot Warning",
		}),
	);
}

function readRojoProject(fileSystem: FileSystem, rojoProjectPath: string): RojoProject | undefined {
	let rojoProjectSource: string;
	try {
		rojoProjectSource = fileSystem.readFileSync(rojoProjectPath, "utf-8");
	} catch (err) {
		process.stderr.write(
			`Warning: Cannot read rojo project ${rojoProjectPath}: ${errorMessage(err)}\n`,
		);
		return undefined;
	}

	let rojoProjectRaw: JSONValue;
	try {
		rojoProjectRaw = JSON.parse(rojoProjectSource);
	} catch (err) {
		warnRojoParseFailure(rojoProjectPath, err);
		return undefined;
	}

	const rojoResult = rojoProjectSchema(rojoProjectRaw);
	if (rojoResult instanceof type.errors) {
		process.stderr.write("Warning: Cannot write snapshots - invalid rojo project\n");
		return undefined;
	}

	return rojoResult;
}

function createSnapshotResolver({
	config,
	fileSystem,
	tsconfigMappings,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}): SnapshotPathResolver | undefined {
	const rojoProjectPath = resolveRojoProjectPath(fileSystem, config);
	if (rojoProjectPath === undefined) {
		return undefined;
	}

	const rojoProject = readRojoProject(fileSystem, rojoProjectPath);
	if (rojoProject === undefined) {
		return undefined;
	}

	try {
		const resolvedTree = resolveNestedProjects(
			{ rootDirectory: path.dirname(rojoProjectPath), tree: rojoProject.tree },
			fileSystem,
		);
		return createSnapshotPathResolver({
			mappings: tsconfigMappings,
			rojoProject: { ...rojoProject, tree: resolvedTree },
		});
	} catch (err) {
		process.stderr.write(`Warning: Cannot resolve rojo project tree: ${errorMessage(err)}\n`);
		return undefined;
	}
}

function writeSnapshotFile({
	config,
	content,
	fileSystem,
	resolver,
	virtualPath,
}: SnapshotDestination & { content: string; virtualPath: string }): boolean {
	const resolved = resolver.resolve(virtualPath);
	if (resolved === undefined) {
		process.stderr.write(`Warning: Cannot resolve snapshot path: ${virtualPath}\n`);
		return false;
	}

	try {
		const absolutePath = path.resolve(config.rootDir, resolved.filePath);
		fileSystem.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fileSystem.writeFileSync(absolutePath, content);

		// Also write to out dir so rojo picks it up without recompile
		const { filePath, mapping } = resolved;
		if (mapping !== undefined) {
			const outPath = replacePrefix({ filePath, from: mapping.rootDir, to: mapping.outDir });
			const absoluteOutPath = path.resolve(config.rootDir, outPath);
			fileSystem.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
			fileSystem.writeFileSync(absoluteOutPath, content);
		}

		return true;
	} catch (err) {
		process.stderr.write(`Warning: Failed to write snapshot ${virtualPath}: ${String(err)}\n`);
		return false;
	}
}

function writeResolvedSnapshots({
	snapshotWrites,
	...destination
}: SnapshotDestination & { snapshotWrites: SnapshotWrites }): Pick<
	SnapshotWriteCounts,
	"failed" | "written"
> {
	let written = 0;
	let failed = 0;

	for (const [virtualPath, content] of Object.entries(snapshotWrites)) {
		if (writeSnapshotFile({ ...destination, content, virtualPath })) {
			written++;
		} else {
			failed++;
		}
	}

	return { failed, written };
}

function logSnapshotWriteSummary({
	attempted,
	failed,
	silent,
	written,
}: {
	attempted: number;
	failed: number;
	silent?: boolean | undefined;
	written: number;
}): void {
	if (written === 0 || silent === true) {
		return;
	}

	const plural = written === 1 ? "" : "s";
	const message =
		failed > 0
			? `Wrote ${String(written)} of ${String(attempted)} snapshot files\n`
			: `Wrote ${String(written)} snapshot file${plural}\n`;
	process.stderr.write(message);
}
