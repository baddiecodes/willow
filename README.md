# 🌿 Willow

> Reference implementation of **ShelbyAgent Hub**  
> A decentralized vector database + AI agent identity layer.

Willow implements **ShelbyAgent Hub protocol**, which defines decentralized infrastructure for AI agents — including vector memory, identity (DIDs), and onchain reputation — built on **Shelby Protocol** storage and **Aptos Move** smart contracts.

---

## What is Willow?

**Willow is the reference implementation of ShelbyAgent Hub protocol.**

ShelbyAgent Hub defines a decentralized infrastructure layer for:

• AI agent identity (DIDs)  
• verifiable agent reputation  
• decentralized vector memory  
• permissioned blob access via Shelby read proofs

```
Your AI Agent / LangChain / CrewAI / MCP
           │
   @willow/sdk  (TypeScript)
           │
  Shelby Protocol ◄──────────────────────────────► Aptos Move Contracts
  (blob storage)                                    (ownership · access · identity)
           │
  @willow/indexer  (local HNSW + query API)
```

**Contract address:** `0xb72a54bf4c5fe6e4448e7fd77dcc58c130141a3eba9eed2de7066fde3479aab3`  
**Network:** Shelbynet (Aptos testnet)

---

## Architecture diagram

![Willow Architecture](docs/architecture.png)

---

## Repo structure

```
willow/
├── sources/                   ← Aptos Move contracts
│   ├── collection.move         VectorCollection: chunks + HNSW index blob
│   ├── access_control.move     ReadProof auth + APT egress payments
│   ├── agent_registry.move     DID registry for AI agents
│   └── reputation.move         Onchain reputation scores
├── tests/
│   └── willow_tests.move       13 unit tests
├── Move.toml
├── INTEGRATION.md              Auth / read-proof / egress payment spec
│
├── willow-sdk/                ← TypeScript SDK (@willow/sdk)
│   └── src/
│       ├── client.ts           WillowClient facade
│       ├── collection.ts       Collection CRUD + access control
│       ├── agent.ts            Agent registry + reputation
│       ├── shelby.ts           Shelby blob upload/download
│       ├── aptos.ts            Aptos client helpers
│       ├── types.ts            All TypeScript interfaces
│       └── constants.ts        Contract addresses + constants
│
└── willow-indexer/            ← Local HNSW indexer + query API
    └── src/
        ├── index.ts            Entrypoint
        ├── indexer.ts          Index manager + rebuild logic
        ├── hnsw.ts             WillowHnsw wrapper (hnswlib-node)
        ├── watcher.ts          Aptos event poller
        └── server.ts           Express query API
```

---

## Quick start

### 1. Run Move tests

```bash
# install Aptos CLI: https://aptos.dev/en/build/cli
aptos move test --named-addresses willow=0xCAFE
```

### 2. Use the TypeScript SDK

```bash
cd willow-sdk && npm install && npm run build
```

```typescript
import { WillowClient, METRIC_COSINE, ACCESS_OPEN } from "@willow/sdk";

const willow = new WillowClient({
  privateKey: process.env.APTOS_PRIVATE_KEY!,
  network:    "testnet",
});

// Create a vector collection
await willow.createCollection({
  name:           "my-rag-kb",
  embeddingModel: "text-embedding-3-small",
  dimensions:     1536,
  distanceMetric: METRIC_COSINE,
  accessPolicy:   ACCESS_OPEN,
});

// Add a chunk (embedding → Shelby blob → on-chain registration)
const result = await willow.addChunk({
  collectionAddr: "<collection_addr>",
  chunkId:        "chunk-001",
  embedding:      new Float32Array(1536).fill(0.1),
  text:           "Willow is a decentralized vector database on Aptos",
});

console.log("blob:", result.blobId, "tx:", result.txHash);
```

### 3. Register an AI agent

```typescript
const agent = await willow.registerAgent({
  metadata: {
    "@context":   "https://schema.org/",
    "@type":      "SoftwareAgent",
    identifier:   "pending",
    name:         "ResearchAgent-Alpha",
    version:      "0.1.0",
    capabilities: ["rag_query", "web_search"],
    framework:    "LangChain",
    createdAt:    new Date().toISOString(),
  },
  memoryCollectionAddr: "<collection_addr>",
  initReputation:       true,
});

console.log("DID:", agent.did);
// → did:willow:aptos:0xb72a...:0
```

### 4. Start the local indexer

```bash
cd willow-indexer
npm install
cp .env.example .env    # fill in APTOS_PRIVATE_KEY, set SHELBY_MOCK=true for dev
npm run build
npm start
```

API endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/track` | Start tracking a collection |
| `POST` | `/query` | Vector search (kNN) |
| `GET`  | `/status` | All tracked collections |
| `GET`  | `/status/:addr` | Single collection status |
| `POST` | `/rebuild/:addr` | Manual index rebuild |

```bash
# Example query
curl -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{
    "collectionAddr": "<addr>",
    "vector": [0.1, 0.2, ...],
    "topK": 5
  }'
```

---

## Move contract functions

| Module | Key functions |
|--------|--------------|
| `collection` | `create_collection` · `add_chunk` · `add_chunks_batch` · `update_index` · `set_access_policy` · `freeze_collection` |
| `access_control` | `configure_access` · `set_allowlist_entry` · `request_read_proof_{open\|allowlist\|paid\|owner}` |
| `agent_registry` | `initialize` · `register_agent` · `link_memory_collection` · `deactivate_agent` |
| `reputation` | `initialize` · `set_reporter` · `initialise_score` · `submit_score_update` |

---

## Deployment

```bash
# 1. Publish contracts
aptos move publish \
  --named-addresses willow=0xb72a54bf4c5fe6e4448e7fd77dcc58c130141a3eba9eed2de7066fde3479aab3 \
  --profile shelbynet \
  --assume-yes

# 2. Initialise (one-time)
ADDR=0xb72a54bf4c5fe6e4448e7fd77dcc58c130141a3eba9eed2de7066fde3479aab3
aptos move run --function-id "${ADDR}::agent_registry::initialize" --profile shelbynet
aptos move run --function-id "${ADDR}::reputation::initialize"     --profile shelbynet
```

---

## Access policies

| Value | Policy | Who pays egress? |
|-------|--------|-----------------|
| `0` | `ACCESS_OPEN` | Collection owner |
| `1` | `ACCESS_OWNER_ONLY` | Collection owner |
| `2` | `ACCESS_ALLOWLIST` | Collection owner |
| `3` | `ACCESS_PAID` | Reader (APT fee onchain) |

---

## License

MIT — built by [@withmewtwo](https://twitter.com/withmewtwo) / [Junohauz](https://junohauz.xyz)
