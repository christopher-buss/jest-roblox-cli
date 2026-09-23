export function isVirtualModule(id: string): boolean;

/** The source of the virtual module `id` names. */
export function buildVirtualModule(id: string): string;

export function virtualModulesPlugin(): {
	load: (id: string) => string | undefined;
	name: string;
	resolveId: (id: string) => undefined | { external: false; id: string };
};
