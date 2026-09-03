import * as fs from "node:fs";

/** An instance read back out of a built `.rbxlx`. */
export interface PlaceNode {
	name: string;
	children: Array<PlaceNode>;
	instanceClass: string;
}

/**
 * An item's opening tag, its closing tag, or the `Name` property that names it.
 * Rojo writes an item's properties before its child items, so the first `Name`
 * after an open belongs to the item that opened; matching the property name
 * literally keeps every other string property out, whatever order the
 * serializer put them in.
 */
const ITEM_TOKEN = /<Item\s+class="([^"]+)"[^>]*>|<\/Item>|<string name="Name">([^<]*)</g;

/**
 * The synthetic root the walk starts at, which carries no `Name` of its own.
 */
const ROOT_NAME = "the place";

/**
 * Read a built place as a tree of instances, so a test can assert on where a
 * class landed rather than on whether the file mentions it. A byte-offset scan
 * cannot: the place's own services serialize after the stage does, and every
 * class in them would read as staged.
 */
export function readPlaceTree(placeFile: string): PlaceNode {
	const root: PlaceNode = { name: ROOT_NAME, children: [], instanceClass: "DataModel" };
	const parents: Array<PlaceNode> = [];
	let current = root;
	// Tracked beside the node rather than read off an empty `name`, so an
	// instance genuinely called "" keeps its name instead of absorbing the
	// first one its children declare.
	let isNamed = true;

	for (const [, opened, name] of fs.readFileSync(placeFile, "utf-8").matchAll(ITEM_TOKEN)) {
		if (opened !== undefined) {
			const node: PlaceNode = { name: "", children: [], instanceClass: opened };
			current.children.push(node);
			parents.push(current);
			current = node;
			isNamed = false;
		} else if (name === undefined) {
			// A `</Item>`, the only token left: it returns the walk to the
			// parent, and the root is where a balanced place ends up. Whichever
			// node that is, it took its name before its children opened.
			current = parents.pop() ?? root;
			isNamed = true;
		} else if (!isNamed) {
			current.name = name;
			isNamed = true;
		}
	}

	return root;
}

/**
 * The node at a path of instance names. Addressed by path rather than searched
 * for, so a test says which parent it expects the instance under — a name found
 * anywhere in the place proves nothing about where the stage put it. A missing
 * step throws naming the step, which reads better than an assertion on
 * `undefined`.
 */
export function nodeAt(root: PlaceNode, names: ReadonlyArray<string>): PlaceNode {
	let cursor = root;
	for (const name of names) {
		const child = cursor.children.find((entry) => entry.name === name);
		if (child === undefined) {
			throw new Error(`no "${name}" under ${cursor.name} on the way to ${names.join(".")}`);
		}

		cursor = child;
	}

	return cursor;
}

/** Every node below `node`, for a test asking what a whole subtree holds. */
export function descendants(node: PlaceNode): Array<PlaceNode> {
	return node.children.flatMap((child) => {
		return [child, ...descendants(child)];
	});
}
