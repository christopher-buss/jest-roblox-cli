import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

import type { ContentWriter, FileWriter } from "istanbul-lib-report";
import istanbulReport from "istanbul-lib-report";
import { Buffer } from "node:buffer";
import path from "node:path";

import type { FileSystem } from "#src/utils/file-system.ts";

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
	// eslint-disable-next-line ts/no-unsafe-class-instance-assignment -- memory double of the istanbul writer class
	return {
		close(): void {
			fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
			fileSystem.writeFileSync(filePath, Buffer.concat(chunks));
		},
		colorize(text): string {
			return text;
		},
		println(text): void {
			chunks.push(Buffer.from(`${text}\n`));
		},
		write(chunk): void {
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
	// eslint-disable-next-line ts/no-unsafe-class-instance-assignment -- memory double of the istanbul writer class
	return {
		copyFile(source, destination, header = ""): void {
			const output = this.writeFile(destination);
			output.write(Buffer.concat([Buffer.from(header), fileSystem.readFileSync(source)]));
			output.close();
		},
		writeFile(file): ContentWriter {
			if (file === null || file === "-") {
				return consoleWriter;
			}

			const filePath = path.join(directory, file);
			return createContentWriter(filePath, fileSystem);
		},
		writeForDir(subdirectory): FileWriter {
			return createMemoryWriter({
				consoleWriter,
				directory: path.join(directory, subdirectory),
				fileSystem,
			});
		},
		writerForDir(subdirectory): FileWriter {
			return this.writeForDir(subdirectory);
		},
	};
}
