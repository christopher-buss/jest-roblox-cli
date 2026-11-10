import type { Buffer } from "node:buffer";

export {};

declare module "istanbul-lib-report" {
	/** Upstream types omit `write`; every content writer defines it. */
	interface ContentWriter {
		write(chunk: Buffer | string): void;
	}
}
