// ─── Core Indexer ─────────────────────────────────────────────────────────────

import * as path from "path";
import * as fs   from "fs";
import { WillowClient, fetchEmbedding, fetchBlob, METRIC_COSINE, METRIC_EUCLIDEAN } from "@willow/sdk";
import { WillowHnsw } from "./hnsw.js";
import type { CollectionState, IndexerConfig, QueryRequest, QueryResult } from "./types.js";

type SpaceType = "cosine" | "l2" | "ip";

function metricToSpace(metric: number): SpaceType {
  if (metric === METRIC_EUCLIDEAN) return "l2";
  if (metric === 2 /* DOT */)      return "ip";
  return "cosine"; // METRIC_COSINE default
}

export class WillowIndexer {
  private client:   WillowClient;
  private indexes:  Map<string, WillowHnsw>        = new Map();
  public  states:   Map<string, CollectionState>   = new Map();

  constructor(private config: IndexerConfig) {
    this.client = new WillowClient({
      privateKey: config.privateKey,
      network:    config.network,
      shelbyRpc:  config.shelbyRpc,
    });
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  // ─── Initialise a tracked collection ───────────────────────────────────────

  async trackCollection(collectionAddr: string): Promise<void> {
    console.log(`[indexer] tracking ${collectionAddr}`);
    const info = await this.client.getCollectionInfo(collectionAddr);

    const state: CollectionState = {
      collectionAddr,
      lastKnownChunks: info.totalChunks,
      indexedChunks:   0,
      indexBlobId:     info.indexBlobId,
      chunkMap:        new Map(),
    };
    this.states.set(collectionAddr, state);

    // Try loading persisted index first
    const localPath = this.localIndexPath(collectionAddr);
    if (fs.existsSync(localPath)) {
      try {
        const hnsw = WillowHnsw.loadFromFile(localPath, {
          dimensions:  info.dimensions,
          spaceType:   metricToSpace(info.distanceMetric),
          maxElements: 100_000,
        });
        this.indexes.set(collectionAddr, hnsw);
        state.indexedChunks = hnsw.size;
        console.log(`[indexer] loaded local index (${hnsw.size} vectors) for ${collectionAddr}`);
        return;
      } catch (e) {
        console.warn("[indexer] local index corrupt, will re-fetch from Shelby:", e);
      }
    }

    // Try fetching existing index from Shelby
    if (info.indexBlobId && info.indexBlobId !== "") {
      try {
        const buf  = await fetchBlob(info.indexBlobId);
        const hnsw = WillowHnsw.deserialize(buf, {
          dimensions:  info.dimensions,
          spaceType:   metricToSpace(info.distanceMetric),
          maxElements: 100_000,
        });
        this.indexes.set(collectionAddr, hnsw);
        state.indexedChunks = hnsw.size;
        hnsw.saveToFile(localPath);
        console.log(`[indexer] fetched index from Shelby (${hnsw.size} vectors)`);
      } catch (e) {
        console.warn("[indexer] could not fetch index from Shelby, starting empty:", e);
        this.createEmptyIndex(collectionAddr, info.dimensions, metricToSpace(info.distanceMetric));
      }
    } else {
      this.createEmptyIndex(collectionAddr, info.dimensions, metricToSpace(info.distanceMetric));
    }
  }

  // ─── Rebuild callback (triggered by watcher) ────────────────────────────────

  async rebuild(
    collectionAddr: string,
    newChunkIds:    string[],
    newBlobIds:     string[]
  ): Promise<void> {
    console.log(`[indexer] rebuilding ${collectionAddr} (+${newChunkIds.length} chunks)`);
    const state = this.states.get(collectionAddr);
    if (!state) return;

    const info = await this.client.getCollectionInfo(collectionAddr);
    const hnsw = this.getOrCreateIndex(
      collectionAddr,
      info.dimensions,
      metricToSpace(info.distanceMetric)
    );

    // Fetch all new chunk embeddings from Shelby in parallel (max 10 concurrent)
    const CONCURRENCY = 10;
    for (let i = 0; i < newBlobIds.length; i += CONCURRENCY) {
      const slice = newBlobIds.slice(i, i + CONCURRENCY);
      const ids   = newChunkIds.slice(i, i + CONCURRENCY);
      const vecs  = await Promise.all(slice.map((blobId) => fetchEmbedding(blobId)));
      ids.forEach((chunkId, j) => hnsw.addItem(chunkId, vecs[j]));
    }

    state.indexedChunks = hnsw.size;
    console.log(`[indexer] index now has ${hnsw.size} vectors`);

    // Persist locally
    const localPath = this.localIndexPath(collectionAddr);
    hnsw.saveToFile(localPath);

    // Upload serialised index to Shelby + update onchain
    await this.publishIndex(collectionAddr, hnsw);
  }

  // ─── Query ──────────────────────────────────────────────────────────────────

  async query(req: QueryRequest): Promise<QueryResult[]> {
    const hnsw = this.indexes.get(req.collectionAddr);
    if (!hnsw) throw new Error(`Collection not tracked: ${req.collectionAddr}`);
    if (hnsw.size === 0) return [];

    const raw = hnsw.search(req.vector, req.topK);
    return raw.map(({ chunkId, distance }) => ({
      chunkId,
      blobId: this.states.get(req.collectionAddr)?.chunkMap.get(chunkId) ?? "",
      score:  1 - distance, // convert distance to similarity score [0,1]
    }));
  }

  // ─── Status ─────────────────────────────────────────────────────────────────

  getStatus(collectionAddr: string) {
    const state = this.states.get(collectionAddr);
    const hnsw  = this.indexes.get(collectionAddr);
    return {
      collectionAddr,
      totalChunks:   state?.lastKnownChunks ?? 0,
      indexedChunks: hnsw?.size ?? 0,
      indexBlobId:   state?.indexBlobId ?? "",
      lastUpdated:   new Date().toISOString(),
    };
  }

  getAllStatuses() {
    return Array.from(this.states.keys()).map((addr) => this.getStatus(addr));
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private createEmptyIndex(addr: string, dimensions: number, space: SpaceType): WillowHnsw {
    const hnsw = new WillowHnsw({ dimensions, spaceType: space, maxElements: 100_000 });
    this.indexes.set(addr, hnsw);
    return hnsw;
  }

  private getOrCreateIndex(addr: string, dimensions: number, space: SpaceType): WillowHnsw {
    return this.indexes.get(addr) ?? this.createEmptyIndex(addr, dimensions, space);
  }

  private localIndexPath(addr: string): string {
    return path.join(this.config.dataDir, `${addr.slice(2, 10)}.hnsw`);
  }

  private async publishIndex(collectionAddr: string, hnsw: WillowHnsw): Promise<void> {
    try {
      const { txHash, blobId } = await this.client.updateIndex({
        collectionAddr,
        indexBuffer: hnsw.serialize(),
      });
      const state = this.states.get(collectionAddr);
      if (state) state.indexBlobId = blobId;
      console.log(`[indexer] index published → blobId=${blobId} txHash=${txHash}`);
    } catch (err) {
      console.error("[indexer] publishIndex error:", err);
    }
  }
}
