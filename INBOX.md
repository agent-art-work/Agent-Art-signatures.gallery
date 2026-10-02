# Inbox

The backlog was evaluated and moved to the [development execution plan](docs/development-plan.md) on 2026-09-19: **E00–E24** are the core task table; **D01–D02** retain the external inquiry and deferred evaluation. The plan contains dependencies, acceptance checks, approval gates and a mapping of every previous Inbox section.

This Inbox is cleared by triage, not because development is finished. Track execution in the plan; append new, untriaged requests here.

- Disk cleanup request for Agent-Art-signatures.gallery:

  Inspect this local rehearsal backup:

  `/Users/bigu/Projects/Agent-Art-signatures.gallery/.local/backups/pre-formal-v1-20260910`

  It occupies approximately 6.3 GiB:

  - 5.2 GiB Anvil state.json
  - 1.1 GiB PostgreSQL data, mostly pg_wal
  - 36 MiB logs
  - Small database dump and runtime metadata

  Determine whether the exact pre-formal-v1 local chain/database rollback point is still required. If obsolete, delete the backup safely. If it must be retained, compact/archive it and document the restoration procedure.

  Do not modify the active `.local/rehearsal` environment. Verify disk recovery and repository/runtime health afterward.

- Fix the slow-primary RPC failover defect: a slow primary can consume the overall read deadline before the secondary is tried, leaving live network checks unavailable despite a responsive secondary. Keep contradictory chain or mint evidence fail-closed, and test slow-primary, healthy-secondary recovery.
