# kysely-compose

Conditional query helpers for [Kysely](https://kysely.dev) — directly on the builder chain. Works on `SELECT`, `UPDATE`, and `DELETE` queries.

```ts
import "kysely-compose";

const contacts = await db
  .selectFrom("contacts")
  .selectAll()
  .iLikeIfValue("name", filters.search)
  .equalsIfValue("status", filters.status)
  .inIfValue("tag_id", filters.tagIds)
  .whereBetweenIfValue("lead_score", filters.minScore, filters.maxScore)
  .isNullWhen("deleted_at", !filters.includeDeleted)
  .unless(user.isSuperAdmin, (qb) => qb.where("tenant_id", "=", user.tenantId))
  .optionalJoin(!!filters.includeCompany, (qb) =>
    qb
      .leftJoin("companies", "companies.id", "contacts.company_id")
      .select("companies.name as company_name")
  )
  .orderBySwitch(filters.sortBy, {
    newest: (qb) => qb.orderBy("created_at", "desc"),
    name_asc: (qb) => qb.orderBy("name", "asc"),
    lead_score: (qb) => qb.orderBy("lead_score", "desc"),
  })
  .paginate({ page: filters.page, perPage: filters.perPage })
  .execute();
```

## Install

```bash
npm install kysely-compose kysely
```

## Setup

Import **once** at your db entry point — all builders in your app get the methods automatically.

```ts
// src/db.ts
import 'kysely-compose'
import { Kysely, PostgresDialect } from 'kysely'

export const db = new Kysely<Database>({ ... })
```

## API

### Equality

`undefined` skips the filter, `null` becomes an explicit null check — so optional DTO fields can distinguish "any owner" from "unassigned".

```ts
.equalsIfValue('owner_id', filters.ownerId)
// undefined → skipped
// null      → WHERE owner_id IS NULL
// 'abc'     → WHERE owner_id = 'abc'

.notEqualsIfValue('owner_id', filters.ownerId)
// undefined → skipped
// null      → WHERE owner_id IS NOT NULL
// 'abc'     → WHERE owner_id != 'abc'
```

### String search

```ts
.containsIfValue('name', filters.search)      // WHERE name LIKE '%?%'   — skipped if blank
.iLikeIfValue('email', filters.search)        // WHERE email ILIKE '%?%' — case-insensitive (pg)
.startsWithIfValue('username', filters.query) // WHERE username LIKE '?%'
```

LIKE wildcards (`%`, `_`, `\`) in user input are escaped so they match literally.

### Range

```ts
.gteIfValue('lead_score', filters.min)        // WHERE lead_score >= ?
.lteIfValue('lead_score', filters.max)        // WHERE lead_score <= ?
.gtIfValue('reply_count', filters.min)        // WHERE reply_count > ?
.ltIfValue('created_at', filters.before)      // WHERE created_at < ?

// Inclusive range — each bound independently skipped if null/undefined
.whereBetweenIfValue('score', filters.min, filters.max)

.filterIfValue('score', '>=', filters.min)    // any operator
```

All range helpers skip on `null` or `undefined` (null comparison isn't meaningful). Use `isNullWhen` / `isNotNullWhen` for explicit null checks.

### Arrays

```ts
.inIfValue('status', filters.statuses)        // WHERE status IN (...)     — skipped if empty
.notInIfValue('id', excludedIds)              // WHERE id NOT IN (...)     — skipped if empty
```

### Null checks

```ts
.isNullWhen('deleted_at', !filters.includeDeleted)   // WHERE deleted_at IS NULL
.isNotNullWhen('verified_at', filters.onlyVerified)  // WHERE verified_at IS NOT NULL
```

### Batch from DTO

Per-key semantics mirror `equalsIfValue`.

```ts
.whereIfValues({
  tenant_id: user.tenantId,     // always applied
  status:    filters.status,    // undefined → skip
  owner_id:  filters.ownerId,   // null → IS NULL, undefined → skip
})
```

### Complex expressions

Falsy entries in the returned array are skipped.

```ts
.whereExpressions(eb => [
  filters.search && eb.or([
    eb('name',  'ilike', `%${filters.search}%`),
    eb('email', 'ilike', `%${filters.search}%`),
  ]),
  filters.tagIds?.length && eb('tag_id', 'in', filters.tagIds),
])
```

### Control flow

```ts
.onlyWhen(user.isManager, qb =>             // applied when truthy
  qb.where('team_id', '=', user.teamId)
)
.unless(user.isSuperAdmin, qb =>            // applied when falsy
  qb.where('tenant_id', '=', user.tenantId)
)
.optionalJoin(!!filters.includeCompany, qb =>
  qb.leftJoin('companies', 'companies.id', 'contacts.company_id')
    .select('companies.name as company_name')
)
```

### Sorting

```ts
.orderByIfValue('created_at', filters.sortDir)   // skipped if null/undefined

// Whitelist-based — prevents SQL injection from user input
.orderBySwitch(filters.sortBy, {
  newest:   qb => qb.orderBy('created_at', 'desc'),
  name_asc: qb => qb.orderBy('name', 'asc'),
})
```

### Pagination

```ts
.paginate({ page: filters.page, perPage: filters.perPage })
// defaults: page=1, perPage=20, max=100
// NaN, negative, and out-of-bounds values are safely clamped

.paginate({ page: 2, perPage: 50, maxPerPage: 500 })
.limitIfValue(opts.isExport ? null : 100)
```

## Scope

| Helpers                                                               | SELECT | UPDATE | DELETE |
| --------------------------------------------------------------------- | :----: | :----: | :----: |
| WHERE (`*IfValue`, `isNullWhen`, `whereIfValues`, `whereExpressions`) |   ✓    |   ✓    |   ✓    |
| Control flow (`onlyWhen`, `unless`)                                   |   ✓    |   ✓    |   ✓    |
| Joins (`optionalJoin`)                                                |   ✓    |   —    |   —    |
| Sorting (`orderByIfValue`, `orderBySwitch`)                           |   ✓    |   —    |   —    |
| Pagination (`paginate`, `limitIfValue`)                               |   ✓    |   —    |   —    |

## Type safety

Value types are inferred directly from your Kysely schema:

```ts
// interface ContactTable { status: 'active' | 'inactive' | 'lead' }

.equalsIfValue('status', 'active')   // ✅
.equalsIfValue('status', 'wrong')    // ❌ TS error
.inIfValue('status', ['active'])     // ✅
.inIfValue('status', ['wrong'])      // ❌ TS error
```

## License

MIT
