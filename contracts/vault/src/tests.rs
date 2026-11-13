//! Unit tests: the night-shift flow plus the attack lab, run natively against
//! near-sdk's mocked blockchain. Cross-contract calls aren't executed here;
//! callbacks are driven directly with mocked promise results.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use near_sdk::test_vm_config;

