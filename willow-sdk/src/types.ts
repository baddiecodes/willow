// ─── Willow SDK Types ────────────────────────────────────────────────────────

export interface WillowConfig {
  /** Aptos private key (hex, with or without 0x prefix) */
  privateKey: string;
  /** "testnet" | "mainnet" | custom RPC URL */
  network?: "testnet" | "mainnet" | string;
  /** Shelby RPC endpoint override */
  shelbyRpc?: string;
  /** OpenAI API key for built-in embedding helper */
  openaiApiKey?: string;
}

// ── Collection ────────────────────────────────────────────────────────────────

export interface CreateCollectionParams {
  name: string;
  embeddingModel: string;
  dimensions: number;
  distanceMetric?: 0 | 1 | 2; // COSINE | EUCLIDEAN | DOT
  accessPolicy?: 0 | 1 | 2 | 3; // OPEN | OWNER_ONLY | ALLOWLIST | PAID
}

export interface AddChunkParams {
  collectionAddr: string;
  chunkId: string;
  /** Raw float32 embedding vector */
  embedding: Float32Array | number[];
  /** Optional text content stored as JSON metadata blob */
  text?: string;
  /** Extra metadata merged into the stored JSON blob */
  metadata?: Record<string, unknown>;
}

export interface AddChunkResult {
  blobId: string;
  chunkId: string;
  txHash: string;
}

export interface BatchAddChunksParams {
  collectionAddr: string;
  chunks: Array<{
    chunkId: string;
    embedding: Float32Array | number[];
    text?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface UpdateIndexParams {
  collectionAddr: string;
  /** Serialised HNSW buffer to upload to Shelby */
  indexBuffer: Buffer;
}

export interface CollectionInfo {
  owner: string;
  name: string;
  embeddingModel: string;
  dimensions: number;
  distanceMetric: number;
  indexBlobId: string;
  totalChunks: number;
  totalReads: number;
  accessPolicy: number;
  frozen: boolean;
  createdAt: bigint;
  updatedAt: bigint;
}

// ── Access Control ───────────────────────────────────────────────────────────

export interface ConfigureAccessParams {
  collectionAddr: string;
  readFeeOctas?: bigint;
  proofTtlUs?: bigint;
}

export interface RequestReadProofParams {
  collectionAddr: string;
  chunkIds: string[];
  /** Monotonic nonce — defaults to Date.now() as BigInt */
  nonce?: bigint;
}

export interface ReadProofResult {
  txHash: string;
  blobIds: string[];
  expiresAt: bigint;
  nonce: bigint;
}

// ── Agent ────────────────────────────────────────────────────────────────────

export interface AgentMetadata {
  "@context": string;
  "@type": string;
  identifier: string;
  name: string;
  version: string;
  capabilities: string[];
  memoryCollection?: string;
  framework?: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface RegisterAgentParams {
  metadata: AgentMetadata;
  /** If provided, link this VectorCollection as the agent's memory store */
  memoryCollectionAddr?: string;
  /** If provided, initialise reputation score (Shelby history blob) */
  initReputation?: boolean;
}

export interface RegisterAgentResult {
  agentAddr: string;
  did: string;
  metadataBlobId: string;
  txHash: string;
}

export interface AgentInfo {
  did: string;
  owner: string;
  metadataBlobId: string;
  memoryCollection: string;
  seq: bigint;
  active: boolean;
  createdAt: bigint;
  updatedAt: bigint;
}

// ── Reputation ───────────────────────────────────────────────────────────────

export interface ScoreInfo {
  agentAddr: string;
  scoreBps: bigint;
  interactionCount: bigint;
  historyBlobId: string;
  lastUpdated: bigint;
}

// ── Shelby blob ───────────────────────────────────────────────────────────────

export interface BlobUploadResult {
  blobId: string;
  size: number;
}

export interface ChunkBlob {
  chunkId: string;
  blobId: string;
  embedding: Float32Array;
  text?: string;
  metadata?: Record<string, unknown>;
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface ReadProofIssuedEvent {
  collection_addr: string;
  reader: string;
  blob_ids: string[];
  nonce: string;
  expires_at: string;
  fee_paid_octas: string;
  timestamp_us: string;
}

export interface ChunkAddedEvent {
  collection_addr: string;
  chunk_id: string;
  blob_id: string;
  chunk_index: string;
  timestamp_us: string;
}

export interface IndexUpdatedEvent {
  collection_addr: string;
  new_index_blob_id: string;
  total_chunks: string;
  timestamp_us: string;
}
