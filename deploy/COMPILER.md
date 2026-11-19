# Run the isolated Overleaf compiler with Docker Compose

Use `compose.compiler.yaml` as a separate Compose project on a dedicated
Linux worker host or VM. It starts the standalone compiler under UID/GID 33,
with a read-only filesystem, AppArmor, no capabilities and no network. The
optional filestore adapter shares the compiler's isolated loopback network.
The application and database remain in their own deployment.

## Prepare the dedicated daemon and images

Use a daemon dedicated to compiler work with the
`org.lope.overleaf.compiler-worker=dedicated` label, systemd cgroups v2,
AppArmor and seccomp. Provision the daemon and its containers under one
bounded parent slice. Verify the effective aggregate memory, swap, CPU and
PID limits on the destination kernel. The Compose limits cover the worker
controller and adapter. The worker sets separate limits on the jobs it starts.

Place the daemon's Unix socket at `docker.sock` in a private runtime
directory owned by the worker UID. Keep the runtime and state directories
separate. Give the controller access to the socket through its supplemental
group. The runtime directory also holds the worker's `clsi.sock` and
`manager.sock`. Every worker connected to this daemon must see the same
directory so it sees the same lease. The web app, the filestore adapter and
individual TeX jobs each run without a mount of the daemon socket.

Build an app image from the reviewed fork revision using the
[portable image instructions](README.md#1-obtain-the-images), or load a
verified archive. Record the exact runtime and TeX image IDs in the
dedicated daemon. The runtime image supplies Node, the worker entrypoint and
the optional nginx adapter. The TeX image supplies the tools in the selected
compiler profile. Preload both images before starting the worker.

## Configure and start

Provision a protected Compose environment file with these values. Use absolute
paths outside the checkout. The directory and file mounts must already exist.

| Setting                         | Value                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPILER_WORKER_IMAGE`         | Verified runtime image content ID (`sha256:…`).                                                                                        |
| `COMPILER_RUNTIME_DIR`          | Private directory containing the dedicated daemon's `docker.sock`.                                                                     |
| `COMPILER_STATE_DIR`            | Separate private directory containing `operations`, `plans` and `published`. Keep `operations` and `published` on the same filesystem. |
| `COMPILER_CONFIG_FILE`          | Protected, regular worker JSON file readable by UID 33.                                                                                |
| `COMPILER_DOCKER_GID`           | Numeric group of the dedicated daemon socket.                                                                                          |
| `COMPILER_FILESTORE_SOCKET_DIR` | Private directory containing the optional filestore relay's `filestore.sock`, accessible to UID 33.                                    |

Create the runtime and state trees with mode `0700` for the worker UID. The
launcher verifies the settings filename, ownership and writable ancestry. The
worker checks that the configured daemon ID matches the live daemon. Record
that ID from `docker --host "unix://$dedicated_socket" info --format '{{.ID}}'`.
For the standard TeX image layout, use this JSON shape and substitute the
observed daemon ID, TeX image ID, profile alias and app-local compiler origin.

```json
{
  "runtimeRoot": "/worker/runtime",
  "stateRoot": "/worker/state",
  "dockerSocket": "/worker/runtime/docker.sock",
  "daemonId": "REPLACE_WITH_DEDICATED_DAEMON_ID",
  "profile": {
    "id": "standard",
    "image": "REPLACE_WITH_VERIFIED_TEX_IMAGE_ID",
    "aliases": ["tex-live:approved"],
    "variant": "standard",
    "texBinDirectory": "/usr/local/bin",
    "tools": {
      "latexmk": "/usr/local/bin/latexmk",
      "texcount": "/usr/local/bin/texcount",
      "synctex": "/usr/local/bin/synctex"
    }
  },
  "downloadHost": "http://127.0.0.1:37499",
  "outputUrlPrefix": ""
}
```

Use the same app-local gateway origin in the web app's `apis.clsi.url` and
`apis.clsi.downloadHost`. If the web app selects an image by name, use an
exact alias from the worker profile. The private gateway forwards compiler
and output requests to the worker's `clsi.sock` through a worker-side relay
authorized to open that mode-`0600` socket. Give the web app and any
network-facing gateway only the protected relay endpoint. Keep the combined
daemon and worker runtime directory on the worker side. Authenticate the
peers across the transport. Users retrieve PDFs through the web app's
authenticated download route.

The [private relay Compose guide](COMPILER-RELAY.md) provides mutually
authenticated web and worker endpoints for this transport.

Run the following from the repository root with `dedicated_socket`,
`compiler_env` and `compiler_project` set to the verified daemon socket, the
protected environment file and the dedicated fixture project name.

```bash
compiler() {
  docker --host "unix://$dedicated_socket" compose -p "$compiler_project" \
    --env-file "$compiler_env" -f deploy/compose.compiler.yaml "$@"
}
compiler config --quiet
compiler up -d --wait
```

The status check runs over the worker's Unix socket and succeeds when the
worker has finished its initial reconciliation. Then compile a synthetic
project through the authenticated web flow and verify the returned PDF.

## Optional image and binary file inputs

Without `filestoreBridge` in the worker settings, URL-backed compile resources
are refused. For projects with binary files, provision an authenticated relay
that accepts HTTP over `filestore.sock` in `COMPILER_FILESTORE_SOCKET_DIR`
and reaches the app's filestore. Create the socket before starting Compose.
Use a real Unix socket owned by UID 33 in its own protected directory. Compose
binds only that socket into the adapter. Keep TLS keys and authentication in
the relay provisioner.

Set the exact origin used by the app to generate its filestore blob URLs.
The stock app setting uses `http://127.0.0.1:3009`. Use the adapter's fixed
loopback listener as `proxyOrigin`.

```json
{
  "filestoreBridge": {
    "sourceOrigin": "http://127.0.0.1:3009",
    "proxyOrigin": "http://127.0.0.1:37431"
  }
}
```

Add this field to the worker JSON and include
`-f deploy/compose.compiler-filestore.yaml` after the base file in **every**
Compose command for that project. The adapter forwards only canonical project
and global history blob GETs over its Unix socket. Match the relay's allowed
routes to that scope and keep redirect following disabled. Verify that a
browser upload survives reload, compiles, and appears in the downloaded PDF.

## Stop, replace and recover

Drain new compile traffic before stopping the project. Record the controller
container ID, stop the project without removing containers, and verify the
controller exited with status zero and removed its two sockets. Then run
`compiler down` using the same Compose files. The daemon service and host
directories remain available for diagnosis and recovery.

With the adapter overlay, recreate both containers together after a worker
upgrade, since they share a network namespace. If the filestore relay replaces
its socket, recreate the adapter so it binds the new socket inode.

After an abrupt stop, a stale socket requires an operator check. Verify the
old controller and its listener have exited, then move only its two stale
socket paths out of the runtime directory. Preserve `docker.sock` and the
worker state. Starting the same verified profile reconciles owned job objects
before accepting requests. Confirm that the worker is ready and compile a
synthetic project before restoring traffic. Keep the previous verified images
and settings available to roll back a worker upgrade.
