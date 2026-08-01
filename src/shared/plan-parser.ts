/**
 * Parses Firebird's legacy `PLAN (...)` execution-plan syntax (the format returned by
 * `Statement.getPlan(false)` — see `NativeClient.getQueryPlan()` in `driver.ts`) into a small
 * tree structure the query plan webview can render as a diagram. Pure and dependency-free so
 * it's unit-testable without a database, per this repo's convention for SQL-parsing logic
 * (`sql-splitter.ts`, `sql-formatter.ts`).
 *
 * The grammar below was reverse-engineered against a **real Firebird 3.0 server** (not just
 * documentation), by creating a scratch database and capturing `SET PLANONLY ON` output for
 * natural scans, single/multi-index scans, index-ordered scans, nested-loop joins (2-way and
 * 3-way), hash joins, sorts (over both a single scan and a join), and a sort wrapping a nested
 * join — specifically because two assumptions in this project's original design doc turned out
 * to be wrong:
 *
 *   1. `JOIN` doesn't nest each participant as its own sub-plan (`JOIN (PLAN(...), PLAN(...))`)
 *      — it's a flat, comma-separated list of scans: `JOIN (A NATURAL, B INDEX (IB), C ...)`.
 *   2. `SORT` isn't only ever wrapped around a `JOIN` — it can wrap a flat list of scans
 *      directly too (seen from a `UNION` query: `SORT (T NATURAL, T INDEX (IX))`), *and* it can
 *      wrap a nested `JOIN (...)` (seen from an `ORDER BY` on a joined query). So wrapper nodes
 *      genuinely recurse into either scans or other wrappers, not a fixed one-level shape.
 *
 * `HASH` and `MERGE` were not both directly observed (`HASH` was; `MERGE` wasn't triggered with
 * the available test data) but share the identical `KEYWORD (item, item, ...)` shape as `JOIN`
 * and `SORT` in every case that *was* observed, and Firebird's plan grammar is documented as
 * uniform across these — so `MERGE` is parsed the same way. A single plan **text** can contain
 * multiple top-level `PLAN` blocks (one per sub-select in a statement — confirmed via an
 * `EXISTS` subquery, which produced two separate `PLAN (...)` lines from one prepared
 * statement), so `parsePlan()` returns an array, not a single tree.
 *
 * Known limitation: Firebird's plan output doesn't quote object names, so a table or index
 * literally named e.g. `SORT` would be misparsed as the keyword — an ambiguity inherent to the
 * plan format itself, not something this parser can resolve.
 */

export type PlanScanMethod =
  | { method: "NATURAL" }
  | { method: "INDEX"; indexes: string[] }
  | { method: "ORDER"; index: string };

export type PlanNode =
  | ({ kind: "scan"; table: string } & PlanScanMethod)
  | { kind: "JOIN" | "HASH" | "MERGE" | "SORT"; children: PlanNode[] };

const WRAPPER_KEYWORDS = ["JOIN", "HASH", "MERGE", "SORT"] as const;
const KEYWORDS = ["PLAN", ...WRAPPER_KEYWORDS, "NATURAL", "INDEX", "ORDER"];

interface Token {
  type: string;
  value: string;
}

const TOKEN_RE = new RegExp(
  `${KEYWORDS.map(k => `\\b${k}\\b`).join("|")}|[(),]|[^\\s(),]+`,
  "g"
);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text))) {
    const value = match[0];
    if (KEYWORDS.includes(value) || value === "(" || value === ")" || value === ",") {
      tokens.push({ type: value, value });
    } else {
      tokens.push({ type: "IDENT", value });
    }
  }
  return tokens;
}

class PlanParseError extends Error {}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) {
      throw new PlanParseError("Unexpected end of plan text.");
    }
    this.pos++;
    return t;
  }

  private expect(type: string): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new PlanParseError(`Expected "${type}" but found "${t.value}".`);
    }
    return t;
  }

  parseBlocks(): PlanNode[] {
    const blocks: PlanNode[] = [];
    while (this.peek()) {
      this.expect("PLAN");
      blocks.push(this.parseTopLevelNode());
    }
    return blocks;
  }

  /**
   * Immediately after the literal "PLAN" token, a bare scan gets its own enclosing parens
   * (`PLAN (EMP NATURAL)`) but a wrapper keyword does not (`PLAN JOIN (...)`, not
   * `PLAN (JOIN (...))`) — confirmed against captured server output, not assumed.
   */
  private parseTopLevelNode(): PlanNode {
    const t = this.peek();
    if (t && (WRAPPER_KEYWORDS as readonly string[]).includes(t.type)) {
      return this.parseWrapper();
    }
    this.expect("(");
    const node = this.parseScan();
    this.expect(")");
    return node;
  }

  /** A wrapper's own children are bare (`JOIN (D NATURAL, E INDEX (...))`) — no extra parens per item. */
  private parseChild(): PlanNode {
    const t = this.peek();
    if (t && (WRAPPER_KEYWORDS as readonly string[]).includes(t.type)) {
      return this.parseWrapper();
    }
    return this.parseScan();
  }

  private parseWrapper(): PlanNode {
    const kind = this.next().type as "JOIN" | "HASH" | "MERGE" | "SORT";
    this.expect("(");
    const children = [this.parseChild()];
    while (this.peek()?.type === ",") {
      this.next();
      children.push(this.parseChild());
    }
    this.expect(")");
    return { kind, children };
  }

  private parseScan(): PlanNode {
    const t = this.peek();
    if (!t || t.type !== "IDENT") {
      throw new PlanParseError(`Expected a table name but found "${t?.value ?? "end of input"}".`);
    }
    const table = this.next().value;
    const method = this.peek();
    if (method?.type === "NATURAL") {
      this.next();
      return { kind: "scan", table, method: "NATURAL" };
    }
    if (method?.type === "INDEX") {
      this.next();
      this.expect("(");
      const indexes = [this.expect("IDENT").value];
      while (this.peek()?.type === ",") {
        this.next();
        indexes.push(this.expect("IDENT").value);
      }
      this.expect(")");
      return { kind: "scan", table, method: "INDEX", indexes };
    }
    if (method?.type === "ORDER") {
      this.next();
      const index = this.expect("IDENT").value;
      return { kind: "scan", table, method: "ORDER", index };
    }
    throw new PlanParseError(`Expected NATURAL, INDEX, or ORDER after table "${table}".`);
  }
}

/**
 * Parses a Firebird legacy plan text into one tree per top-level `PLAN` block (usually one, but
 * a statement with subqueries can produce several). Throws a descriptive error on malformed
 * input — callers should catch this and fall back to showing the raw text (e.g. when handed the
 * pure-JS driver's heuristic fallback string, which isn't real plan syntax at all).
 */
export function parsePlan(planText: string): PlanNode[] {
  const tokens = tokenize(planText);
  if (tokens.length === 0) {
    return [];
  }
  return new Parser(tokens).parseBlocks();
}

/**
 * Prefixes NativeClient/NodeClient's `Driver.getQueryPlan()` uses for its "this isn't a real
 * plan" fallback text (see `driver.ts`) — not real Firebird plan syntax, so `parsePlan()` would
 * just throw on it anyway, but checking first lets callers show a clearer, more actionable
 * message than a parse error.
 */
/**
 * Every shape `renderIndexMetadataPlan()` can return.
 *
 * It has three return paths — no tables, tables but no index rows, and tables with index rows —
 * and this list originally covered only the first and third. A table without indexes therefore
 * reached the parser and produced `Couldn't parse the plan: Expected "PLAN" but found "--"`,
 * exactly the confusing error the prefix check exists to prevent. Found by the Playwright tier
 * against a real server; `src/test/plan-parser.test.ts` now drives all three straight out of
 * `renderIndexMetadataPlan()` so the two cannot drift apart again.
 */
export const PLAN_FALLBACK_PREFIXES = [
  "-- PLAN not available",
  "-- Firebird Index Metadata",
  "-- No index information found",
];

export type PlanInterpretation =
  | { blocks: PlanNode[]; raw: string }
  | { error: string; raw: string };

/**
 * Interprets raw plan text (from a live `Driver.getQueryPlan()` fetch, or a plan file someone
 * saved earlier) into either a parsed tree or a user-facing error — the fallback-detection,
 * parsing, and error-message shape shared by every plan-diagram consumer, currently
 * `QueryPlanView` (the standalone diagram panel) and `ResultView` (the per-statement "Query Plan"
 * result-view tab), so both surface identical errors for identical inputs instead of two
 * independently-drifting copies of the same three checks.
 */
export function interpretPlanText(planText: string): PlanInterpretation {
  if (PLAN_FALLBACK_PREFIXES.some(prefix => planText.startsWith(prefix))) {
    return {
      error: 'Graphical plans need the native driver. Enable "firebird.useNativeDriver" in settings, then try again.',
      raw: planText,
    };
  }
  try {
    return { blocks: parsePlan(planText), raw: planText };
  } catch (err: any) {
    return { error: `Couldn't parse the plan: ${err?.message ?? err}`, raw: planText };
  }
}
