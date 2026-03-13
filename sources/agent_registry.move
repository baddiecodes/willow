/// willow::agent_registry
///
/// Decentralised Identity (DID) registry for AI agents on Aptos.
///
/// DID format: "did:shelby:aptos:<owner_hex>:<agent_seq>"
///   owner_hex — 0x-prefixed hex string of the owner's Aptos address
///   agent_seq — per-owner monotonic sequence number (u64, decimal string)
///
/// Each agent record links to:
///   • a Shelby blob ID for the JSON-LD agent metadata document
///   • the Aptos address of a VectorCollection used as the agent's memory store
///
/// Object address = object::create_object_address(&owner, seed)
///   where seed = b"agent::<owner_hex>::<seq_as_bytes>"
module willow::agent_registry {
    friend willow::reputation;

    use std::string::{Self, String};
    use std::signer;
    use std::bcs;
    use aptos_framework::object::{Self, ExtendRef};
    use aptos_framework::event;
    use aptos_framework::timestamp;
    use aptos_std::table::{Self, Table};

    // ── Errors ───────────────────────────────────────────────────────────────
    const E_NOT_OWNER:            u64 = 200;
    const E_AGENT_NOT_FOUND:      u64 = 201;
    const E_AGENT_INACTIVE:       u64 = 202;
    const E_COUNTER_NOT_INIT:     u64 = 203;
    const E_COLLECTION_MISMATCH:  u64 = 204;

    // ── OwnerCounter resource ─────────────────────────────────────────────────
    /// Stored at the owner's address. Tracks how many agents they have created.
    struct OwnerCounter has key {
        next_seq: u64,
    }

    // ── AgentDID resource ────────────────────────────────────────────────────
    #[resource_group_member(group = aptos_framework::object::ObjectGroup)]
    struct AgentDID has key {
        /// W3C-compatible DID string, e.g. "did:shelby:aptos:0xcafe:0"
        did:                String,
        /// Aptos address of the owner (can transfer via object transfer).
        owner:              address,
        /// Shelby blob ID storing the JSON-LD DID Document (metadata, capabilities).
        metadata_blob_id:   String,
        /// Aptos address of the VectorCollection used as this agent's memory.
        /// address(0) means no memory collection linked yet.
        memory_collection:  address,
        /// Sequence number within the owner's namespace.
        seq:                u64,
        active:             bool,
        created_at:         u64,
        updated_at:         u64,
        extend_ref:         ExtendRef,
    }

    // ── GlobalIndex resource ─────────────────────────────────────────────────
    /// Stored at @willow. Maps DID string → agent object address.
    struct GlobalIndex has key {
        did_to_addr: Table<String, address>,
        total_agents: u64,
    }

    // ── Events ───────────────────────────────────────────────────────────────
    #[event]
    struct AgentRegistered has drop, store {
        agent_addr:        address,
        did:               String,
        owner:             address,
        metadata_blob_id:  String,
        timestamp_us:      u64,
    }

    #[event]
    struct AgentMetadataUpdated has drop, store {
        agent_addr:           address,
        did:                  String,
        new_metadata_blob_id: String,
        timestamp_us:         u64,
    }

    #[event]
    struct MemoryCollectionLinked has drop, store {
        agent_addr:      address,
        did:             String,
        collection_addr: address,
        timestamp_us:    u64,
    }

    #[event]
    struct AgentDeactivated has drop, store {
        agent_addr:   address,
        did:          String,
        timestamp_us: u64,
    }

    // ── Module initialiser ───────────────────────────────────────────────────

    /// Must be called once by the package deployer after publishing.
    public entry fun initialize(deployer: &signer) {
        let addr = signer::address_of(deployer);
        assert!(addr == @willow, E_NOT_OWNER);
        if (!exists<GlobalIndex>(addr)) {
            move_to(deployer, GlobalIndex {
                did_to_addr:  table::new<String, address>(),
                total_agents: 0,
            });
        }
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    #[view]
    public fun agent_exists(agent_addr: address): bool {
        exists<AgentDID>(agent_addr)
    }

    #[view]
    public fun get_did(agent_addr: address): String acquires AgentDID {
        borrow_global<AgentDID>(agent_addr).did
    }

    #[view]
    public fun get_owner(agent_addr: address): address acquires AgentDID {
        borrow_global<AgentDID>(agent_addr).owner
    }

    #[view]
    public fun get_metadata_blob_id(agent_addr: address): String acquires AgentDID {
        borrow_global<AgentDID>(agent_addr).metadata_blob_id
    }

    #[view]
    public fun get_memory_collection(agent_addr: address): address acquires AgentDID {
        borrow_global<AgentDID>(agent_addr).memory_collection
    }

    #[view]
    public fun is_active(agent_addr: address): bool acquires AgentDID {
        borrow_global<AgentDID>(agent_addr).active
    }

    #[view]
    public fun lookup_by_did(did: String): address acquires GlobalIndex {
        *table::borrow(&borrow_global<GlobalIndex>(@willow).did_to_addr, did)
    }

    #[view]
    public fun total_agents(): u64 acquires GlobalIndex {
        borrow_global<GlobalIndex>(@willow).total_agents
    }

    #[view]
    public fun next_seq(owner: address): u64 acquires OwnerCounter {
        if (!exists<OwnerCounter>(owner)) { return 0 };
        borrow_global<OwnerCounter>(owner).next_seq
    }

    // ── Public entry functions ────────────────────────────────────────────────

    /// Register a new AI agent DID.
    /// metadata_blob_id: Shelby blob containing the JSON-LD DID Document.
    ///   Upload this blob with your Shelby SDK before calling this function.
    public entry fun register_agent(
        owner:            &signer,
        metadata_blob_id: String,
    ) acquires OwnerCounter, GlobalIndex {
        let owner_addr = signer::address_of(owner);

        if (!exists<OwnerCounter>(owner_addr)) {
            move_to(owner, OwnerCounter { next_seq: 0 });
        };

        let counter = borrow_global_mut<OwnerCounter>(owner_addr);
        let seq     = counter.next_seq;
        counter.next_seq = seq + 1;

        let seed       = build_seed(owner_addr, seq);
        let ctor_ref   = object::create_named_object(owner, seed);
        let extend_ref = object::generate_extend_ref(&ctor_ref);
        let obj_signer = object::generate_signer(&ctor_ref);
        let agent_addr = object::address_from_constructor_ref(&ctor_ref);
        let now        = timestamp::now_microseconds();

        let did = build_did(owner_addr, seq);

        move_to(&obj_signer, AgentDID {
            did:               copy did,
            owner:             owner_addr,
            metadata_blob_id:  copy metadata_blob_id,
            memory_collection: @0x0,
            seq,
            active:            true,
            created_at:        now,
            updated_at:        now,
            extend_ref,
        });

        let index = borrow_global_mut<GlobalIndex>(@willow);
        table::add(&mut index.did_to_addr, copy did, agent_addr);
        index.total_agents = index.total_agents + 1;

        event::emit(AgentRegistered {
            agent_addr,
            did,
            owner: owner_addr,
            metadata_blob_id,
            timestamp_us: now,
        });
    }

    /// Update the agent's metadata blob (e.g. after adding new capabilities).
    public entry fun update_metadata(
        owner:                &signer,
        agent_addr:           address,
        new_metadata_blob_id: String,
    ) acquires AgentDID {
        let agent = borrow_global_mut<AgentDID>(agent_addr);
        assert!(signer::address_of(owner) == agent.owner, E_NOT_OWNER);
        assert!(agent.active, E_AGENT_INACTIVE);

        agent.metadata_blob_id = copy new_metadata_blob_id;
        let now = timestamp::now_microseconds();
        agent.updated_at = now;

        event::emit(AgentMetadataUpdated {
            agent_addr,
            did: agent.did,
            new_metadata_blob_id,
            timestamp_us: now,
        });
    }

    /// Link a VectorCollection as this agent's memory store.
    public entry fun link_memory_collection(
        owner:           &signer,
        agent_addr:      address,
        collection_addr: address,
    ) acquires AgentDID {
        let owner_addr = signer::address_of(owner);
        let agent      = borrow_global_mut<AgentDID>(agent_addr);
        assert!(owner_addr == agent.owner, E_NOT_OWNER);
        assert!(agent.active, E_AGENT_INACTIVE);
        assert!(
            willow::collection::get_owner(collection_addr) == owner_addr,
            E_COLLECTION_MISMATCH
        );

        agent.memory_collection = collection_addr;
        let now = timestamp::now_microseconds();
        agent.updated_at = now;

        event::emit(MemoryCollectionLinked {
            agent_addr,
            did: agent.did,
            collection_addr,
            timestamp_us: now,
        });
    }

    /// Deactivate an agent (soft delete; object remains onchain).
    public entry fun deactivate_agent(
        owner:      &signer,
        agent_addr: address,
    ) acquires AgentDID {
        let agent = borrow_global_mut<AgentDID>(agent_addr);
        assert!(signer::address_of(owner) == agent.owner, E_NOT_OWNER);
        agent.active     = false;
        agent.updated_at = timestamp::now_microseconds();
        event::emit(AgentDeactivated {
            agent_addr,
            did:          agent.did,
            timestamp_us: agent.updated_at,
        });
    }

    // ── Friend-visible helpers (used by reputation.move) ─────────────────────

    public(friend) fun borrow_extend_ref(
        agent_addr: address,
    ): &ExtendRef acquires AgentDID {
        &borrow_global<AgentDID>(agent_addr).extend_ref
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Seed = b"agent" ++ bcs(owner_addr) ++ bcs(seq)
    fun build_seed(owner: address, seq: u64): vector<u8> {
        let seed        = b"agent";
        let owner_bytes = bcs::to_bytes(&owner);
        let seq_bytes   = bcs::to_bytes(&seq);
        std::vector::append(&mut seed, owner_bytes);
        std::vector::append(&mut seed, seq_bytes);
        seed
    }

    /// "did:shelby:aptos:<hex_addr>:<seq>"
    fun build_did(owner: address, seq: u64): String {
        let did = string::utf8(b"did:shelby:aptos:");
        string::append(&mut did, address_to_hex_string(owner));
        string::append_utf8(&mut did, b":");
        string::append(&mut did, u64_to_string(seq));
        did
    }

    fun address_to_hex_string(addr: address): String {
        let bytes  = bcs::to_bytes(&addr);
        let result = string::utf8(b"0x");
        let i = 0;
        while (i < std::vector::length(&bytes)) {
            let byte = *std::vector::borrow(&bytes, i);
            let hi   = byte >> 4;
            let lo   = byte & 0x0f;
            string::append_utf8(&mut result, vector[nibble_to_ascii(hi)]);
            string::append_utf8(&mut result, vector[nibble_to_ascii(lo)]);
            i = i + 1;
        };
        result
    }

    fun nibble_to_ascii(n: u8): u8 {
        if (n < 10) { n + 48 } else { n + 87 }
    }

    fun u64_to_string(n: u64): String {
        if (n == 0) { return string::utf8(b"0") };
        let buf = std::vector::empty<u8>();
        let val = n;
        while (val > 0) {
            std::vector::push_back(&mut buf, ((val % 10) as u8) + 48);
            val = val / 10;
        };
        std::vector::reverse(&mut buf);
        string::utf8(buf)
    }
}
