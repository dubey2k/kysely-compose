/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * kysely-compose
 *
 * Extends Kysely's `SelectQueryBuilder`, `UpdateQueryBuilder`, and
 * `DeleteQueryBuilder` with conditional, ergonomic helpers directly on the
 * chain — ts-sql-query style, fully type-safe.
 *
 * ─── Setup ────────────────────────────────────────────────────────────────────
 *
 *   Import ONCE at your db entry point — every builder in your app gets the
 *   helpers automatically via prototype augmentation:
 *
 *     // src/db.ts
 *     import 'kysely-compose'
 *     export const db = new Kysely<Database>({ ... })
 *
 *   The augmentation is idempotent — importing twice (e.g. across different
 *   module realms in tooling) is a no-op.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────────
 *
 *   The following helpers are available on SELECT, UPDATE, and DELETE:
 *
 *     equalsIfValue, notEqualsIfValue, gteIfValue, lteIfValue, gtIfValue,
 *     ltIfValue, filterIfValue, inIfValue, notInIfValue, containsIfValue,
 *     iLikeIfValue, startsWithIfValue, whereBetweenIfValue, isNullWhen,
 *     isNotNullWhen, whereIfValues, whereExpressions, onlyWhen, unless.
 *
 *   On SELECT, conditional helpers safely skip when their input is empty.
 *
 *   On UPDATE / DELETE, helpers that would otherwise skip the WHERE clause
 *   THROW instead — preventing accidental full-table writes if a filter DTO
 *   is empty or undefined. Use plain `.where(...)` when you genuinely want
 *   to mutate every row.
 *
 *   SELECT-only helpers (intentionally excluded from UPDATE/DELETE — LIMIT
 *   and ORDER BY on those statements are MySQL-specific and don't translate
 *   to portable SQL):
 *
 *     orderByIfValue, orderBySwitch, paginate, limitIfValue, optionalJoin.
 *
 * ─── Type safety ─────────────────────────────────────────────────────────────
 *
 *   Value arguments are inferred from the actual column type in your DB
 *   schema using `<DB[TB][C]>` + `SelectType`:
 *
 *     interface ContactTable {
 *       status: 'active' | 'inactive' | 'lead'
 *       lead_score: number | null
 *       created_at: ColumnType<Date, string, never>
 *     }
 *
 *     .equalsIfValue('status', 'active')     // OK — 'active' | 'inactive' | 'lead'
 *     .equalsIfValue('status', 'wrong')      // TS error
 *     .gteIfValue('lead_score', 50)          // OK — number
 *     .gteIfValue('created_at', new Date())  // OK — Date (from ColumnType<Date,...>)
 *     .inIfValue('status', ['active'])       // OK
 *     .inIfValue('status', ['wrong'])        // TS error
 *
 *   CAVEAT (Kysely-wide, not specific to this file): the WHERE RHS is typed
 *   from the column's SelectType. For columns where the "valid where-input"
 *   type diverges from the select type (e.g. `ColumnType<Array, TaggedJson, never>`
 *   where values must be wrapped on insert but come back raw on select),
 *   the typed RHS may not match what the driver accepts at runtime. Tracked
 *   in kysely-org/kysely#1621. For normal columns this is never an issue.
 *
 * ─── Null vs undefined ───────────────────────────────────────────────────────
 *
 *   `equalsIfValue`, `notEqualsIfValue`, and `whereIfValues` distinguish
 *   `undefined` ("user didn't specify this filter") from `null` ("user wants
 *   the null-match"):
 *
 *     .equalsIfValue('owner_id', undefined)  // skipped (or throws on UPDATE/DELETE)
 *     .equalsIfValue('owner_id', null)       // WHERE owner_id IS NULL
 *     .equalsIfValue('owner_id', 'abc')      // WHERE owner_id = 'abc'
 *
 *   All other `*IfValue` helpers (gte/lte/gt/lt/between/in/contains/iLike/
 *   startsWith/filter) treat both `null` and `undefined` as "no filter",
 *   since `col >= null`, `col LIKE null`, `col IN (null)` etc. are not
 *   useful. Use `isNullWhen` / `isNotNullWhen` for explicit null checks
 *   on those.
 *
 * ─── What's intentionally NOT here ───────────────────────────────────────────
 *
 *   `orEqualsIfValue(col, values)` — semantically identical to
 *   `inIfValue(col, values)`; every major RDBMS compiles `WHERE x IN (a,b,c)`
 *   to the same plan as `x = a OR x = b OR x = c`. Use `inIfValue`. For
 *   arbitrary OR logic, use `whereExpressions(eb => [eb.or([...])])`.
 */

import type {
  SelectQueryBuilder,
  UpdateQueryBuilder,
  DeleteQueryBuilder,
  ExpressionBuilder,
  Expression,
  ComparisonOperatorExpression,
  OrderByExpression,
  SelectType,
} from "kysely";

// ESM namespace import — critical that this is NOT `require("kysely")` even
// in CJS output, because module-realm-aware loaders (vitest's vite-SSR,
// Jest's experimental ESM, dual-pkg setups) can otherwise hand us a different
// kysely instance than the consumer ends up importing — patching one
// prototype wouldn't affect calls reaching the other realm. ESM `import *`
// resolves through the host's module graph, so we always touch the same
// instance the consumer does.
import * as kyselyRuntimeNs from "kysely";
const kyselyRuntime = kyselyRuntimeNs as unknown as Record<string, unknown>;

// Locally re-defined to avoid importing `SqlBool` from kysely — it was only
// added to the public type export surface in 0.27. Keeping a local alias with
// the EXACT same shape (`boolean | 0 | 1`, see kysely/util/type-utils) lets
// us support kysely down to its 0.26 ExpressionBuilder rewrite — the real
// floor for this file's runtime API (callable `eb(...)`, `eb.val(...)`,
// array-form `eb.and([...])` / `eb.or([...])`).
type SqlBool = boolean | 0 | 1;

// ─── Type helpers ─────────────────────────────────────────────────────────────

/**
 * Narrows `keyof DB` (string | number | symbol) to only string keys.
 * All real Kysely table names are strings; required for use in template
 * literals like `${StringTB<TB>}.${C}`.
 */
type StringTB<TB> = Extract<TB, string>;

/**
 * String column names of table TB.
 *
 * Note: when TB is a union (e.g. after a join), `DB[TB]` produces the
 * intersection of the tables' shapes, so `keyof DB[TB]` resolves to only
 * the columns that exist in EVERY joined table. This is a TypeScript
 * limitation, not a bug. For cross-table filtering after joins, prefer
 * qualified `'table.col'` refs or `whereExpressions`.
 */
type StringCol<DB, TB extends keyof DB> = keyof DB[TB] & string;

/** Unwrap `ColumnType<S, I, U>` → S (the SELECT / read type). */
type ColSelectType<
  DB,
  TB extends keyof DB,
  C extends StringCol<DB, TB>
> = SelectType<DB[TB][C]>;

/** Value arg: column's read-type ∪ null ∪ undefined (allows no-op skip). */
type ColValue<DB, TB extends keyof DB, C extends StringCol<DB, TB>> =
  | ColSelectType<DB, TB, C>
  | null
  | undefined;

/** Array arg for IN / NOT IN — NonNullable element type. */
type ColArray<DB, TB extends keyof DB, C extends StringCol<DB, TB>> =
  | ReadonlyArray<NonNullable<ColSelectType<DB, TB, C>>>
  | null
  | undefined;

/** Accepts bare `'col'` OR qualified `'table.col'`. */
type ColRef<DB, TB extends keyof DB, C extends StringCol<DB, TB>> =
  | C
  | `${StringTB<TB>}.${C}`;

// Internal `any` types — used only as the `this` parameter inside shared
// prototype implementations. All three builders implement WhereInterface
// so `.where(...)` is always safe to call on any of them. DB/TB/O are
// type-system constructs with no runtime representation; this `any` is
// fully isolated and never surfaces at call-sites.
type AnyQB = SelectQueryBuilder<any, any, any>;
type AnyUQB = UpdateQueryBuilder<any, any, any, any>;
type AnyDQB = DeleteQueryBuilder<any, any, any>;
type AnyBuilder = AnyQB | AnyUQB | AnyDQB;
type AnyEB = ExpressionBuilder<any, any>;

// ─── Runtime utilities ────────────────────────────────────────────────────────

/**
 * Escape SQL LIKE / ILIKE wildcards so user input is matched literally.
 * `%`, `_`, and `\` are the three characters with special meaning inside
 * a LIKE pattern. Without escaping, searching for `"50_off"` would also
 * match `"50xoff"`, and `"100%"` would match every string starting with `"100"`.
 *
 * Emits a `\` escape character — Kysely + PostgreSQL both honor `\` by default.
 */
function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Coerce a possibly-undefined/null/NaN number to a sane integer with bounds.
 * Used by `paginate` to defend against things like `parseInt(undefined)`
 * reaching the query builder and producing `LIMIT NaN OFFSET NaN`.
 */
function clampInt(
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Centralizes the unavoidable cast for the shared `where(...)` call. */
function addWhere(
  qb: AnyBuilder,
  ...args: readonly unknown[]
): AnyBuilder {
  return (qb as any).where(...args);
}

function failWriteSkip(method: string, reason: string): never {
  throw new Error(
    `kysely-compose: ${method}() would skip the WHERE clause on an ` +
      `UPDATE/DELETE query (${reason}). This would risk affecting all rows. ` +
      `Pass a real value, gate the call with onlyWhen(...), or call .where(...) ` +
      `directly if you genuinely intend to mutate every row.`
  );
}

// ─── Module augmentation ──────────────────────────────────────────────────────
// Must match Kysely's exact signatures — no `& string` narrowing on TB.

declare module "kysely" {
  // ═══════════════════════════════════════════════════════════════════════════
  // SelectQueryBuilder — full API: WHERE + control flow + sort + paginate + join
  // ═══════════════════════════════════════════════════════════════════════════

  interface SelectQueryBuilder<DB, TB extends keyof DB, O> {
    // ── WHERE — Equality ──────────────────────────────────────────────────────

    /**
     * Adds `WHERE col = value` with smart null handling:
     * - `value` is `undefined` → filter is skipped entirely
     * - `value` is `null`      → generates `WHERE col IS NULL`
     * - any other value        → generates `WHERE col = value`
     *
     * Distinguishes "user didn't specify" (`undefined`) from "user
     * specifically wants null-match" (`null`). Pairs naturally with
     * optional DTO fields.
     *
     * @example
     * .equalsIfValue('status', 'active')        // WHERE status = 'active'
     * .equalsIfValue('status', undefined)       // skipped
     * .equalsIfValue('owner_id', null)          // WHERE owner_id IS NULL
     * .equalsIfValue('contacts.org_id', orgId)  // qualified, after a join
     *
     * Note: passing `null` for a NOT NULL column generates an always-false
     * condition. TypeScript allows it (the value type is permissive); be
     * mindful of nullability.
     */
    equalsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Adds `WHERE col != value` with smart null handling:
     * - `value` is `undefined` → filter is skipped entirely
     * - `value` is `null`      → generates `WHERE col IS NOT NULL`
     * - any other value        → generates `WHERE col != value`
     *
     * Mirror of {@link equalsIfValue}.
     */
    notEqualsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    // ── WHERE — String search ─────────────────────────────────────────────────

    /**
     * Adds `WHERE col LIKE '%value%'` — skipped when value is blank, null,
     * or undefined. Whitespace is trimmed before checking. LIKE wildcards
     * (`%`, `_`, `\`) in the input are escaped so they match literally.
     *
     * For case-insensitive search on PostgreSQL, prefer {@link iLikeIfValue}.
     */
    containsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Adds `WHERE col ILIKE '%value%'` — case-insensitive contains (PostgreSQL).
     * Skipped when value is blank, null, or undefined. Wildcards in the
     * input are escaped so they match literally.
     */
    iLikeIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Adds `WHERE col LIKE 'value%'` — prefix / starts-with search.
     * Skipped when value is blank, null, or undefined. Wildcards escaped.
     */
    startsWithIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;

    // ── WHERE — Range / Comparison ────────────────────────────────────────────

    /** `WHERE col >= value` — skipped when value is `null | undefined`. */
    gteIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /** `WHERE col <= value` — skipped when value is `null | undefined`. */
    lteIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /** `WHERE col > value` (strict) — skipped when value is `null | undefined`. */
    gtIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /** `WHERE col < value` (strict) — skipped when value is `null | undefined`. */
    ltIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Bounded range — `WHERE col >= min AND col <= max`. Each side is
     * independently skipped when its value is `null | undefined`.
     *
     * Semantics are BETWEEN-compatible (both bounds inclusive). Open-ended
     * ranges are supported without sprinkling conditionals through your code.
     *
     * @example
     * .whereBetweenIfValue('lead_score', 50, 90)            // >= 50 AND <= 90
     * .whereBetweenIfValue('lead_score', 50, undefined)     // >= 50
     * .whereBetweenIfValue('lead_score', null, 90)          // <= 90
     * .whereBetweenIfValue('lead_score', undefined, undefined)  // skipped
     */
    whereBetweenIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      min: ColValue<DB, TB, C>,
      max: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Generic conditional filter — any comparison operator, skipped when
     * value is `null | undefined`. Use when none of the named helpers
     * (gteIfValue etc.) fit your operator.
     *
     * For NULL checks use {@link isNullWhen} / {@link isNotNullWhen} instead.
     */
    filterIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      op: ComparisonOperatorExpression,
      value: ColValue<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    // ── WHERE — Array / Set ───────────────────────────────────────────────────

    /**
     * `WHERE col IN (values)` — skipped when the array is empty, null, or
     * undefined. Element type is inferred from the column's schema type.
     */
    inIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      values: ColArray<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    /** `WHERE col NOT IN (values)` — skipped when array is empty, null, or undefined. */
    notInIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      values: ColArray<DB, TB, C>
    ): SelectQueryBuilder<DB, TB, O>;

    // ── WHERE — Null checks ───────────────────────────────────────────────────

    /**
     * `WHERE col IS NULL` — applied only when `condition` is truthy.
     * Perfect for "show only unassigned" toggles.
     *
     * @example
     * .isNullWhen('owner_id',   filters.unassignedOnly)
     * .isNullWhen('deleted_at', !filters.includeDeleted)  // soft-delete gate
     */
    isNullWhen<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      condition: boolean | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;

    /** `WHERE col IS NOT NULL` — applied only when `condition` is truthy. */
    isNotNullWhen<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      condition: boolean | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;

    // ── WHERE — Batch from DTO ────────────────────────────────────────────────

    /**
     * Apply multiple equality filters from a DTO object in one call. Per-key
     * semantics mirror {@link equalsIfValue}:
     * - `undefined` value → key is skipped
     * - `null`      value → generates `WHERE key IS NULL`
     * - other value       → generates `WHERE key = value`
     *
     * LIMITATION: on joined queries `TB` becomes a union, and `keyof DB[TB]`
     * resolves to only the columns that exist in EVERY joined table. For
     * cross-table filters after a join, use qualified `.equalsIfValue('table.col', v)`
     * calls or {@link whereExpressions} instead.
     *
     * @example
     * .whereIfValues({
     *   tenant_id: user.tenantId,    // always applied (required)
     *   status:    filters.status,   // skipped if undefined
     *   owner_id:  filters.ownerId,  // null → IS NULL, undefined → skip
     * })
     */
    whereIfValues(filters: {
      [C in StringCol<DB, TB>]?: ColValue<DB, TB, C>;
    }): SelectQueryBuilder<DB, TB, O>;

    // ── WHERE — ExpressionBuilder composition ─────────────────────────────────

    /**
     * Build multiple `eb(...)` conditions and combine them with AND.
     * Falsy entries (`false | null | undefined | 0 | ''`) in the returned
     * array are skipped. On SELECT, an empty list (all falsy) safely
     * resolves to `TRUE`. On UPDATE / DELETE it throws.
     *
     * Go-to method for complex conditional filters — OR groups, cross-column
     * logic, anything needing the full Kysely ExpressionBuilder.
     *
     * @example
     * .whereExpressions(eb => [
     *   filters.search && eb.or([
     *     eb('name',  'ilike', `%${filters.search}%`),
     *     eb('email', 'ilike', `%${filters.search}%`),
     *   ]),
     *   filters.tagIds?.length && eb('tag_id', 'in', filters.tagIds),
     * ])
     */
    whereExpressions(
      build: (
        eb: ExpressionBuilder<DB, TB>
      ) => Array<Expression<SqlBool> | false | null | undefined>
    ): SelectQueryBuilder<DB, TB, O>;

    // ── Control flow ──────────────────────────────────────────────────────────

    /**
     * Apply ANY query transformation when `condition` is truthy — where, join,
     * orderBy, select, limit, or any combination. Accepts `null | undefined`
     * as falsy (unlike Kysely's native `$if` which requires a strict boolean).
     *
     * @example
     * .onlyWhen(!user.isSuperAdmin, qb => qb.where('tenant_id', '=', user.tenantId))
     * .onlyWhen(opts.includeScore,  qb => qb.select('lead_score'))
     */
    onlyWhen(
      condition: boolean | null | undefined,
      apply: (
        qb: SelectQueryBuilder<DB, TB, O>
      ) => SelectQueryBuilder<DB, TB, O>
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Inverse of {@link onlyWhen} — applied when `condition` is falsy.
     * Reads naturally for "restrict unless elevated privilege" patterns.
     *
     * @example
     * .unless(user.isSuperAdmin, qb => qb.where('tenant_id', '=', user.tenantId))
     */
    unless(
      condition: boolean | null | undefined,
      apply: (
        qb: SelectQueryBuilder<DB, TB, O>
      ) => SelectQueryBuilder<DB, TB, O>
    ): SelectQueryBuilder<DB, TB, O>;

    // ── Joins ─────────────────────────────────────────────────────────────────

    /**
     * Apply a join only when `condition` is truthy.
     *
     * Prefer this over Kysely's native `$if` for joins — `$if` produces TS
     * errors when chained after a prior `innerJoin` (kysely-org/kysely#233).
     */
    optionalJoin(
      condition: boolean | null | undefined,
      apply: (
        qb: SelectQueryBuilder<DB, TB, O>
      ) => SelectQueryBuilder<DB, TB, O>
    ): SelectQueryBuilder<DB, TB, O>;

    // ── Sorting ───────────────────────────────────────────────────────────────

    /**
     * `ORDER BY col direction` — skipped when direction is `null | undefined`.
     */
    orderByIfValue(
      column: OrderByExpression<DB, TB, O>,
      direction: "asc" | "desc" | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Pick a named sort strategy by string key from a whitelist map. The
     * raw user string never reaches Kysely — only keys present in `map`
     * are ever applied, so this is safe against column injection. Direction
     * defaults to `'asc'` when null/undefined.
     *
     * @example
     * .orderBySwitch(filters.sortBy, filters.sortDir, {
     *   created_at: (qb, dir) => qb.orderBy('created_at', dir),
     *   lead_score: (qb, dir) => qb.orderBy('lead_score', dir),
     * })
     * .orderBy('id', 'asc')  // stable tiebreaker last
     */
    orderBySwitch(
      key: string | null | undefined,
      direction: "asc" | "desc" | null | undefined,
      map: Record<
        string,
        (
          qb: SelectQueryBuilder<DB, TB, O>,
          dir: "asc" | "desc"
        ) => SelectQueryBuilder<DB, TB, O>
      >
    ): SelectQueryBuilder<DB, TB, O>;

    // ── Pagination ────────────────────────────────────────────────────────────

    /**
     * Adds `LIMIT` + `OFFSET` for page-based pagination.
     *
     * Defaults & bounds (all enforced at runtime — safe against garbage input):
     * - `page`:    defaults to 1,  minimum 1
     * - `perPage`: defaults to 20, minimum 1, capped at `maxPerPage` (default 100)
     * - `null | undefined | NaN | non-finite` values fall back to defaults
     * - Fractional values are truncated (`Math.trunc`)
     *
     * @example
     * .paginate({ page: 1, perPage: 20 })   // LIMIT 20 OFFSET 0
     * .paginate({ page: 3, perPage: 20 })   // LIMIT 20 OFFSET 40
     * .paginate({ page, perPage, maxPerPage: 500 })   // exports
     */
    paginate(opts: {
      page: number | null | undefined;
      perPage: number | null | undefined;
      maxPerPage?: number;
    }): SelectQueryBuilder<DB, TB, O>;

    /**
     * `LIMIT value` — skipped entirely when value is `null | undefined` or
     * not a finite number. Truncates fractional values.
     */
    limitIfValue(
      value: number | null | undefined
    ): SelectQueryBuilder<DB, TB, O>;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UpdateQueryBuilder — WHERE + control-flow helpers only.
  // Runtime behavior mirrors SelectQueryBuilder, EXCEPT helpers that would
  // skip the WHERE clause throw instead — preventing accidental full-table
  // updates. LIMIT / ORDER BY on UPDATE is MySQL-specific so pagination
  // helpers are intentionally absent.
  // ═══════════════════════════════════════════════════════════════════════════

  interface UpdateQueryBuilder<
    DB,
    UT extends keyof DB,
    TB extends keyof DB,
    O
  > {
    /** Same as {@link SelectQueryBuilder.equalsIfValue}, but throws on undefined. */
    equalsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.notEqualsIfValue}, but throws on undefined. */
    notEqualsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.containsIfValue}, but throws on blank. */
    containsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.iLikeIfValue}, but throws on blank. */
    iLikeIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.startsWithIfValue}, but throws on blank. */
    startsWithIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.gteIfValue}, but throws on null/undefined. */
    gteIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.lteIfValue}, but throws on null/undefined. */
    lteIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.gtIfValue}, but throws on null/undefined. */
    gtIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.ltIfValue}, but throws on null/undefined. */
    ltIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.whereBetweenIfValue}, but throws when both bounds are null/undefined. */
    whereBetweenIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      min: ColValue<DB, TB, C>,
      max: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.filterIfValue}, but throws on null/undefined. */
    filterIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      op: ComparisonOperatorExpression,
      value: ColValue<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.inIfValue}, but throws on empty/null/undefined. */
    inIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      values: ColArray<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.notInIfValue}, but throws on empty/null/undefined. */
    notInIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      values: ColArray<DB, TB, C>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.isNullWhen}, but throws on falsy condition. */
    isNullWhen<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      condition: boolean | null | undefined
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.isNotNullWhen}, but throws on falsy condition. */
    isNotNullWhen<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      condition: boolean | null | undefined
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.whereIfValues}, but throws when all values are undefined. */
    whereIfValues(filters: {
      [C in StringCol<DB, TB>]?: ColValue<DB, TB, C>;
    }): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.whereExpressions}, but throws when all expressions are falsy. */
    whereExpressions(
      build: (
        eb: ExpressionBuilder<DB, TB>
      ) => Array<Expression<SqlBool> | false | null | undefined>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.onlyWhen}. */
    onlyWhen(
      condition: boolean | null | undefined,
      apply: (
        qb: UpdateQueryBuilder<DB, UT, TB, O>
      ) => UpdateQueryBuilder<DB, UT, TB, O>
    ): UpdateQueryBuilder<DB, UT, TB, O>;

    /** Same as {@link SelectQueryBuilder.unless}. */
    unless(
      condition: boolean | null | undefined,
      apply: (
        qb: UpdateQueryBuilder<DB, UT, TB, O>
      ) => UpdateQueryBuilder<DB, UT, TB, O>
    ): UpdateQueryBuilder<DB, UT, TB, O>;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DeleteQueryBuilder — WHERE + control-flow helpers only.
  // Runtime semantics identical to UpdateQueryBuilder above (throws on
  // would-be no-op WHERE clauses to prevent full-table deletes).
  // ═══════════════════════════════════════════════════════════════════════════

  interface DeleteQueryBuilder<DB, TB extends keyof DB, O> {
    /** Same as {@link SelectQueryBuilder.equalsIfValue}, but throws on undefined. */
    equalsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.notEqualsIfValue}, but throws on undefined. */
    notEqualsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.containsIfValue}, but throws on blank. */
    containsIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.iLikeIfValue}, but throws on blank. */
    iLikeIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.startsWithIfValue}, but throws on blank. */
    startsWithIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: string | null | undefined
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.gteIfValue}, but throws on null/undefined. */
    gteIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.lteIfValue}, but throws on null/undefined. */
    lteIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.gtIfValue}, but throws on null/undefined. */
    gtIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.ltIfValue}, but throws on null/undefined. */
    ltIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.whereBetweenIfValue}, but throws when both bounds are null/undefined. */
    whereBetweenIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      min: ColValue<DB, TB, C>,
      max: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.filterIfValue}, but throws on null/undefined. */
    filterIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      op: ComparisonOperatorExpression,
      value: ColValue<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.inIfValue}, but throws on empty/null/undefined. */
    inIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      values: ColArray<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.notInIfValue}, but throws on empty/null/undefined. */
    notInIfValue<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      values: ColArray<DB, TB, C>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.isNullWhen}, but throws on falsy condition. */
    isNullWhen<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      condition: boolean | null | undefined
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.isNotNullWhen}, but throws on falsy condition. */
    isNotNullWhen<C extends StringCol<DB, TB>>(
      column: ColRef<DB, TB, C>,
      condition: boolean | null | undefined
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.whereIfValues}, but throws when all values are undefined. */
    whereIfValues(filters: {
      [C in StringCol<DB, TB>]?: ColValue<DB, TB, C>;
    }): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.whereExpressions}, but throws when all expressions are falsy. */
    whereExpressions(
      build: (
        eb: ExpressionBuilder<DB, TB>
      ) => Array<Expression<SqlBool> | false | null | undefined>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.onlyWhen}. */
    onlyWhen(
      condition: boolean | null | undefined,
      apply: (
        qb: DeleteQueryBuilder<DB, TB, O>
      ) => DeleteQueryBuilder<DB, TB, O>
    ): DeleteQueryBuilder<DB, TB, O>;

    /** Same as {@link SelectQueryBuilder.unless}. */
    unless(
      condition: boolean | null | undefined,
      apply: (
        qb: DeleteQueryBuilder<DB, TB, O>
      ) => DeleteQueryBuilder<DB, TB, O>
    ): DeleteQueryBuilder<DB, TB, O>;
  }
}

// ─── Runtime prototype resolution ─────────────────────────────────────────────
//
// Kysely's runtime class layout is uneven across versions:
//   - SelectQueryBuilder is an interface; the concrete class `SelectQueryBuilderImpl`
//     lives in an internal module and is NOT re-exported from the package root
//     (verified on 0.26-0.27). Only the `createSelectQueryBuilder` factory and
//     `SelectQueryNode` are public.
//   - UpdateQueryBuilder / DeleteQueryBuilder ARE exported as runtime classes
//     directly.
//
// To stay robust across versions, each builder uses a 2-tier resolver:
//   1. DIRECT EXPORT — try `${Name}Impl` then `${Name}` from the package root.
//      Cheapest path; works for U/D today and will work for S if Kysely ever
//      starts exporting the impl.
//   2. PROBE — construct a throwaway instance via the public factory or
//      constructor with a minimal stub, then read `Object.getPrototypeOf(it)`.
//      The probe instance is never executed and is GC-eligible immediately.
//
// All probe inputs use only PUBLIC kysely exports (createSelectQueryBuilder,
// SelectQueryNode, UpdateQueryBuilder, UpdateQueryNode, TableNode,
// DeleteQueryBuilder, DeleteQueryNode). No deep imports, no internals.

type ProtoRecord = Record<string, unknown>;
type AnyCtor = { prototype: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProbeFn = () => any;

/** No-op executor stub — the probe instance never executes a query. */
const STUB_EXECUTOR = { transformQuery: <T>(q: T): T => q };
const STUB_QUERY_ID = { queryId: "__kysely-compose-probe__" };

/** Read a public export by name, returning `undefined` if missing. */
function pickExport<T>(name: string): T | undefined {
  return kyselyRuntime[name] as T | undefined;
}

/**
 * Resolve a builder prototype by trying direct exports first, then probing
 * the public constructor/factory. Throws a clear, actionable error if both
 * paths fail (which would only happen on a major Kysely refactor).
 */
function resolveProto(
  builderName: string,
  directExports: readonly string[],
  probe: ProbeFn
): ProtoRecord {
  for (const key of directExports) {
    const ctor = pickExport<AnyCtor>(key);
    if (ctor && typeof ctor === "function" && ctor.prototype) {
      return ctor.prototype as ProtoRecord;
    }
  }

  try {
    const instance = probe();
    const proto = Object.getPrototypeOf(instance) as ProtoRecord | null;
    if (proto && typeof (proto as { where?: unknown }).where === "function") {
      return proto;
    }
  } catch (err) {
    throw new Error(
      `kysely-compose: failed to probe ${builderName} prototype ` +
        `(direct exports [${directExports.join(", ")}] not found, probe threw: ` +
        `${err instanceof Error ? err.message : String(err)}). ` +
        `Your installed Kysely version may be incompatible — please file an issue.`
    );
  }

  throw new Error(
    `kysely-compose: could not resolve runtime prototype for ${builderName}. ` +
      `Tried direct exports [${directExports.join(", ")}] and a constructor probe. ` +
      `Your installed Kysely version may be incompatible — please file an issue.`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodeCreator = (...args: any[]) => unknown;

/** Pull a `.create(...)` factory off a Kysely *Node namespace export. */
function pickNodeCreate(name: string): NodeCreator {
  const ns = pickExport<{ create?: NodeCreator }>(name);
  const create = ns?.create;
  if (typeof create !== "function") {
    throw new Error(`kysely-compose: missing public export "${name}.create"`);
  }
  return create;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FactoryFn = (props: any) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BuilderCtor = new (props: any) => unknown;

/** Build the standard QueryBuilder constructor props using a given query node. */
function buildBuilderProps(queryNode: unknown): Record<string, unknown> {
  return {
    queryId: STUB_QUERY_ID,
    executor: STUB_EXECUTOR,
    queryNode,
  };
}

const selectProto = resolveProto(
  "SelectQueryBuilder",
  ["SelectQueryBuilderImpl", "SelectQueryBuilder"],
  () => {
    const factory = pickExport<FactoryFn>("createSelectQueryBuilder");
    if (typeof factory !== "function") {
      throw new Error('missing public export "createSelectQueryBuilder"');
    }
    const selectNode = pickNodeCreate("SelectQueryNode")();
    return factory(buildBuilderProps(selectNode));
  }
);

const updateProto = resolveProto(
  "UpdateQueryBuilder",
  ["UpdateQueryBuilderImpl", "UpdateQueryBuilder"],
  () => {
    const Ctor = pickExport<BuilderCtor>("UpdateQueryBuilder");
    if (typeof Ctor !== "function") {
      throw new Error('missing public export "UpdateQueryBuilder"');
    }
    const tableNode = pickNodeCreate("TableNode")("__probe__");
    const updateNode = pickNodeCreate("UpdateQueryNode")(tableNode);
    return new Ctor(buildBuilderProps(updateNode));
  }
);

const deleteProto = resolveProto(
  "DeleteQueryBuilder",
  ["DeleteQueryBuilderImpl", "DeleteQueryBuilder"],
  () => {
    const Ctor = pickExport<BuilderCtor>("DeleteQueryBuilder");
    if (typeof Ctor !== "function") {
      throw new Error('missing public export "DeleteQueryBuilder"');
    }
    const tableNode = pickNodeCreate("TableNode")("__probe__");
    const deleteNode = pickNodeCreate("DeleteQueryNode")([tableNode]);
    return new Ctor(buildBuilderProps(deleteNode));
  }
);

// ─── Idempotency guard ────────────────────────────────────────────────────────
// Multiple imports across module realms (jest, bundlers, monorepos) can run
// this file more than once. Re-augmenting is harmless but wasteful and can
// mask method-shadowing bugs — guard with a Symbol marker.

const INSTALLED = Symbol.for("kysely-compose.installed");

interface MarkedProto extends ProtoRecord {
  [INSTALLED]?: true;
}

function isAlreadyInstalled(proto: MarkedProto): boolean {
  return proto[INSTALLED] === true;
}

function markInstalled(proto: MarkedProto): void {
  Object.defineProperty(proto, INSTALLED, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

// ─── Shared helpers factory ───────────────────────────────────────────────────
//
// `strict = true` is used for UPDATE / DELETE — helpers that would otherwise
// produce a no-op WHERE clause throw instead, preventing accidental
// full-table mutations. The branch is decided ONCE at registration time, so
// per-call has zero overhead vs. checking `this.constructor.name` each time.

function createSharedHelpers(strict: boolean): ProtoRecord {
  const skip = (
    method: string,
    reason: string,
    qb: AnyBuilder
  ): AnyBuilder => {
    if (strict) failWriteSkip(method, reason);
    return qb;
  };

  return {
    // ── Equality ──────────────────────────────────────────────────────────────

    equalsIfValue(
      this: AnyBuilder,
      column: string,
      value: unknown
    ): AnyBuilder {
      if (value === undefined)
        return skip("equalsIfValue", "value is undefined", this);
      if (value === null) return addWhere(this, column, "is", null);
      return addWhere(this, column, "=", value);
    },

    notEqualsIfValue(
      this: AnyBuilder,
      column: string,
      value: unknown
    ): AnyBuilder {
      if (value === undefined)
        return skip("notEqualsIfValue", "value is undefined", this);
      if (value === null) return addWhere(this, column, "is not", null);
      return addWhere(this, column, "!=", value);
    },

    // ── String search ──────────────────────────────────────────────────────────

    containsIfValue(
      this: AnyBuilder,
      column: string,
      value: string | null | undefined
    ): AnyBuilder {
      const q = value?.trim();
      if (!q) return skip("containsIfValue", "value is blank/null/undefined", this);
      return addWhere(this, column, "like", `%${escapeLikeValue(q)}%`);
    },

    iLikeIfValue(
      this: AnyBuilder,
      column: string,
      value: string | null | undefined
    ): AnyBuilder {
      const q = value?.trim();
      if (!q) return skip("iLikeIfValue", "value is blank/null/undefined", this);
      return addWhere(this, column, "ilike", `%${escapeLikeValue(q)}%`);
    },

    startsWithIfValue(
      this: AnyBuilder,
      column: string,
      value: string | null | undefined
    ): AnyBuilder {
      const q = value?.trim();
      if (!q) return skip("startsWithIfValue", "value is blank/null/undefined", this);
      return addWhere(this, column, "like", `${escapeLikeValue(q)}%`);
    },

    // ── Range / Comparison ──────────────────────────────────────────────────────

    gteIfValue(this: AnyBuilder, column: string, value: unknown): AnyBuilder {
      if (value == null) return skip("gteIfValue", "value is null/undefined", this);
      return addWhere(this, column, ">=", value);
    },

    lteIfValue(this: AnyBuilder, column: string, value: unknown): AnyBuilder {
      if (value == null) return skip("lteIfValue", "value is null/undefined", this);
      return addWhere(this, column, "<=", value);
    },

    gtIfValue(this: AnyBuilder, column: string, value: unknown): AnyBuilder {
      if (value == null) return skip("gtIfValue", "value is null/undefined", this);
      return addWhere(this, column, ">", value);
    },

    ltIfValue(this: AnyBuilder, column: string, value: unknown): AnyBuilder {
      if (value == null) return skip("ltIfValue", "value is null/undefined", this);
      return addWhere(this, column, "<", value);
    },

    whereBetweenIfValue(
      this: AnyBuilder,
      column: string,
      min: unknown,
      max: unknown
    ): AnyBuilder {
      const hasMin = min != null;
      const hasMax = max != null;
      if (!hasMin && !hasMax)
        return skip("whereBetweenIfValue", "both bounds are null/undefined", this);
      let qb: AnyBuilder = this;
      if (hasMin) qb = addWhere(qb, column, ">=", min);
      if (hasMax) qb = addWhere(qb, column, "<=", max);
      return qb;
    },

    filterIfValue(
      this: AnyBuilder,
      column: string,
      op: ComparisonOperatorExpression,
      value: unknown
    ): AnyBuilder {
      if (value == null) return skip("filterIfValue", "value is null/undefined", this);
      return addWhere(this, column, op, value);
    },

    // ── Array / Set ─────────────────────────────────────────────────────────────

    inIfValue(
      this: AnyBuilder,
      column: string,
      values: readonly unknown[] | null | undefined
    ): AnyBuilder {
      if (!values?.length)
        return skip("inIfValue", "array is empty/null/undefined", this);
      return addWhere(this, column, "in", values);
    },

    notInIfValue(
      this: AnyBuilder,
      column: string,
      values: readonly unknown[] | null | undefined
    ): AnyBuilder {
      if (!values?.length)
        return skip("notInIfValue", "array is empty/null/undefined", this);
      return addWhere(this, column, "not in", values);
    },

    // ── Null checks ─────────────────────────────────────────────────────────────

    isNullWhen(
      this: AnyBuilder,
      column: string,
      condition: boolean | null | undefined
    ): AnyBuilder {
      if (!condition)
        return skip("isNullWhen", "condition is false/null/undefined", this);
      return addWhere(this, column, "is", null);
    },

    isNotNullWhen(
      this: AnyBuilder,
      column: string,
      condition: boolean | null | undefined
    ): AnyBuilder {
      if (!condition)
        return skip("isNotNullWhen", "condition is false/null/undefined", this);
      return addWhere(this, column, "is not", null);
    },

    // ── Batch from DTO ──────────────────────────────────────────────────────────
    // Skip rule mirrors `equalsIfValue`: only `undefined` is treated as
    // "user didn't specify". Explicit `null` produces `IS NULL`.

    whereIfValues(
      this: AnyBuilder,
      filters: Record<string, unknown>
    ): AnyBuilder {
      const entries = Object.entries(filters).filter(
        ([, v]) => v !== undefined
      );
      if (entries.length === 0)
        return skip("whereIfValues", "all filter values are undefined", this);

      let qb: AnyBuilder = this;
      for (const [column, value] of entries) {
        if (value === null) {
          qb = addWhere(qb, column, "is", null);
        } else {
          qb = addWhere(qb, column, "=", value);
        }
      }
      return qb;
    },

    // ── ExpressionBuilder composition ───────────────────────────────────────────
    // For SELECT (lenient): an empty expr list resolves to TRUE so the
    // builder remains a valid query.
    // For UPDATE/DELETE (strict): we throw BEFORE invoking `.where(...)`,
    // because the where callback running with an empty list would otherwise
    // emit `WHERE TRUE` and silently affect every row.

    whereExpressions(
      this: AnyBuilder,
      build: (
        eb: AnyEB
      ) => Array<Expression<SqlBool> | false | null | undefined>
    ): AnyBuilder {
      return addWhere(this, (eb: AnyEB) => {
        const exprs = build(eb).filter((e): e is Expression<SqlBool> =>
          Boolean(e)
        );
        if (exprs.length === 0) {
          if (strict)
            failWriteSkip("whereExpressions", "all expressions are falsy");
          return eb.val(true);
        }
        return eb.and(exprs);
      });
    },

    // ── Control flow ────────────────────────────────────────────────────────────
    // Intentionally NOT subject to the strict-write check — these helpers
    // delegate to a user-supplied `apply` callback that can build any clause,
    // not just WHERE. Skipping `apply` is the documented contract.

    onlyWhen(
      this: AnyBuilder,
      condition: boolean | null | undefined,
      apply: (qb: AnyBuilder) => AnyBuilder
    ): AnyBuilder {
      return condition ? apply(this) : this;
    },

    unless(
      this: AnyBuilder,
      condition: boolean | null | undefined,
      apply: (qb: AnyBuilder) => AnyBuilder
    ): AnyBuilder {
      return condition ? this : apply(this);
    },
  };
}

// ─── Select-only helpers ──────────────────────────────────────────────────────

const selectOnlyHelpers: ProtoRecord = {
  optionalJoin(
    this: AnyQB,
    condition: boolean | null | undefined,
    apply: (qb: AnyQB) => AnyQB
  ): AnyQB {
    return condition ? apply(this) : this;
  },

  orderByIfValue(
    this: AnyQB,
    column: OrderByExpression<any, any, any>,
    direction: "asc" | "desc" | null | undefined
  ): AnyQB {
    if (!direction) return this;
    return this.orderBy(column, direction);
  },

  orderBySwitch(
    this: AnyQB,
    key: string | null | undefined,
    direction: "asc" | "desc" | null | undefined,
    map: Record<string, (qb: AnyQB, dir: "asc" | "desc") => AnyQB>
  ): AnyQB {
    if (!key) return this;
    const handler = map[key];
    if (!handler) return this;
    const dir: "asc" | "desc" = direction === "desc" ? "desc" : "asc";
    return handler(this, dir);
  },

  paginate(
    this: AnyQB,
    opts: {
      page: number | null | undefined;
      perPage: number | null | undefined;
      maxPerPage?: number;
    }
  ): AnyQB {
    const maxPerPage = clampInt(opts.maxPerPage, 100, 1);
    const perPage = clampInt(opts.perPage, 20, 1, maxPerPage);
    const page = clampInt(opts.page, 1, 1);
    return this.limit(perPage).offset((page - 1) * perPage);
  },

  limitIfValue(this: AnyQB, value: number | null | undefined): AnyQB {
    if (value == null || !Number.isFinite(value)) return this;
    return this.limit(Math.trunc(value));
  },
};

// ─── Prototype registration ───────────────────────────────────────────────────

if (!isAlreadyInstalled(selectProto)) {
  Object.assign(selectProto, createSharedHelpers(false), selectOnlyHelpers);
  markInstalled(selectProto);
}

if (!isAlreadyInstalled(updateProto)) {
  Object.assign(updateProto, createSharedHelpers(true));
  markInstalled(updateProto);
}

if (!isAlreadyInstalled(deleteProto)) {
  Object.assign(deleteProto, createSharedHelpers(true));
  markInstalled(deleteProto);
}

export {};
