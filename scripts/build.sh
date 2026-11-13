#!/usr/bin/env bash
# Build both contracts to wasm and copy them into ./wasm (where bootstrap looks first).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p wasm
if command -v cargo-near >/dev/null 2>&1; then
  for c in vault test-token; do
    (cd "contracts/$c" && cargo near build non-reproducible-wasm --no-abi)
  done
else
  echo "cargo-near not found: using plain cargo (install it with: cargo install --locked cargo-near)"
  rustup target add wasm32-unknown-unknown >/dev/null
  cargo build --release --target wasm32-unknown-unknown -p almoner-vault -p almoner-test-usdc
fi
for n in almoner_vault almoner_test_usdc; do
  f=$(find target -name "$n.wasm" -path "*near*" 2>/dev/null | head -1)
  [ -z "$f" ] && f="target/wasm32-unknown-unknown/release/$n.wasm"
  cp "$f" "wasm/$n.wasm"
  echo "wasm/$n.wasm  $(wc -c < "wasm/$n.wasm") bytes  sha256 $(sha256sum "wasm/$n.wasm" | cut -c1-16)…"
done
