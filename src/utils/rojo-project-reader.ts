import { RojoResolver } from "@isentinel/rojo-utils";

export type RojoResolverFactory = typeof RojoResolver.fromPath;

export function nodeRojoResolverFactory(rojoConfigFilePath: string): RojoResolver {
	return RojoResolver.fromPath(rojoConfigFilePath);
}
