/// willow::reputation
///
/// Onchain reputation scores for registered AI agents.
///
/// Score design
/// ────────────
/// score_bps: u64 — basis points, range [0, 10_000].
///   10_000 = perfect (100.00%)
///   5_000   = neutral starting score (50.00%)
///
/// Updates are submitted by authorised reporters (oracle network, contract
/// admin, or peer agents). The raw interaction history is stored as a
/// Shelby blob (history_blob_id); only the aggregated score lives onchain.
module willow::reputation {
    use std::signer;
    use std::string::String;
    use aptos_framework::event;
    use aptos_framework::timestamp;
    use aptos_std::table::{Self, Table};

    // ── Errors ───────────────────────────────────────────────────────────────
    const E_NOT_ADMIN:         u64 = 300;
    const E_NOT_REPORTER:      u64 = 301;
    const E_SCORE_NOT_FOUND:   u64 = 302;
    const E_SCORE_EXISTS:      u64 = 303;
    const E_INVALID_SCORE:     u64 = 304;
    const E_INVALID_DELTA:     u64 = 305;
    const E_REGISTRY_NOT_INIT: u64 = 306;

    // ── Constants ────────────────────────────────────────────────────────────
    const MAX_SCORE:   u64 = 10_000;
    const START_SCORE: u64 = 5_000;
    const MAX_DELTA:   u64 = 1_000;   // max single-update change (±10%)

    // ── ReporterRegistry resource ─────────────────────────────────────────────
    /// Stored at @willow.
    struct ReporterRegistry has key {
        reporters: Table<address, bool>,
    }

    // ── AgentScore resource ───────────────────────────────────────────────────
    /// One per agent; stored at the AGENT OBJECT ADDRESS (not owner address).
    struct AgentScore has key {
        agent_addr:        address,
        /// Current aggregated score in basis points [0, 10_000].
        score_bps:         u64,
        /// Total number of score updates received.
        interaction_count: u64,
        /// Shelby blob ID of the full interaction-history JSONL log.
        history_blob_id:   String,
        created_at:        u64,
        last_updated:      u64,
    }

    // ── Events ───────────────────────────────────────────────────────────────
    #[event]
    struct ScoreInitialised has drop, store {
        agent_addr:   address,
        score_bps:    u64,
        timestamp_us: u64,
    }

    #[event]
    struct ScoreUpdated has drop, store {
        agent_addr:        address,
        old_score_bps:     u64,
        new_score_bps:     u64,
        delta_bps:         u64,
        positive:          bool,
        reporter:          address,
        interaction_count: u64,
        timestamp_us:      u64,
    }

    #[event]
    struct HistoryBlobUpdated has drop, store {
        agent_addr:          address,
        new_history_blob_id: String,
        timestamp_us:        u64,
    }

    #[event]
    struct ReporterUpdated has drop, store {
        reporter:     address,
        authorised:   bool,
        timestamp_us: u64,
    }

    // ── Module initialiser ────────────────────────────────────────────────────

    public entry fun initialize(admin: &signer) {
        assert!(signer::address_of(admin) == @willow, E_NOT_ADMIN);
        if (!exists<ReporterRegistry>(@willow)) {
            move_to(admin, ReporterRegistry {
                reporters: table::new<address, bool>(),
            });
        };
    }

    // ── Admin: reporter management ────────────────────────────────────────────

    public entry fun set_reporter(
        admin:    &signer,
        reporter: address,
        allowed:  bool,
    ) acquires ReporterRegistry {
        assert!(signer::address_of(admin) == @willow, E_NOT_ADMIN);
        assert!(exists<ReporterRegistry>(@willow), E_REGISTRY_NOT_INIT);
        let reg = borrow_global_mut<ReporterRegistry>(@willow);
        if (table::contains(&reg.reporters, reporter)) {
            *table::borrow_mut(&mut reg.reporters, reporter) = allowed;
        } else {
            table::add(&mut reg.reporters, reporter, allowed);
        };
        event::emit(ReporterUpdated {
            reporter,
            authorised:   allowed,
            timestamp_us: timestamp::now_microseconds(),
        });
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    #[view]
    public fun score_exists(agent_addr: address): bool {
        exists<AgentScore>(agent_addr)
    }

    #[view]
    public fun get_score(agent_addr: address): u64 acquires AgentScore {
        assert!(exists<AgentScore>(agent_addr), E_SCORE_NOT_FOUND);
        borrow_global<AgentScore>(agent_addr).score_bps
    }

    #[view]
    public fun get_interaction_count(agent_addr: address): u64 acquires AgentScore {
        assert!(exists<AgentScore>(agent_addr), E_SCORE_NOT_FOUND);
        borrow_global<AgentScore>(agent_addr).interaction_count
    }

    #[view]
    public fun get_history_blob_id(agent_addr: address): String acquires AgentScore {
        assert!(exists<AgentScore>(agent_addr), E_SCORE_NOT_FOUND);
        borrow_global<AgentScore>(agent_addr).history_blob_id
    }

    #[view]
    public fun is_reporter(addr: address): bool acquires ReporterRegistry {
        if (!exists<ReporterRegistry>(@willow)) { return false };
        let reg = borrow_global<ReporterRegistry>(@willow);
        table::contains(&reg.reporters, addr) &&
            *table::borrow(&reg.reporters, addr)
    }

    // ── Public entry functions ────────────────────────────────────────────────

    /// Bootstrap a score record for a newly registered agent.
    public entry fun initialise_score(
        owner:           &signer,
        agent_addr:      address,
        history_blob_id: String,
    ) {
        assert!(
            willow::agent_registry::get_owner(agent_addr) == signer::address_of(owner),
            E_NOT_ADMIN
        );
        assert!(!exists<AgentScore>(agent_addr), E_SCORE_EXISTS);

        let extend_ref = willow::agent_registry::borrow_extend_ref(agent_addr);
        let obj_signer = aptos_framework::object::generate_signer_for_extending(extend_ref);
        let now        = timestamp::now_microseconds();

        move_to(&obj_signer, AgentScore {
            agent_addr,
            score_bps:         START_SCORE,
            interaction_count: 0,
            history_blob_id:   copy history_blob_id,
            created_at:        now,
            last_updated:      now,
        });

        event::emit(ScoreInitialised {
            agent_addr,
            score_bps:    START_SCORE,
            timestamp_us: now,
        });
    }

    /// Submit a score delta from an authorised reporter.
    /// positive=true  → add delta_bps (capped at MAX_SCORE)
    /// positive=false → subtract delta_bps (floored at 0)
    public entry fun submit_score_update(
        reporter:   &signer,
        agent_addr: address,
        delta_bps:  u64,
        positive:   bool,
    ) acquires AgentScore, ReporterRegistry {
        let reporter_addr = signer::address_of(reporter);
        assert!(is_reporter(reporter_addr), E_NOT_REPORTER);
        assert!(exists<AgentScore>(agent_addr), E_SCORE_NOT_FOUND);
        assert!(delta_bps > 0 && delta_bps <= MAX_DELTA, E_INVALID_DELTA);

        let score_rec = borrow_global_mut<AgentScore>(agent_addr);
        let old_score = score_rec.score_bps;
        let new_score = if (positive) {
            let s = old_score + delta_bps;
            if (s > MAX_SCORE) { MAX_SCORE } else { s }
        } else {
            if (delta_bps >= old_score) { 0 } else { old_score - delta_bps }
        };

        score_rec.score_bps         = new_score;
        score_rec.interaction_count = score_rec.interaction_count + 1;
        let now                     = timestamp::now_microseconds();
        score_rec.last_updated      = now;

        event::emit(ScoreUpdated {
            agent_addr,
            old_score_bps:     old_score,
            new_score_bps:     new_score,
            delta_bps,
            positive,
            reporter:          reporter_addr,
            interaction_count: score_rec.interaction_count,
            timestamp_us:      now,
        });
    }

    /// Update the Shelby blob ID pointing to the latest interaction-history snapshot.
    public entry fun update_history_blob(
        reporter:            &signer,
        agent_addr:          address,
        new_history_blob_id: String,
    ) acquires AgentScore, ReporterRegistry {
        assert!(is_reporter(signer::address_of(reporter)), E_NOT_REPORTER);
        assert!(exists<AgentScore>(agent_addr), E_SCORE_NOT_FOUND);

        let score_rec = borrow_global_mut<AgentScore>(agent_addr);
        score_rec.history_blob_id = copy new_history_blob_id;
        let now = timestamp::now_microseconds();
        score_rec.last_updated = now;

        event::emit(HistoryBlobUpdated {
            agent_addr,
            new_history_blob_id,
            timestamp_us: now,
        });
    }
}
