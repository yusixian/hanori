#!/bin/sh
set -eu

: "${CODING_WORKER_SECRET:?CODING_WORKER_SECRET is required}"

job_root=/job
control_root=/coding-control

# These mount roots are broker-owned. Pi receives only the staged workspace below /job.
chown root:root "$job_root"
chmod 0711 "$job_root"

# A previous job can create entries here, but the trusted root entrypoint repairs the
# control channel before every boot and Pi cannot chmod the root-owned directory itself.
find "$control_root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
chown root:node "$control_root"
chmod 0770 "$control_root"

su-exec node:node sh -c 'umask 077; printf "%s" "$CODING_WORKER_SECRET" > /tmp/coding-worker-secret'

# Compose must not add an outer init process: this tini becomes PID 1 only after the
# secret has left the environment. Node then reads and removes the one-time file.
exec env -u CODING_WORKER_SECRET su-exec node:node tini -g -- "$@"
