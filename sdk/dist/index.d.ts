import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
export declare const TGAS = 1000000000000n;
export declare const USDC_DECIMALS = 6;
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
export type TaskStatus = "Active" | "Paused" | "Closed";
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
export interface Quote {
    seller: string;
    item: string;
    category: string;
    description: string;
    price: string;
    expires_at_ms: number;
    nonce: string;
}
export interface SignedQuote {
    quote: Quote;
    /** base64 ed25519 signature over quoteMessage(vault, quote) */
    signature: string;
}
export type PurchaseStatus = "Declined" | "Reused" | "PendingApproval" | "Rejected" | "Escrowed" | "Delivered" | "PayoutPending" | "Paid" | "Refunded";
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
export interface LogEntry {
    seq: number;
    at_ms: number;
    kind: string;
    purchase_id: number | null;
    code: string;
    prev_hash: string;
    hash: string;
}
export declare const sha256hex: (data: string | Uint8Array) => string;
export declare const usdc: (amount: number) => string;
/** yoctoNEAR to a short NEAR string. A key's allowance is spent by the gas a call attaches (about 0.001 NEAR per TGas on testnet). */
export declare const fmtNear: (yocto: bigint) => string;
export declare const fmtUsdc: (base: string | bigint) => string;
/** Exact bytes a seller signs. Must match contracts/vault/src/intent.rs::quote_message. */
export declare function quoteMessage(vault: string, q: Quote): string;
export declare function signQuote(vault: string, q: Quote, quoteKey: KeyPairString): SignedQuote;
export declare const newNonce: () => string;
/** Mirror of the on-chain IntentLock normalizer, for pre-flight checks. */
export declare function normalize(s: string): string;
export declare function preflight(rules: TaskInput, q: Quote): {
    ok: true;
} | {
    ok: false;
    code: string;
    detail: string;
};
export declare const explorerTx: (network: string, hash: string) => string;
export declare const explorerAccount: (network: string, id: string) => string;
export declare class AlmonerVault {
    readonly vaultId: string;
    readonly rpcUrl: string;
    readonly provider: JsonRpcProvider;
    constructor(vaultId: string, rpcUrl: string);
    view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
    getVault: () => Promise<VaultView>;
    getTask: (task_id: number) => Promise<TaskView | null>;
    getTasks: () => Promise<TaskView[]>;
    getAgents: () => Promise<{
        name: string;
        public_key: string;
        task_ids: number[];
        active: boolean;
        requests: number;
    }[]>;
    getSellers: () => Promise<SellerView[]>;
    getSeller: (account_id: string) => Promise<SellerView | null>;
    getPurchase: (purchase_id: number) => Promise<Purchase | null>;
    getPurchases: (limit?: number) => Promise<Purchase[]>;
    getLog: (from_index?: number, limit?: number) => Promise<LogEntry[]>;
    verifyLog: () => Promise<boolean>;
    /** Sub-mandates handed out by agents. Empty on a vault whose contract predates them. */
    getSubMandates: () => Promise<SubMandateView[]>;
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
