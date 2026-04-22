import { add, greet } from "./example";

// Minimal compiled-source fixture, not a real Jest test file.
// Keep this line at line 3; source-mapping e2e asserts it.
const result = greet("Alice");
print(result);

const sum = add(2, 3);
print(sum);
