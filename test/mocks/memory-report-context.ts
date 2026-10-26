import type { ContentWriter, FileWriter } from "istanbul-lib-report";
import istanbulReport from "istanbul-lib-report";
import { Buffer } from "node:buffer";
import path from "node:path";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { FileSystem } from "../../src/utils/file-system.ts";

interface MemoryWriter extends FileWriter {
	writerForDir(subdirectory: string): FileWriter;
}

interface MemoryReportEnvironment {
	readonly createContext: typeof istanbulReport.createContext;
	readonly directory: string;
	readonly fileSystem: FileSystem;
}

export function createMemoryReportEnvironment(): MemoryReportEnvironment {
	const directory = path.resolve("coverage");
	const { fileSystem } = createMemoryFileSystem();
	function createContext(
		options: Parameters<typeof istanbulReport.createContext>[0] = {},
	): istanbulReport.Context {
		const reportDirectory = options.dir ?? directory;
		const context = istanbulReport.createContext({
			...options,
			dir: reportDirectory,
			sourceFinder: (filePath) => fileSystem.readFileSync(filePath, "utf8"),
		});
		const consoleWriter = context.writer.writeFile(null);
		const writer = createMemoryWriter({
			consoleWriter,
			directory: reportDirectory,
			fileSystem,
		});
		Object.defineProperty(context, "writer", { value: writer });
		return context;
	}

	return { createContext, directory, fileSystem };
}

function createContentWriter(filePath: string, fileSystem: FileSystem): ContentWriter {
	const chunks: Array<Buffer> = [];
	return {
		close(): void {
			fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
			fileSystem.writeFileSync(filePath, Buffer.concat(chunks));
		},
		colorize(text: string): string {
			return text;
		},
		println(text: string): void {
			chunks.push(Buffer.from(`${text}\n`));
		},
		write(chunk: Buffer | string): void {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		},
	};
}

function createMemoryWriter({
	consoleWriter,
	directory,
	fileSystem,
}: {
	consoleWriter: ContentWriter;
	directory: string;
	fileSystem: FileSystem;
}): MemoryWriter {
	return {
		copyFile(source: string, destination: string, header = ""): void {
			const output = this.writeFile(destination);
			output.write(Buffer.concat([Buffer.from(header), fileSystem.readFileSync(source)]));
			output.close();
		},
		writeFile(file: null | string): ContentWriter {
			if (file === null || file === "-") {
				return consoleWriter;
			}

			const filePath = path.join(directory, file);
			return createContentWriter(filePath, fileSystem);
		},
		writeForDir(subdirectory: string): FileWriter {
			return createMemoryWriter({
				consoleWriter,
				directory: path.join(directory, subdirectory),
				fileSystem,
			});
		},
		writerForDir(subdirectory: string): FileWriter {
			return this.writeForDir(subdirectory);
		},
	};
}
