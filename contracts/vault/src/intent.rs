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

/// Decode %XX escapes; invalid sequences are kept as-is.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

