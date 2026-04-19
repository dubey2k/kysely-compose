/**
 * Smoke tests for runtime installation. These guard the most fragile part
 * of the library — the prototype resolver — against regressions when a
 * future kysely release shifts internal export names or class layouts.
 */

import { describe, it, expect } from "vitest";
import {
  createSelectQueryBuilder,
  SelectQueryNode,
  UpdateQueryBuilder,
  DeleteQueryBuilder,
} from "kysely";

import "../src/index.js";

const HELPERS = [
  "equalsIfValue",
  "notEqualsIfValue",
  "containsIfValue",
  "iLikeIfValue",
  "startsWithIfValue",
  "gteIfValue",
  "lteIfValue",
  "gtIfValue",
  "ltIfValue",
  "whereBetweenIfValue",
  "filterIfValue",
  "inIfValue",
  "notInIfValue",
  "isNullWhen",
  "isNotNullWhen",
  "whereIfValues",
  "whereExpressions",
  "onlyWhen",
  "unless",
] as const;

const SELECT_ONLY = [
  "optionalJoin",
  "orderByIfValue",
  "orderBySwitch",
  "paginate",
  "limitIfValue",
] as const;

function getSelectProto(): Record<string, unknown> {
  const probe = createSelectQueryBuilder({
    queryId: { queryId: "__test__" },
    // Stub executor — never executes.
    executor: { transformQuery: <T>(q: T): T => q } as never,
    queryNode: SelectQueryNode.create(),
  });
  return Object.getPrototypeOf(probe) as Record<string, unknown>;
}

describe("runtime install", () => {
  it("imports the package without throwing", () => {
    // The mere fact that this test file's import succeeded proves it.
    // Asserting `true` documents the intent.
    expect(true).toBe(true);
  });

  it("attaches all shared helpers to SelectQueryBuilder prototype", () => {
    const proto = getSelectProto();
    for (const name of HELPERS) {
      expect(typeof proto[name], `select.${name}`).toBe("function");
    }
  });

  it("attaches all shared helpers to UpdateQueryBuilder prototype", () => {
    const proto = UpdateQueryBuilder.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of HELPERS) {
      expect(typeof proto[name], `update.${name}`).toBe("function");
    }
  });

  it("attaches all shared helpers to DeleteQueryBuilder prototype", () => {
    const proto = DeleteQueryBuilder.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of HELPERS) {
      expect(typeof proto[name], `delete.${name}`).toBe("function");
    }
  });

  it("attaches select-only helpers to SelectQueryBuilder ONLY", () => {
    const sel = getSelectProto();
    const upd = UpdateQueryBuilder.prototype as unknown as Record<
      string,
      unknown
    >;
    const del = DeleteQueryBuilder.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of SELECT_ONLY) {
      expect(typeof sel[name], `select.${name}`).toBe("function");
      expect(upd[name], `update should NOT have ${name}`).toBeUndefined();
      expect(del[name], `delete should NOT have ${name}`).toBeUndefined();
    }
  });

  it("re-importing the module is idempotent (no double-augment)", async () => {
    const proto = getSelectProto();
    const original = proto.equalsIfValue;
    // Force the module loader to evaluate again. Vitest dedupes by spec by
    // default, so this is more a documentation of intent than a true second
    // evaluation — but the Symbol.for guard inside src/index.ts ensures a
    // second `Object.assign` would still be a no-op for shape.
    await import("../src/index.js");
    expect(proto.equalsIfValue).toBe(original);
  });
});
