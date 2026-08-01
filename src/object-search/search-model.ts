/**
 * Pure result-index assembly for Object Search. No vscode/Driver dependency — unit-testable
 * without a database, matching schema-graph.ts's/openapi-spec.ts's own convention. Building the
 * QuickPick item list and dispatching a pick to the matching NodeTable/NodeView/.../action lives
 * in index.ts, since that part genuinely needs the vscode QuickPick API and the Node* classes.
 */

export type ObjectKind = "TABLE" | "VIEW" | "PROCEDURE" | "TRIGGER" | "GENERATOR" | "DOMAIN";

/** `row` is the original metadata row — NodeTrigger/NodeDomain are constructed from the whole row, not just a name. */
export interface SearchResult {
  name: string;
  kind: ObjectKind;
  row: any;
}

export interface ObjectSearchInput {
  tables: { TABLE_NAME: string }[];
  views: { VIEW_NAME: string }[];
  procedures: { PROCEDURE_NAME: string }[];
  triggers: { TRIGGER_NAME: string }[];
  generators: { GENERATOR_NAME: string }[];
  domains: { DOMAIN_NAME: string }[];
}

const KIND_LABELS: Record<ObjectKind, string> = {
  TABLE: "Table",
  VIEW: "View",
  PROCEDURE: "Procedure",
  TRIGGER: "Trigger",
  GENERATOR: "Generator",
  DOMAIN: "Domain",
};

export function kindLabel(kind: ObjectKind): string {
  return KIND_LABELS[kind];
}

/** Combines every object type's rows into one alphabetically-sorted search index. */
export function buildSearchIndex(input: ObjectSearchInput): SearchResult[] {
  const results: SearchResult[] = [
    ...input.tables.map(row => ({ name: row.TABLE_NAME.trim(), kind: "TABLE" as const, row })),
    ...input.views.map(row => ({ name: row.VIEW_NAME.trim(), kind: "VIEW" as const, row })),
    ...input.procedures.map(row => ({ name: row.PROCEDURE_NAME.trim(), kind: "PROCEDURE" as const, row })),
    ...input.triggers.map(row => ({ name: row.TRIGGER_NAME.trim(), kind: "TRIGGER" as const, row })),
    ...input.generators.map(row => ({ name: row.GENERATOR_NAME.trim(), kind: "GENERATOR" as const, row })),
    ...input.domains.map(row => ({ name: row.DOMAIN_NAME.trim(), kind: "DOMAIN" as const, row })),
  ];
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Merges the system-table results into the main index, sorted as one list.
 *
 * Pure, and separated from the picker for exactly that reason: the picker is driven by a command
 * that takes a tree node, so it cannot be reached from the Command Palette and therefore not by
 * the Playwright tier either. This is the part worth pinning down — that system entries are
 * distinguishable, and that the merged list stays in one alphabetical order rather than appending
 * a second sorted block at the end.
 */
export function mergeSystemResults(base: SearchResult[], system: SearchResult[]): SearchResult[] {
  return [...base, ...system].sort((a, b) => a.name.localeCompare(b.name));
}

/** The description shown beside a result: its kind, marked when the object is a system one. */
export function describeResult(result: SearchResult, isSystem = false): string {
  return isSystem ? `${kindLabel(result.kind)} (system)` : kindLabel(result.kind);
}
