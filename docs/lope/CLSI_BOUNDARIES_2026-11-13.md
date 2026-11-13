# CLSI lock ownership and private listener — November 13, 2026

This source increment prepares the approved local compiler boundary. It adds
private Unix listener support and repairs a lock-release race. It creates no
managed worker, host account, mount, TLS identity or service exposure. Default TCP configuration remains available to existing deployments.

## Private endpoint contract

An explicit CLSI_UNIX_SOCKET selects Unix mode. The endpoint must be canonical,
absolute, at most 100 UTF-8 bytes, with no symlink ancestry. Its existing parent
must belong to the current effective UID and have mode 0700. Ancestors must
belong to root/current UID without group/other write, except root-owned sticky
directories. Every existing endpoint is refused, including stale sockets,
files, symlinks and directories. No directory is created and no stale pathname
is implicitly deleted by the listener.

Unix mode starts only the main HTTP server with socket mode 0600. Both load
listeners are absent; report_load alone did not disable them. Startup failure
closes partial listeners and causes the actual application to exit. SIGTERM and
SIGINT close active HTTP connections and the owned endpoint before exiting.
SIGKILL may leave a stale socket that blocks startup until investigated.

The local proxy belongs to the same trusted UID and protected namespace. Node
close automatically unlinks its Unix pathname, so trusted same-UID/root exclusive
ownership is part of this contract. This is not a guarantee against a malicious
same-UID process replacing the path. The future managed runtime must establish
its own directory, credentials and restart ordering before activation. Outbound
filestore proxy endpoint authenticity remains a separate requirement.

TCP startup uses explicit {port, host} options and Unix startup uses {path}.
All three TCP ports are validated before binding; integer numbers and benign
decimal numeric strings are supported. Independent review reproduced a numeric
string dropping its configured host in the first draft. Fifty intercept-only
RED controls fail that draft without opening a wildcard listener; the repaired
source passes them and actual loopback numeric-string tests. Do not choose a
listener profile by whether its port value happens to be a string.

## Ownership-aware lock release

An expired lock can be replaced while its old operation is still running. The
old release previously deleted the map entry unconditionally, so that operation's
later finally block could remove a newer owner's lock. Release now deletes only
when the map still refers to that exact lock instance. Two regressions fail
against the original implementation and pass with the repair.

Existing expiry takeover and inclusive concurrency behavior are preserved.
Expiry can still wake waiters before old work finishes; wordcount releases its
sync lock before execution, and output/SyncTeX use separate coordination. This
small repair does not prove a quiescent source tree or safe cache publication
for the future ephemeral CommandRunner bridge.

## Actual integration and evidence

Independent component reviews found no blocking source-unit issue. The listener's
older manifest/type/test hunks were deliberately merged into the current source;
all existing lifecycle/native checks remain. The only dependency change is an
exact CLSI development edge to the already present @types/express 4.17.23. No
locator or retained checksum changes, local patch edits or new online hooks are
introduced. All 19 blocking hook IDs remain.

The existing archive gate keeps its strict, exact-optional and erasable options
and adds all listener fixtures. A focused @ts-check/JSDoc lock gate runs through
types:check with strict/noImplicitAny and checkJs:false globally, checking the
real legacy import graph. It deliberately does not introduce exactOptionalPropertyTypes
for that graph, which has unrelated existing fetch/AbortSignal diagnostics.
The original stricter archive gate is unchanged.

Both actual type commands pass. The actual combined selection passes 180 tests:
166 previous compiler tests, seven original plus six new lock tests, and one
listener wrapper invoking 75 native Node/Express HTTP lifecycle cases. These
cover default TCP behavior, Unix startup, unsafe/stale paths, startup rollback,
active requests, graceful stop/restart and abrupt-stop refusal. Full installed
hooks and required CI still need final exact-head acceptance.

A separate unprivileged process bootstrapped the actual integrated CLSI app on
its private Unix endpoint, served the exact /status response, opened no TCP
listeners, stopped cleanly and repeated the same process successfully. In both
rounds an actual nobody process with a different UID received EACCES for both
connect and bind. Logs and all mutable paths were confined to the private test
root. This proves the controller endpoint behavior; it does not establish the
future worker account, mTLS, rootless cgroups, compilation or promotion.

## Remaining integration

The bounded admission and input snapshot units remain private drafts. Independent review identified a lease-ancestry gap and a producer-settlement
gap; new draft repairs require closure review before adoption. The existing
job input-transfer caller also needs an explicit producer-completion join. Do not infer complete restart recovery or
input ownership from a closed stream. The serving stock runtime, catalog,
fleet listing and backup policy remain unchanged by this source increment.
