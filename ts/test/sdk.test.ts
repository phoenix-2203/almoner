// Cross-language checks: the TypeScript SDK must produce exactly what the Rust
// contract verifies. The fixture written here is consumed by the Rust test
// `ts_signed_quote_verifies_on_chain` in contracts/vault/src/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { normalize, preflight, quoteMessage, signQuote, type Quote } from "../src/sdk.js";
import { checkDelivery } from "../src/agent.js";
import { ROOT } from "../src/config.js";

