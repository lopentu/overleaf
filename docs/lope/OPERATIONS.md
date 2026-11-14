# Source increment and deployed base

The lab service at <https://overleaf.lopen.linguistics.ntu.edu.tw/> now serves
CE+ base source `f5cd4cdd77eb8c4f4f58959632069ab77afd063b`, image
`sha256:5dcf4da760841cd615eda70b6bebca863e881b939683375f858d53a5a6289043`,
accepted on November 15, 2026. Its deployment and recovery are managed by the
separate server-utils [runtime contract](https://github.com/lopentu/server-utils/blob/main/services/overleaf/lope-service.json)
and [canonical operations runbook](https://github.com/lopentu/server-utils/blob/main/services/overleaf/OPERATIONS.md).

The current source increment `0104ea71b4c2bcadbc99b4db70ffc6047d71ae12`
adds compiler-workflow integration and remains discovery/unselected. This
checkout and its source declaration do not replace the accepted runtime contract
or declare a deployment manifest for that increment.

## Build and local checks

Follow DEVELOPMENT.md for the pinned toolchain, immutable installation and
blocking quality checks. Upstream server-ce/Makefile contains image-build
recipes; the accepted f5 base build is recorded in the canonical runbook.
The current compiler increment's image/runtime qualification remains open.
Do not run the development Compose defaults against a production host.

## Promotion gates

Validate lope-service.json with the canonical lifecycle checker and the actual
fleet catalog before any further promotion. Portable schema validation in CI does not
verify catalog ownership, resource placement, backup evidence or live behavior.
Resolve and test the compiler privilege boundary; prove no cross-project,
application-secret or host-socket access, bounded resources and safe cleanup.
Test commenting/tracked changes under concurrent edits and each permission role.
Verify Git/GitHub/Zotero and visual editing, then migration of source/assets,
settings, references, comments, suggestions and history. A source ZIP is not
proof of full review/history transfer. Never modify hosted account credentials
or existing projects merely to test a proposed import.

## Recovery and rollback

The serving f5 base's fresh pre-upgrade cold state and portable image recovery
are governed by the canonical runbook. Preserve the stock rollback and never
downgrade migrated stores in place. The current 0104 compiler increment has no
accepted deployment or recovery claim. Do not replace or overwrite live stores
while testing it. Use isolated state, project names and private test origins with
explicit health and useful-workflow acceptance. Preserve failed evidence privately.

## Handoff

Read AGENTS.md, DEVELOPMENT.md and the foundation design/plan under
../superpowers/. Record exact build/source pins, check coverage, unresolved
issues and the next acceptance action. Update Git/fleet/Notion after any live
change and re-fetch every written record. Kernel/recovery-console qualification,
rootless and untrusted compilation, and complete hosted parity remain pending;
accepting the serving base does not qualify the current compiler increment.
