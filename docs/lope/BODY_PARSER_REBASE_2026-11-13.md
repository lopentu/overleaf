# Body-parser 1.20.9 rebase — November 13, 2026

This private compatibility increment is based on the first accepted dependency
batch (`cc8819684a3c0a68df793ba3204ce91f97f73845`, subsequently merged). It
supplies source changes without a generated lockfile. The apply manifest uses
the parent's subsequent parser-work snapshot and preserves those pending changes. It changes no serving
runtime and establishes no image, migration, recovery or deployment acceptance.

## Provenance and minimum age

Fresh metadata and tarballs came directly from the primary npm registry. Each
tarball was verified against its declared SHA512 SRI. The three-day age gate
remains unchanged. The following are the exact sources used by the private
fixtures:

| Package      | Version | Published UTC       | Age at retrieval |
| ------------ | ------- | ------------------- | ---------------- |
| body-parser  | 1.20.9  | 2026-10-22 11:38:27 | 21.947 days      |
| qs           | 6.16.0  | 2026-08-29 23:50:15 | 75.439 days      |
| side-channel | 1.1.1   | 2026-06-08 20:34:47 | 157.577 days     |

Primary sources: [body-parser](https://registry.npmjs.org/body-parser),
[qs](https://registry.npmjs.org/qs),
[side-channel](https://registry.npmjs.org/side-channel).
SRI verifies the downloaded bytes against registry metadata; attestation and
signature metadata are not a claim of independent signature verification.

## Custom patch comparison

The existing 1.20.4 patch has two separate purposes: a custom compressed-stream
pipeline backport, and symbol-based request-body access in all four parser
factories. Upstream 1.20.9 handles the relevant decompressor issue directly: it
validates unsupported charsets before creating a decoder, detaches and destroys
the decoder on successful completion, handles late errors and resumes the
remaining request without detaching other consumers.

The proposed 1.20.9 patch therefore contains only the four request-lockdown
changes in `json.js`, `raw.js`, `text.js` and `urlencoded.js`. Each declares the
same two global symbols and initializes the body through the raw-body symbol
when lockdown is installed. The proposed `lib/read.js` is byte-for-byte upstream
1.20.9. No old `Stream.pipeline` hunk is retained, and upstream notices remain.
The original patch and exact comparison are retained in private evidence.

The root `qs` override must also change from 6.15.2 to 6.16.0: upstream
body-parser 1.20.9 declares `~6.16.0`. Forcing the old root override would leave
that declared range unsatisfied. The tested qs source adds an
`es-define-property` edge (existing cached 1.0.1) and raises the `side-channel`
minimum to 1.1.1. Normal Yarn resolution must review these declared transitives;
private fixtures do not replace lock generation. Because the root override also
affects Express query parsing, the new suite checks its actual lockdown/query
path as well as URL-encoded bodies.

## Typed HTTP coverage and controls

`BodyParserCompatibility.test.mjs` and its child fixture are strict checked
JavaScript in the existing focused dependency-security compiler gate. The
existing hook count remains 19; the existing backend hook also selects the new
suite. No existing selection or type scope is removed.

The new suite covers all four parser formats with identity/gzip/deflate under
actual patched Express request lockdown. It checks parsed symbol-body values and
that direct body reads still throw. Additional cases check invalid-limit
construction, configured size-limit rejection over HTTP, both null/undefined
100kb defaults, gzip trailing bytes with a concurrent full-wire hash, compressed
text hashing, unsupported charset rejection with verification enabled, arrays
with 105 entries and shared Express extended-query parsing.

Private package controls distinguish upstream behavior from local compatibility:

- Existing patched 1.20.4: invalid limits fail to throw in all four parsers; the
  combined trailing-gzip/hash case times out; the 105-entry array becomes an
  object instead of the expected array. Other new cases pass.
- Pristine upstream 1.20.9: invalid-limit cases pass, while HTTP cases fail under
  request lockdown. This demonstrates that the local four-file patch remains
  necessary.
- Rebased upstream 1.20.9: all 33 new cases pass. Running the actual prepared
  Vitest wrapper alongside all 14 existing dependency-security scenarios passes
  47 tests, preserving the original seven parser regressions.

The two new behavior differences are explicit compatibility considerations:
unsupported limit values now throw synchronously, and large URL-encoded arrays
retain array shape. The first-batch parser qualification remains historically
accurate for its seven tests; those tests never established every parser property.
No audit ignore or exclusion is proposed.

## Integration and remaining acceptance

The private fixture uses registry tarballs and a read-only baseline PnP bridge,
including exact new declared qs dependencies. It is not a complete new Yarn
installation. Its Vitest configuration/cache are private and do not establish
the actual backend bootstrap hook passing. Focused strict types, changed-source
ESLint and Prettier must be repeated with all real hooks on the installed graph.

Generate and review the new lock normally using pinned Node 24.18.1/Yarn 4.18.0.
Preserve the minimum-age, hardened, checksum and immutable gates. Yarn must
compute the real patched locator/hash/checksum. Remove the old 1.20.4 custom
patch only after no source/lock descriptor references it. Keep that patch in Git
history and private evidence. Re-run all 19 hooks, matching required CI, relevant
controller/query workflows, a fresh recursive production audit without ignores,
and private exact-image application workflows. No Nodemailer major update or
public cutover is included here.

## Actual integration checkpoint

The private preparation above is historical. The fork now has a normally
regenerated graph with patched body-parser 1.20.9, qs 6.16.0, side-channel 1.1.1
and the already present es-define-property 1.0.1. The actual installed reader's
SHA256 `8a23bb191305aedf03694f007fd07db2a4d004054233f4487bf113834adde238`
equals pristine upstream. Independent review verified each parser file equals
upstream plus exactly its required symbol/body edits. The obsolete patch was
removed only after every manifest/lock reference disappeared.

Actual strict fixture types, public backend types and all 19 hooks pass, along
with all 60 combined parser/security regressions and existing validation,
notification and real-time suites. The full backend gate caught the stronger
app-augmented Request annotation in the test error handler; a contextual
ErrorRequestHandler annotation preserves runtime behavior and passes both
compiler scopes. No exclusion or suppression was introduced.

The fresh audit has no body-parser rows; five unrelated high rows remain.
This does not establish a rebuilt application, provider/SAML acceptance,
migration/recovery or a production cutover. Required hosted CI remains a separate
gate. The source preparation's no-install statements describe its original
private artifact method, not the actual integrated checkpoint.
