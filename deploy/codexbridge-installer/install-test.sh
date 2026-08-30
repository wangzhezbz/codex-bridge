#!/usr/bin/env sh
set -eu

ROOT="/opt/shanhai/codexbridge-installer"
APP_ROOT="$ROOT/app"
PRIVATE_ROOT="$ROOT/private"
PUBLIC_ROOT="$ROOT/public"
WORK_ROOT="$ROOT/work"
TRUST_ROOT="$ROOT/trust"
RUNTIME_BIN="$ROOT/runtime/node/bin"
TRUST_CERT="$TRUST_ROOT/microsoft-identity-verification-root-ca-2020.pem"
V2RAYN_KEY_ASC="$TRUST_ROOT/v2rayn-fqfqgo-public-key.asc"
V2RAYN_KEYRING="$TRUST_ROOT/v2rayn-fqfqgo-keyring.gpg"
V2RAYN_KEY_FINGERPRINT="A4A69C432C532A5F21D0B6EE14162A209ADA306B"
PRIVATE_KEY="$PRIVATE_ROOT/catalog-signing-private.pem"
PUBLIC_KEY="$PRIVATE_ROOT/catalog-signing-public.pem"
ENV_FILE="$PRIVATE_ROOT/publisher.env"
DOGECLOUD_ENV_FILE="$PRIVATE_ROOT/dogecloud.env"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
TRUST_CERT_SOURCE="$SCRIPT_DIR/microsoft-identity-verification-root-ca-2020.pem"
V2RAYN_KEY_SOURCE="$SCRIPT_DIR/v2rayn-fqfqgo-public-key.asc"
TRUST_CERT_SHA1="F40042E2E5F7E8EF8189FED15519AECE42C3BFA2"

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

for target in "$ROOT" "$APP_ROOT" "$PRIVATE_ROOT" "$PUBLIC_ROOT" "$WORK_ROOT" "$TRUST_ROOT" "$RUNTIME_BIN" "$TRUST_CERT" "$V2RAYN_KEY_ASC" "$V2RAYN_KEYRING" "$PRIVATE_KEY" "$PUBLIC_KEY" "$ENV_FILE" "$DOGECLOUD_ENV_FILE"; do
  assert_new_root_path "$target"
done

for command in realpath openssl nginx systemctl install osslsigncode gpg gpgv cut tr python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done

[ -x "$RUNTIME_BIN/node" ] || { echo "missing isolated Node runtime: $RUNTIME_BIN/node" >&2; exit 1; }
[ -x "$RUNTIME_BIN/npm" ] || { echo "missing isolated npm runtime: $RUNTIME_BIN/npm" >&2; exit 1; }
node_major="$($RUNTIME_BIN/node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -eq 24 ] || { echo "isolated Node runtime must be Node.js 24" >&2; exit 1; }
PATH="$RUNTIME_BIN:$PATH" "$RUNTIME_BIN/npm" --version >/dev/null
python3 -c 'import boto3, botocore' >/dev/null
SEVEN_ZIP="$APP_ROOT/node_modules/7zip-bin/linux/x64/7za"
[ -f "$SEVEN_ZIP" ] || { echo "missing Linux x64 7zip helper: $SEVEN_ZIP" >&2; exit 1; }
chmod 0755 "$SEVEN_ZIP"
[ -x "$SEVEN_ZIP" ] || { echo "Linux x64 7zip helper is not executable" >&2; exit 1; }

install -d -m 0755 "$ROOT" "$APP_ROOT" "$PUBLIC_ROOT" "$PUBLIC_ROOT/packages"
install -d -m 0755 "$TRUST_ROOT"
install -d -m 0700 "$PRIVATE_ROOT" "$WORK_ROOT"
install -m 0644 "$TRUST_CERT_SOURCE" "$TRUST_CERT"
install -m 0644 "$V2RAYN_KEY_SOURCE" "$V2RAYN_KEY_ASC"
trust_fingerprint="$(openssl x509 -in "$TRUST_CERT" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')"
[ "$trust_fingerprint" = "$TRUST_CERT_SHA1" ] || { echo "Microsoft code-signing root fingerprint mismatch" >&2; exit 1; }
install -d -m 0700 "$PRIVATE_ROOT/gpg"
gpg --batch --no-options --homedir "$PRIVATE_ROOT/gpg" --no-default-keyring --keyring "$V2RAYN_KEYRING" --import "$V2RAYN_KEY_ASC" >/dev/null 2>&1
v2rayn_fingerprint="$(gpg --batch --no-options --homedir "$PRIVATE_ROOT/gpg" --no-default-keyring --keyring "$V2RAYN_KEYRING" --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')"
[ "$v2rayn_fingerprint" = "$V2RAYN_KEY_FINGERPRINT" ] || { echo "V2RayN signing key fingerprint mismatch" >&2; exit 1; }
chmod 0644 "$V2RAYN_KEYRING"

umask 077
if [ ! -f "$PRIVATE_KEY" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$PRIVATE_KEY"
  chmod 0600 "$PRIVATE_KEY"
fi
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY"
chmod 0644 "$PUBLIC_KEY"

{
  printf '%s\n' "CBI_SIGNING_KEY_FILE=$PRIVATE_KEY"
  printf '%s\n' "CBI_PUBLIC_ROOT=$PUBLIC_ROOT"
  printf '%s\n' "CBI_PACKAGE_BASE_URL=https://download.shanhaiyouling.com/codexbridge-test/packages/"
  printf '%s\n' "CBI_SYNC_WORK_ROOT=$WORK_ROOT"
  printf '%s\n' "CBI_SYNC_STATUS_FILE=$WORK_ROOT/sync-status.json"
  printf '%s\n' "CBI_OSSLSIGNCODE_PATH=/usr/bin/osslsigncode"
  printf '%s\n' "CBI_OSSLSIGNCODE_CA_FILE=$TRUST_CERT"
  printf '%s\n' "CBI_GPGV_PATH=/usr/bin/gpgv"
  printf '%s\n' "CBI_V2RAYN_KEYRING=$V2RAYN_KEYRING"
  printf '%s\n' "CBI_DOGECLOUD_BUCKET=codex"
  printf '%s\n' "CBI_DOGECLOUD_PYTHON=/usr/bin/python3"
  printf '%s\n' "CBI_DOGECLOUD_UPLOADER=$APP_ROOT/deploy/codexbridge-installer/dogecloud_uploader.py"
  printf '%s\n' "CBI_SYNC_PROGRESS=1"
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"

[ -f "$DOGECLOUD_ENV_FILE" ] || {
  echo "missing root-only DogeCloud credentials: $DOGECLOUD_ENV_FILE" >&2
  exit 1
}
chmod 0600 "$DOGECLOUD_ENV_FILE"

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
