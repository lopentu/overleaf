# LOPE Overleaf CE+ development

This is the lab's CE+ source fork. Preserve upstream history, attribution and
licenses. `origin` is lopentu/overleaf, `ceplus` is yu-i-i/overleaf-cep, and
`upstream` is overleaf/overleaf. Development checkouts are not production.

Use Node 24.18.1 (`.nvmrc`) and pinned Yarn 4.18.0. Install the blocking hooks as
shown in docs/lope/DEVELOPMENT.md. All applicable hooks must pass; do not use
SKIP, --no-verify, continue-on-error, ts-ignore, blanket any declarations or
warning-only checks to hide failures. CI runs the same hooks.

Keep patches small and interfaces explicit. New code uses strict TypeScript or
checked JavaScript with concrete JSDoc. Reuse CE+ modules and existing build/test
frameworks; avoid unrelated rewrites, duplicated editors and scattered feature
flags. Verify behavior fixes with failing regressions before implementation.

The public production frontend/backend type commands define their scope
explicitly. Original upstream checks include unavailable SaaS development
fixtures and remain separate diagnostics; never call those commands passing
without running them. Existing CLSI tsc does not typecheck ordinary unannotated
JavaScript; runner regressions do not establish a typed or secure implementation.

Current production is the separately managed stock image. No fork build is
accepted for deployment. Before promotion, use the lope-service-lifecycle and
lope-sysadmin workflows and validate the source declaration against the
canonical private fleet catalog, not just the portable schema check. Keep
runtime code/config/secrets/state at the canonical /opt/lope, /etc/lope and
/srv/lope boundaries; never deploy from this development home checkout.

Keep credentials, environment files, cookies, reset links and database/project
content out of Git, logs and chat. Keep signup restricted and do not expose a
candidate or mount the host Docker socket into the live app during development.
Sandboxing, migration, backup/restore and feature parity require actual tests.
Update technical docs, fleet records and Notion after meaningful maintenance;
re-fetch writes and verify live results before claiming completion.
