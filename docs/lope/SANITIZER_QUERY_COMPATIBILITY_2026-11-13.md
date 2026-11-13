# Sanitizer and query-parser dependency repair

The web source now pins sanitize-html 2.18.1 and resolves all three qs selectors
(global, request and @cypress/request) to 6.16.2. This closes the six reviewed
sanitizer/query advisory ranges without changing application sanitization or
parser policy. It does not establish HTTP exploitability or deployed-image
clearance. The public service still uses the separately managed stock image.

The unchanged three-day npm age policy excludes sanitize-html 2.18.2 at this
November 13 checkpoint. Fresh primary registry metadata confirms every actual
new locator is eligible. Normal Yarn resolution adds seven locators: sanitizer,
qs, launder 1.7.2, dayjs 1.11.23, is-plain-object 5.1.0, postcss 8.5.32 and nanoid
3.3.20. The latter two differ from the private proposal's minimum-version
fixture. Four old locators disappear; all 2,962 retained locator checksums and
all 30 custom patch files remain unchanged. No audit exclusions or ignored
advisories are added.

Nine small checked-JavaScript regressions exercise the three sanitizer policy
conditions, qs finite comma-array limits, constructor/isBuffer and toString
handling, ordinary Unicode/nested serialization and prototype-key rejection.
They run in the existing Vitest backend gate and strict dependency-security
check. The resolved actual baseline fails five cases and passes four; the
repaired graph passes all nine. Explicit development edges to qs and its
existing genuine @types/qs package make PnP test resolution reproducible. An
initial unresolved-import attempt executed no cases and is not a RED receipt.

The existing real EmailMessageHelper tests are also added to the backend
selection; the existing template-gallery frontend selection remains. Private
preparation additionally exercised byte-identical email/gallery helpers and
statically verified brand defaults, with 14 candidate cases passing. Those
copies are not maintained as duplicate application implementations. Ordinary
source policies do not enable the nondefault SVG/meta conditions used by the
advisory controls; this observation is not a general reachability exemption.

A fresh complete production source audit has 30 rows, no critical/high findings,
and no remaining sanitizer or qs rows. Remaining findings still require triage.
Full audit exits nonzero for lower-severity rows; the independent high/critical
threshold exits zero. Neither result accepts the compiler bridge, rootless
worker, provider integrations, migration or candidate recovery.

Primary references: [sanitize-html registry](https://registry.npmjs.org/sanitize-html),
[qs registry](https://registry.npmjs.org/qs),
[SMIL URI list](https://github.com/advisories/GHSA-g8qq-57p8-ggw5),
[noscript discard](https://github.com/advisories/GHSA-x3q4-9hxx-gx8m),
[meta refresh](https://github.com/advisories/GHSA-cv27-6wvh-8x7j),
[array limit](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx),
[isBuffer](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
[toString](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).
