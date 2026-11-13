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

/// Lowercase, map leetspeak and keep only a-z0-9.
pub fn normalize(s: &str) -> String {
    let decoded = percent_decode(&percent_decode(s));
    let mut out = String::with_capacity(decoded.len());
    for c in decoded.chars() {
        let c = c.to_ascii_lowercase();
        let mapped = match c {
            '0' => 'o',
            '1' | '!' | '|' => 'i',
            '3' => 'e',
            '4' | '@' => 'a',
            '5' | '$' => 's',
            '7' => 't',
            '8' => 'b',
            c if c.is_ascii_alphanumeric() => c,
            _ => continue,
        };
        out.push(mapped);
    }
    out
}

/// Returns the first blocked term found in the quote, if any.
pub fn find_blocked(rules: &TaskInput, q: &Quote) -> Option<String> {
    let haystack = normalize(&format!("{} {} {}", q.item, q.category, q.description));
    rules.blocked_terms.iter().find_map(|t| {
        let n = normalize(t);
        if !n.is_empty() && haystack.contains(&n) {
            Some(t.clone())
        } else {
            None
        }
    })
}

pub fn category_allowed(rules: &TaskInput, category: &str) -> bool {
    rules.categories.is_empty()
        || rules.categories.iter().any(|c| c.eq_ignore_ascii_case(category.trim()))
}

/// The exact bytes a seller signs for a quote. Newline-separated; the
/// description is hashed so it may contain any characters.
pub fn quote_message(vault: &str, q: &Quote, description_hash_hex: &str) -> String {
    format!(
        "almoner-quote/v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        vault,
        q.seller,
        q.item,
        q.category,
        q.price.0,
        q.expires_at_ms,
        q.nonce,
        description_hash_hex
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disguises_are_undone() {
        assert_eq!(normalize("G1FT-c@rd"), "giftcard");
        assert_eq!(normalize("g i f t   c a r d"), "giftcard");
        assert_eq!(normalize("gift%20card"), "giftcard");
        assert_eq!(normalize("gift%2520card"), "giftcard");
        assert_eq!(normalize("Pr3m1um $tock data"), "premiumstockdata");
    }

    #[test]
    fn percent_decode_keeps_invalid() {
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode("%41"), "A");
    }
}
