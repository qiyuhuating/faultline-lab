# ADR 001 — SQLite owns the single-host state

Status: accepted. Scope: local reliability laboratory.

We need a durable task engine that can be started without another service and whose transaction boundaries can be reviewed in one repository. SQLite WAL with synchronous=FULL supplies an inspectable persistence boundary; separate processes compete using BEGIN IMMEDIATE.

A Redis-backed queue or network database would be appropriate for other deployment goals. Here it adds a second service and obscures the small failure model being demonstrated. The chosen design deliberately has one host and one database writer at a time. It is not a distributed scheduling cluster.

Read-only snapshots use BEGIN and share one SQLite read version. Worker writes remain concurrent under WAL. Evidence export can delay checkpoints while its read transaction is active, so retained evidence is bounded and exports remain a local laboratory operation.

Revisit if tasks require multiple hosts, durable external delivery, tenant isolation, or sustained write throughput beyond the measured single-machine workload. A backend change must preserve idempotency, revision, generation and fencing semantics rather than imitate the current SQL statements.
