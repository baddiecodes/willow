// ─── Collection operations ────────────────────────────────────────────────────

import type { Aptos } from "@aptos-labs/ts-sdk";
import type { Account } from "@aptos-labs/ts-sdk";
import {
  MODULE_COLLECTION,
  MODULE_ACCESS_CONTROL,
  METRIC_COSINE,
  ACCESS_OPEN,
  DEFAULT_TTL_US,
} from "./constants.js";
import { submitTx, viewFn } from "./aptos.js";
import { uploadBlob, uploadEmbedding } from "./shelby.js";
import type {
  CreateCollectionParams,
  AddChunkParams,
  AddChunkResult,
  BatchAddChunksParams,
  UpdateIndexParams,
  CollectionInfo,
  ConfigureAccessParams,
  RequestReadProofParams,
  ReadProofResult,
} from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive deterministic collection object address from owner + name */
export async function collectionAddress(
  aptos: Aptos,
  owner: string,
  name: string
): Promise<string> {
  return viewFn<string>(
    aptos,
    `${MODULE_COLLECTION}::collection_address`,
    [],
    [owner, name]
  );
}

// ─── Read (view) ──────────────────────────────────────────────────────────────

export async function getCollectionInfo(
  aptos: Aptos,
  collectionAddr: string
): Promise<CollectionInfo> {
  const [resource] = await aptos.getAccountResource({
    accountAddress: collectionAddr,
    resourceType: `${MODULE_COLLECTION}::VectorCollection`,
  }).then((r) => [r as Record<string, unknown>]);

  const d = resource as Record<string, unknown>;
  return {
    owner:           d.owner as string,
    name:            d.name as string,
    embeddingModel:  d.embedding_model as string,
    dimensions:      Number(d.dimensions),
    distanceMetric:  Number(d.distance_metric),
    indexBlobId:     d.index_blob_id as string,
    totalChunks:     Number(d.total_chunks),
    totalReads:      Number(d.total_reads),
    accessPolicy:    Number(d.access_policy),
    frozen:          Boolean(d.frozen),
    createdAt:       BigInt(d.created_at as string),
    updatedAt:       BigInt(d.updated_at as string),
  };
}

export async function getTotalChunks(
  aptos: Aptos,
  collectionAddr: string
): Promise<number> {
  const n = await viewFn<string>(aptos, `${MODULE_COLLECTION}::get_total_chunks`, [], [collectionAddr]);
  return Number(n);
}

export async function getIndexBlobId(
  aptos: Aptos,
  collectionAddr: string
): Promise<string> {
  return viewFn<string>(aptos, `${MODULE_COLLECTION}::get_index_blob_id`, [], [collectionAddr]);
}

export async function getChunkBlobId(
  aptos: Aptos,
  collectionAddr: string,
  chunkId: string
): Promise<string> {
  return viewFn<string>(
    aptos,
    `${MODULE_COLLECTION}::get_chunk_blob_id`,
    [],
    [collectionAddr, chunkId]
  );
}

// ─── Write (entry functions) ──────────────────────────────────────────────────

export async function createCollection(
  aptos:   Aptos,
  account: Account,
  params:  CreateCollectionParams
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_COLLECTION}::create_collection`,
    functionArguments: [
      params.name,
      params.embeddingModel,
      params.dimensions.toString(),
      (params.distanceMetric ?? METRIC_COSINE).toString(),
      (params.accessPolicy ?? ACCESS_OPEN).toString(),
    ],
  });
}

/**
 * Add a single chunk:
 * 1. Pack embedding → Shelby blob
 * 2. (Optional) upload text/metadata as companion JSON blob
 * 3. Register blob ID onchain
 */
export async function addChunk(
  aptos:   Aptos,
  account: Account,
  params:  AddChunkParams
): Promise<AddChunkResult> {
  const shelbyOpts = {
    privateKey: (account as unknown as { privateKey?: { toString(): string } }).privateKey?.toString(),
  };

  // Pack + upload embedding
  const { blobId } = await uploadEmbedding(params.embedding, shelbyOpts);

  // If text/metadata provided, store companion JSON (blobId stored in chunk metadata on Shelby)
  if (params.text || params.metadata) {
    await uploadBlob(
      Buffer.from(JSON.stringify({ chunkId: params.chunkId, text: params.text, ...params.metadata })),
      { ...shelbyOpts, contentType: "application/json" }
    );
  }

  const txHash = await submitTx(aptos, account, {
    function: `${MODULE_COLLECTION}::add_chunk`,
    functionArguments: [params.collectionAddr, params.chunkId, blobId],
  });

  return { blobId, chunkId: params.chunkId, txHash };
}

/**
 * Batch add — uploads all blobs to Shelby first, then commits one tx.
 * More efficient than looping addChunk (single onchain tx for the whole batch).
 */
export async function addChunksBatch(
  aptos:   Aptos,
  account: Account,
  params:  BatchAddChunksParams
): Promise<{ txHash: string; results: Array<{ chunkId: string; blobId: string }> }> {
  const shelbyOpts = {
    privateKey: (account as unknown as { privateKey?: { toString(): string } }).privateKey?.toString(),
  };

  const results: Array<{ chunkId: string; blobId: string }> = [];

  // Upload all blobs to Shelby in parallel
  await Promise.all(
    params.chunks.map(async (chunk) => {
      const { blobId } = await uploadEmbedding(chunk.embedding, shelbyOpts);
      if (chunk.text || chunk.metadata) {
        await uploadBlob(
          Buffer.from(JSON.stringify({ chunkId: chunk.chunkId, text: chunk.text, ...chunk.metadata })),
          { ...shelbyOpts, contentType: "application/json" }
        );
      }
      results.push({ chunkId: chunk.chunkId, blobId });
    })
  );

  // Single onchain transaction for the batch
  const txHash = await submitTx(aptos, account, {
    function: `${MODULE_COLLECTION}::add_chunks_batch`,
    functionArguments: [
      params.collectionAddr,
      results.map((r) => r.chunkId),
      results.map((r) => r.blobId),
    ],
  });

  return { txHash, results };
}

export async function updateIndex(
  aptos:   Aptos,
  account: Account,
  params:  UpdateIndexParams
): Promise<{ txHash: string; blobId: string }> {
  const shelbyOpts = {
    privateKey: (account as unknown as { privateKey?: { toString(): string } }).privateKey?.toString(),
  };
  const { blobId } = await uploadBlob(params.indexBuffer, {
    ...shelbyOpts,
    contentType: "application/octet-stream",
    metadata: { type: "hnsw-index" },
  });
  const txHash = await submitTx(aptos, account, {
    function: `${MODULE_COLLECTION}::update_index`,
    functionArguments: [params.collectionAddr, blobId],
  });
  return { txHash, blobId };
}

export async function setAccessPolicy(
  aptos:          Aptos,
  account:        Account,
  collectionAddr: string,
  policy:         number
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_COLLECTION}::set_access_policy`,
    functionArguments: [collectionAddr, policy.toString()],
  });
}

export async function freezeCollection(
  aptos:          Aptos,
  account:        Account,
  collectionAddr: string
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_COLLECTION}::freeze_collection`,
    functionArguments: [collectionAddr],
  });
}

// ─── Access control ───────────────────────────────────────────────────────────

export async function configureAccess(
  aptos:   Aptos,
  account: Account,
  params:  ConfigureAccessParams
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_ACCESS_CONTROL}::configure_access`,
    functionArguments: [
      params.collectionAddr,
      (params.readFeeOctas ?? 0n).toString(),
      (params.proofTtlUs ?? DEFAULT_TTL_US).toString(),
    ],
  });
}

export async function setAllowlistEntry(
  aptos:          Aptos,
  account:        Account,
  collectionAddr: string,
  subject:        string,
  allowed:        boolean
): Promise<string> {
  return submitTx(aptos, account, {
    function: `${MODULE_ACCESS_CONTROL}::set_allowlist_entry`,
    functionArguments: [collectionAddr, subject, allowed],
  });
}

/**
 * Request a read proof and return the tx hash + resolved blob IDs.
 * Automatically selects the correct entry function based on the collection's access policy.
 */
export async function requestReadProof(
  aptos:   Aptos,
  account: Account,
  params:  RequestReadProofParams
): Promise<ReadProofResult> {
  const policy = await viewFn<string>(
    aptos,
    `${MODULE_COLLECTION}::get_access_policy`,
    [],
    [params.collectionAddr]
  );

  const nonce = params.nonce ?? BigInt(Date.now());

  const fnMap: Record<number, string> = {
    0: `${MODULE_ACCESS_CONTROL}::request_read_proof_open`,
    1: `${MODULE_ACCESS_CONTROL}::request_read_proof_owner`,
    2: `${MODULE_ACCESS_CONTROL}::request_read_proof_allowlist`,
    3: `${MODULE_ACCESS_CONTROL}::request_read_proof_paid`,
  };

  const fn = fnMap[Number(policy)];
  if (!fn) throw new Error(`Unknown access policy: ${policy}`);

  const txHash = await submitTx(aptos, account, {
    function: fn,
    functionArguments: [params.collectionAddr, params.chunkIds, nonce.toString()],
  });

  // Resolve blob IDs from view functions
  const blobIds = await Promise.all(
    params.chunkIds.map((id) => getChunkBlobId(aptos, params.collectionAddr, id))
  );

  const now      = BigInt(Date.now()) * 1000n; // to microseconds
  const expiresAt = now + DEFAULT_TTL_US;

  return { txHash, blobIds, expiresAt, nonce };
}
