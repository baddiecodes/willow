# Shelby Integration Design Document

**Project:** ShelbyVector + ShelbyAgent Hub  
**Version:** 0.1.0  
**Date:** 2026-03-13

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client / Agent                              │
│  TypeScript SDK  ·  Python SDK  ·  LangChain adapter               │
└──────────────┬────────────────────────────┬────────────────────────┘
               │ 1. Upload blobs            │ 3. Fetch blobs
               ▼                            ▼
┌─────────────────────────┐   ┌─────────────────────────────────────┐
│   Shelby Protocol SDK   │   │   Shelby Gateway / RPC Node         │
│  @shelby-protocol/sdk   │   │  Validates ReadProofIssued event    │
│  shelbynet | mainnet    │   │  before serving egress              │
└────────────┬────────────┘   └────────────┬────────────────────────┘
             │ blob_id returned             │ 4. Egress served + billed
             ▼                             │
┌─────────────────────────┐   ┌────────────▼────────────────────────┐
│   Aptos Move Contracts  │◄──│   Shelby Event Indexer              │
│   shelby_hub package    │   │  Watches ReadProofIssued events     │
│  ─────────────────────  │   │  on Aptos; caches valid proofs      │
│  collection.move        │   └─────────────────────────────────────┘
│  access_control.move    │
│  agent_registry.move    │   2. onchain: register blobs,
│  reputation.move        │      request read proof, pay fee
└─────────────────────────┘
```

---

## 2. Shelby Auth Model

Shelby uses a **read-proof event model** — not API keys. Access control lives onchain (Aptos); Shelby gateway only serves a blob if a valid `ReadProofIssued` event exists for the requesting wallet.

### 2.1 Write Auth (Upload)

Blob writes require a funded Shelby account.

```typescript
import { ShelbyClient } from "@shelby-protocol/sdk";

const shelby = new ShelbyClient({
  network:    "shelbynet",          // or "mainnet"
  privateKey: process.env.SHELBY_PRIVATE_KEY,  // Ed25519, hex
  aptosApiKey: process.env.APTOS_API_KEY,
});

// Upload a chunk blob; returns Shelby blob ID
const blobId = await shelby.uploadBlob(chunkBuffer, {
  contentType: "application/octet-stream",  // float32 embedding array
  metadata:    { schema: "vector-chunk-v1", dimensions: 1536 },
});
```

- One Aptos account per service (not per agent). Use a deployer/operator key.
- Blob IDs are content-addressed; uploading the same bytes twice returns the same ID.
- Pre-fund with ShelbyUSD + APT from the faucet (testnet) or bridge (mainnet).

### 2.2 Read Auth — ReadProof Event Flow

```
Client wallet ──► aptos.tx(request_read_proof_*) ──► ReadProofIssued event emitted
                                                              │
Client ──► shelby.fetchBlob(blobId, { proofTxHash }) ──────► Shelby gateway
                                                   verifies event, serves blob
```

**Step-by-step:**

1. **Client builds chunk list** — determine which chunk UUIDs are needed for the query.

2. **Client submits onchain transaction:**
```typescript
import { Aptos, AptosConfig, Network, Account } from "@aptos-labs/ts-sdk";

const aptos  = new Aptos(new AptosConfig({ network: Network.TESTNET }));
const signer = Account.fromPrivateKey({ privateKey: readerPrivKey });

// For ACCESS_OPEN collections:
const txHash = await aptos.transaction.build.simple({
  sender:  signer.accountAddress,
  data: {
    function:      `${HUB_ADDRESS}::access_control::request_read_proof_open`,
    functionArguments: [
      collectionAddr,
      chunkIds,          // vector<String>
      BigInt(Date.now()) // nonce: use epoch ms as monotonic counter
    ],
  },
}).then(tx => aptos.signAndSubmitTransaction({ signer, transaction: tx }));

await aptos.waitForTransaction({ transactionHash: txHash });
```

3. **Client fetches blob from Shelby:**
```typescript
const chunkBuffer = await shelby.fetchBlob(blobId, {
  proofTxHash: txHash,
  reader:      signer.accountAddress.toString(),
});
```

4. **Shelby gateway verifies** (internal, not client-callable):
   - Fetches the Aptos transaction receipt by `proofTxHash`.
   - Locates the `ReadProofIssued` event in the receipt.
   - Checks: `reader` == requesting wallet, `blobId` ∈ `blob_ids`, `now < expires_at`.
   - If valid: streams blob bytes and bills egress to the collection owner's Shelby account.
   - If invalid: returns HTTP 403.

### 2.3 Proof Expiry

Default TTL is **5 minutes** (`DEFAULT_TTL_US = 300_000_000` microseconds). Configure per-collection with `access_control::configure_access`. Maximum allowed TTL is **10 minutes** to limit replay window.

If your pipeline takes longer than 5 minutes between proof request and fetch, increase TTL via `update_access_config`.

---

## 3. Blob Schema Conventions

All blobs stored by this system follow a naming convention encoded in the Shelby blob **path** field (optional metadata, not enforced by the protocol).

| Blob type | Path pattern | Content type |
|-----------|-------------|--------------|
| Vector chunk | `collections/{collection_addr}/chunks/{chunk_uuid}.f32` | `application/octet-stream` |
| HNSW index | `collections/{collection_addr}/index.hnsw` | `application/octet-stream` |
| Agent metadata | `agents/{agent_addr}/metadata.jsonld` | `application/ld+json` |
| Reputation history | `agents/{agent_addr}/reputation.jsonl` | `application/jsonl` |
| Memory snapshot | `agents/{agent_addr}/memory.jsonl` | `application/jsonl` |

### 3.1 Vector Chunk Format

Raw binary: little-endian `float32` array, `dimensions × 4` bytes.  
Preceded by a 16-byte header: `[magic(4)] [dimensions(4)] [reserved(8)]`.

```
Offset  Size  Field
0       4     magic: 0x5356454B ("SVEK")
4       4     dimensions: uint32 LE
8       8     reserved (zero)
12      N*4   float32 values
```

### 3.2 Agent Metadata (JSON-LD)

```json
{
  "@context": "https://schema.org/",
  "@type":    "SoftwareAgent",
  "identifier":   "did:shelby:aptos:0xa001:0",
  "name":         "ResearchAgent-Alpha",
  "version":      "0.2.1",
  "capabilities": ["web_search", "rag_query", "code_execution"],
  "memoryCollection": "0x<collection_addr>",
  "framework":    "LangChain",
  "createdAt":    "2026-03-13T00:00:00Z"
}
```

### 3.3 Reputation History (JSONL)

One JSON object per line, appended by the off-chain reporter before calling `update_history_blob`:

```jsonl
{"ts":1741824000,"reporter":"0xa003","delta":50,"positive":true,"reason":"correct_answer","score_after":5050}
{"ts":1741824600,"reporter":"0xa003","delta":100,"positive":false,"reason":"hallucination","score_after":4950}
```

---

## 4. Egress Payment Model

### 4.1 Who Pays?

| Collection policy | Who pays egress? |
|-------------------|-----------------|
| `ACCESS_OPEN`     | Collection **owner** (they fund their Shelby account for public reads) |
| `ACCESS_ALLOWLIST`| Collection **owner** |
| `ACCESS_PAID`     | **Reader** pays `read_fee_octas` APT onchain to the owner; owner funds Shelby egress from that revenue |
| `ACCESS_OWNER_ONLY` | Collection **owner** |

### 4.2 Setting the Right Read Fee (ACCESS_PAID)

Shelby charges egress per GB served. To calculate break-even:

```
chunk_size_bytes   = dimensions × 4 + 16  (header)
shelby_egress_cost = chunk_size_bytes / 1_000_000_000 × shelby_gb_rate_usd
read_fee_octas     = ceil(shelby_egress_cost / apt_price_usd × 100_000_000)
```

Set `read_fee_octas` via `access_control::configure_access` or `update_access_config`.  
A 1536-dimension chunk ≈ 6.2 KB. At $0.01/GB egress rate, break-even ≈ 0.000062 APT per read — round up for margin.

### 4.3 APT Transfer onchain

In `request_read_proof_paid`:
```move
coin::transfer<AptosCoin>(reader, collection_owner, read_fee_octas);
```
This is atomic with the proof emission. If the reader has insufficient APT the entire transaction reverts — no partial fee, no proof emitted.

---

## 5. Off-chain Indexer

The Shelby gateway needs to index `ReadProofIssued` events. Reference implementation (pseudo-code):

```typescript
// Aptos event subscription
const stream = aptos.event.getModuleEventsByEventType({
  eventType: `${HUB_ADDRESS}::access_control::ReadProofIssued`,
  limit:     100,
});

for await (const event of stream) {
  const { collection_addr, reader, blob_ids, nonce, expires_at } = event.data;
  // Cache in Redis with TTL = expires_at - now
  for (const blobId of blob_ids) {
    await redis.setex(
      `proof:${reader}:${blobId}`,
      Math.ceil((expires_at - Date.now() * 1000) / 1_000_000),
      JSON.stringify({ collection_addr, nonce, expires_at }),
    );
  }
}
```

The gateway then checks `GET proof:{reader}:{blobId}` before serving. If the key exists and is not expired: serve. Otherwise: 403.

---

## 6. Full Write → Read Lifecycle

```
1. EMBED
   chunkText → embedding model → float32[1536]

2. PACK
   header(magic, dims) ++ float32 bytes → chunkBuffer

3. UPLOAD TO SHELBY
   shelby.uploadBlob(chunkBuffer) → blobId: "shelby://abc123..."

4. REGISTER onchain
   collection::add_chunk(owner, collectionAddr, chunkUUID, blobId)
   ↳ emits ChunkAdded event (indexed by off-chain query service)

5. REBUILD INDEX (periodic, e.g. after every 100 new chunks)
   local: load all chunk blobs → rebuild HNSW → serialise
   shelby.uploadBlob(hnswBuffer) → indexBlobId
   collection::update_index(owner, collectionAddr, indexBlobId)
   ↳ emits IndexUpdated event

6. QUERY (reader side)
   a. fetch indexBlobId from chain (get_index_blob_id view)
   b. request_read_proof_open/paid/allowlist for [indexChunkId, queryChunkIds]
   c. shelby.fetchBlob(indexBlobId, { proofTxHash })
   d. local HNSW search → top-K blobIds
   e. shelby.fetchBlob(blobId, { proofTxHash }) for each result
   f. return chunk text to LLM context
```

---

## 7. Contract Addresses

Fill in after deploying:

| Network     | `shelby_hub` address |
|-------------|---------------------|
| Shelbynet (testnet) | `TBD — fill after `aptos move publish`` |
| Aptos Mainnet | `TBD` |

Deploy command:
```bash
aptos move publish \
  --named-addresses shelby_hub=<your_deployer_address> \
  --profile shelbynet \
  --assume-yes
```

After deploy, call initialisers:
```bash
aptos move run \
  --function-id '<addr>::agent_registry::initialize' \
  --profile shelbynet

aptos move run \
  --function-id '<addr>::reputation::initialize' \
  --profile shelbynet
```

---

## 8. Security Notes

| Risk | Mitigation |
|------|-----------|
| Proof replay across collections | `collection_addr` is part of the proof event; gateway validates it matches the requested blob's collection |
| Nonce replay within TTL window | Caller must use monotonic nonce (epoch ms or onchain sequence); gateway caches `proof:{reader}:{blobId}:{nonce}` |
| Reporter manipulation of scores | MAX_DELTA = 1000 bps per update; moving from 5000 to 0 requires 5 sequential negative updates — gives time for challenge |
| Large chunk_blob_ids vector | Capped by Aptos tx gas limit (~64 items per proof request at current gas); batch into multiple txs if needed |
| ACCESS_PAID front-running | Proof expires in ≤10 min; economic attack cost = read_fee × window; not profitable at reasonable fees |
| Private key exposure | Never commit `SHELBY_PRIVATE_KEY` or `APTOS_API_KEY`; use environment variables or AWS Secrets Manager |
