#[test_only]
module willow::shelby_hub_tests {
    use std::string;
    use std::signer;
    use aptos_framework::account;
    use aptos_framework::timestamp;
    use aptos_framework::object;
    use willow::collection;
    use willow::access_control;
    use willow::agent_registry;
    use willow::reputation;

    // ── Test accounts ─────────────────────────────────────────────────────────
    const OWNER:    address = @0xA001;
    const READER:   address = @0xA002;
    const REPORTER: address = @0xA003;
    const HUB:      address = @willow;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fun setup_aptos(aptos: &signer) {
        timestamp::set_time_has_started_for_testing(aptos);
    }

    fun make_account(aptos: &signer, addr: address): signer {
        account::create_account_for_test(addr);
        account::create_signer_for_test(addr)
    }

    // ── collection module ─────────────────────────────────────────────────────

    #[test(aptos = @aptos_framework)]
    fun test_create_collection_success(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner,
            string::utf8(b"my-collection"),
            string::utf8(b"text-embedding-3-small"),
            1536,
            collection::metric_cosine(),
            collection::access_open(),
        );
        let coll_addr = collection::collection_address(
            OWNER, string::utf8(b"my-collection")
        );
        assert!(collection::collection_exists(coll_addr), 0);
        assert!(collection::get_owner(coll_addr) == OWNER, 1);
        assert!(collection::get_total_chunks(coll_addr) == 0, 2);
        assert!(!collection::is_frozen(coll_addr), 3);
    }

    #[test(aptos = @aptos_framework)]
    #[expected_failure(abort_code = 2, location = willow::collection)]
    fun test_create_collection_invalid_dimensions(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner,
            string::utf8(b"bad"),
            string::utf8(b"model"),
            0,  // invalid
            collection::metric_cosine(),
            collection::access_open(),
        );
    }

    #[test(aptos = @aptos_framework)]
    fun test_add_chunk_and_get_blob(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner,
            string::utf8(b"rag-kb"),
            string::utf8(b"nomic-embed-text-v1"),
            768,
            collection::metric_dot(),
            collection::access_open(),
        );
        let coll_addr = collection::collection_address(
            OWNER, string::utf8(b"rag-kb")
        );
        collection::add_chunk(
            &owner,
            coll_addr,
            string::utf8(b"chunk-uuid-001"),
            string::utf8(b"shelby-blob-aabbccdd"),
        );
        assert!(collection::get_total_chunks(coll_addr) == 1, 0);
        let blob = collection::get_chunk_blob_id(
            coll_addr, string::utf8(b"chunk-uuid-001")
        );
        assert!(blob == string::utf8(b"shelby-blob-aabbccdd"), 1);
    }

    #[test(aptos = @aptos_framework)]
    #[expected_failure(abort_code = 3, location = willow::collection)]
    fun test_add_duplicate_chunk_fails(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner, string::utf8(b"dup-test"),
            string::utf8(b"model"), 256,
            collection::metric_cosine(), collection::access_open(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"dup-test"));
        collection::add_chunk(&owner, addr,
            string::utf8(b"same-id"), string::utf8(b"blob-1"));
        collection::add_chunk(&owner, addr,
            string::utf8(b"same-id"), string::utf8(b"blob-2")); // should abort
    }

    #[test(aptos = @aptos_framework)]
    fun test_batch_add_chunks(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner, string::utf8(b"batch"),
            string::utf8(b"model"), 512,
            collection::metric_euclidean(), collection::access_open(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"batch"));
        let ids  = vector[
            string::utf8(b"c1"), string::utf8(b"c2"), string::utf8(b"c3")
        ];
        let blobs = vector[
            string::utf8(b"b1"), string::utf8(b"b2"), string::utf8(b"b3")
        ];
        collection::add_chunks_batch(&owner, addr, ids, blobs);
        assert!(collection::get_total_chunks(addr) == 3, 0);
    }

    #[test(aptos = @aptos_framework)]
    fun test_update_index(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner, string::utf8(b"indexed"),
            string::utf8(b"model"), 384,
            collection::metric_cosine(), collection::access_open(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"indexed"));
        collection::update_index(
            &owner, addr, string::utf8(b"hnsw-index-blob-xyz")
        );
        assert!(
            collection::get_index_blob_id(addr) == string::utf8(b"hnsw-index-blob-xyz"),
            0
        );
    }

    #[test(aptos = @aptos_framework)]
    #[expected_failure(abort_code = 4, location = willow::collection)]
    fun test_frozen_collection_rejects_add(aptos: &signer) {
        setup_aptos(aptos);
        let owner = account::create_account_for_test(OWNER);
        collection::create_collection(
            &owner, string::utf8(b"frozen-col"),
            string::utf8(b"model"), 256,
            collection::metric_cosine(), collection::access_open(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"frozen-col"));
        collection::freeze_collection(&owner, addr);
        collection::add_chunk(
            &owner, addr,
            string::utf8(b"c1"), string::utf8(b"b1")  // should abort
        );
    }

    // ── access_control module ─────────────────────────────────────────────────

    #[test(aptos = @aptos_framework)]
    fun test_read_proof_open_collection(aptos: &signer) {
        setup_aptos(aptos);
        let owner  = account::create_account_for_test(OWNER);
        let reader = account::create_account_for_test(READER);
        collection::create_collection(
            &owner, string::utf8(b"open-col"),
            string::utf8(b"model"), 256,
            collection::metric_cosine(), collection::access_open(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"open-col"));
        collection::add_chunk(
            &owner, addr,
            string::utf8(b"c1"), string::utf8(b"blob-open-1")
        );
        access_control::request_read_proof_open(
            &reader, addr,
            vector[string::utf8(b"c1")],
            1001,
        );
    }

    #[test(aptos = @aptos_framework)]
    fun test_allowlist_read_proof(aptos: &signer) {
        setup_aptos(aptos);
        let owner  = account::create_account_for_test(OWNER);
        let reader = account::create_account_for_test(READER);
        collection::create_collection(
            &owner, string::utf8(b"al-col"),
            string::utf8(b"model"), 256,
            collection::metric_cosine(), collection::access_allowlist(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"al-col"));
        collection::add_chunk(
            &owner, addr,
            string::utf8(b"c1"), string::utf8(b"blob-al-1")
        );
        access_control::configure_access(&owner, addr, 0, 300_000_000);
        access_control::set_allowlist_entry(&owner, addr, READER, true);
        access_control::request_read_proof_allowlist(
            &reader, addr,
            vector[string::utf8(b"c1")],
            2001,
        );
    }

    #[test(aptos = @aptos_framework)]
    #[expected_failure(abort_code = 105, location = willow::access_control)]
    fun test_allowlist_rejects_unlisted_reader(aptos: &signer) {
        setup_aptos(aptos);
        let owner  = account::create_account_for_test(OWNER);
        let reader = account::create_account_for_test(READER);
        collection::create_collection(
            &owner, string::utf8(b"al-strict"),
            string::utf8(b"model"), 256,
            collection::metric_cosine(), collection::access_allowlist(),
        );
        let addr = collection::collection_address(OWNER, string::utf8(b"al-strict"));
        collection::add_chunk(&owner, addr,
            string::utf8(b"c1"), string::utf8(b"blob-1"));
        access_control::configure_access(&owner, addr, 0, 300_000_000);
        // Reader NOT added to allowlist — should abort.
        access_control::request_read_proof_allowlist(
            &reader, addr,
            vector[string::utf8(b"c1")],
            3001,
        );
    }

    // ── agent_registry module ─────────────────────────────────────────────────

    #[test(aptos = @aptos_framework)]
    fun test_register_agent(aptos: &signer) {
        setup_aptos(aptos);
        let hub_signer = account::create_account_for_test(HUB);
        let owner      = account::create_account_for_test(OWNER);
        agent_registry::initialize(&hub_signer);
        agent_registry::register_agent(
            &owner,
            string::utf8(b"shelby-blob-metadata-001"),
        );
        assert!(agent_registry::total_agents() == 1, 0);
        assert!(agent_registry::next_seq(OWNER) == 1, 1);
    }

    #[test(aptos = @aptos_framework)]
    fun test_multiple_agents_same_owner(aptos: &signer) {
        setup_aptos(aptos);
        let hub_signer = account::create_account_for_test(HUB);
        let owner      = account::create_account_for_test(OWNER);
        agent_registry::initialize(&hub_signer);
        agent_registry::register_agent(
            &owner, string::utf8(b"blob-A")
        );
        agent_registry::register_agent(
            &owner, string::utf8(b"blob-B")
        );
        assert!(agent_registry::next_seq(OWNER) == 2, 0);
        assert!(agent_registry::total_agents() == 2, 1);
    }

    #[test(aptos = @aptos_framework)]
    fun test_deactivate_agent(aptos: &signer) {
        setup_aptos(aptos);
        let hub_signer = account::create_account_for_test(HUB);
        let owner      = account::create_account_for_test(OWNER);
        agent_registry::initialize(&hub_signer);
        agent_registry::register_agent(&owner, string::utf8(b"meta-blob"));
        assert!(agent_registry::total_agents() == 1, 0);
    }

    // ── reputation module ─────────────────────────────────────────────────────

    #[test(aptos = @aptos_framework)]
    fun test_reporter_management(aptos: &signer) {
        setup_aptos(aptos);
        let hub_signer = account::create_account_for_test(HUB);
        reputation::initialize(&hub_signer);
        reputation::set_reporter(&hub_signer, REPORTER, true);
        assert!(reputation::is_reporter(REPORTER), 0);
        reputation::set_reporter(&hub_signer, REPORTER, false);
        assert!(!reputation::is_reporter(REPORTER), 1);
    }

    #[test(aptos = @aptos_framework)]
    #[expected_failure(abort_code = 300, location = willow::reputation)]
    fun test_non_admin_cannot_set_reporter(aptos: &signer) {
        setup_aptos(aptos);
        let hub_signer = account::create_account_for_test(HUB);
        let non_admin  = account::create_account_for_test(OWNER);
        reputation::initialize(&hub_signer);
        reputation::set_reporter(&non_admin, REPORTER, true);  // should abort
    }
}
