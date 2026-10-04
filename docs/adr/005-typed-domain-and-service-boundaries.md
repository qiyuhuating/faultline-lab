# ADR 005 — Typed domain and explicit service boundaries

Date: 2026-10-04. Status: accepted for v1.1.0.

## Problem

The 24,679-byte Queue owned transactions, SQL persistence, job policy, leases, experiment orchestration, event chaining, read models and retention. Its reliable behavior was difficult to change independently, and JavaScript could not reject inconsistent state combinations before execution.

## Decision

Keep Queue as a 151-line / 5,125-byte composition and compatibility facade. Use one SqliteStore per connection. A persistence-only JobRepository handles job/attempt/receipt SQL; JobService and LeaseService own policy. Dedicated services own requests, experiment orchestration, event chaining, worker metadata, read models and retention. They share the same store rather than opening additional connections or committing substeps.

`BEGIN IMMEDIATE` remains the outer write boundary. Claim, attempt and event commit together. Receipt, success, attempt and event commit together. Duplicate experiment submission uses the same durable idempotency primitive inside its outer transaction. Read services reuse an already active transaction, preserving standalone details and nested report consistency. Native SQLite errors retain their original identity if SQLite has already rolled back. Lease clocks are sampled after acquiring the writer lock.

The backend uses TypeScript 5.9.3 with strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noUnusedLocals/Parameters, erasableSyntaxOnly and verbatimModuleSyntax. Job is a discriminated union: running requires owner/deadline; succeeded requires completion time/result; pending and unsuccessful terminal states cannot hold a lease/result. Commit and failure outcomes narrow on accepted. Transition commands separate cancel from replay options. Unknown HTTP JSON is runtime-validated before it reaches typed contracts.

SQL row assertions are confined to SqliteStore's v1 schema boundary. Job serialization additionally verifies lifecycle combinations; TypeScript does not validate existing databases or JSON. The browser's existing pure proof implementation has a typed declaration consumed by the backend and remains the single runtime implementation.

Node 24.15+ runs erasable TypeScript natively. This is execution, not type checking. CI separately installs locked development tools and runs the compiler, 12 negative compile contracts, formatting and the architecture gate. Existing `.mjs` entry points delegate to the sole typed implementation; no second engine or emitted JavaScript copy is maintained. There are still zero runtime package dependencies.

## Enforced boundaries

The compiler AST gate rejects storage→service, domain→infrastructure and service→entry-point imports, runtime cycles, explicit any, source-level type suppression, SQL in Queue and transaction-control strings outside SqliteStore. Queue has an 8 KB responsibility budget. These gates enforce current boundaries; they do not prove arbitrary SQL statements correct or replace behavioral concurrency tests.

## Acceptance and tradeoffs

All existing 61 fault tests run against the extracted implementation. Four added tests cover the frozen v1.0.1 schema, an audit failure after repository completion, an experiment failure after nested idempotency, and invalid persisted leases rejected without mutation. Browser gates and extracted-source crash recovery run on the exact releasing commit. Source/web ZIPs contain no tests; the independent test ZIP includes compile fixtures and all historical evidence batches.

Services still intentionally share SQLite. This is a single-host application decomposition, not a promise that switching storage engines requires no work. Read-model SQL stays with QueryService; extracting every SELECT into a generic repository would add indirection without creating a useful domain boundary. Frontend ESM remains JavaScript to preserve direct browser delivery. The HTTP/process orchestration boundary is TypeScript too, and stays separate from queue policy.

Sources: [Node 24.19 TypeScript execution](https://nodejs.org/download/release/v24.19.0/docs/api/typescript.html), [TypeScript narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html), [strict](https://www.typescriptlang.org/tsconfig/strict.html).
