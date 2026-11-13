//! tUSDC: a testnet-only NEP-141 token (6 decimals) for the Almoner demo.
//!
//! Anyone can call `faucet` to mint up to 1,000 tUSDC per call. Accounts are
//! registered automatically on mint and on transfer, so the demo needs no
//! `storage_deposit` calls (the token account pays that storage). Never deploy
//! this to mainnet: the faucet is open by design.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

/// 1,000 tUSDC with 6 decimals.
pub const FAUCET_MAX: u128 = 1_000 * 1_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    token: FungibleToken,
}

#[near]
impl TestUsdc {
    #[init]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(StorageKey::Token) }
    }

    /// Mint up to 1,000 tUSDC to `account_id` (or the caller). Testnet only.
    pub fn faucet(&mut self, account_id: Option<AccountId>, amount: U128) {
        let to = account_id.unwrap_or_else(env::predecessor_account_id);
        require!(amount.0 > 0 && amount.0 <= FAUCET_MAX, "faucet: 1..=1000 tUSDC per call");
        self.ensure_registered(&to);
        self.token.internal_deposit(&to, amount.0);
        FtMint { owner_id: &to, amount, memo: Some("faucet") }.emit();
    }

    fn ensure_registered(&mut self, account_id: &AccountId) {
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
        }
    }
}

#[near]
impl FungibleTokenCore for TestUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.ensure_registered(&receiver_id);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.ensure_registered(&receiver_id);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }
}
