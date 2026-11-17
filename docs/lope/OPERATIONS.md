# Source increment and deployed base

The lab service at <https://overleaf.lopen.linguistics.ntu.edu.tw/> now serves
CE+ source `cb7f6803035fb8f4a5df5db9bc215a1f025cbecd`, image
`sha256:19957473a0d23ddfc363a0882a9584a8b08ece6b28979932cce138f93e7704a2`,
accepted on November 17, 2026. Its deployment and recovery are managed by the
separate server-utils [runtime contract](https://github.com/lopentu/server-utils/blob/main/services/overleaf/lope-service.json)
and [canonical operations runbook](https://github.com/lopentu/server-utils/blob/main/services/overleaf/OPERATIONS.md).

Candidate image `sha256:4cee833fb4c85e8103f150d3fc1a76e116a700135b03a7f0e1f366aee57aa91f`
was built from source `516dbdf06d6a53105764108f0b7fc42d9f0158ac`. Its scan reports
no HIGH or CRITICAL findings, with 115 MEDIUM and 53 LOW findings retained and no
vendor fixes reported for them. It has not been promoted; runtime, restore and
rollback acceptance remain separate gates. These source changes do not enable
Git, GitHub/Zotero provider access, SMTP, Google Drive or untrusted compilation
in production.

The earlier compiler increment `0104ea71b4c2bcadbc99b4db70ffc6047d71ae12`
remains discovery/unselected. This checkout and its source declaration do not
replace the accepted runtime contract or establish hosted feature parity.

## Build and local checks

Follow DEVELOPMENT.md for the pinned toolchain, immutable installation and
blocking quality checks. Upstream server-ce/Makefile contains image-build
recipes; the serving image's build and acceptance are recorded in the canonical
runbook. Candidate image and compiler qualification remain separate from local
source checks.
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

The serving image's fresh pre-upgrade cold state and portable image recovery
are governed by the canonical runbook. Preserve the stock rollback and never
downgrade migrated stores in place. The earlier 0104 compiler increment has no
accepted deployment or recovery claim. Do not replace or overwrite live stores
while testing it. Use isolated state, project names and private test origins with
explicit health and useful-workflow acceptance. Preserve failed evidence privately.

## Handoff

Read AGENTS.md, DEVELOPMENT.md and the foundation design/plan under
../superpowers/. Record exact build/source pins, check coverage, unresolved
issues and the next acceptance action. Update Git/fleet/Notion after any live
change and re-fetch every written record. Git, provider, SMTP and Google Drive
acceptance, untrusted compilation and complete hosted parity remain open;
accepting the serving image does not qualify those capabilities or promote the
candidate.
