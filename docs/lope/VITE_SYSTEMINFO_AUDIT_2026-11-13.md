# Vite/systeminformation refresh and CI audit — November 13, 2026

This source increment follows the merged Nodemailer batch. The original private
preparation preserved mail/parser work and all 30 custom patch files without
changing the actual source graph. Actual integration results are recorded below;
no serving runtime or branch-protection change is made by this increment.

## Exact versions and provenance

| Package           | Baseline | Proposed | Published UTC       | Age at retrieval |
| ----------------- | -------- | -------- | ------------------- | ---------------- |
| Vite              | 7.3.5    | 7.3.8    | 2026-11-09 11:01:58 | 4.013 days       |
| systeminformation | 5.31.17  | 5.33.19  | 2026-10-30 05:08:10 | 14.259 days      |

Fresh primary registry metadata and tarballs were verified against declared
SHA512 SRI: [Vite](https://registry.npmjs.org/vite),
[systeminformation](https://registry.npmjs.org/systeminformation).
The exact SHA256 values are in the private version manifest. Registry signatures
and attestations are not independently validated by this preparation.
Systeminformation 5.33.20/5.33.21 were only 0.628/0.242 days old and are excluded
from this proposal. Preserve the three-day age gate without bypass flags.

Vite changes only its existing root resolution. Its declared esbuild range
widens from `^0.27.0` to `^0.27.0 || ^0.28.0`; normal Yarn resolution may therefore
change esbuild/platform locators. Review that declared delta and every resulting
lock change. This is not a claim that only two locators will change. Keep Vitest
4.1.5 and all existing patches; no global esbuild override is proposed.

Systeminformation's two current runtime descriptors, `^5.31.1` and `^5.31.6`,
both admit 5.33.19. The new Linux regression also declares exact 5.33.19 as a
legitimate web dev dependency to use the package's actual bundled declarations.
It introduces no production direct edge or fictitious module exports. After
updating, verify all three descriptors resolve 5.33.19 and that no old vulnerable
locator remains anywhere in the graph.

`VERSION-MAP.json` identifies the exact desired descriptors. The controlled
owner command is `corepack yarn up -R systeminformation --mode=skip-build`,
after applying the source manifest changes. The pinned implementation supports
that mode and refreshes only this package's stored resolutions. Its recursive
mode rejects version/range arguments, so `systeminformation@5.33.19` is not a
valid recursive pattern. The command uses existing ranges and the age gate;
reject an unexpected selected version rather than silently accepting a later
eligible release. `yarn set resolution` invokes installation without the same
mode support, so it is not presented as a lock-only update here.

## Actual metrics path and Linux compatibility

Metrics telemetry initialization is gated by GCP/Jaeger flags. Static inspection
of installed instrumentation-host-metrics 0.3.0 shows CPU/memory metrics use
`node:os` helpers. Its systeminformation dependency is used specifically through
`lib/network.networkStats()`, wrapped by `stats/si.getNetworkData()`.
The six consumed fields are cumulative RX/TX bytes, dropped packets and errors.
Initial per-second rates can be null in actual data despite their declaration
being numeric; they are not consumed by this instrumentation or asserted as
finite by this smoke.

The typed Linux test resolves the real metrics dependency path without starting
telemetry/exporters. It collects and checks those six finite counters through
both direct networkStats and the actual wrapper. It also checks the requested
CPU, memory and currentLoad APIs as additional compatibility coverage. It uses
actual systeminformation declarations and checks that the runtime metrics copy
matches the explicit dev/test copy. No interface names/addresses, packet data,
hardware identifiers, processes, command lines or credentials are logged.

The real baseline 5.31.17 and proposed tarball 5.33.19 both passed these API
checks on Linux, each with one sanitized network result. The actual prepared
Vitest test passed privately using baseline Vite/Vitest tooling. The private
fixture uses a read-only PnP bridge for the proposed package and its direct
bundled-type edge; it is not a complete new graph install. A restricted tool
sandbox initially denied worker spawning; the unprivileged host-side rerun
passed without changing repository or daemon policy.

Both recorded high advisories have Windows-specific preconditions: Vite's
launch-editor issue and systeminformation services() injection. No Windows
exploit is reproduced or inferred from Linux compatibility. Lower Linux
systeminformation findings remain subject to the full audit; Windows scoping
does not clear the package. No custom development server is created.

## Verified Yarn audit semantics and proposed CI policy

Official [audit documentation](https://yarnpkg.com/cli/npm/audit) describes
severity selection and workspace/transitive scope. Pinned Yarn 4.18.0 help,
implementation and actual read-only commands were also verified. On the historical pre-update installed graph, with no exclusions or advisory
ignores:

| Command threshold | Exit | Displayed security rows     |
| ----------------- | ---- | --------------------------- |
| critical          | 0    | none                        |
| high              | 1    | 2 high                      |
| all/default       | 1    | 2 high, 34 moderate, 10 low |

In this pinned implementation severity selection happens before both output and
exit status. Its observed JSON is filtered tree-shaped NDJSON; critical selection
produces empty output. Generic help wording about raw registry JSON should not
be used to infer that lower findings are retained by a severity-filtered run.
Keep the full no-threshold audit report for unresolved lower findings.

The workflow appends a fresh audit step to the existing quality job:

```sh
test "$(corepack yarn config get npmAuditExcludePackages --json)" = '[]'
test "$(corepack yarn config get npmAuditIgnoreAdvisories --json)" = '[]'
corepack yarn npm audit --all --recursive --environment production --severity high --json --no-deprecations
```

The two guards fail closed if exclusions or ignores are configured. Private
controls confirmed empty settings pass and either nonempty setting fails before
an audit request. No exception was used for a real audit. `--no-deprecations`
omits deprecation notices, not security advisories. Registry/network errors and
any selected high/critical row fail the CI step; no continue-on-error or output
pipeline masks the exit status. The two pre-update highs correctly block that baseline; the updated graph
passes this exact command.

All 19 local hook IDs remain, with the new Linux case added to the
existing backend selection and strict type scope. No online audit is added to
local commits. This avoids making local commits depend on registry availability;
CI deliberately depends on a fresh registry response. Developers may run the
same audit manually. Review the CI policy and confirm its existing quality job
is a required branch check; this artifact does not inspect or change branch
protection. A green threshold gate is not a clean all-severity audit or an image
SBOM.

## Actual graph integration

Normal Yarn 4.18.0 resolution under the unchanged three-day age/integrity policy
selects systeminformation 5.33.19 for both existing runtime ranges and the exact
new development edge. No old systeminformation locator remains. Vite 7.3.8
selects its newly permitted esbuild 0.28.2 and 26 platform locators; the graph
adds 29 locators and removes the two superseded Vite/systeminformation locators.
All retained checksums are unchanged. The earlier esbuild remains where required
by unrelated consumers; there is no blanket override. Lockfile SHA256:
`566b79968de6ebaec5d4b4d253dcfd749da9106349f25758c011b3ccda5b991b`.

The actual installed-graph Linux test passes through the metrics dependency
path. A fresh full recursive production audit reports 37 rows: zero critical,
zero high, 30 moderate and seven low. Its nonzero full-report exit remains
visible. The exact high/critical threshold command exits zero with no advisory
rows and no excludes/ignores. This is a threshold result, not complete security
clearance or an image SBOM. All 19 installed blocking hooks pass on this graph, exercising the actual
Vite 7.3.8 configuration through the selected backend/compiler tests. Independent
final-graph review and required/post-merge CI remain to be verified before
source acceptance; a fresh production asset image remains a separate gate.

## Remaining acceptance

After the separate reviewed source change, regenerate the graph with pinned
Node 24.18.1/Yarn 4.18.0 under the unchanged age/hardened/checksum/cache policies.
Inspect exact descriptors, absence of old vulnerable locators, every new
esbuild/platform locator, retained checksums and all patch hashes. Run all 19
actual hooks, matching required CI and the new fresh audit step. Parent-owned
Vite 7.3.8 Vitest/frontend build/config acceptance remains unrun by this private
preparation. Re-fetch a full recursive production audit without ignores or
exclusions and retain unresolved lower rows. No production cutover or runtime
clearance follows from these source/tooling checks.
