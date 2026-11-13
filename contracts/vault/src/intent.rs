//! On-chain IntentLock: deterministic checks that a purchase serves the task's
//! signed purpose. No model decides anything about money here.
//!
//! Two rules:
//! 1. The quote's category must be one the mandate allows.
//! 2. No blocked term may appear in the item, its category or the seller's
//!    description, after undoing the usual disguises: percent-escapes, case,
//!    leetspeak, spacing and punctuation ("G1FT-c@rd", "g i f t card",
//!    "gift%20card" all read as "giftcard").

use crate::types::{Quote, TaskInput};

