//! Injected time and identity.
//!
//! Both are seams for the same reason: a test that cannot control the clock or
//! the id generator can only assert "something happened", never "the rows are
//! ordered the way I said". Production uses [`SystemClock`] + [`UuidSource`];
//! tests use [`FixedClock`] + [`SeqIdSource`] and assert exact values.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use crate::model::Timestamp;

/// Wall-clock time, in milliseconds since the Unix epoch, UTC.
pub trait Clock: Send + Sync {
    fn now(&self) -> Timestamp;
}

/// Production clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            // A clock set before 1970 is a broken machine, not a Vela error;
            // clamp rather than panic inside a write path.
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Timestamp::from_millis(millis)
    }
}

/// Test clock. Starts at `start` and advances by `step` on every read, so
/// consecutive writes get strictly increasing, *predictable* timestamps.
#[derive(Debug)]
pub struct FixedClock {
    next: AtomicI64,
    step: i64,
}

impl FixedClock {
    pub fn new(start: i64, step: i64) -> Self {
        Self {
            next: AtomicI64::new(start),
            step,
        }
    }

    /// A clock that never moves — for asserting that a value was *not* touched.
    pub fn frozen(at: i64) -> Self {
        Self::new(at, 0)
    }
}

impl Default for FixedClock {
    fn default() -> Self {
        Self::new(1_700_000_000_000, 1_000)
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_millis(self.next.fetch_add(self.step, Ordering::SeqCst))
    }
}

/// Row identifiers. Kept behind a trait so tests get stable ids like
/// `conv_1` instead of random UUIDs.
pub trait IdSource: Send + Sync {
    /// `prefix` is a short entity tag (`conv`, `msg`, `proj`). Implementations
    /// must return a value that is unique for the lifetime of the database.
    fn next_id(&self, prefix: &str) -> String;
}

/// Production id source: `<prefix>_<uuid-v4>`.
#[derive(Debug, Default, Clone, Copy)]
pub struct UuidSource;

impl IdSource for UuidSource {
    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
    }
}

/// Test id source: `<prefix>_1`, `<prefix>_2`, … across all prefixes.
#[derive(Debug, Default)]
pub struct SeqIdSource {
    next: AtomicU64,
}

impl SeqIdSource {
    pub fn new() -> Self {
        Self::default()
    }
}

impl IdSource for SeqIdSource {
    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}_{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_clock_advances_predictably_so_ordering_can_be_asserted() {
        let clock = FixedClock::new(1_000, 5);
        assert_eq!(clock.now().as_millis(), 1_000);
        assert_eq!(clock.now().as_millis(), 1_005);
        assert_eq!(clock.now().as_millis(), 1_010);
    }

    #[test]
    fn a_frozen_clock_returns_the_same_instant_every_time() {
        let clock = FixedClock::frozen(42);
        assert_eq!(clock.now(), clock.now());
    }

    #[test]
    fn the_system_clock_reports_a_plausible_epoch_millisecond() {
        // Sanity only: after 2020-01-01 and before 2100-01-01. Asserts we are
        // storing milliseconds, not seconds — a mistake that only shows up
        // years later in sort order.
        let now = SystemClock.now().as_millis();
        assert!(now > 1_577_836_800_000, "clock looks like seconds: {now}");
        assert!(
            now < 4_102_444_800_000,
            "clock is implausibly far ahead: {now}"
        );
    }

    #[test]
    fn generated_ids_are_unique_and_prefixed() {
        let uuids = UuidSource;
        let a = uuids.next_id("conv");
        let b = uuids.next_id("conv");
        assert!(a.starts_with("conv_"));
        assert_ne!(a, b);

        let seq = SeqIdSource::new();
        assert_eq!(seq.next_id("msg"), "msg_1");
        assert_eq!(seq.next_id("msg"), "msg_2");
    }
}
