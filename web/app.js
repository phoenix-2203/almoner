// Almoner dashboard: reads the vault directly over NEAR JSON-RPC. No keys, no backend.
(() => {
  const qs = new URLSearchParams(location.search);
  const cfg = Object.assign({ rpc: "https://rpc.testnet.fastnear.com", network: "testnet", vault: "" }, window.ALMONER || {});
  if (qs.get("vault")) cfg.vault = qs.get("vault");
  if (qs.get("rpc")) cfg.rpc = qs.get("rpc");
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usdc = (b) => { const n = Number(BigInt(b || 0)) / 1e6; return n.toFixed(n < 1 ? 3 : 2) + " tUSDC"; };
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
  const explorer = cfg.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  const tone = { Paid: "ok", Reused: "ok", Escrowed: "info", Delivered: "info", PayoutPending: "info", PendingApproval: "warn", Refunded: "warn", Rejected: "bad", Declined: "bad" };
  let filter = "All";
})();
