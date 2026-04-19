/**
 * SQL-generation tests for SELECT helpers. Each test compiles a query with
 * the helper applied to a representative input and asserts both SQL and
 * parameters. Skipped/no-op cases are also asserted to confirm the helper
 * doesn't add unexpected fragments.
 */

import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { db } from "./_helpers.js";

function compile(qb: { compile: () => { sql: string; parameters: readonly unknown[] } }) {
  return qb.compile();
}

describe("equality helpers", () => {
  it("equalsIfValue with a value emits =", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().equalsIfValue("status", "active")
    );
    expect(c.sql).toBe(`select * from "contacts" where "status" = $1`);
    expect(c.parameters).toEqual(["active"]);
  });

  it("equalsIfValue with null emits IS NULL", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().equalsIfValue("owner_id", null)
    );
    expect(c.sql).toBe(`select * from "contacts" where "owner_id" is null`);
    expect(c.parameters).toEqual([]);
  });

  it("equalsIfValue with undefined is a no-op", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().equalsIfValue("status", undefined)
    );
    expect(c.sql).toBe(`select * from "contacts"`);
    expect(c.parameters).toEqual([]);
  });

  it("equalsIfValue accepts qualified table.col references", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().equalsIfValue("contacts.org_id", "org-1")
    );
    expect(c.sql).toBe(`select * from "contacts" where "contacts"."org_id" = $1`);
    expect(c.parameters).toEqual(["org-1"]);
  });

  it("notEqualsIfValue distinguishes null / undefined / value", () => {
    expect(
      compile(
        db.selectFrom("contacts").selectAll().notEqualsIfValue("status", "lead")
      ).sql
    ).toBe(`select * from "contacts" where "status" != $1`);

    expect(
      compile(
        db.selectFrom("contacts").selectAll().notEqualsIfValue("owner_id", null)
      ).sql
    ).toBe(`select * from "contacts" where "owner_id" is not null`);

    expect(
      compile(
        db.selectFrom("contacts").selectAll().notEqualsIfValue("status", undefined)
      ).sql
    ).toBe(`select * from "contacts"`);
  });
});

describe("string-search helpers", () => {
  it("containsIfValue wraps with %...%", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().containsIfValue("name", "Alice")
    );
    expect(c.sql).toBe(`select * from "contacts" where "name" like $1`);
    expect(c.parameters).toEqual(["%Alice%"]);
  });

  it("iLikeIfValue uses ilike and escapes wildcards", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().iLikeIfValue("name", "50%_off\\")
    );
    expect(c.sql).toBe(`select * from "contacts" where "name" ilike $1`);
    expect(c.parameters).toEqual(["%50\\%\\_off\\\\%"]);
  });

  it("startsWithIfValue uses prefix match", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().startsWithIfValue("name", "Al")
    );
    expect(c.sql).toBe(`select * from "contacts" where "name" like $1`);
    expect(c.parameters).toEqual(["Al%"]);
  });

  it("string helpers skip blank / whitespace / null / undefined", () => {
    for (const v of ["", "   ", null, undefined] as const) {
      expect(
        compile(db.selectFrom("contacts").selectAll().containsIfValue("name", v))
          .sql
      ).toBe(`select * from "contacts"`);
      expect(
        compile(db.selectFrom("contacts").selectAll().iLikeIfValue("name", v))
          .sql
      ).toBe(`select * from "contacts"`);
      expect(
        compile(
          db.selectFrom("contacts").selectAll().startsWithIfValue("name", v)
        ).sql
      ).toBe(`select * from "contacts"`);
    }
  });
});

describe("range / comparison helpers", () => {
  it.each([
    ["gteIfValue", ">="],
    ["lteIfValue", "<="],
    ["gtIfValue", ">"],
    ["ltIfValue", "<"],
  ] as const)("%s emits %s", (method, op) => {
    const c = compile(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.selectFrom("contacts").selectAll() as any)[method]("lead_score", 50)
    );
    expect(c.sql).toBe(`select * from "contacts" where "lead_score" ${op} $1`);
    expect(c.parameters).toEqual([50]);
  });

  it.each(["gteIfValue", "lteIfValue", "gtIfValue", "ltIfValue"] as const)(
    "%s skips on null/undefined",
    (method) => {
      for (const v of [null, undefined] as const) {
        const c = compile(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (db.selectFrom("contacts").selectAll() as any)[method]("lead_score", v)
        );
        expect(c.sql).toBe(`select * from "contacts"`);
      }
    }
  );

  it("whereBetweenIfValue applies both bounds when given", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll()
        .whereBetweenIfValue("lead_score", 50, 90)
    );
    expect(c.sql).toBe(
      `select * from "contacts" where "lead_score" >= $1 and "lead_score" <= $2`
    );
    expect(c.parameters).toEqual([50, 90]);
  });

  it("whereBetweenIfValue applies only the bound that's set", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .whereBetweenIfValue("lead_score", 50, undefined)
      ).sql
    ).toBe(`select * from "contacts" where "lead_score" >= $1`);

    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .whereBetweenIfValue("lead_score", null, 90)
      ).sql
    ).toBe(`select * from "contacts" where "lead_score" <= $1`);
  });

  it("whereBetweenIfValue skips entirely when both are null/undefined", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .whereBetweenIfValue("lead_score", null, undefined)
      ).sql
    ).toBe(`select * from "contacts"`);
  });

  it("filterIfValue forwards the operator", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll()
        .filterIfValue("lead_score", "<>", 0)
    );
    expect(c.sql).toBe(`select * from "contacts" where "lead_score" <> $1`);
    expect(c.parameters).toEqual([0]);
  });

  it("filterIfValue skips on null/undefined", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .filterIfValue("lead_score", ">=", undefined)
      ).sql
    ).toBe(`select * from "contacts"`);
  });
});

describe("array helpers", () => {
  it("inIfValue emits IN (...)", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll()
        .inIfValue("status", ["active", "lead"])
    );
    expect(c.sql).toBe(`select * from "contacts" where "status" in ($1, $2)`);
    expect(c.parameters).toEqual(["active", "lead"]);
  });

  it("inIfValue skips empty/null/undefined", () => {
    for (const v of [[], null, undefined] as const) {
      expect(
        compile(db.selectFrom("contacts").selectAll().inIfValue("status", v)).sql
      ).toBe(`select * from "contacts"`);
    }
  });

  it("notInIfValue emits NOT IN (...)", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().notInIfValue("status", ["inactive"])
    );
    expect(c.sql).toBe(`select * from "contacts" where "status" not in ($1)`);
    expect(c.parameters).toEqual(["inactive"]);
  });
});

describe("null-check helpers", () => {
  it("isNullWhen applies when condition is truthy", () => {
    expect(
      compile(
        db.selectFrom("contacts").selectAll().isNullWhen("owner_id", true)
      ).sql
    ).toBe(`select * from "contacts" where "owner_id" is null`);
  });

  it("isNullWhen skips when condition is falsy", () => {
    for (const v of [false, null, undefined] as const) {
      expect(
        compile(
          db.selectFrom("contacts").selectAll().isNullWhen("owner_id", v)
        ).sql
      ).toBe(`select * from "contacts"`);
    }
  });

  it("isNotNullWhen applies when condition is truthy", () => {
    expect(
      compile(
        db.selectFrom("contacts").selectAll().isNotNullWhen("deleted_at", true)
      ).sql
    ).toBe(`select * from "contacts" where "deleted_at" is not null`);
  });
});

describe("whereIfValues (DTO batch)", () => {
  it("applies multiple equality filters in one call", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().whereIfValues({
        status: "active",
        owner_id: null,
        org_id: "org-1",
      })
    );
    expect(c.sql).toBe(
      `select * from "contacts" where "status" = $1 and "owner_id" is null and "org_id" = $2`
    );
    expect(c.parameters).toEqual(["active", "org-1"]);
  });

  it("skips undefined keys, applies null as IS NULL", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().whereIfValues({
        status: undefined,
        owner_id: null,
      })
    );
    expect(c.sql).toBe(`select * from "contacts" where "owner_id" is null`);
  });

  it("is a no-op on SELECT when every value is undefined", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .whereIfValues({ status: undefined, owner_id: undefined })
      ).sql
    ).toBe(`select * from "contacts"`);
  });
});

describe("whereExpressions", () => {
  it("ANDs multiple expressions and skips falsy entries", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().whereExpressions((eb) => [
        eb("status", "=", "active"),
        false,
        null,
        undefined,
        eb("lead_score", ">=", 50),
      ])
    );
    expect(c.sql).toBe(
      `select * from "contacts" where ("status" = $1 and "lead_score" >= $2)`
    );
    expect(c.parameters).toEqual(["active", 50]);
  });

  it("supports OR groups via eb.or", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().whereExpressions((eb) => [
        eb.or([eb("status", "=", "active"), eb("status", "=", "lead")]),
      ])
    );
    expect(c.sql).toBe(
      `select * from "contacts" where ("status" = $1 or "status" = $2)`
    );
    expect(c.parameters).toEqual(["active", "lead"]);
  });

  it("resolves to TRUE on SELECT when all expressions are falsy", () => {
    // `eb.val(true)` parameterizes the literal — driver receives `true` as
    // a bound parameter rather than emitting `WHERE TRUE` as raw SQL. Both
    // are semantically equivalent; the parameterized form is what kysely
    // produces and what the test asserts.
    const c = compile(
      db.selectFrom("contacts").selectAll().whereExpressions(() => [
        false,
        null,
        undefined,
      ])
    );
    expect(c.sql).toBe(`select * from "contacts" where $1`);
    expect(c.parameters).toEqual([true]);
  });
});

describe("control flow", () => {
  it("onlyWhen applies only when truthy", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .onlyWhen(true, (qb) => qb.where("status", "=", "active"))
      ).sql
    ).toBe(`select * from "contacts" where "status" = $1`);

    for (const v of [false, null, undefined] as const) {
      expect(
        compile(
          db
            .selectFrom("contacts")
            .selectAll()
            .onlyWhen(v, (qb) => qb.where("status", "=", "active"))
        ).sql
      ).toBe(`select * from "contacts"`);
    }
  });

  it("unless inverts onlyWhen", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .unless(false, (qb) => qb.where("status", "=", "active"))
      ).sql
    ).toBe(`select * from "contacts" where "status" = $1`);

    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll()
          .unless(true, (qb) => qb.where("status", "=", "active"))
      ).sql
    ).toBe(`select * from "contacts"`);
  });
});

describe("optionalJoin", () => {
  it("applies the join when condition is truthy", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll("contacts")
        .optionalJoin(true, (qb) =>
          qb.innerJoin("owners", "owners.id", "contacts.owner_id")
        )
    );
    expect(c.sql).toBe(
      `select "contacts".* from "contacts" inner join "owners" on "owners"."id" = "contacts"."owner_id"`
    );
  });

  it("skips the join when condition is falsy", () => {
    expect(
      compile(
        db
          .selectFrom("contacts")
          .selectAll("contacts")
          .optionalJoin(false, (qb) =>
            qb.innerJoin("owners", "owners.id", "contacts.owner_id")
          )
      ).sql
    ).toBe(`select "contacts".* from "contacts"`);
  });
});

describe("ordering", () => {
  it("orderByIfValue applies direction", () => {
    expect(
      compile(
        db.selectFrom("contacts").selectAll().orderByIfValue("created_at", "desc")
      ).sql
    ).toBe(`select * from "contacts" order by "created_at" desc`);
  });

  it("orderByIfValue skips null/undefined", () => {
    expect(
      compile(
        db.selectFrom("contacts").selectAll().orderByIfValue("created_at", null)
      ).sql
    ).toBe(`select * from "contacts"`);
  });

  it("orderBySwitch picks from a whitelist map", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = {
      score: (qb: any, dir: "asc" | "desc") => qb.orderBy("lead_score", dir),
      created: (qb: any, dir: "asc" | "desc") => qb.orderBy("created_at", dir),
    };

    expect(
      compile(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db.selectFrom("contacts").selectAll() as any).orderBySwitch(
          "score",
          "desc",
          map
        )
      ).sql
    ).toBe(`select * from "contacts" order by "lead_score" desc`);
  });

  it("orderBySwitch ignores unknown keys (injection guard)", () => {
    expect(
      compile(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db.selectFrom("contacts").selectAll() as any).orderBySwitch(
          "DROP TABLE; --",
          "asc",
          { score: () => null }
        )
      ).sql
    ).toBe(`select * from "contacts"`);
  });

  it("orderBySwitch defaults to 'asc' when direction missing", () => {
    let observedDir: string | undefined;
    compile(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.selectFrom("contacts").selectAll() as any).orderBySwitch(
        "score",
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          score: (qb: any, dir: string) => {
            observedDir = dir;
            return qb;
          },
        }
      )
    );
    expect(observedDir).toBe("asc");
  });
});

describe("pagination", () => {
  it("paginate emits LIMIT and OFFSET correctly", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().paginate({ page: 3, perPage: 20 })
    );
    expect(c.sql).toBe(`select * from "contacts" limit $1 offset $2`);
    expect(c.parameters).toEqual([20, 40]);
  });

  it("paginate falls back to defaults for null/undefined/NaN", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll()
        .paginate({ page: NaN, perPage: undefined })
    );
    expect(c.parameters).toEqual([20, 0]); // perPage=20, offset=0
  });

  it("paginate caps perPage at maxPerPage", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll()
        .paginate({ page: 1, perPage: 9999, maxPerPage: 100 })
    );
    expect(c.parameters).toEqual([100, 0]);
  });

  it("paginate clamps negative page to 1", () => {
    const c = compile(
      db.selectFrom("contacts").selectAll().paginate({ page: -5, perPage: 10 })
    );
    expect(c.parameters).toEqual([10, 0]);
  });

  it("limitIfValue applies LIMIT when set", () => {
    expect(
      compile(db.selectFrom("contacts").selectAll().limitIfValue(50)).sql
    ).toBe(`select * from "contacts" limit $1`);
  });

  it("limitIfValue skips on null/undefined/non-finite", () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity] as const) {
      expect(
        compile(db.selectFrom("contacts").selectAll().limitIfValue(v)).sql
      ).toBe(`select * from "contacts"`);
    }
  });
});

describe("composability", () => {
  it("all helpers chain together correctly", () => {
    const c = compile(
      db
        .selectFrom("contacts")
        .selectAll("contacts")
        .equalsIfValue("status", "active")
        .equalsIfValue("owner_id", null)
        .equalsIfValue("contacts.org_id", "org-1")
        .inIfValue("status", ["active", "lead"])
        .iLikeIfValue("name", "ali")
        .whereBetweenIfValue("lead_score", 50, 90)
        .isNotNullWhen("deleted_at", false)
        .whereExpressions((eb) => [eb("email", "like", "%@acme.com")])
        .onlyWhen(true, (qb) => qb.where(sql<boolean>`1 = 1`))
        .orderByIfValue("created_at", "desc")
        .paginate({ page: 1, perPage: 25 })
    );
    expect(c.sql).toContain(`from "contacts"`);
    expect(c.sql).toContain(`"status" = $`);
    expect(c.sql).toContain(`"owner_id" is null`);
    expect(c.sql).toContain(`"status" in ($`);
    expect(c.sql).toContain(`"name" ilike $`);
    expect(c.sql).toContain(`"lead_score" >= $`);
    expect(c.sql).toContain(`"lead_score" <= $`);
    expect(c.sql).toContain(`"email" like $`);
    expect(c.sql).toContain(`order by "created_at" desc`);
    expect(c.sql).toContain(`limit $`);
    expect(c.sql).toContain(`offset $`);
  });
});
