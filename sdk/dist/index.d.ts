import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
/** One teragas (10^12 gas). Calls attach multiples of this. */
export declare const TGAS = 1000000000000n;
/** Decimals of the vault token (tUSDC on testnet): 1 tUSDC = 1_000_000 base units. */
export declare const USDC_DECIMALS = 6;
/** A mandate: what an agent may buy under a task, and how much. Amounts are base-unit strings. */
export interface TaskInput {
    name: string;
    purpose: string;
    categories: string[];
    blocked_terms: string[];
    allowed_sellers: string[];
    budget: string;
    max_per_purchase: string;
    approval_above: string;
    max_purchases_per_hour: number;
    reuse_window_ms: number;
    delivery_window_ms: number;
    review_window_ms: number;
    expires_at_ms: number;
}
/** Lifecycle of a task. Only Active tasks accept purchase requests. */
export type TaskStatus = "Active" | "Paused" | "Closed";
/** A task as stored on-chain, with its mandate hash and spend so far. */
export interface TaskView {
    id: number;
    rules: TaskInput;
    status: TaskStatus;
    version: number;
    mandate_hash: string;
    spent: string;
    reserved: string;
    remaining: string;
    created_ms: number;
    updated_ms: number;
}
/** A seller's offer for one item. Signed by the seller's quote key; the vault verifies it. */
export interface Quote {
    seller: string;
    item: string;
    category: string;
    description: string;
    price: string;
    expires_at_ms: number;
    nonce: string;
}
/** A Quote plus the seller's ed25519 signature over quoteMessage(vault, quote). */
export interface SignedQuote {
    quote: Quote;
    /** base64 ed25519 signature over quoteMessage(vault, quote) */
    signature: string;
}
/** Where a purchase stands. Declined and Rejected are refusals; Paid and Refunded are final. */
export type PurchaseStatus = "Declined" | "Reused" | "PendingApproval" | "Rejected" | "Escrowed" | "Delivered" | "PayoutPending" | "Paid" | "Refunded";
/** One purchase request and everything that happened to it. `code` and `detail` hold the vault's decision. */
export interface Purchase {
    id: number;
    task_id: number;
    mandate_version: number;
    agent: string;
    seller: string;
    item: string;
    category: string;
    description: string;
    price: string;
    reason: string;
    status: PurchaseStatus;
    code: string;
    detail: string;
    quote_nonce: string;
    created_ms: number;
    deliver_by_ms: number;
    delivered_ms: number;
    result_hash: string | null;
    review_by_ms: number;
    settled_ms: number;
    reused_from: number | null;
}
/** A registered seller, with its delivery record and hold state. */
export interface SellerView {
    account_id: string;
    name: string;
    about: string;
    quote_key: string;
    on_hold: boolean;
    hold_reason: string;
    registered_ms: number;
    stats: {
        delivered_ok: number;
        auto_released: number;
        rejected: number;
        missed: number;
        earned: string;
    };
    delivery_score_bps: number;
    settled: number;
}
/** Vault totals: owner, token, balance, reserved escrow, counts and the log head. */
export interface VaultView {
    owner: string;
    token: string;
    frozen: boolean;
    balance: string;
    reserved: string;
    available: string;
    tasks: number;
    agents: number;
    sellers: number;
    purchases: number;
    log_len: number;
    log_head: string;
}
/** A sub-mandate an agent handed to a sub-agent (contracts/vault/src/sub.rs). */
export interface SubMandateView {
    agent: string;
    parent: string;
    name: string;
    task_id: number;
    budget: string;
    max_per_purchase: string;
    expires_at_ms: number;
    spent: string;
    reserved: string;
    depth: number;
    revoked: boolean;
    created_ms: number;
    remaining: string;
    usable: boolean;
}
/** One entry of the vault's hash-chained decision log. */
export interface LogEntry {
    seq: number;
    at_ms: number;
    kind: string;
    purchase_id: number | null;
    code: string;
    prev_hash: string;
    hash: string;
}
/** SHA-256 of a string or bytes, as lowercase hex. */
export declare const sha256hex: (data: string | Uint8Array) => string;
/** tUSDC amount (e.g. 0.5) to a base-unit string ("500000"). */
export declare const usdc: (amount: number) => string;
/** yoctoNEAR to a short NEAR string. A key's allowance is spent by the gas a call attaches (about 0.001 NEAR per TGas on testnet). */
export declare const fmtNear: (yocto: bigint) => string;
/** Base units to a short display string such as "0.500 tUSDC". */
export declare const fmtUsdc: (base: string | bigint) => string;
/** Exact bytes a seller signs. Must match contracts/vault/src/intent.rs::quote_message. */
export declare function quoteMessage(vault: string, q: Quote): string;
/** Sign a quote with a seller's quote key (seller side). Fields must not contain newlines. */
export declare function signQuote(vault: string, q: Quote, quoteKey: KeyPairString): SignedQuote;
/** A random 24-hex-character nonce for quotes and idempotency keys. */
export declare const newNonce: () => string;
/** Mirror of the on-chain IntentLock normalizer, for pre-flight checks. */
export declare function normalize(s: string): string;
/** Check a quote against a mandate locally before spending gas. The vault re-checks everything on-chain. */
export declare function preflight(rules: TaskInput, q: Quote): {
    ok: true;
} | {
    ok: false;
    code: string;
    detail: string;
};
/** Explorer link for a transaction hash. */
export declare const explorerTx: (network: string, hash: string) => string;
/** Explorer link for an account. */
export declare const explorerAccount: (network: string, id: string) => string;
/**
 * Client for one Almoner vault. Views need no keys; agent(), owner() and seller() return signers for each role.
 * @param vaultId the vault contract account, e.g. "vault.example.testnet"
 * @param rpcUrl a NEAR RPC endpoint, e.g. "https://rpc.testnet.near.org"
 */
export declare class AlmonerVault {
    readonly vaultId: string;
    readonly rpcUrl: string;
    readonly provider: JsonRpcProvider;
    constructor(vaultId: string, rpcUrl: string);
    /** Call any view method on the vault. */
    view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
    /** Vault totals. */
    getVault: () => Promise<VaultView>;
    /** One task, or null. */
    getTask: (task_id: number) => Promise<TaskView | null>;
    /** All tasks. */
    getTasks: () => Promise<TaskView[]>;
    /** All agent keys issued by the owner. */
    getAgents: () => Promise<{
        name: string;
        public_key: string;
        task_ids: number[];
        active: boolean;
        requests: number;
    }[]>;
    /** All registered sellers. */
    getSellers: () => Promise<SellerView[]>;
    /** One seller, or null. */
    getSeller: (account_id: string) => Promise<SellerView | null>;
    /** One purchase, or null. */
    getPurchase: (purchase_id: number) => Promise<Purchase | null>;
    /** The most recent purchases. */
    getPurchases: (limit?: number) => Promise<Purchase[]>;
    /** Log entries from an index. */
    getLog: (from_index?: number, limit?: number) => Promise<LogEntry[]>;
    /** True if the on-chain log's hash chain is intact. */
    verifyLog: () => Promise<boolean>;
    /** Sub-mandates handed out by agents. Empty on a vault whose contract predates them. */
    getSubMandates: () => Promise<SubMandateView[]>;
    /** The exact mandate JSON a task's mandate_hash commits to. */
    getMandateJson: (task_id: number) => Promise<string | null>;
    /** Remaining gas allowance (yoctoNEAR) of a function-call key on the vault, or null if the key is gone. */
    keyAllowance(publicKey: string): Promise<bigint | null>;
    /** NEAR balance (yoctoNEAR) of any account. */
    nearBalance(accountId: string): Promise<bigint>;
    /** Client signed by a vault-issued agent key. */
    agent(agentKey: KeyPairString): {
        publicKey: string;
        requestPurchase: (a: {
            task_id: number;
            mandate_hash: string;
            signed: SignedQuote;
            reason: string;
            idempotency_key: string;
            gas?: bigint;
        }) => Promise<Purchase>;
        confirmDelivery: (purchase_id: number, accept: boolean, note?: string) => Promise<Purchase>;
        settleExpired: (purchase_id: number) => Promise<Purchase>;
        /** Hand part of the task to a sub-agent. Can only narrow; needs a key issued with the right to delegate. */
        delegate: (a: {
            public_key: string;
            name: string;
            task_id: number;
            budget: string;
            max_per_purchase?: string;
            expires_at_ms?: number;
        }) => Promise<void>;
        revokeDelegate: (public_key: string) => Promise<void>;
    };
    /** Client for the vault owner (their own account). */
    owner(ownerId: string, ownerKey: KeyPairString): {
        account: Account;
        createTask: (rules: TaskInput) => Promise<TaskView>;
        updateTask: (task_id: number, rules: TaskInput) => Promise<TaskView>;
        setTaskStatus: (task_id: number, status: TaskStatus) => Promise<void>;
        addAgent: (public_key: string, name: string, task_ids: number[], allowanceYocto?: string, canDelegate?: boolean) => Promise<void>;
        revokeDelegate: (public_key: string) => Promise<void>;
        revokeAgent: (public_key: string) => Promise<void>;
        approve: (purchase_id: number) => Promise<Purchase>;
        reject: (purchase_id: number, note?: string) => Promise<Purchase>;
        review: (purchase_id: number, accept: boolean, note?: string) => Promise<Purchase>;
        clearHold: (seller: string) => Promise<void>;
        setFrozen: (frozen: boolean) => Promise<void>;
        withdraw: (amount: string) => Promise<boolean>;
    };
    /** Client for a seller (their own account). */
    seller(sellerId: string, sellerKey: KeyPairString): {
        register: (name: string, quote_key: string, about: string) => Promise<import("near-api-js").SerializedReturnValue>;
        deliver: (purchase_id: number, result_hash: string) => Promise<Purchase>;
    };
}
/** What went wrong when a call could not reach a decision at all. A vault refusal is never an AlmonerError. */
export type AlmonerErrorKind = "revoked_key" | "out_of_gas" | "network" | "seller" | "contract";
/** A network or protocol failure. Refusals by the vault are returned as data (see BuyResult), not thrown. */
export declare class AlmonerError extends Error {
    /** Machine-readable category of the failure. */
    readonly kind: AlmonerErrorKind;
    /** The underlying error, if any. */
    readonly cause?: unknown;
    constructor(kind: AlmonerErrorKind, message: string, cause?: unknown);
}
/** Turns any error thrown by near-api-js or fetch into an AlmonerError with a kind. Already-typed errors pass through. */
export declare function toAlmonerError(e: unknown): AlmonerError;
/** A delivered result is acceptable if it hashes to what the seller committed on-chain and is data, not an error message. */
export declare function checkDelivery(result: string, onChainHash: string | null): {
    ok: boolean;
    why: string;
};
/** A seller's signed quote as returned by an Almoner seller server (POST {sellerUrl}/quote). */
export interface SellerQuote extends SignedQuote {
    /** The seller's note, e.g. "list price" or "counter at floor". */
    note?: string;
    /** The seller's list price, base units. */
    list?: string;
}
/**
 * Ask a seller server for a signed quote.
 * @param sellerUrl base URL of one seller, e.g. "https://almoner.duckdns.org/api/datadesk"
 * @param item the catalog item URL to quote
 * @param opts.offer optional counter-offer in base units; the seller may accept it or counter at its floor
 * @param opts.vault the vault the quote is for (sellers serving several vaults need it)
 */
export declare function getQuote(sellerUrl: string, item: string, opts?: {
    offer?: string;
    vault?: string;
}): Promise<SellerQuote>;
/** The outcome of buy(): the vault's decision, always as data. */
export interface BuyResult {
    /** True only if the purchase ended Paid (or Delivered/PayoutPending on the way to Paid). */
    paid: boolean;
    /** The purchase status the vault ended at: Declined, PendingApproval, Reused, Paid, Refunded, ... */
    status: PurchaseStatus;
    /** The vault's decision code for the request, e.g. APPROVED_ESCROW, INTENT_MISMATCH, QUOTE_INVALID, NEEDS_APPROVAL. */
    code: string;
    /** The vault's reason, in words. */
    detail: string;
    /** The full purchase record as it stands after the last step. */
    purchase: Purchase;
    /** The quote that was sent to the vault. */
    quote: SellerQuote;
    /** The delivered result, if the seller delivered. */
    result?: string;
    /** Why the agent accepted or rejected the delivery, if it got that far. */
    review?: {
        ok: boolean;
        why: string;
    };
}
/** Options for buy(). */
export interface BuyOptions {
    /** Base URL of one seller server, e.g. "https://almoner.duckdns.org/api/datadesk". */
    sellerUrl: string;
    /** Catalog item URL to buy. */
    item: string;
    /** Task (mandate) id the agent key is allowed to spend under. */
    taskId: number;
    /** Why the agent wants it; stored on-chain with the request. */
    reason: string;
    /** Optional counter-offer in base units. */
    offer?: string;
    /** Repeat calls with the same key return the first purchase instead of buying twice. Default: random. */
    idempotencyKey?: string;
    /** Custom delivery check. Default: checkDelivery (hash matches, body is JSON data, not an error). */
    check?: (result: string, onChainHash: string | null) => {
        ok: boolean;
        why: string;
    };
}
/**
 * The common agent flow in one call: get a signed quote from the seller, ask the vault, collect the delivery,
 * and accept or reject it on-chain. Every vault decision, including refusals, comes back as a BuyResult.
 * Throws AlmonerError only when no decision could be reached (network down, key revoked, gas allowance used up).
 */
export declare function buy(vault: AlmonerVault, agentKey: KeyPairString, o: BuyOptions): Promise<BuyResult>;
/** What setupAgent() returns. Keep agentKey secret: it is the only copy. */
export interface AgentSetup {
    /** The task (mandate) that was created. */
    task: TaskView;
    /** The new agent's private key. Give it to the agent; it can only ask the vault, never move funds. */
    agentKey: KeyPairString;
    /** The new agent's public key, as registered on the vault. Use it with owner.revokeAgent(). */
    publicKey: string;
}
/**
 * Owner flow in one call: create a task (mandate) and issue a fresh agent key limited to it.
 * @param vault the vault client
 * @param ownerId the vault owner's account id
 * @param ownerKey the owner's full-access key
 * @param rules the mandate: budget, limits, categories, blocked terms, sellers
 * @param agentName a label for the agent, stored on-chain
 * @param opts.allowanceYocto gas allowance for the agent key in yoctoNEAR (default: the contract's default)
 * @param opts.canDelegate let the agent hand narrower sub-mandates to sub-agents
 */
export declare function setupAgent(vault: AlmonerVault, ownerId: string, ownerKey: KeyPairString, rules: TaskInput, agentName: string, opts?: {
    allowanceYocto?: string;
    canDelegate?: boolean;
}): Promise<AgentSetup>;
