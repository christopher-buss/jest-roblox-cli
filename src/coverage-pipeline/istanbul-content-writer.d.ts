import type { Buffer } from "node:buffer";

export {};

declare module "istanbul-lib-report" {
	/**
	 * `write` is the one method every content writer implements and the types
	 * leave out — `println` calls it, and both shipped writers define it. It
	 * ends in `fs.writeSync`, which takes bytes as readily as a string, and two
	 * of the html assets are PNG files.
	 */
	interface ContentWriter {
		write(chunk: Buffer | string): void;
	}
}
