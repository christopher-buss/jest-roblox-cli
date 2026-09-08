-- exported values (no top-level return allowed alongside them)
export local exported = 1
export local exportedA, exportedB = 1, 2
export local annotated: number = 3
export const constant = 4
export function exportedFunction() end
export type Exported = number
