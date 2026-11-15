#!/usr/bin/env bash
# Packs the SDK, installs the tarball into a clean temp project, then imports and type-checks it there.
# Run from the repository root after `cd ts && npm ci`:  bash sdk/test-pack.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/ts" && node ../sdk/build.mjs)
TMP="$(mktemp -d)"
TGZ="$(cd "$ROOT/sdk" && npm pack --silent --pack-destination "$TMP")"
cd "$TMP"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --silent --no-audit --no-fund "./$TGZ" near-api-js@^7.5.3 typescript@^5 @types/node >/dev/null
cat > check.ts <<'TS'
import { AlmonerVault, AlmonerError, buy, setupAgent, signQuote, quoteMessage, usdc, type BuyResult, type TaskInput } from "almoner-sdk";
const v: AlmonerVault = new AlmonerVault("vault.example.testnet", "https://rpc.testnet.near.org");
const r: BuyResult | null = null;
const t: Partial<TaskInput> = { budget: usdc(1) };
export { v, r, t, AlmonerError, buy, setupAgent, signQuote, quoteMessage };
TS
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck false check.ts
node --input-type=module -e 'import * as sdk from "almoner-sdk"; const n = Object.keys(sdk).sort(); console.log(`imported ${n.length} exports: ${n.join(", ")}`); if (!sdk.buy || !sdk.AlmonerVault) process.exit(1);'
echo "pack check passed: $TGZ installed into $TMP, type-checks under --strict"
