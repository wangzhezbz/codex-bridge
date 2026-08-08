#!/usr/bin/env sh
set -eu

ROOT="/opt/shanhai/codexbridge-installer"
APP_ROOT="$ROOT/app"
PRIVATE_ROOT="$ROOT/private"
PUBLIC_ROOT="$ROOT/public"
WORK_ROOT="$ROOT/work"
RUNTIME_BIN="$ROOT/runtime/node/bin"
PRIVATE_KEY="$PRIVATE_ROOT/catalog-signing-private.pem"
PUBLIC_KEY="$PRIVATE_ROOT/catalog-signing-public.pem"
ENV_FILE="$PRIVATE_ROOT/publisher.env"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

if [ "$(id -u)" -ne 0 ]; then
  echo "install-test.sh must run as root" >&2
  exit 1
fi

assert_new_root_path() {
  resolved="$(realpath -m -- "$1")"
  case "$resolved" in
    "$ROOT"|"$ROOT"/*) ;;
    *) echo "path escapes isolated root: $resolved" >&2; exit 1 ;;
  esac
}

for target in "$ROOT" "$APP_ROOT" "$PRIVATE_ROOT" "$PUBLIC_ROOT" "$WORK_ROOT" "$RUNTIME_BIN" "$PRIVATE_KEY" "$PUBLIC_KEY" "$ENV_FILE"; do
  assert_new_root_path "$target"
done

for command in realpath openssl nginx systemctl install osslsigncode; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done

[ -x "$RUNTIME_BIN/node" ] || { echo "missing isolated Node runtime: $RUNTIME_BIN/node" >&2; exit 1; }
[ -x "$RUNTIME_BIN/npm" ] || { echo "missing isolated npm runtime: $RUNTIME_BIN/npm" >&2; exit 1; }
node_major="$($RUNTIME_BIN/node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -eq 24 ] || { echo "isolated Node runtime must be Node.js 24" >&2; exit 1; }
PATH="$RUNTIME_BIN:$PATH" "$RUNTIME_BIN/npm" --version >/dev/null
SEVEN_ZIP="$APP_ROOT/node_modules/7zip-bin/linux/x64/7za"
[ -f "$SEVEN_ZIP" ] || { echo "missing Linux x64 7zip helper: $SEVEN_ZIP" >&2; exit 1; }
chmod 0755 "$SEVEN_ZIP"
[ -x "$SEVEN_ZIP" ] || { echo "Linux x64 7zip helper is not executable" >&2; exit 1; }

install -d -m 0755 "$ROOT" "$APP_ROOT" "$PUBLIC_ROOT" "$PUBLIC_ROOT/packages"
install -d -m 0700 "$PRIVATE_ROOT" "$WORK_ROOT"

umask 077
if [ ! -f "$PRIVATE_KEY" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$PRIVATE_KEY"
  chmod 0600 "$PRIVATE_KEY"
fi
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY"
chmod 0644 "$PUBLIC_KEY"

if [ ! -f "$ENV_FILE" ]; then
  {
    printf '%s\n' "CBI_SIGNING_KEY_FILE=$PRIVATE_KEY"
    printf '%s\n' "CBI_PUBLIC_ROOT=$PUBLIC_ROOT"
    printf '%s\n' "CBI_PACKAGE_BASE_URL=https://shanhaiyouling.com/codexbridge-test/packages/"
    printf '%s\n' "CBI_SYNC_WORK_ROOT=$WORK_ROOT"
    printf '%s\n' "CBI_OSSLSIGNCODE_PATH=/usr/bin/osslsigncode"
  } > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

install -m 0644 "$SCRIPT_DIR/codexbridge-installer-sync.service" /etc/systemd/system/codexbridge-installer-sync.service
install -m 0644 "$SCRIPT_DIR/codexbridge-installer-sync.timer" /etc/systemd/system/codexbridge-installer-sync.timer
install -m 0644 "$SCRIPT_DIR/nginx-test-location.conf" /etc/nginx/snippets/codexbridge-installer-test.conf

nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl enable --now codexbridge-installer-sync.timer

printf '%s\n' 'CATALOG_PUBLIC_KEY_SPKI_BEGIN'
openssl pkey -in "$PRIVATE_KEY" -pubout
printf '%s\n' 'CATALOG_PUBLIC_KEY_SPKI_END'
fingerprint="$(openssl pkey -in "$PRIVATE_KEY" -pubout -outform DER | openssl dgst -sha256 | awk '{print $NF}')"
printf 'CATALOG_PUBLIC_KEY_SHA256=%s\n' "$fingerprint"
