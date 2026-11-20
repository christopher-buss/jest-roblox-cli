import * as path from "node:path";

import type { SetupResolverFactory } from "#src/config/setup-resolver.ts";

/**
 * A setup-resolver factory that maps every setup file to `Resolved/<basename>`.
 * @returns The factory, in the shape of `SetupResolverFactory`.
 */
export function basenameSetupResolver(): SetupResolverFactory {
	return () => (input) => `Resolved/${path.basename(input)}`;
}
