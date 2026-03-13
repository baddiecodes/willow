/// willow::access_control
///
/// Enforces per-collection access policies and issues onchain ReadProofs.
///
/// ReadProof flow
/// ─────────────
/// 1. Off-chain: caller builds the list of chunk_ids they want to retrieve.
/// 2. Onchain:  caller calls `request_read_proof`.
///    – For ACCESS_PAID collections the required APT fee is transferred here.
///    – A `ReadProofIssued` event is emitted (blob_ids, reader, nonce, expires_at).
/// 3. Off-chain: caller passes the transaction hash to the Shelby SDK.
///    The Shelby gateway:
///      a. Fetches the tx receipt and locates the `ReadProofIssued` event.
///      b. Verifies reader == caller, blob_ids ⊇ requested blob, not expired.
///      c. Serves the blob and charges egress.
///
/// AccessConfig resource
/// ─────────────────────
/// Stored at the SAME object address as VectorCollection via ExtendRef.
/// Owner must call `configure_access` before paid/allowlist reads work.
module willow::access_control {
    use std::string::String;
    use std::signer;
    use std::vector;
    use aptos_framework::object;
    use aptos_framework::event;
    use aptos_framework::timestamp;
    use aptos_framework::coin;
    use aptos_framework::aptos_coin::AptosCoin;
    use aptos_std::table::{Self, Table};
    use willow::collection;

    // ── Errors ───────────────────────────────────────────────────────────────
    const E_NOT_OWNER:           u64 = 100;
    const E_ACCESS_DENIED:       u64 = 101;
    const E_CONFIG_NOT_FOUND:    u64 = 102;
    const E_CONFIG_EXISTS:       u64 = 103;
    const E_INSUFFICIENT_FEE:    u64 = 104;
    const E_NOT_ON_ALLOWLIST:    u64 = 105;
    const E_ZERO_CHUNKS:         u64 = 106;
    const E_PROOF_TTL_TOO_LARGE: u64 = 107;

    // ── Constants ────────────────────────────────────────────────────────────
    /// Maximum proof TTL: 10 minutes in microseconds.
    const MAX_TTL_US: u64 = 600_000_000;
    /// Default proof TTL: 5 minutes.
    const DEFAULT_TTL_US: u64 = 300_000_000;

    // ── AccessConfig resource ────────────────────────────────────────────────
    /// Stored at the collection object address alongside VectorCollection.
    #[resource_group_member(group = aptos_framework::object::ObjectGroup)]
    struct AccessConfig has key {
        /// APT amount (in octas) charged per read-proof call for ACCESS_PAID.
        read_fee_octas: u64,
        /// Proof time-to-live in microseconds. Shelby gateway rejects expired proofs.
        proof_ttl_us: u64,
        /// Allowlist for ACCESS_ALLOWLIST policy: address → allowed.
        allowlist: Table<address, bool>,
        /// Total APT collected from paid reads (informational).
        total_fees_collected: u64,
    }

    // ── Events ───────────────────────────────────────────────────────────────
    #[event]
    struct AccessConfigured has drop, store {
        collection_addr: address,
        read_fee_octas:  u64,
        proof_ttl_us:    u64,
        timestamp_us:    u64,
    }

    /// Primary event consumed by the Shelby gateway to authorise egress.
    #[event]
    struct ReadProofIssued has drop, store {
        /// Aptos address of the collection object.
        collection_addr: address,
        /// Reader (signer) who requested this proof.
        reader:          address,
        /// Shelby blob IDs the reader is authorised to fetch in this proof.
        blob_ids:        vector<String>,
        /// Caller-supplied nonce — prevents replay. Use monotonic counter or random u64.
        nonce:           u64,
        /// Unix timestamp (microseconds) after which the proof is invalid.
        expires_at:      u64,
        /// Fee paid in octas (0 for free collections).
        fee_paid_octas:  u64,
        timestamp_us:    u64,
    }

    #[event]
    struct AllowlistUpdated has drop, store {
        collection_addr: address,
        subject:         address,
        allowed:         bool,
        timestamp_us:    u64,
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    #[view]
    public fun config_exists(collection_addr: address): bool {
        exists<AccessConfig>(collection_addr)
    }

    #[view]
    public fun get_read_fee(collection_addr: address): u64 acquires AccessConfig {
        borrow_global<AccessConfig>(collection_addr).read_fee_octas
    }

    #[view]
    public fun is_allowlisted(
        collection_addr: address,
        subject:         address,
    ): bool acquires AccessConfig {
        let cfg = borrow_global<AccessConfig>(collection_addr);
        table::contains(&cfg.allowlist, subject) &&
            *table::borrow(&cfg.allowlist, subject)
    }

    // ── Owner configuration ───────────────────────────────────────────────────

    /// Attach an AccessConfig to the collection object.
    /// Must be called by the collection owner before paid/allowlist reads work.
    public entry fun configure_access(
        owner:           &signer,
        collection_addr: address,
        read_fee_octas:  u64,
        proof_ttl_us:    u64,
    ) acquires AccessConfig {
        assert!(!exists<AccessConfig>(collection_addr), E_CONFIG_EXISTS);
        assert!(
            collection::get_owner(collection_addr) == signer::address_of(owner),
            E_NOT_OWNER
        );
        assert!(proof_ttl_us <= MAX_TTL_US, E_PROOF_TTL_TOO_LARGE);

        let extend_ref  = collection::borrow_extend_ref(collection_addr);
        let obj_signer  = object::generate_signer_for_extending(extend_ref);

        move_to(&obj_signer, AccessConfig {
            read_fee_octas,
            proof_ttl_us,
            allowlist:            table::new<address, bool>(),
            total_fees_collected: 0,
        });

        event::emit(AccessConfigured {
            collection_addr,
            read_fee_octas,
            proof_ttl_us,
            timestamp_us: timestamp::now_microseconds(),
        });
    }

    /// Update fee or TTL after initial configuration.
    public entry fun update_access_config(
        owner:           &signer,
        collection_addr: address,
        read_fee_octas:  u64,
        proof_ttl_us:    u64,
    ) acquires AccessConfig {
        assert!(
            collection::get_owner(collection_addr) == signer::address_of(owner),
            E_NOT_OWNER
        );
        assert!(proof_ttl_us <= MAX_TTL_US, E_PROOF_TTL_TOO_LARGE);
        let cfg = borrow_global_mut<AccessConfig>(collection_addr);
        cfg.read_fee_octas = read_fee_octas;
        cfg.proof_ttl_us   = proof_ttl_us;
    }

    /// Add or remove an address from the allowlist.
    public entry fun set_allowlist_entry(
        owner:           &signer,
        collection_addr: address,
        subject:         address,
        allowed:         bool,
    ) acquires AccessConfig {
        assert!(
            collection::get_owner(collection_addr) == signer::address_of(owner),
            E_NOT_OWNER
        );
        assert!(exists<AccessConfig>(collection_addr), E_CONFIG_NOT_FOUND);
        let cfg = borrow_global_mut<AccessConfig>(collection_addr);
        if (table::contains(&cfg.allowlist, subject)) {
            *table::borrow_mut(&mut cfg.allowlist, subject) = allowed;
        } else {
            table::add(&mut cfg.allowlist, subject, allowed);
        };
        event::emit(AllowlistUpdated {
            collection_addr,
            subject,
            allowed,
            timestamp_us: timestamp::now_microseconds(),
        });
    }

    // ── Read-proof entry points ───────────────────────────────────────────────

    /// Request a read proof for an ACCESS_OPEN collection.
    public entry fun request_read_proof_open(
        reader:          &signer,
        collection_addr: address,
        chunk_ids:       vector<String>,
        nonce:           u64,
    ) acquires AccessConfig {
        assert!(
            collection::get_access_policy(collection_addr) == collection::access_open(),
            E_ACCESS_DENIED
        );
        assert!(!vector::is_empty(&chunk_ids), E_ZERO_CHUNKS);

        let ttl = get_ttl(collection_addr);
        let blob_ids = resolve_chunk_blob_ids(collection_addr, &chunk_ids);
        emit_read_proof(collection_addr, signer::address_of(reader), blob_ids, nonce, ttl, 0);
        increment_reads_safe(collection_addr);
    }

    /// Request a read proof for an ACCESS_ALLOWLIST collection.
    public entry fun request_read_proof_allowlist(
        reader:          &signer,
        collection_addr: address,
        chunk_ids:       vector<String>,
        nonce:           u64,
    ) acquires AccessConfig {
        let reader_addr = signer::address_of(reader);
        assert!(
            collection::get_access_policy(collection_addr) == collection::access_allowlist(),
            E_ACCESS_DENIED
        );
        assert!(is_allowlisted(collection_addr, reader_addr), E_NOT_ON_ALLOWLIST);
        assert!(!vector::is_empty(&chunk_ids), E_ZERO_CHUNKS);

        let ttl      = get_ttl(collection_addr);
        let blob_ids = resolve_chunk_blob_ids(collection_addr, &chunk_ids);
        emit_read_proof(collection_addr, reader_addr, blob_ids, nonce, ttl, 0);
        increment_reads_safe(collection_addr);
    }

    /// Request a read proof for an ACCESS_PAID collection.
    /// Transfers read_fee_octas APT from reader to collection owner.
    public entry fun request_read_proof_paid(
        reader:          &signer,
        collection_addr: address,
        chunk_ids:       vector<String>,
        nonce:           u64,
    ) acquires AccessConfig {
        assert!(
            collection::get_access_policy(collection_addr) == collection::access_paid(),
            E_ACCESS_DENIED
        );
        assert!(exists<AccessConfig>(collection_addr), E_CONFIG_NOT_FOUND);
        assert!(!vector::is_empty(&chunk_ids), E_ZERO_CHUNKS);

        let cfg    = borrow_global_mut<AccessConfig>(collection_addr);
        let fee    = cfg.read_fee_octas;
        let owner  = collection::get_owner(collection_addr);

        coin::transfer<AptosCoin>(reader, owner, fee);
        cfg.total_fees_collected = cfg.total_fees_collected + fee;

        let ttl      = cfg.proof_ttl_us;
        let blob_ids = resolve_chunk_blob_ids(collection_addr, &chunk_ids);

        let reader_addr = signer::address_of(reader);
        emit_read_proof(collection_addr, reader_addr, blob_ids, nonce, ttl, fee);
        increment_reads_safe(collection_addr);
    }

    /// Owner-only read (ACCESS_OWNER_ONLY collections).
    public entry fun request_read_proof_owner(
        owner:           &signer,
        collection_addr: address,
        chunk_ids:       vector<String>,
        nonce:           u64,
    ) acquires AccessConfig {
        let owner_addr = signer::address_of(owner);
        assert!(
            collection::get_access_policy(collection_addr) == collection::access_owner_only(),
            E_ACCESS_DENIED
        );
        assert!(collection::get_owner(collection_addr) == owner_addr, E_NOT_OWNER);
        assert!(!vector::is_empty(&chunk_ids), E_ZERO_CHUNKS);

        let ttl      = get_ttl(collection_addr);
        let blob_ids = resolve_chunk_blob_ids(collection_addr, &chunk_ids);
        emit_read_proof(collection_addr, owner_addr, blob_ids, nonce, ttl, 0);
        increment_reads_safe(collection_addr);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fun resolve_chunk_blob_ids(
        collection_addr: address,
        chunk_ids:       &vector<String>,
    ): vector<String> {
        let blob_ids = vector::empty<String>();
        let len = vector::length(chunk_ids);
        let i = 0;
        while (i < len) {
            let blob_id = collection::get_chunk_blob_id(
                collection_addr,
                *vector::borrow(chunk_ids, i),
            );
            vector::push_back(&mut blob_ids, blob_id);
            i = i + 1;
        };
        blob_ids
    }

    fun get_ttl(collection_addr: address): u64 acquires AccessConfig {
        if (exists<AccessConfig>(collection_addr)) {
            borrow_global<AccessConfig>(collection_addr).proof_ttl_us
        } else {
            DEFAULT_TTL_US
        }
    }

    fun emit_read_proof(
        collection_addr: address,
        reader:          address,
        blob_ids:        vector<String>,
        nonce:           u64,
        ttl_us:          u64,
        fee_paid_octas:  u64,
    ) {
        let now        = timestamp::now_microseconds();
        let expires_at = now + ttl_us;
        event::emit(ReadProofIssued {
            collection_addr,
            reader,
            blob_ids,
            nonce,
            expires_at,
            fee_paid_octas,
            timestamp_us: now,
        });
    }

    fun increment_reads_safe(collection_addr: address) {
        collection::increment_reads(collection_addr);
    }
}
