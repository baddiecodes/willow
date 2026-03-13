// ─── Shelby Protocol integration ─────────────────────────────────────────────
//
// Shelby SDK (@shelby-protocol/sdk) is gated behind Early Access on Shelbynet.
// This module wraps the SDK so the rest of Willow never imports it directly —
// making it trivial to swap in the real SDK when you receive access.
//
// Until then, `SHELBY_MOCK=true` in env stores blobs in-memory for local dev.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { SHELBYNET_RPC, CHUNK_MAGIC, CHUNK_HEADER_BYTES } from "./constants.js";
import type { BlobUploadResult } from "./types.js";

// ─── Blob header helpers ──────────────────────────────────────────────────────

/**
 * Pack a Float32Array into the Willow chunk binary format:
 *   [magic(4)] [dimensions(4)] [reserved(8)] [float32 * N]
 */
export function packEmbedding(embedding: Float32Array | number[]): Buffer {
  const arr   = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  const total = CHUNK_HEADER_BYTES + arr.byteLength;
  const buf   = Buffer.alloc(total, 0);

  CHUNK_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(arr.length, 4);
  // bytes 8-15: reserved (zeroed)
  Buffer.from(arr.buffer).copy(buf, CHUNK_HEADER_BYTES);

  return buf;
}

/**
 * Unpack a chunk buffer back into a Float32Array.
 */
export function unpackEmbedding(buf: Buffer): Float32Array {
  const magic = buf.subarray(0, 4);
  if (!magic.equals(CHUNK_MAGIC)) {
    throw new Error(`Invalid chunk magic: expected SVEK, got ${magic.toString("ascii")}`);
  }
  const dims       = buf.readUInt32LE(4);
  const floatBytes = buf.subarray(CHUNK_HEADER_BYTES);
  if (floatBytes.byteLength !== dims * 4) {
    throw new Error(`Dimension mismatch: header says ${dims}, data has ${floatBytes.byteLength / 4}`);
  }
  const copy = Buffer.from(floatBytes);
  return new Float32Array(copy.buffer, copy.byteOffset, dims);
}

// ─── Mock store (local dev / CI) ──────────────────────────────────────────────

const mockStore = new Map<string, Buffer>();

function mockUpload(data: Buffer): BlobUploadResult {
  const blobId = "mock-" + crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  mockStore.set(blobId, data);
  return { blobId, size: data.length };
}

function mockDownload(blobId: string): Buffer {
  const buf = mockStore.get(blobId);
  if (!buf) throw new Error(`Mock blob not found: ${blobId}`);
  return buf;
}

// ─── Real Shelby client wrapper ───────────────────────────────────────────────

interface ShelbyClientLike {
  uploadBlob(data: Buffer, opts?: Record<string, unknown>): Promise<BlobUploadResult>;
  fetchBlob(blobId: string, opts?: Record<string, unknown>): Promise<Buffer>;
}

let _shelbyClient: ShelbyClientLike | null = null;

async function getRealClient(
  privateKey: string,
  rpcUrl: string
): Promise<ShelbyClientLike> {
  if (_shelbyClient) return _shelbyClient;
  try {
    // Dynamic import so the SDK is optional
    const { ShelbyClient } = await import("@shelby-protocol/sdk" as string);
    _shelbyClient = new ShelbyClient({ network: rpcUrl, privateKey }) as ShelbyClientLike;
    return _shelbyClient;
  } catch {
    throw new Error(
      "Shelby SDK not available. Install @shelby-protocol/sdk or set SHELBY_MOCK=true for local dev."
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ShelbyUploadOpts {
  privateKey?: string;
  rpcUrl?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Upload a blob to Shelby (or mock store in dev mode).
 * Returns the Shelby blob ID.
 */
export async function uploadBlob(
  data: Buffer,
  opts: ShelbyUploadOpts = {}
): Promise<BlobUploadResult> {
  if (process.env.SHELBY_MOCK === "true") {
    return mockUpload(data);
  }
  const rpc    = opts.rpcUrl ?? process.env.SHELBY_RPC ?? SHELBYNET_RPC;
  const pk     = opts.privateKey ?? process.env.SHELBY_PRIVATE_KEY ?? "";
  const client = await getRealClient(pk, rpc);
  return client.uploadBlob(data, {
    contentType: opts.contentType ?? "application/octet-stream",
    metadata:    opts.metadata,
  });
}

/**
 * Upload JSON (metadata, DID documents, history JSONL) as a Shelby blob.
 */
export async function uploadJson(
  data: unknown,
  opts: ShelbyUploadOpts = {}
): Promise<BlobUploadResult> {
  return uploadBlob(Buffer.from(JSON.stringify(data)), {
    ...opts,
    contentType: "application/json",
  });
}

/**
 * Fetch a blob from Shelby (or mock store in dev mode).
 * Requires a ReadProof tx hash for protected collections.
 */
export async function fetchBlob(
  blobId: string,
  opts: ShelbyUploadOpts & { proofTxHash?: string; reader?: string } = {}
): Promise<Buffer> {
  if (process.env.SHELBY_MOCK === "true") {
    return mockDownload(blobId);
  }
  const rpc    = opts.rpcUrl ?? process.env.SHELBY_RPC ?? SHELBYNET_RPC;
  const pk     = opts.privateKey ?? process.env.SHELBY_PRIVATE_KEY ?? "";
  const client = await getRealClient(pk, rpc);
  return client.fetchBlob(blobId, {
    proofTxHash: opts.proofTxHash,
    reader:      opts.reader,
  });
}

/**
 * Upload a Float32 embedding chunk with the SVEK header.
 */
export async function uploadEmbedding(
  embedding: Float32Array | number[],
  opts: ShelbyUploadOpts = {}
): Promise<BlobUploadResult> {
  return uploadBlob(packEmbedding(embedding), opts);
}

/**
 * Fetch and unpack a Float32 embedding chunk.
 */
export async function fetchEmbedding(
  blobId: string,
  opts: ShelbyUploadOpts & { proofTxHash?: string } = {}
): Promise<Float32Array> {
  const buf = await fetchBlob(blobId, opts);
  return unpackEmbedding(buf);
}
