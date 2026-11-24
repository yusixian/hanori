#!/bin/sh
set -eu
export LC_ALL=C
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }

directory=./hanori
email=
url=http://localhost:43100
tag=latest
ref=main
source_dir=

while [ "$#" -gt 0 ]; do
  case $1 in
    --help)
      cat <<'EOF'
Usage: sh install.sh [--dir ./hanori] [--email owner@example.com]
                     [--url http://localhost:43100] [--tag latest]
                     [--ref main] [--source-dir local-repository]

Provide --email on first install. Existing configuration is kept.
Use --source-dir with a trusted checkout to install without downloading.
EOF
      exit 0 ;;
    --dir|--email|--url|--tag|--ref|--source-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail 'Missing option value. See --help.'
      case $2 in --*) fail 'Missing option value. See --help.' ;; esac
      case $1 in
        --dir) directory=$2 ;;
        --email) email=$2 ;;
        --url) url=$2 ;;
        --tag) tag=$2 ;;
        --ref) ref=$2 ;;
        --source-dir) source_dir=$2 ;;
      esac
      shift 2 ;;
    *) fail 'Unknown argument. See --help.' ;;
  esac
done

case $tag in
  [.-]*|*[!a-zA-Z0-9_.-]*) fail 'Invalid Docker image tag.' ;;
esac
[ "${#tag}" -le 128 ] || fail 'Invalid Docker image tag.'
case $ref in
  /*|*/|*//*|*..*|*[!a-zA-Z0-9._/-]*) fail 'Invalid Git ref.' ;;
esac
case /$ref/ in */./*|*/.git/*) fail 'Invalid Git ref.' ;; esac

command -v openssl >/dev/null 2>&1 || fail 'Install OpenSSL first.'
if [ -n "$source_dir" ]; then
  case $source_dir in /*) ;; *) source_dir=$PWD/$source_dir ;; esac
  [ -d "$source_dir" ] || fail 'Source directory does not exist.'
else
  command -v curl >/dev/null 2>&1 || fail 'Install curl or use --source-dir.'
fi

case $directory in /*) ;; *) directory=./$directory ;; esac
mkdir -p "$directory"
cd -P "$directory"

for path in .env .env.selfhost.example docker-compose.prebuilt.yml scripts/init-env.sh; do
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then
    fail "Expected a regular file at $path."
  fi
done
[ ! -L scripts ] || fail 'Expected a regular scripts directory.'
[ -f .env ] || [ -n "$email" ] || fail 'Provide --email on first install.'

suffix=$(openssl rand -hex 12)
stage=./.hanori-install-$suffix
mkdir "$stage"
trap 'rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
mkdir "$stage/scripts"

fetch() {
  if [ -n "$source_dir" ]; then
    cp "$source_dir/$1" "$stage/$1"
  else
    curl -q -fsSL --proto '=https' --proto-redir '=https' --max-time 60 \
      -o "$stage/$1" "https://raw.githubusercontent.com/yusixian/hanori/$ref/$1"
  fi || fail "Could not obtain $1."
  [ -s "$stage/$1" ] || fail "Empty source file: $1."
}

for path in docker-compose.prebuilt.yml .env.selfhost.example scripts/init-env.sh; do
  if [ ! -f "$path" ] || [ ! -f .env ]; then
    fetch "$path"
  fi
done

if [ ! -f .env ]; then
  # Older refs only look for .env.example beside the scripts directory.
  ln "$stage/.env.selfhost.example" "$stage/.env.example"
  sh "$stage/scripts/init-env.sh" --email "$email" --url "$url" \
    --output "$stage/.env" >/dev/null
  printf 'HANORI_IMAGE_TAG=%s\n' "$tag" >> "$stage/.env"
else
  printf '%s\n' 'Keeping existing .env (email, URL and image tag unchanged).'
fi

publish() {
  [ -f "$1" ] && return
  # Give ln the parent directory so a destination symlink cannot redirect the write.
  ln "$stage/$1" "$2"
}

mkdir -p scripts
publish docker-compose.prebuilt.yml .
publish .env.selfhost.example .
if [ ! -f scripts/init-env.sh ]; then
  chmod 700 "$stage/scripts/init-env.sh"
  publish scripts/init-env.sh scripts
fi
if [ -f "$stage/.env" ]; then
  publish .env .
  printf '%s\n' 'Read PANEL_PASSWORD from .env locally for first login.'
fi

printf '\nIn %s, run:\n' "$PWD"
printf '%s\n' \
  '  docker compose -f docker-compose.prebuilt.yml up -d' \
  '  curl -fsS http://127.0.0.1:43100/api/health/ready'
