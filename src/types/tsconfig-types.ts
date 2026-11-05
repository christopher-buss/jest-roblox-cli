/** The `compilerOptions` fields the executor reads. */
export interface TsconfigCompilerOptions {
	/** Compiled-output directory. */
	outDir?: string;
	/** Source root directory; `null` clears an inherited value. */
	rootDir?: null | string;
	/** Source roots merged into one virtual directory. */
	rootDirs?: Array<string>;
}

/** The source and output roots of one tsconfig. */
export interface TsconfigMapping {
	/** The compiled output root. */
	outDir: string;
	/** The TypeScript source root. */
	rootDir: string;
}
