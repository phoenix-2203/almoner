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

