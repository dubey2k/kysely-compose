/**
 * Shared test fixtures: a Kysely instance wired to a no-op driver +
 * Postgres compiler. We never execute queries — every test only inspects
 * the compiled SQL + parameters via `qb.compile()`.
 */

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type ColumnType,
  type Dialect,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";

// IMPORTANT: side-effect import installs the prototype helpers. Test files
// import from this helper, which guarantees a single canonical install path.
import "../src/index.js";

// ─── Sample schema ───────────────────────────────────────────────────────────

export interface ContactsTable {
  id: string;
  name: string;
  email: string;
  status: "active" | "inactive" | "lead";
  owner_id: string | null;
  lead_score: number | null;
  org_id: string;
  created_at: ColumnType<Date, string | Date, never>;
  deleted_at: Date | null;
}

export interface OwnersTable {
  id: string;
  name: string;
  org_id: string;
}

export interface DB {
  contacts: ContactsTable;
  owners: OwnersTable;
}

// ─── Stub driver — never actually executes ────────────────────────────────────

const noConn: DatabaseConnection = {
  executeQuery: <R>(): Promise<QueryResult<R>> =>
    Promise.resolve({ rows: [] as R[] }),
  // eslint-disable-next-line @typescript-eslint/require-await
  streamQuery: async function* () {
    /* empty */
  },
};

const stubDriver: Driver = {
  init: () => Promise.resolve(),
  acquireConnection: () => Promise.resolve(noConn),
  releaseConnection: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
  beginTransaction: () => Promise.resolve(),
  commitTransaction: () => Promise.resolve(),
  rollbackTransaction: () => Promise.resolve(),
};

const stubDialect: Dialect = {
  createDriver: () => stubDriver,
  createAdapter: () => new PostgresAdapter(),
  createQueryCompiler: () => new PostgresQueryCompiler(),
  createIntrospector: (db) => new PostgresIntrospector(db),
};

export const db = new Kysely<DB>({ dialect: stubDialect });
