# Deploy this Overleaf fork with Docker Compose

Run a dedicated Compose project on a Linux Docker host. The default stack uses
this fork, MongoDB and Redis. It publishes HTTP on `127.0.0.1:8080` and gives
each project its own data volumes. Use trusted accounts only because
compilation runs inside the application container. For a separate worker, see
the [isolated compiler Compose guide](COMPILER.md). Git and provider
connections are configured separately.

Use Docker Engine 28 or newer for the localhost binding and a Compose v2
plugin with support for `up --wait`. Use a BuildKit-capable Docker setup if
building the app image. Match the image platform to the destination host.
Lab image qualification used Linux amd64. Check the destination CPU and kernel
against the MongoDB version you select. Allow room for the images, four
persistent volumes and a separate recovery copy. See the [Docker port publishing
reference][ports], [Compose CLI reference][compose-up] and [MongoDB production
notes][mongo-notes].

[ports]: https://docs.docker.com/engine/network/port-publishing/
[compose-up]: https://docs.docker.com/reference/cli/docker/compose/up/
[mongo-notes]: https://www.mongodb.com/docs/v8.0/administration/production-notes/

## 1. Obtain the images

Use the images recorded in a verified backup or build the fork from a reviewed
Git revision. Compose requires explicit image references already present on
the host. The examples below record Docker content IDs and can be run from
the root of the fork checkout in Bash.

### Build the app image

The two Dockerfiles build the TeX Live base and then Overleaf. Export tracked
files into a temporary context, so files from the working tree such as
credentials, build outputs or project data cannot enter the build.

```bash
set -euo pipefail
revision=$(git rev-parse HEAD)
build_context=$(mktemp -d)
git archive "$revision" | tar -x -C "$build_context"
cp "$build_context/server-ce/.dockerignore" "$build_context/.dockerignore"
base_tag="overleaf-base:local-$revision"
app_tag="overleaf-ce-plus:local-$revision"
docker build --file "$build_context/server-ce/Dockerfile-base" \
  --tag "$base_tag" "$build_context"
docker build --file "$build_context/server-ce/Dockerfile" \
  --build-arg "OVERLEAF_BASE_TAG=$base_tag" \
  --label "com.overleaf.ce.revision=$revision" \
  --tag "$app_tag" "$build_context"
docker image inspect --format '{{.Id}} {{index .Config.Labels "com.overleaf.ce.revision"}}' "$app_tag"
```

The revision identifies the source. The build also uses upstream image,
package and TeX repositories whose contents can change. Record the resulting
image ID and keep an archive when you need to reproduce the exact deployment.

For a fresh installation, select reviewed MongoDB and Redis images. The
original Compose example uses the MongoDB 8.0 and Redis 6.2 lines. The next
commands select their current artifacts explicitly and record the pulled IDs.
For recovery, use the original backup IDs and database versions.

```bash
docker pull mongo:8.0
docker pull redis:6.2
docker image inspect --format '{{.Id}}' "$app_tag" mongo:8.0 redis:6.2
```

### Load a verified image archive

Use an archive from the original deployment with its expected checksum and
image IDs. For the archive format below, run from the protected backup
directory and compare all three IDs with the saved runtime configuration.

```bash
sha256sum --check SHA256SUMS
docker image load --input images.tar
docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' \
  "$app_image_id" "$mongo_image_id" "$redis_image_id"
```

Set the shell variables to the three expected IDs from the backup first.
Use a checksum received through your trusted backup channel.

## 2. Configure the deployment

Choose an operator-owned configuration directory outside the checkout. The
examples use `/etc/overleaf-portable`. Run with an account authorized to
manage its parent directory and Docker. Create the files once and retain the
same secret values through restarts and upgrades.

```bash
config_dir=/etc/overleaf-portable
(
  set -eu
  umask 077
  mkdir "$config_dir"
  install -m 0600 deploy/runtime.env.example "$config_dir/runtime.env"
  install -m 0600 deploy/app.env.example "$config_dir/app.env"
)
```

In `runtime.env`, set `OVERLEAF_IMAGE`, `MONGO_IMAGE` and `REDIS_IMAGE`
to the verified references and `OVERLEAF_APP_ENV_FILE` to the absolute
path of `app.env`. Set `OVERLEAF_HTTP_PORT` if you need a different
available loopback port. In `app.env`, set the matching
`OVERLEAF_SITE_URL`, the administrator's email and two distinct persistent
secrets. Generate one value for each secret with `openssl rand -hex 32`
in a private terminal. HTTP requires leaving `OVERLEAF_SECURE_COOKIE`
absent. The app treats any value for that setting as enabled.

From the checkout root, use a fixed project name and explicit file paths for
all commands. Clear these overrides from your shell so the runtime file
supplies the values.

```bash
unset OVERLEAF_IMAGE MONGO_IMAGE REDIS_IMAGE OVERLEAF_APP_ENV_FILE OVERLEAF_HTTP_PORT
dc() {
  docker compose -p overleaf --env-file "$config_dir/runtime.env" -f compose.yaml "$@"
}
dc config --quiet
```

Use `config --quiet` for validation because the expanded configuration can
include secret values.

## 3. Start and create the administrator

Start MongoDB and Redis first. Wait for MongoDB to respond, then initialize a
single-member replica set if it has none. A restored replica set must retain
its name and member address. This sequence works for both a new and a
restored database.

```bash
(
  set -e
  dc up -d mongo redis
  mongo_ready=false
  for attempt in $(seq 1 40); do
    if dc exec -T mongo mongosh --quiet --eval \
      'quit(db.runCommand({ping:1}).ok === 1 ? 0 : 1)' >/dev/null 2>&1; then
      mongo_ready=true
      break
    fi
    sleep 2
  done
  if [ "$mongo_ready" != true ]; then
    printf '%s\n' 'MongoDB did not respond. Check its container before initialising it.' >&2
    exit 1
  fi
  dc exec -T mongo mongosh --quiet --eval \
    'try {
       const config = rs.conf()
       if (config._id !== "rs0" || config.members.length !== 1 || config.members[0].host !== "mongo:27017") quit(1)
     } catch (error) {
       if (error.code !== 94) throw error
       if (rs.initiate({_id:"rs0", members:[{_id:0, host:"mongo:27017"}]}).ok !== 1) quit(1)
     }'
  dc up -d --wait --wait-timeout 300
  dc ps
)
```

The application waits for MongoDB to become primary and Redis to respond. If
any of the commands fails, diagnose the reported service before moving on.

On a new database, enter the approved administrator's email into
`admin_email` and run the account CLI. Save the output to a new protected file
because it contains a one-use setup URL. On a restored database, sign in with
an existing account.

```bash
(
  set -e -C
  umask 077
  dc exec -T -w /overleaf/services/web sharelatex /bin/bash -c \
    'source /etc/overleaf/env.sh || exit 1
     export LISTEN_ADDRESS=127.0.0.1 ENABLED_SERVICES=web WEB_PORT=4000
     exec /sbin/setuser www-data node modules/server-ce-scripts/scripts/create-user.mjs "$@"' \
    bootstrap --admin --email="$admin_email" > "$config_dir/admin-activation.txt"
)
```

Open the setup URL privately. The same command without `--admin` creates a
regular account. The app blocks public signup and web bootstrap. For a
remote server, an SSH tunnel can bring the server's loopback port to the same
port on your workstation. Set the site URL to match the browser address.

Before use, verify `/status`, that `/launchpad` and `/register` return 404,
that the approved account can sign in, and that two trusted users can save
and reconnect to a test project. Compile a small LaTeX project and open the
PDF. For routine downtime, use `dc stop` and restart with
`dc up -d --wait --wait-timeout 300`.

### Optional HTTPS

Keep the Compose port on loopback and terminate TLS at your server's reverse
proxy. Set `OVERLEAF_SITE_URL` to the final HTTPS origin in `app.env` and
include `-f deploy/compose.https.yaml` after `-f compose.yaml` in the
`dc` function. Use that same file list for subsequent commands.

For an Nginx TLS virtual host configured with your own certificate and host
name, forward to the configured loopback port. This example assumes clients
connect directly to that Nginx instance.

```nginx
client_max_body_size 50m;
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_buffering off;
}
```

If you require accurate client addresses, set `OVERLEAF_TRUSTED_PROXY_IPS`
to include loopback and only the proxy addresses that the application
actually sees. Validate the proxy configuration before reloading it. Test
HTTPS login, secure cookies, WebSocket reconnect and a real compile at the
public origin. Restrict proxy access to approved users or networks.

## 4. Back up and restore

This cold backup covers the default three-service project. It retains the
application store, both MongoDB paths, Redis, the image set and deployment
configuration. Use the same Compose files and project selection as the
running instance. Keep the backup encrypted and access-restricted and store
a verified copy on independent storage.

Before stopping the stack, record the checkout revision, project name,
enabled Compose overlays, reverse proxy configuration and actual container
image IDs. Save the overlay file list and proxy configuration alongside the
backup. Preserve any TLS recovery material in protected backup storage if
this instance uses HTTPS. Set `app_image_id`, `mongo_image_id` and `redis_image_id` to
those IDs. For each service, use
`docker inspect --format '{{.Image}}' "$(dc ps -q SERVICE)"`. The example
creates a new backup directory under an existing protected backup root.

```bash
set -euo pipefail
umask 077
backup=$(mktemp -d /path/to/backup-root/overleaf.XXXXXXXX)
git rev-parse HEAD > "$backup/revision"
cp "$config_dir/runtime.env" "$config_dir/app.env" "$backup/"
printf '%s\n' "$app_image_id" "$mongo_image_id" "$redis_image_id" > "$backup/image-ids"
docker image save --output "$backup/images.tar" "$app_image_id" "$mongo_image_id" "$redis_image_id"

dc stop sharelatex
dc stop mongo redis
running=$(dc ps -q --status running sharelatex mongo redis)
test -z "$running"
archive() {
  dc run -T --rm --no-deps --user 0:0 --entrypoint /bin/tar "$1" \
    --numeric-owner -cpf - -C "$2" . > "$backup/$3"
}
archive sharelatex /var/lib/overleaf overleaf.tar
archive mongo /data/db mongo.tar
archive mongo /data/configdb mongo-configdb.tar
archive redis /data redis.tar
(
  cd "$backup"
  sha256sum revision runtime.env app.env image-ids images.tar \
    overleaf.tar mongo.tar mongo-configdb.tar redis.tar > SHA256SUMS
  sha256sum --check SHA256SUMS
)
dc up -d --wait --wait-timeout 300
```

If an export fails, keep the partial backup separate from accepted copies.
Check the original project's state before starting it again. Only a restore
with working data and a functional smoke test verifies recovery.

To restore, verify the backup and load its images. Check out the saved
revision in a separate directory. Copy `app.env` and `runtime.env` to a
separate protected configuration directory. In the copies, keep the secrets
and image IDs, set `OVERLEAF_APP_ENV_FILE` to the new file, and choose a
different loopback port and matching HTTP site URL. Remove any
`OVERLEAF_SECURE_COOKIE` setting for this private HTTP restore. For a test restore leave public DNS and proxy routes alone. The example
below expects the copies in `/etc/overleaf-restore` and a fresh project
name. Set `backup` to the absolute path of the verified backup directory.

Run from the restored checkout. These commands check the backup again,
refuse an existing project, create the volumes and extract
only into empty mount points, before running MongoDB, Redis or the app.

```bash
set -euo pipefail
restore_project=overleaf-restore
restore_dc() {
  docker compose -p "$restore_project" --env-file /etc/overleaf-restore/runtime.env -f compose.yaml "$@"
}
(cd "$backup" && sha256sum --check SHA256SUMS)
restore_dc config --quiet
existing_containers=$(restore_dc ps -aq)
existing_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$restore_project")
test -z "$existing_containers"
test -z "$existing_volumes"
restore() {
  restore_dc run -T --rm --no-deps --user 0:0 --entrypoint /bin/sh "$1" \
    -ec 'existing=$(ls -A -- "$1"); test -z "$existing"; exec tar --numeric-owner -xpf - -C "$1"' \
    sh "$2" < "$backup/$3"
}
restore sharelatex /var/lib/overleaf overleaf.tar
restore mongo /data/db mongo.tar
restore mongo /data/configdb mongo-configdb.tar
restore redis /data redis.tar
```

Use the start sequence in step 3 with `restore_dc`. Check login, source,
assets, comments and history for representative projects, then edit,
reconnect and compile a PDF on the restored instance. A separate project
name and port let you verify the restore before moving traffic.

For an upgrade, first take and test a cold backup from the currently serving
image and state. Upgrade a separate restore and test it there. If deployment
fails, route traffic back to the retained old project, or restore the
pre-upgrade backup into new volumes with its recorded image IDs and config.
A prior image needs its matching pre-upgrade state. Keep the failed and old
volumes until the rollback window closes.

## LOPE deployments

`deploy/compose.lope.yaml` is an optional bind-mount overlay for
`/srv/lope/services/overleaf`. Precreate and verify the intended directories
and filesystem before using it. Keep deployed code under
`/opt/lope/services/overleaf`, nonsecret config under
`/etc/lope/services/overleaf`, and secrets under
`/etc/lope/secrets/overleaf`. The [lab operations guide](../docs/lope/OPERATIONS.md)
points to the separately managed runtime and backup procedures.
