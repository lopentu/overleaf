# Candidate operations

This repository is a development source candidate, not an accepted deployment.
The running lab instance and its active service contract remain managed by the
private lopentu/server-utils repository, services/overleaf/OPERATIONS.md. No
candidate host, resource envelope, exposed port or recovery claim is declared.

## Build and local checks

Follow DEVELOPMENT.md for the pinned toolchain, immutable installation and
blocking quality checks. Upstream server-ce/Makefile contains image-build
recipes; complete builds and their resource cost have not yet been accepted.
Do not run the development Compose defaults against a production host.

## Promotion gates

Validate lope-service.json with the canonical lifecycle checker and the actual
fleet catalog before any promotion. Portable schema validation in CI does not
verify catalog ownership, resource placement, backup evidence or live behavior.
Resolve and test the compiler privilege boundary; prove no cross-project,
application-secret or host-socket access, bounded resources and safe cleanup.
Test commenting/tracked changes under concurrent edits and each permission role.
Verify Git/GitHub/Zotero and visual editing, then migration of source/assets,
settings, references, comments, suggestions and history. A source ZIP is not
proof of full review/history transfer. Never modify hosted account credentials
or existing projects merely to test a proposed import.

## Recovery and rollback

The existing stock service's verified cold backup and isolated restore remain
the operational rollback. No fork image/state migration is accepted yet. Do
not replace or overwrite the live stores while testing. Use isolated state,
project names and private test origins with explicit health and useful-workflow
acceptance. Preserve failed tests and recovery artifacts privately.

## Handoff

Read AGENTS.md, DEVELOPMENT.md and the foundation design/plan under
../superpowers/. Record exact build/source pins, check coverage, unresolved
issues and the next acceptance action. Update Git/fleet/Notion after any live
change and re-fetch every written record. Current known limitations are tracked
in the private operational task; no complete parity or sandbox acceptance claim
is made by this candidate declaration.
