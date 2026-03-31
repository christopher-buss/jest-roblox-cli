interface ResolveContext {
	conditions?: Array<string>;
	importAttributes?: Record<string, string>;
	parentURL?: string;
}

interface ResolveResult {
	format?: string;
	url: string;
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

interface LoadContext {
	conditions?: Array<string>;
	format?: string;
	importAttributes?: Record<string, string>;
}

interface LoadResult {
	format: string;
	shortCircuit?: boolean;
	source: string;
}

type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

export function resolve(
	specifier: string,
	context: ResolveContext,
	nextResolve: NextResolve,
): Promise<ResolveResult>;

export function load(url: string, context: LoadContext, nextLoad: NextLoad): Promise<LoadResult>;
