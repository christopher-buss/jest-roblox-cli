import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { ResolvedConfig } from "../config/schema.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import { createSnapshotPathResolver } from "../snapshot/path-resolver.ts";
import type { RojoProject } from "../types/rojo.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { formatBanner } from "../utils/banner.ts";
import { errorMessage } from "../utils/error-message.ts";
import { replacePrefix } from "../utils/tsconfig-mapping.ts";

export interface SnapshotWriteCounts {
	attempted: number;
	failed: number;
	written: number;
}

type SnapshotPathResolver = ReturnType<typeof createSnapshotPathResolver>;

export function findRojoProject(rootDirectory: string): string | undefined {
	const defaultPath = path.join(rootDirectory, "default.project.json");
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fs.readdirSync(rootDirectory);
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	return projectFile !== undefined ? path.join(rootDirectory, projectFile) : undefined;
}

/**
 * Write every snapshot the Luau run asked for back to its TypeScript source
 * location. Resolver construction is the fragile half — a missing, unreadable,
 * malformed, or unresolvable rojo project all mean "no snapshot can land", and
 * every one of those counts the whole batch as failed.
 */
export function writeSnapshots(
	snapshotWrites: SnapshotWrites,
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): SnapshotWriteCounts {
	const attempted = Object.keys(snapshotWrites).length;

	const resolver = createSnapshotResolver(config, tsconfigMappings);
	if (resolver === undefined) {
		return { attempted, failed: attempted, written: 0 };
	}

	const { failed, written } = writeResolvedSnapshots(snapshotWrites, config, resolver);

	logSnapshotWriteSummary({ attempted, failed, silent: config.silent, written });

	return { attempted, failed, written };
}

function resolveRojoProjectPath(config: ResolvedConfig): string | undefined {
	// Resolve against `config.rootDir`, not CWD. In single-package mode CWD
	// happens to equal rootDir so the distinction is invisible; in workspace
	// mode CWD is the workspace root and a relative `config.rojoProject`
	// (e.g. "test.project.json") would miss every package. `findRojoProject`
	// already returns an absolute path so the resolve is a no-op for that
	// branch — needed only for the user-supplied raw string.
	const rawRojoProjectPath = config.rojoProject ?? findRojoProject(config.rootDir);
	const rojoProjectPath =
		rawRojoProjectPath !== undefined
			? path.resolve(config.rootDir, rawRojoProjectPath)
			: undefined;
	if (rojoProjectPath === undefined || !fs.existsSync(rojoProjectPath)) {
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

function readRojoProject(rojoProjectPath: string): RojoProject | undefined {
	let rojoProjectSource: string;
	try {
		rojoProjectSource = fs.readFileSync(rojoProjectPath, "utf-8");
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

function createSnapshotResolver(
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): SnapshotPathResolver | undefined {
	const rojoProjectPath = resolveRojoProjectPath(config);
	if (rojoProjectPath === undefined) {
		return undefined;
	}

	const rojoProject = readRojoProject(rojoProjectPath);
	if (rojoProject === undefined) {
		return undefined;
	}

	try {
		const resolvedTree = resolveNestedProjects(rojoProject.tree, path.dirname(rojoProjectPath));
		return createSnapshotPathResolver({
			mappings: tsconfigMappings,
			rojoProject: { ...rojoProject, tree: resolvedTree },
		});
	} catch (err) {
		process.stderr.write(`Warning: Cannot resolve rojo project tree: ${errorMessage(err)}\n`);
		return undefined;
	}
}

function writeSnapshotFile(
	virtualPath: string,
	content: string,
	config: ResolvedConfig,
	resolver: SnapshotPathResolver,
): boolean {
	const resolved = resolver.resolve(virtualPath);
	if (resolved === undefined) {
		process.stderr.write(`Warning: Cannot resolve snapshot path: ${virtualPath}\n`);
		return false;
	}

	try {
		const absolutePath = path.resolve(config.rootDir, resolved.filePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, content);

		// Also write to out dir so rojo picks it up without recompile
		const { filePath, mapping } = resolved;
		if (mapping !== undefined) {
			const outPath = replacePrefix(filePath, mapping.rootDir, mapping.outDir);
			const absoluteOutPath = path.resolve(config.rootDir, outPath);
			fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
			fs.writeFileSync(absoluteOutPath, content);
		}

		return true;
	} catch (err) {
		process.stderr.write(`Warning: Failed to write snapshot ${virtualPath}: ${String(err)}\n`);
		return false;
	}
}

function writeResolvedSnapshots(
	snapshotWrites: SnapshotWrites,
	config: ResolvedConfig,
	resolver: SnapshotPathResolver,
): { failed: number; written: number } {
	let written = 0;
	let failed = 0;

	for (const [virtualPath, content] of Object.entries(snapshotWrites)) {
		if (writeSnapshotFile(virtualPath, content, config, resolver)) {
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
