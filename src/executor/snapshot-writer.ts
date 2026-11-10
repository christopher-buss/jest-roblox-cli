import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { SnapshotWrites } from "../protocol/runner-fields.ts";
import type { PathResolver } from "../source-mapper/path-resolver.ts";
import { createPathResolver } from "../source-mapper/path-resolver.ts";
import { formatBanner } from "../terminal/banner.ts";
import { plural } from "../terminal/plural.ts";
import type { TsconfigMapping } from "../tsconfig/tsconfig-mappings.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { readProjectRojo } from "./project-rojo.ts";

/** Inputs for `writeSnapshots`. */
export interface WriteSnapshotsOptions {
	/** Resolved config of the project. */
	config: ResolvedConfig;
	/** File system to write to; defaults to Node's. */
	fileSystem: FileSystem;
	/** Snapshot contents keyed by virtual path. */
	snapshotWrites: SnapshotWrites;
	/** Mappings that translate output paths back to source paths. */
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}

interface SnapshotDestination {
	fileSystem: FileSystem;
	resolver: PathResolver;
}

/**
 * Write each snapshot the Luau run asked for back to its TypeScript source.
 * @param options - Config, snapshots and tsconfig mappings.
 * @returns How many snapshots could not be written.
 */
export function writeSnapshots({
	config,
	fileSystem,
	snapshotWrites,
	tsconfigMappings,
}: WriteSnapshotsOptions): number {
	const attempted = Object.keys(snapshotWrites).length;

	const resolver = createSnapshotResolver({ config, fileSystem, tsconfigMappings });
	if (resolver === undefined) {
		return attempted;
	}

	const { failed, written } = writeResolvedSnapshots({
		fileSystem,
		resolver,
		snapshotWrites,
	});

	logSnapshotWriteSummary({ attempted, failed, silent: config.silent, written });

	return failed;
}

function warnRojoFailure(projectPath: string, err: unknown): void {
	process.stderr.write(
		formatBanner({
			body: [
				color.red(`Cannot read rojo project: ${errorMessage(err)}`),
				`  ${color.dim("File:")} ${projectPath}`,
			],
			level: "warn",
			title: "Snapshot Warning",
		}),
	);
}

function createSnapshotResolver({
	config,
	fileSystem,
	tsconfigMappings,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}): PathResolver | undefined {
	const read = readProjectRojo(config, fileSystem);
	if (read.kind === "missing") {
		process.stderr.write("Warning: Cannot write snapshots - no rojo project found\n");
		return undefined;
	}

	if (read.kind === "failed") {
		warnRojoFailure(read.projectPath, read.error);
		return undefined;
	}

	return createPathResolver(read.project, {
		fileSystem,
		mappings: tsconfigMappings,
		rootDirectory: read.rojoDirectory,
	});
}

function writeSnapshotFile({
	content,
	fileSystem,
	resolver,
	virtualPath,
}: SnapshotDestination & { content: string; virtualPath: string }): boolean {
	const resolved = resolver.resolveSnapshot(virtualPath);
	if (resolved === undefined) {
		process.stderr.write(`Warning: Cannot resolve snapshot path: ${virtualPath}\n`);
		return false;
	}

	try {
		for (const filePath of [resolved.filePath, resolved.outPath]) {
			if (filePath === undefined) {
				continue;
			}

			fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
			fileSystem.writeFileSync(filePath, content);
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
}: SnapshotDestination & { snapshotWrites: SnapshotWrites }): {
	failed: number;
	written: number;
} {
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

	const message =
		failed > 0
			? `Wrote ${String(written)} of ${String(attempted)} snapshot files\n`
			: `Wrote ${String(written)} snapshot ${plural(written, "file")}\n`;
	process.stderr.write(message);
}
