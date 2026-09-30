#!/usr/bin/env bash
# A self-signed code-signing certificate for test MSIX builds (PLAN Phase 8), made with OpenSSL.
# Nothing is added to any Windows certificate store. Output goes OUTSIDE the repo:
#   <dir>/chief-test-signing.pfx   signing key + certificate (keep private)
#   <dir>/chief-test-signing.cer   public certificate: the one a tester trusts to install the test build
#   <dir>/chief-test-signing.password
# Usage: make-test-cert.sh <dir> ["CN=Chief Command Center Test"]
set -euo pipefail
dir="${1:?output folder outside the repo}"
subject="${2:-CN=Chief Command Center Test}"
openssl="${OPENSSL:-openssl}"
mkdir -p "$dir"
umask 077
password="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
printf '%s' "$password" > "$dir/chief-test-signing.password"
MSYS_NO_PATHCONV=1 "$openssl" req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" -subj "/${subject}" \
  -addext "extendedKeyUsage=codeSigning" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature"
"$openssl" pkcs12 -export -out "$dir/chief-test-signing.pfx" -inkey "$dir/key.pem" -in "$dir/cert.pem" -passout "pass:$password"
"$openssl" x509 -in "$dir/cert.pem" -outform der -out "$dir/chief-test-signing.cer"
rm -f "$dir/key.pem"
echo "subject: $subject"
"$openssl" x509 -in "$dir/cert.pem" -noout -fingerprint -sha256
