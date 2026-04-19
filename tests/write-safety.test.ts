/**
 * Write-safety tests. Every helper that would silently produce a no-op
 * WHERE clause MUST throw on UPDATE / DELETE — preventing accidental
 * full-table mutations. The same call on SELECT must pass through silently.
 */

import { describe, it, expect } from "vitest";
import { db } from "./_helpers.js";

const ERR = /kysely-compose:.*UPDATE\/DELETE/;

describe("write-safety: throws on UPDATE when WHERE would be empty", () => {
  function update() {
    return db.updateTable("contacts").set({ status: "inactive" });
  }

  it("equalsIfValue(undefined) throws", () => {
    expect(() => update().equalsIfValue("id", undefined).compile()).toThrow(
      ERR
    );
  });

  it("notEqualsIfValue(undefined) throws", () => {
    expect(() =>
      update().notEqualsIfValue("status", undefined).compile()
    ).toThrow(ERR);
  });

  it.each(["containsIfValue", "iLikeIfValue", "startsWithIfValue"] as const)(
    "%s with blank/null/undefined throws",
    (method) => {
      for (const v of ["", "  ", null, undefined] as const) {
        expect(() =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (update() as any)[method]("name", v).compile()
        ).toThrow(ERR);
      }
    }
  );

  it.each([
    "gteIfValue",
    "lteIfValue",
    "gtIfValue",
    "ltIfValue",
    "filterIfValue",
  ] as const)("%s with null/undefined throws", (method) => {
    for (const v of [null, undefined] as const) {
      const upd = update();
      expect(() => {
        if (method === "filterIfValue") {
          upd.filterIfValue("lead_score", ">=", v).compile();
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (upd as any)[method]("lead_score", v).compile();
        }
      }).toThrow(ERR);
    }
  });

  it("whereBetweenIfValue with both bounds null/undefined throws", () => {
    expect(() =>
      update().whereBetweenIfValue("lead_score", null, undefined).compile()
    ).toThrow(ERR);
  });

  it("inIfValue / notInIfValue with empty/null/undefined throws", () => {
    for (const v of [[], null, undefined] as const) {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update().inIfValue("status", v as any).compile()
      ).toThrow(ERR);
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update().notInIfValue("status", v as any).compile()
      ).toThrow(ERR);
    }
  });

  it("isNullWhen / isNotNullWhen with falsy condition throws", () => {
    for (const v of [false, null, undefined] as const) {
      expect(() => update().isNullWhen("owner_id", v).compile()).toThrow(ERR);
      expect(() => update().isNotNullWhen("owner_id", v).compile()).toThrow(
        ERR
      );
    }
  });

  it("whereIfValues with all-undefined throws", () => {
    expect(() =>
      update().whereIfValues({ status: undefined, owner_id: undefined }).compile()
    ).toThrow(ERR);
  });

  it("whereExpressions with all falsy throws", () => {
    expect(() =>
      update()
        .whereExpressions(() => [false, null, undefined])
        .compile()
    ).toThrow(ERR);
  });

  it("does NOT throw when at least one condition is real", () => {
    expect(() =>
      update().equalsIfValue("id", "u-1").compile()
    ).not.toThrow();
    expect(() =>
      update().whereIfValues({ status: undefined, owner_id: "owner-1" }).compile()
    ).not.toThrow();
  });
});

describe("write-safety: throws on DELETE when WHERE would be empty", () => {
  function del() {
    return db.deleteFrom("contacts");
  }

  it("equalsIfValue(undefined) throws", () => {
    expect(() => del().equalsIfValue("id", undefined).compile()).toThrow(ERR);
  });

  it("inIfValue([]) throws", () => {
    expect(() => del().inIfValue("status", []).compile()).toThrow(ERR);
  });

  it("whereExpressions with all falsy throws", () => {
    expect(() =>
      del()
        .whereExpressions(() => [null, undefined, false])
        .compile()
    ).toThrow(ERR);
  });

  it("compiles a real DELETE when at least one condition is set", () => {
    const c = del().equalsIfValue("id", "c-1").compile();
    expect(c.sql).toBe(`delete from "contacts" where "id" = $1`);
    expect(c.parameters).toEqual(["c-1"]);
  });
});

describe("write-safety: SELECT does NOT throw in the same scenarios", () => {
  function sel() {
    return db.selectFrom("contacts").selectAll();
  }

  it("equalsIfValue(undefined) is a silent no-op on SELECT", () => {
    expect(() => sel().equalsIfValue("id", undefined).compile()).not.toThrow();
  });

  it("inIfValue([]) is a silent no-op on SELECT", () => {
    expect(() => sel().inIfValue("status", []).compile()).not.toThrow();
  });

  it("whereExpressions all-falsy resolves to TRUE on SELECT", () => {
    expect(() =>
      sel()
        .whereExpressions(() => [false, null, undefined])
        .compile()
    ).not.toThrow();
  });

  it("whereIfValues all-undefined is a silent no-op on SELECT", () => {
    expect(() =>
      sel()
        .whereIfValues({ status: undefined, owner_id: undefined })
        .compile()
    ).not.toThrow();
  });
});

describe("control-flow helpers are NOT subject to write-safety", () => {
  it("onlyWhen(false) on UPDATE is a no-op (does NOT throw)", () => {
    expect(() =>
      db
        .updateTable("contacts")
        .set({ status: "inactive" })
        .equalsIfValue("id", "u-1")
        .onlyWhen(false, (qb) => qb.where("status", "=", "active"))
        .compile()
    ).not.toThrow();
  });

  it("unless(true) on DELETE is a no-op (does NOT throw)", () => {
    expect(() =>
      db
        .deleteFrom("contacts")
        .equalsIfValue("id", "c-1")
        .unless(true, (qb) => qb.where("status", "=", "lead"))
        .compile()
    ).not.toThrow();
  });
});
