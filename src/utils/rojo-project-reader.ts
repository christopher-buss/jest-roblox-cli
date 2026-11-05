import { RojoResolver } from "@isentinel/rojo-utils";

/** Builds a Rojo resolver from a project file path. */
export type RojoResolverFactory = typeof RojoResolver.fromPath;

/**
 * Build a Rojo resolver from a project file on disk.
 * @param rojoConfigFilePath - The Rojo project file.
 * @returns The resolver for that project.
 */
export function nodeRojoResolverFactory(rojoConfigFilePath: string): RojoResolver {
	return RojoResolver.fromPath(rojoConfigFilePath);
}
