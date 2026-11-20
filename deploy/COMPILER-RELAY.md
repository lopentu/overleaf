# Private transport for the isolated compiler

The relay Compose project runs two instances. Place the `web` instance on
the application side and the `worker` instance on the compiler side. Both
instances use only Unix sockets and have no container network. A separate
private transport carries the TLS bytes between peers.

| Role     | Local HTTP listener for its caller                         | Peer TLS listener                                     | Local HTTP backend   |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------- | -------------------- |
| `web`    | `compile.sock` for Web's private compile and PDF gateway   | `peer.sock` accepts the worker's filestore connection | App filestore bridge |
| `worker` | `filestore.sock` for the optional worker filestore adapter | `peer.sock` accepts Web's compile connection          | Worker's `clsi.sock` |

Put each role's two listeners in its own UID-33-owned directory with mode
`0700`. Keep the local HTTP listener private to its caller. The role's
outbound transport socket must connect transparently to the other role's
`peer.sock`. Provision a dedicated, initially empty listener directory for
each relay. The launcher checks its ownership and mode, verifies that both
inputs are distinct Unix sockets, and rejects overlaps with the TLS directory.

The app-side bridge publishes only the filestore HTTP socket. The app's
compile gateway reaches the web relay's `compile.sock`. Use that app-local
gateway as both `apis.clsi.url` and `apis.clsi.downloadHost`. Overleaf still
authorizes project access and browser downloads. Set both
`OVERLEAF_PROXY_CLSI_OUTPUT_THROUGH_WEB=true` and
`OVERLEAF_DISABLE_EMBEDDED_CLSI=true` in the app container's environment.
At startup the app routes PDF and log previews through authenticated Web
routes, leaves the embedded compiler down and omits its output listener on
port 8080. With a separate compiler enabled, keep PDF caching disabled.
Recreate the app container when switching back to the embedded compiler so
runit starts from the image's original service directory.
The worker-side relay
mounts only `clsi.sock` from the dedicated runtime directory. Keep `docker.sock`
and `manager.sock` outside both relays. The optional filestore adapter uses
the worker relay's `filestore.sock` as described in the
[compiler guide](COMPILER.md#optional-image-and-binary-file-inputs).

## Attach the private gateway to the portable Web app

Build the Web image from a fork revision that includes the NGINX filestore
socket startup check. Add `-f deploy/compose.compiler-web.yaml` after the
portable `compose.yaml`.
The overlay adds a compiler listener on the app container's loopback and a
filestore listener on a private Unix socket. It leaves the exposed Web port
and persistent volumes as configured by the base Compose file. The gateway
settings merge with the fork's normal image settings. Deployments with a
custom settings module should merge the same compiler endpoints into it.

Set these values in the portable deployment's runtime environment file.

| Setting                      | Value                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPILER_WEB_RELAY_DIR`     | Pre-created absolute path to the Web relay's UID-33-owned mode-`0700` listener directory. The app mounts it read-only and connects to `compile.sock`. |
| `COMPILER_WEB_FILESTORE_DIR` | A distinct pre-created absolute path to the app's UID-33-owned mode-`0700` socket directory. The app creates `filestore-http.sock` here.              |

The overlay disables PDF caching for the isolated worker. Projects without a
saved TeX image use the worker's pinned default. Verify that the worker accepts
each saved image name before switching a deployment. Setting
`TEX_LIVE_DOCKER_IMAGE` in the app environment can persist that image choice
when a project is created or opened with no saved selection.

Keep both directories in private runtime storage outside the application
data and backup trees. Allocate each filestore directory to one Web app and
its NGINX supervisor. Start Web so NGINX creates `filestore-http.sock`.
Use that exact socket as the Web relay's backend. The compiler gateway returns
a failure until the relay's `compile.sock` is available. The app checks its
private filestore socket on NGINX startup. It removes an owned socket only
when a connection was refused and the socket still has the same inode.
After any Web or Docker restart that replaces it, recreate the Web relay so
its file bind uses the new socket. Check both directions with an image compile
before accepting traffic. For unattended restarts, the deployment must
coordinate Web and relay recovery and repeat those checks.

## Configure TLS identity

Use purpose-limited trust roots and a protected TLS directory for each role.
The relay process runs as UID/GID 33 and needs read access to the six files.
Keep private keys readable only by the required account or group. Keep CA
signing keys outside both directories.

| File                                         | Web role                                                                 | Worker role                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `inbound-server.pem`, `inbound-server.key`   | Server certificate and key for `filestore.overleaf.internal`             | Server certificate and key for `compile.overleaf.internal`                    |
| `inbound-ca.pem`                             | Root for the worker filestore client                                     | Root for the Web compile client                                               |
| `outbound-client.pem`, `outbound-client.key` | Client certificate and key with subject `CN=overleaf-web-compile-client` | Client certificate and key with subject `CN=overleaf-worker-filestore-client` |
| `outbound-ca.pem`                            | Root for the worker compile server                                       | Root for the Web filestore server                                             |

Use the exact DNS name in each server certificate's subject alternative name.
The names are TLS identities. The connections run over the pre-provisioned
Unix transport sockets. Each inbound listener verifies the certificate chain
and requires the exact client subject in the table. Both outbound connections
verify the peer name and chain.

The compiler relay permits project requests and leaves operation and input
validation to the worker. The filestore relay permits only canonical history
blob GETs. It forwards neither request headers nor bodies from the caller.

## Start and check each relay

Provision one protected Compose environment file per role. Use absolute paths
for both input sockets and both directories.

| Setting                         | Value                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| `COMPILER_RELAY_ROLE`           | `web` or `worker`, according to the table above.                           |
| `COMPILER_RELAY_IMAGE`          | Verified runtime image content ID with Node 24.18.1 and `/usr/sbin/nginx`. |
| `COMPILER_RELAY_TLS_DIR`        | This role's protected TLS directory.                                       |
| `COMPILER_RELAY_SOCKET_DIR`     | Private directory for this role's new listeners.                           |
| `COMPILER_RELAY_BACKEND_SOCKET` | Exact socket for this role's local HTTP backend.                           |
| `COMPILER_RELAY_TUNNEL_SOCKET`  | Exact outgoing transport socket connected to the other role's `peer.sock`. |

Start the base compiler project with its bridge settings first. Wait for the
protected `clsi.sock` health check. Start the app's filestore bridge and
provision both transport sockets. Then start both relay peers. Once the worker
relay has created `filestore.sock`, use the compiler project's base and
filestore Compose files with `up -d --no-deps filestore`. This adds the
adapter to the existing compiler namespace. Keep compile traffic drained
until both directions pass acceptance.

From the checkout root, set `local_engine_socket`, `relay_project` and
`relay_env` for the selected role. On the daemon host, set `expected_backend`
and `expected_tunnel` from the separately verified local backend and transport
provisioning. The worker backend must be its canonical `clsi.sock` path.
Use an operator with read access to the private listener directory for the
host check, and run it with the repository's pinned Node 24.18.1. Repeat for
the other role's engine and configuration.

```bash
relay() {
  docker --host "unix://$local_engine_socket" compose -p "$relay_project" \
    --env-file "$relay_env" -f deploy/compose.compiler-relay.yaml "$@"
}
relay config --format json |
  node deploy/compiler-relay/launch.mts --check "$expected_backend" "$expected_tunnel" &&
  relay up -d
```

Check compiler status through the app gateway. Then upload an image in the
editor, reload, recompile, and verify that the authenticated PDF contains the
image. Check that each TLS listener denies a missing or wrong peer certificate
and that the filestore path rejects unrelated requests before they reach its
backend. The status probe alone covers only the compiler direction.

## Restart and recover

Drain compilation traffic before stopping the relay projects. Stop using the
same project and environment files. Remove only stale listener sockets after
confirming the old process is gone. Keep both input sockets owned by their
provisioners. If an input is recreated, recreate the receiving relay container
so its file bind uses the new socket inode. For a compiler replacement, stop
the adapter, replace the base compiler, recreate the worker relay using the
new `clsi.sock`, then recreate the adapter using the new `filestore.sock`.
After rotating TLS files, recreate each affected relay so nginx loads the
new credentials. Recreate any consumer that mounts a replaced listener socket,
including the filestore adapter when the worker relay is recreated. Repeat
both directions' acceptance checks before restoring traffic.
