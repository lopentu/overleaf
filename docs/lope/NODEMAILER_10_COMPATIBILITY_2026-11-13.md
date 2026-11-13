# Nodemailer 10 compatibility increment — November 13, 2026

This source batch follows merged parser PR #7. It changes the web dependency
from `^8.0.5` (installed 8.0.11) to exact `10.1.7` and removes two message-content
logging paths. Production email configuration and the serving runtime are
unchanged. Actual Yarn integration and local acceptance are recorded below;
no rebuilt candidate image is accepted by this increment.

## Provenance and major-version trade-offs

Primary [npm registry metadata](https://registry.npmjs.org/nodemailer) identifies
10.1.7 as published at `2026-10-18T18:24:50.456Z`, 25.682 days old at retrieval.
The exact tarball's declared SHA512 SRI was verified; its SHA256 is
`b9163453a4bf2643f0f7fe398daeb39c4492e548c55c56b2517aec616d2a64cb`.
Registry signature/attestation metadata is retained without claiming independent
signature verification. The unchanged three-day minimum-age gate still applies.

The published package has no runtime dependencies, requires Node >=20 and
includes TypeScript declarations plus separate CommonJS/ESM builds. Pinned Node
24.18.1 satisfies that minimum. Its bundled declarations are used directly by
the new strict checked-JavaScript tests; no replacement module declarations,
blanket `any` or ignore directives are introduced.

The major upgrade deliberately includes upstream compatibility changes. Version
9 validates remote-content HTTPS certificates by default. Version 10 changes
packaging/builds and raises the Node minimum. Later fixes refine address parsing,
MIME encoding, transport errors and stream cleanup. Certificate verification
remains enabled; fixture TLS tests trust only their generated local certificate.
The source wrapper's current valid-message behavior is tested across 8 and 10,
but arbitrary malformed address normalization is not promised byte-for-byte.

## Actual call sites and preserved interfaces

Repository inspection finds one production Nodemailer consumer:
`EmailSender.mjs`. It imports the default API, creates an SMTP transport from an
explicit settings whitelist or an SESv2 transport with `{sesClient,
SendEmailCommand}`, and awaits `sendMail`. `EmailHandler` generates the message
body/subject and calls its promise wrapper; callback wrappers remain in place.
No production addressparser, SMTP-pool or transport-internal subpath imports were
found.

The SMTP whitelist is unchanged: host, port, secure, auth, ignoreTLS, tls,
logger and name. Message fields remain to/from/subject/HTML/text/replyTo,
30-second socket timeout, optional cc/textEncoding and the category-derived
`X-SMTPAPI` header. The wrapper does not forward raw messages or attachments;
new application tests verify those extra input fields remain ignored. Existing
rate-limit behavior, default/override fields and the generic public rejection
are covered by the existing EmailSender suite.

## Real-library and application checks

The isolated real-library suite uses the actual 10.1.7 package with test-only
loopback peers. Its 15 cases cover SMTP delivery/envelope/authentication,
SMTPUTF8/IDN handling, captured debug-logger credential redaction, auth and
recipient rejection, disconnect during DATA, greeting timeout, verified implicit
TLS and rejected untrusted certificates, MIME/Unicode/header/category semantics,
stream transport, native ESM default API, and bounded advisory controls.
The fixtures never call Ethereal, an external SMTP server or a cloud endpoint.

Implicit TLS fixtures generate short-lived certificates using the controller/CI
OpenSSL executable in mode-0700 temporary directories. No private key enters
Git. TLS checks fail if fixture generation is unavailable; they do not silently
skip or disable verification. Listeners, sockets and fixture files are closed
or removed in `finally` blocks.

Four additional tests invoke the actual EmailSender with real
Nodemailer SMTP/SES transports. They cover promise and callback delivery,
MIME/field whitelisting, generic SMTP rejection, and actual SDK
`SendEmailCommand` construction and input shape. The SDK client is mocked, so
only MIME generation/command input are verified; SDK HTTP serialization,
credential providers and AWS delivery are not invoked. SES rejection still
reaches the same public generic error. Console and logger capture checks assert
only booleans, so failures cannot echo generated credential sentinels.

The original private preparation included the existing 10 EmailSender tests
and two credential regressions. Those 12 and the four new application cases
passed with baseline 8.0.11. That historical private selection had 31 passing
tests across four files. The integrated selection now has 33 passing tests
with the two additional privacy regressions described below. It uses the
repository's actual unit bootstrap, including its existing Chai plugins; native
promise-rejection assertions avoid a matcher/plugin conflict without weakening
the error checks. All new code is in the existing strict JS gate, and the
existing backend hook selects both new suites plus the original EmailSender
suite. All 19 hooks and existing selections remain in place; CI invokes that
same hookset.

## Bounded advisory controls and reachability

With 2,000 synthetic addresses (52,000 input bytes), the baseline parser copies
1,999,000 previously accumulated elements through Array.concat; 10.1.7 copies
zero in that path. The regression gates a generous linear-work bound instead of
an unreliable wall-clock benchmark. Each child has a 128 MiB heap and six-second
process timeout. The additional malformed fallback input is only 6,144 bytes;
it is a bounded functional smoke check, not a full reproduction or universal
complexity proof.

Two raw-message controls use a generated synthetic local `.eml` file and a
loopback HTTP server. Baseline 8.0.11 bypasses the respective disableFileAccess /
disableUrlAccess policies; 10.1.7 rejects both with the expected access-denied
codes. The baseline passes 12 of the 15 library controls and fails these two
plus the address-copy bound. The proposal passes all 15.

The raw-option advisory is not established as reachable through the inspected
wrapper, which does not forward that option. Address-parser reachability still
depends on calling-route validation and address lengths. These library controls
do not establish a public exploit or exhaustive email security. No advisory
ignore or exclusion is proposed.

## Integration and remaining acceptance

The original private preparation mapped the real 10.1.7 tarball and bundled types
without changing the actual graph. Integration subsequently used the pinned
Node 24.18.1 and Yarn 4.18.0 for a normal controlled install. Exactly one locator
was removed (Nodemailer 8.0.11) and one added (10.1.7), with only the web workspace
edge changed. Independent review checked all 2,933 retained locator checksums
and all 34 unchanged patched locators. The integrated lockfile SHA256 is
`0b9f46717b650e033561267d5cd2305495a01bc44b1f963e1d0acc422b1b8bad`.
Age, hardened, checksum, cache-isolation and immutable gates remain enabled.

Two additional synthetic regressions first failed against the existing code:
the disabled transport logged the complete generated message, and a deferred
queue failure logged options plus the raw error. These paths can contain reset
links or credentials. The disabled transport now records only that no message
was sent; deferred failures record the email type without options or the raw
error. Delivery behavior is unchanged, but deferred diagnostics intentionally
contain less detail. The existing site-admin-protected manual activation endpoint
remains available. Tests capture only boolean assertions, never the synthetic
secrets or message contents.

All 33 actual mail tests and all 19 installed blocking hooks passed. A fresh
recursive production audit without ignores or exclusions reports 46 advisory
rows: zero critical, two high, 34 moderate and ten low. Nodemailer has no remaining
row; the high rows belong to Vite and systeminformation and remain separate
follow-up work. Independent review found no blocking source issue and reran five
non-network native/PnP library controls. Required CI and merge acceptance must
still be checked against the eventual exact commit.

Rebuild the exact accepted source and repeat private application acceptance
before promotion. Local implicit TLS tests do not cover STARTTLS upgrade,
provider policies, OAuth2, proxy/fetch behavior, SES IAM/quotas or real delivery.
Production SMTP and provider credentials remain unconfigured by this increment.
