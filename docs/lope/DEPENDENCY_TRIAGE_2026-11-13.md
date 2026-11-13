# Production dependency triage — November 13, 2026

This source hardening increment changes no serving stock runtime and establishes
no candidate image, sandbox, migration or recovery acceptance. The preparation
record below is historical; actual installed-graph results follow at the end.
Required hosted CI and rebuilt-image workflows remain separate gates.

## Audit scope and provenance

The initial source snapshot is `9ebb3b8aa93a20fa268c542f00e5e8fb5e671412`
plus the controller's pending bounded-archive changes. Its working `yarn.lock`
SHA256 is `77a3ec6f53603d754e7dbf2aff88cd9f69e4b9ce2932675c9fd79105782f0480`.
Using Node 24.18.1 and Yarn 4.18.0, the source-declared audit command was:

```sh
corepack yarn npm audit --all --recursive --environment production --json --no-deprecations
```

The registry response contains 126 package/advisory-version rows: one critical,
47 high, 62 moderate and 16 low. By distinct GHSA URL these are one critical,
43 high, 51 moderate and 16 low. No effective package exclusions or advisory
ignores were configured. Exit 1 denotes findings. The initial sandbox DNS
failure and successful network retry are retained separately.

This includes production dependencies of all workspaces, including optional
integrations and packages that may not ship in the CE image. It is not an image
SBOM. Route reachability, effective configuration and source patches must be
assessed separately; version matches do not prove stock deployment exploitability.

Public registry metadata and tarballs, verified against registry integrity
hashes, are retained privately under the controller's dependency-audit evidence.
The following exact same-major releases all satisfy the unchanged three-day
minimum age policy as of November 13:

| Package     | Proposed version | Published UTC       |
| ----------- | ---------------- | ------------------- |
| proxy-addr  | 2.0.8            | 2026-09-15 06:12:45 |
| multer      | 2.5.0            | 2026-10-22 11:58:46 |
| mongoose    | 8.24.7           | 2026-10-23 16:54:46 |
| compression | 1.8.2            | 2026-09-11 11:16:47 |
| on-headers  | 1.1.0            | 2025-07-17 15:41:31 |
| mquery      | 5.0.1            | 2026-10-23 16:06:52 |

Registry sources: [proxy-addr](https://registry.npmjs.org/proxy-addr),
[multer](https://registry.npmjs.org/multer),
[mongoose](https://registry.npmjs.org/mongoose),
[compression](https://registry.npmjs.org/compression),
[on-headers](https://registry.npmjs.org/on-headers),
[mquery](https://registry.npmjs.org/mquery).
Do not disable minimum age, hardened, checksum or immutable verification.

## Patch-aware decisions

`proxy-addr` 2.0.8 fixes
[GHSA-jqcg-44mw-7w3h / CVE-2026-90711](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).
The issue requires particular IPv4-mapped IPv6 trust subnet configurations;
the inspected source default is `loopback`. Update the real-time minimum and
the root resolution so Express and real-time share the fixed release. Preserve
the separate existing `forwarded` patch. Test plain IPv4, correctly mapped
subnets, malformed short mapped prefixes, native IPv6 and loopback behavior.

`multer` 2.5.0 covers the reported field-name, aborted descriptor and pending
async-filter advisories:
[GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm),
[GHSA-qfvm-cv95-jqjf](https://github.com/advisories/GHSA-qfvm-cv95-jqjf),
[GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4),
[GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m).
The oversized-array advisory requires a finite `fieldArrayIndexLimit`; upgrading
alone leaves its default at Infinity. The proposed web and CLSI default is 100.
Normal upload metadata is flat. Review any operator override before activation.

Both existing custom Multer behaviors remain necessary and are absent upstream:
retain a local parsed-body reference so Express request lockdown never reads
`req.body`, and accept nameless file parts with original name `undefined`.
Upstream now computes `originalname` earlier, so normalize the missing filename
before that computation. Preserve upstream's guarded `appendField`, late-error
listener, pending-filter handling and disk pipeline/descriptor cleanup. Rebase
only these two local changes onto 2.5.0; do not apply the old patch blindly.
The installed `@types/multer` 2.1.0 does not yet declare `fieldArrayIndexLimit`;
use the real runtime API and investigate any type error narrowly rather than
introducing fake package exports or weakening type gates.

`mongoose` 8.24.7 fixes
[GHSA-8332-j7wj-wjw4 / CVE-2026-125117](https://github.com/advisories/GHSA-8332-j7wj-wjw4)
and [GHSA-gg4r-jv3p-qx3c / CVE-2026-125119](https://github.com/advisories/GHSA-gg4r-jv3p-qx3c).
Synchronize the web exact pin and `sinon-mongoose` dependency extension in
`.yarnrc.yml`; the latter must resolve the identical Mongoose model constructor.
This also moves `mquery` 5.0.0 to 5.0.1. Exercise query casting, hydration,
Mixed fields, updates, existing mocks and actual isolated database workflows.

`compression` 1.8.2 fixes
[GHSA-vc2v-76pw-4v95 / CVE-2026-87776](https://github.com/advisories/GHSA-vc2v-76pw-4v95).
Source use is the metrics response middleware. Update its workspace minimum,
the root resolution and the conflicting root `on-headers` override to 1.1.0;
the latter is required by compression's new `~1.1.0` dependency and also fixes
[GHSA-76c9-3jph-rj3q](https://github.com/advisories/GHSA-76c9-3jph-rj3q).
The same-major change adds Brotli negotiation and changes several small
transitives. Test gzip/identity/Brotli negotiation, metrics content, response
headers and native compression-resource closure after client abort.

## Existing body-parser backport

Keep the patched 1.20.4 descriptor and custom request-lockdown integration for
this increment. The version audit reports
[GHSA-27r3-jxmh-p828 / CVE-2026-111181](https://github.com/advisories/GHSA-27r3-jxmh-p828),
but its local `Stream.pipeline` backport changes the relevant implementation.
Seven synthetic HTTP regressions, derived from the
[official upstream fix](https://github.com/expressjs/body-parser/commit/1260c38),
passed on the installed patched candidate: delayed deflate completion,
concurrent raw-body hashing, trailing gzip bytes, unsupported charset rejection,
and normal identity/gzip/deflate JSON.

A negative control substituted the official unpatched 1.20.4 `lib/read.js`
while retaining the same installed dependency graph; trailing-gzip and unsupported
charset cases crashed with uncaught `Z_DATA_ERROR`. Substituting official
1.20.9 `lib/read.js` passed all seven cases. These controls replace only the read
implementation in memory; they are not complete alternate package installations.
Retain this exact evidence and add the regression to the required source gate.
Do not configure an audit ignore or claim that every possible parser issue is
excluded by these seven cases.

## Credential-log promotion blocker

The inspected `EmailSender.sendEmail()` logged the complete email settings on
both SMTP and SES send paths. This increment removes that statement
independently of advisory reachability. A strict checked-JavaScript regression invokes the real send path
with generated synthetic sentinels, mocked transports and captured console/logger
output. Both transport cases fail with the original statement and pass after its
removal. No actual email, credential or external connection is used; failure
assertions report only booleans.

## Historical preparation and remaining validation

The prepared isolated regression fixture runs crash/prototype cases in separate
128 MiB Node processes with five-second child timeouts. Against the pre-update
source graph, it exposes proxy trust mismatch, prototype corruption, missing
connection-level sanitization, compression resource retention, and an oversized
multipart index timeout. Nameless-file/request-lockdown, one late-filter case
and all seven body-parser cases pass already. The late-filter case alone does
not reproduce every upstream async-filter exploit. These are source-only,
synthetic dependency checks, not authenticated route acceptance.

After regenerating the lock, run the new fixture through the existing required
backend regression hook, the existing Multer/controller tests, real-time address
tests and metrics tests, followed by every existing local/CI gate. The isolated preparation itself did not install the proposed
new package graph; subsequent installed-graph results are recorded below.
Record a fresh full production audit, preserving unresolved rows and this
body-parser qualification. Other reported high packages remain follow-up triage;
this small increment does not make the complete dependency graph clean.

## Private preparation verification

The corrected overlay is based on the bounded-archive result
`57f0fb88a1399beb3c265ffe9ba43e428c1d570f` (merged with the same tree). It
preserves the archive ownership regression in the compiler hook. The changed
`.yarnrc.yml` needs mechanical quote normalization to pass the existing Prettier
configuration; its only semantic change is the synchronized Mongoose pin.

Private registry-tarball tests bridge unchanged dependencies through the baseline
PnP graph. All 14 dependency scenarios pass with the proposed package sources;
the baseline has five failing controls (proxy trust, two Mongoose cases,
compression abort cleanup and the oversized-index timeout). The seven parser
controls pass with both the existing patched read implementation and upstream
1.20.9, while the unpatched 1.20.4 control crashes with `Z_DATA_ERROR` in the two
previously documented cases.

The actual prepared Vitest files run in a private configuration/cache: 34 tests
pass. Restoring the original email log and upload default produces exactly three
failing assertions (SMTP, SES and the finite default); restoring the fixes passes
all 34. The three newly added regression files pass a focused strict checked-JS
compiler configuration. The web workspace explicitly declares `@types/multer`,
which was previously declared only at the root. The additional blocking type hook
brings the hook count to 19, preserving all existing 18; CI invokes that same
hookset without path filters.

These runs used private tarballs and a baseline PnP bridge, including a private
copy with only the proposed direct type-dependency edge. They do not establish a
complete new Yarn installation, immutable lock acceptance, the production backend
hook's bootstrap/environment, real Mongo acceptance or a rebuilt private image.
Repeat all real gates against the generated graph. The limited late-filter test
passes in both baseline and proposal; it does not reproduce every upstream
async-filter issue. Normal compression negotiation, on-headers behavior, route
controllers and database workflows remain separate checks.

## Actual installed-graph checkpoint

Normal Yarn installation regenerated the lock with the three-day age gate,
checksum checks and all existing source patches retained. Eight locators were
added and ten removed; every retained locator checksum is unchanged. The new
Multer patch hash is `92f3ee`; its old 2.2.0 patch was deleted only after the
manifests and lock no longer referenced it. Compression's small transitive
changes include negotiator 0.6.4, bytes 3.1.2, safe-buffer 5.2.1 and existing
compressible 2.0.18. No unrelated broad lock refresh was performed.

The actual graph passed the strict checked-JS gate and 34 focused security,
credential and shared-upload tests. All 19 blocking hooks passed together.
Additional existing regressions passed: 106 project upload/controller/import,
eight websocket address and 11 HTTP metrics tests. A separate loopback probe
of the actual metrics route verified identity, gzip and Brotli negotiation,
decoded Prometheus content and response headers. Independent staged code/lock
review found no important blockers and reran all 14 installed dependency
scenarios successfully. These synthetic checks do not replace real MongoDB or
rebuilt private application acceptance.

A fresh recursive production-source audit, without exclusions or ignores,
returned 113 advisory/package-version rows: zero critical, 40 high, 59 moderate
and 14 low across 41 packages. The targeted multer, mongoose, compression,
proxy-addr and on-headers rows are absent. Body-parser's version-based high
compressed-body row remains, with the tested backport qualification above;
a separate low invalid-limit row also remains. The audit exits 1 for findings.
Neither the remaining source graph nor a deployed image is declared clean.
Lock SHA256 at this checkpoint:
`10ce98ba94527198a91bc7ddef6e0fdc4fd5e78b34aa711598292196655f92ac`.

Further patch-aware triage is recorded privately. Compatible XML/Zod and
transitive updates, a separate Nodemailer major-version compatibility change,
and scoped tooling/Windows findings remain follow-ups. Required CI, exact-source
image build, actual upload/database/editor/PDF workflows and operational records
must pass before any public promotion. No audit allowlist is introduced.

The standard unified patch stores syntactically required blank context-line
prefixes. Generic whitespace diagnostics on that patch data are not source
whitespace errors; changed executable/manifests/docs pass the corresponding
checks and formatting hooks.
