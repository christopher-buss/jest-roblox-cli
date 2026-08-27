/**
 * A workspace package, named as `--packages` names it.
 *
 * The workspace layer's shared vocabulary, so it lives in a leaf module rather
 * than in whichever module happens to produce one — enumeration, the pnpm
 * snapshot, and turbo/nx affected all answer in this shape, and none of them
 * should have to depend on another to say so.
 */
export interface PackageInfo {
	name: string;
	packageDirectory: string;
}
