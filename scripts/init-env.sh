#!/bin/sh
set -eu
export LC_ALL=C
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }

email=
url=http://localhost:43100
output=.env
while [ "$#" -gt 0 ]; do
  case $1 in
    --help)
      printf '%s\n' 'Usage: scripts/init-env.sh --email owner@example.com [--url https://bot.example.com] [--output .env]'
      exit 0 ;;
    --email=*|--url=*|--output=*)
      option=${1%%=*}; argument=${1#*=}; shift
      set -- "$option" "$argument" "$@"
      continue ;;
    --email|--url|--output)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail 'Missing option value.'
      case $2 in --*) fail 'Missing option value.' ;; esac
      case $1 in
        --email) email=$2 ;;
        --url) url=$2 ;;
        --output) output=$2 ;;
      esac
      shift 2 ;;
    *) fail 'Unknown argument. See --help.' ;;
  esac
done

case $email$url in *[[:space:]]*) fail 'Unexpected whitespace in email or URL.' ;; esac
printf '%s\n' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' ||
  fail 'Provide --email with your owner login email.'

# Validate the entire authority before writing it to a Compose environment file.
origin=$(printf '%s\n' "$url" | awk '
  function ipv6(host, parts, n, i, compressed) {
    sub(/^\[/, "", host); sub(/\]$/, "", host)
    compressed = sub(/::/, "@", host)
    if (host ~ /::|^:|:$|:@|@:/) return 0
    gsub(/@/, ":", host)
    sub(/^:/, "", host); sub(/:$/, "", host)
    n = split(host, parts, ":")
    for (i = 1; i <= n; i++)
      if (parts[i] !~ /^[a-f0-9]+$/ || length(parts[i]) > 4) return 0
    return compressed ? n < 8 : n == 8
  }
  {
    origin = tolower($0)
    if (origin !~ /^https?:\/\//) exit 1
    scheme = origin ~ /^https:/ ? "https" : "http"
    sub(/^https?:\/\//, "", origin); sub(/\/$/, "", origin)
    host = origin
    port = ""
    if (match(host, /:[0-9]+$/)) {
      port = substr(host, RSTART + 1) + 0
      if (port > 65535) exit 1
      host = substr(host, 1, RSTART - 1)
    }
    if (host ~ /^\[[a-f0-9:]+\]$/) {
      if (!ipv6(host)) exit 1
    } else if (host !~ /^[a-z0-9.-]+$/) exit 1
    # Numeric final labels are parsed as IPv4 by browsers. Require dotted decimal.
    if (host ~ /(^|\.)([0-9]+|0x[0-9a-f]*)\.?$/) {
      if (split(host, octets, "\\.") != 4) exit 1
      for (i = 1; i <= 4; i++)
        if (octets[i] !~ /^(0|[1-9][0-9]*)$/ || octets[i] + 0 > 255) exit 1
    }
    if (scheme == "http" && host != "localhost" && host != "127.0.0.1" && host != "[::1]") exit 1
    if (port == (scheme == "https" ? 443 : 80)) port = ""
    print scheme "://" host (length(port) ? ":" port : "")
  }') || fail 'Provide an HTTPS origin or local HTTP origin without credentials, path or query.'

case $output in /*) ;; *) output=./$output ;; esac
[ ! -e "$output" ] && [ ! -L "$output" ] || fail 'Output already exists.'
template=$(dirname "$0")/../.env.example
[ -f "$template" ] || template=${template%/*}/.env.selfhost.example
# Link a complete private file into place. Concurrent initializers cannot overwrite it.
suffix=$(openssl rand -hex 12)
temp=${output%/*}/.init-env-$suffix
mkdir "$temp"
trap 'rm -f "$temp/env"; rmdir "$temp"' 0
trap 'exit 1' HUP INT TERM
while IFS= read -r line || [ -n "$line" ]; do
  key=${line%%=*}
  case $key in
    DB_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|MINI_APP_SESSION_SECRET) value=$(openssl rand -hex 32) ;;
    PANEL_PASSWORD) value=$(openssl rand -hex 24) ;;
    AUTH_OWNER_EMAIL) value=$email ;;
    BETTER_AUTH_URL) value=$origin ;;
    NSFW_API_URL) value=http://nsfw-api:3000 ;;
    DATABASE_URL|CODING_WORKER_URL) value= ;;
    *) printf '%s\n' "$line"; continue ;;
  esac
  printf '%s=%s\n' "$key" "$value"
done < "$template" > "$temp/env"
ln "$temp/env" "$output"
printf '%s\n' 'Created Docker deployment environment (mode 0600). Read PANEL_PASSWORD locally for first login; keep ENCRYPTION_KEY stable.'
