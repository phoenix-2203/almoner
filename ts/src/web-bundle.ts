/**
 * Entry point for the browser bundle used by web/try.html.
 * Built with `npm run build:web` into web/vendor/near.js (global `NearApi`).
 * It is the same near-api-js the CLI scripts use, so the browser signs
 * transactions exactly as `npm run attack` does.
 */
export { Account, KeyPair } from "near-api-js";
