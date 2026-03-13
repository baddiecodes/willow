/// willow::collection
///
/// Manages VectorCollection objects on Aptos.
/// Each collection owns an ordered list of Shelby blob IDs (chunks) plus a
/// Shelby blob ID pointing to the serialised vector index (HNSW / flat).
///
/// Object address = object::create_object_address(&owner_addr, name_bytes)
/// so the address is deterministic and publicly derivable.
module willow::collection {
    friend willow::access_control;

    use std::string::{Self, String};
    use std::signer;
    use std::vector;
    use aptos_framework::object::{Self, ExtendRef};
    use aptos_framework::event;
    use aptos_framework::timestamp;
    use aptos_std::table::{Self, Table};

    // ── Errors ──────────────────────────────────────────────────────────────
    const E_NOT_OWNER:          u64 = 1;
    const E_INVALID_DIMENSIONS: u64 = 2;
    const E_DUPLICATE_CHUNK:    u64 = 3;
    const E_FROZEN:             u64 = 4;
    const E_CHUNK_NOT_FOUND:    u64 = 5;
    const E_INVALID_METRIC:     u64 = 6;
    const E_LENGTH_MISMATCH:    u64 = 7;

    // ── Distance metric constants ────────────────────────────────────────────
    const METRIC_COSINE:    u8 = 0;
    const METRIC_EUCLIDEAN: u8 = 1;
    const METRIC_DOT:       u8 = 2;

    // ── Access policy constants (enforcement in access_control.move) ─────────
    const ACCESS_OPEN:       u8 = 0;  // anyone may read
    const ACCESS_OWNER_ONLY: u8 = 1;  // only collection owner
    const ACCESS_ALLOWLIST:  u8 = 2;  // allowlist managed on-chain
    const ACCESS_PAID:       u8 = 3;  // pay-per-read in APT

    const MAX_DIMENSIONS: u64 = 65536;

    // ── Core resource ────────────────────────────────────────────────────────
    #[resource_group_member(group = aptos_framework::object::ObjectGroup)]
    struct VectorCollection has key {
        /// Aptos address of the collection owner (initially the creator).
        owner: address,
        /// Human-readable name; also used as the object seed.
        name: String,
        /// Embedding model identifier, e.g. "text-embedding-3-small".
        embedding_model: String,
        /// Number of float32 dimensions per vector.
        dimensions: u64,
        /// One of METRIC_COSINE | METRIC_EUCLIDEAN | METRIC_DOT.
        distance_metric: u8,
        /// Shelby blob ID of the serialised HNSW / flat-index file.
        /// Empty string means the index has not been uploaded yet.
        index_blob_id: String,
        /// Ordered list of Shelby blob IDs, one per chunk.
        chunk_blob_ids: vector<String>,
        /// chunk_uuid (caller-assigned) → position in chunk_blob_ids.
        chunk_id_to_idx: Table<String, u64>,
        /// One of ACCESS_OPEN | ACCESS_OWNER_ONLY | ACCESS_ALLOWLIST | ACCESS_PAID.
        access_policy: u8,
        total_chunks: u64,
        total_reads: u64,
        created_at: u64,
        updated_at: u64,
        frozen: bool,
        /// Kept so that access_control.move can add its own resource to this object.
        extend_ref: ExtendRef,
    }

    // ── Events ───────────────────────────────────────────────────────────────
    #[event]
    struct CollectionCreated has drop, store {
        collection_addr: address,
        owner:           address,
        name:            String,
        embedding_model: String,
        dimensions:      u64,
        timestamp_us:    u64,
    }

    #[event]
    struct ChunkAdded has drop, store {
        collection_addr: address,
        chunk_id:        String,
        blob_id:         String,
        chunk_index:     u64,
        timestamp_us:    u64,
    }

    #[event]
    struct IndexUpdated has drop, store {
        collection_addr:   address,
        new_index_blob_id: String,
        total_chunks:      u64,
        timestamp_us:      u64,
    }

    #[event]
    struct AccessPolicyChanged has drop, store {
        collection_addr: address,
        new_policy:      u8,
        timestamp_us:    u64,
    }

    #[event]
    struct CollectionFrozen has drop, store {
        collection_addr: address,
        timestamp_us:    u64,
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    #[view]
    public fun collection_exists(collection_addr: address): bool {
        exists<VectorCollection>(collection_addr)
    }

    #[view]
    public fun get_owner(collection_addr: address): address acquires VectorCollection {
        borrow_global<VectorCollection>(collection_addr).owner
    }

    #[view]
    public fun get_index_blob_id(collection_addr: address): String acquires VectorCollection {
        borrow_global<VectorCollection>(collection_addr).index_blob_id
    }

    #[view]
    public fun get_chunk_blob_id(
        collection_addr: address,
        chunk_id: String,
    ): String acquires VectorCollection {
        let coll = borrow_global<VectorCollection>(collection_addr);
        assert!(table::contains(&coll.chunk_id_to_idx, copy chunk_id), E_CHUNK_NOT_FOUND);
        let idx = *table::borrow(&coll.chunk_id_to_idx, chunk_id);
        *vector::borrow(&coll.chunk_blob_ids, idx)
    }

    #[view]
    public fun get_total_chunks(collection_addr: address): u64 acquires VectorCollection {
        borrow_global<VectorCollection>(collection_addr).total_chunks
    }

    #[view]
    public fun get_access_policy(collection_addr: address): u8 acquires VectorCollection {
        borrow_global<VectorCollection>(collection_addr).access_policy
    }

    #[view]
    public fun is_frozen(collection_addr: address): bool acquires VectorCollection {
        borrow_global<VectorCollection>(collection_addr).frozen
    }

    /// Compute the deterministic object address for a given owner + name.
    #[view]
    public fun collection_address(owner: address, name: String): address {
        object::create_object_address(&owner, *string::bytes(&name))
    }

    // ── Public entry functions ────────────────────────────────────────────────

    /// Create a new VectorCollection as a named Move object.
    /// The caller becomes the owner; the object address is deterministic.
    public entry fun create_collection(
        owner:           &signer,
        name:            String,
        embedding_model: String,
        dimensions:      u64,
        distance_metric: u8,
        access_policy:   u8,
    ) {
        assert!(dimensions > 0 && dimensions <= MAX_DIMENSIONS, E_INVALID_DIMENSIONS);
        assert!(
            distance_metric == METRIC_COSINE   ||
            distance_metric == METRIC_EUCLIDEAN ||
            distance_metric == METRIC_DOT,
            E_INVALID_METRIC
        );

        let owner_addr      = signer::address_of(owner);
        let seed            = *string::bytes(&name);
        let ctor_ref        = object::create_named_object(owner, seed);
        let extend_ref      = object::generate_extend_ref(&ctor_ref);
        let obj_signer      = object::generate_signer(&ctor_ref);
        let collection_addr = object::address_from_constructor_ref(&ctor_ref);
        let now             = timestamp::now_microseconds();

        move_to(&obj_signer, VectorCollection {
            owner:           owner_addr,
            name:            copy name,
            embedding_model: copy embedding_model,
            dimensions,
            distance_metric,
            index_blob_id:   string::utf8(b""),
            chunk_blob_ids:  vector::empty<String>(),
            chunk_id_to_idx: table::new<String, u64>(),
            access_policy,
            total_chunks:    0,
            total_reads:     0,
            created_at:      now,
            updated_at:      now,
            frozen:          false,
            extend_ref,
        });

        event::emit(CollectionCreated {
            collection_addr,
            owner: owner_addr,
            name,
            embedding_model,
            dimensions,
            timestamp_us: now,
        });
    }

    /// Add a single chunk.
    /// chunk_id: caller-assigned UUID (e.g. SHA256 hex of content).
    /// blob_id:  Shelby blob ID returned by @shelby-protocol/sdk after upload.
    public entry fun add_chunk(
        owner:           &signer,
        collection_addr: address,
        chunk_id:        String,
        blob_id:         String,
    ) acquires VectorCollection {
        add_chunk_impl(signer::address_of(owner), collection_addr, chunk_id, blob_id);
    }

    /// Batch-add chunks atomically.
    /// Upload all blobs to Shelby first, then commit the full batch on-chain.
    public entry fun add_chunks_batch(
        owner:           &signer,
        collection_addr: address,
        chunk_ids:       vector<String>,
        blob_ids:        vector<String>,
    ) acquires VectorCollection {
        let len = vector::length(&chunk_ids);
        assert!(len == vector::length(&blob_ids), E_LENGTH_MISMATCH);
        let owner_addr = signer::address_of(owner);
        let i = 0;
        while (i < len) {
            add_chunk_impl(
                owner_addr,
                collection_addr,
                *vector::borrow(&chunk_ids, i),
                *vector::borrow(&blob_ids, i),
            );
            i = i + 1;
        };
    }

    /// Upload a new serialised vector index to Shelby, then record its blob ID here.
    /// Call this after re-indexing locally (HNSW rebuild / incremental update).
    public entry fun update_index(
        owner:             &signer,
        collection_addr:   address,
        new_index_blob_id: String,
    ) acquires VectorCollection {
        let coll = borrow_global_mut<VectorCollection>(collection_addr);
        assert!(signer::address_of(owner) == coll.owner, E_NOT_OWNER);
        assert!(!coll.frozen, E_FROZEN);

        coll.index_blob_id = copy new_index_blob_id;
        let now = timestamp::now_microseconds();
        coll.updated_at = now;

        event::emit(IndexUpdated {
            collection_addr,
            new_index_blob_id,
            total_chunks: coll.total_chunks,
            timestamp_us: now,
        });
    }

    /// Change the access policy. Takes effect immediately for new read-proof requests.
    public entry fun set_access_policy(
        owner:           &signer,
        collection_addr: address,
        new_policy:      u8,
    ) acquires VectorCollection {
        let coll = borrow_global_mut<VectorCollection>(collection_addr);
        assert!(signer::address_of(owner) == coll.owner, E_NOT_OWNER);
        assert!(!coll.frozen, E_FROZEN);
        coll.access_policy = new_policy;
        event::emit(AccessPolicyChanged {
            collection_addr,
            new_policy,
            timestamp_us: timestamp::now_microseconds(),
        });
    }

    /// Permanently freeze a collection (no further mutations).
    public entry fun freeze_collection(
        owner:           &signer,
        collection_addr: address,
    ) acquires VectorCollection {
        let coll = borrow_global_mut<VectorCollection>(collection_addr);
        assert!(signer::address_of(owner) == coll.owner, E_NOT_OWNER);
        coll.frozen = true;
        event::emit(CollectionFrozen {
            collection_addr,
            timestamp_us: timestamp::now_microseconds(),
        });
    }

    // ── Friend-visible helpers (used by access_control.move) ─────────────────

    /// Increment the read counter. Called by access_control after issuing a proof.
    public(friend) fun increment_reads(
        collection_addr: address,
    ) acquires VectorCollection {
        borrow_global_mut<VectorCollection>(collection_addr).total_reads =
            borrow_global<VectorCollection>(collection_addr).total_reads + 1;
    }

    /// Expose the ExtendRef so access_control can attach its resource.
    public(friend) fun borrow_extend_ref(
        collection_addr: address,
    ): &ExtendRef acquires VectorCollection {
        &borrow_global<VectorCollection>(collection_addr).extend_ref
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fun add_chunk_impl(
        owner_addr:      address,
        collection_addr: address,
        chunk_id:        String,
        blob_id:         String,
    ) acquires VectorCollection {
        let coll = borrow_global_mut<VectorCollection>(collection_addr);
        assert!(owner_addr == coll.owner, E_NOT_OWNER);
        assert!(!coll.frozen, E_FROZEN);
        assert!(
            !table::contains(&coll.chunk_id_to_idx, copy chunk_id),
            E_DUPLICATE_CHUNK
        );

        let chunk_index = coll.total_chunks;
        vector::push_back(&mut coll.chunk_blob_ids, copy blob_id);
        table::add(&mut coll.chunk_id_to_idx, copy chunk_id, chunk_index);
        coll.total_chunks = coll.total_chunks + 1;
        let now = timestamp::now_microseconds();
        coll.updated_at = now;

        event::emit(ChunkAdded {
            collection_addr,
            chunk_id,
            blob_id,
            chunk_index,
            timestamp_us: now,
        });
    }

    // ── Constants re-exported for other modules ───────────────────────────────
    public fun access_open():       u8 { ACCESS_OPEN }
    public fun access_owner_only(): u8 { ACCESS_OWNER_ONLY }
    public fun access_allowlist():  u8 { ACCESS_ALLOWLIST }
    public fun access_paid():       u8 { ACCESS_PAID }

    // ── Test-only helpers ────────────────────────────────────────────────────
    #[test_only]
    public fun metric_cosine():    u8 { METRIC_COSINE }
    #[test_only]
    public fun metric_euclidean(): u8 { METRIC_EUCLIDEAN }
    #[test_only]
    public fun metric_dot():       u8 { METRIC_DOT }
}
