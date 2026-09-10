import source from "../../luau/code-bundle-rebuild.luau";

/**
 * The Luau that rebuilds a task's Code Mounts from the Code Bundle its
 * `BinaryInput` carries.
 *
 * Where it goes in a task script is `prepareTaskScript`'s to say — it is one
 * of the preambles that have to be ordered against each other, and one
 * function owning both is what keeps a refused task from paying for a rebuild.
 *
 * Inlined by the raw loader at build time rather than read from beside the
 * module: nothing sits beside the SEA executable, so a run-time read works
 * everywhere except the one place the CLI ships as.
 */
export const CODE_BUNDLE_REBUILD_SOURCE: string = source;
