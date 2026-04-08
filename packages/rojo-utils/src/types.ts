export interface RojoTreeNode {
	$className?: string;
	$ignoreUnknownInstances?: boolean;
	$path?: string | { optional: string };
	$properties?: Record<string, unknown>;
	[key: string]:
		| boolean
		| Record<string, unknown>
		| RojoTreeNode
		| string
		| undefined
		| { optional: string };
}

export interface RojoProject {
	name: string;
	servePort?: number;
	tree: RojoTreeNode;
}
