// ─── Aptos event watcher ──────────────────────────────────────────────────────
// Polls for ChunkAdded and IndexUpdated events from the Willow contracts
// and triggers index rebuilds when thresholds are met.

import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { WILLOW_ADDRESS } from "@willow/sdk";
import type { CollectionState, IndexerConfig } from "./types.js";

const CHUNK_ADDED_EVENT    = `${WILLOW_ADDRESS}::collection::ChunkAdded`;
const INDEX_UPDATED_EVENT  = `${WILLOW_ADDRESS}::collection::IndexUpdated`;

export type RebuildCallback = (
  collectionAddr: string,
  newChunkIds:    string[],
  newBlobIds:     string[]
) => Promise<void>;

export class AptosWatcher {
  private aptos:    Aptos;
  private timer:    ReturnType<typeof setInterval> | null = null;
  /** last processed sequence number per event type */
  private cursors:  Map<string, number> = new Map();

  constructor(
    private config:   IndexerConfig,
    private states:   Map<string, CollectionState>,
    private onRebuild: RebuildCallback
  ) {
    const netConfig =
      config.network === "mainnet"
        ? { network: Network.MAINNET }
        : config.network === "testnet"
        ? { network: Network.TESTNET }
        : { fullnode: config.network, network: Network.CUSTOM };

    this.aptos = new Aptos(new AptosConfig(netConfig));
  }

  start(pollIntervalMs = 5_000): void {
    console.log(`[watcher] polling every ${pollIntervalMs}ms`);
    this.timer = setInterval(() => this.poll(), pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    await Promise.allSettled([
      this.pollChunkAdded(),
      this.pollIndexUpdated(),
    ]);
  }

  private async pollChunkAdded(): Promise<void> {
    const cursor = this.cursors.get(CHUNK_ADDED_EVENT) ?? 0;
    try {
      const events = await this.aptos.getModuleEventsByEventType({
        eventType: CHUNK_ADDED_EVENT,
        options:   { limit: 100, offset: cursor },
      });
      if (events.length === 0) return;

      // Group by collection
      const byCollection: Map<string, Array<{ chunkId: string; blobId: string }>> = new Map();
      for (const e of events) {
        const d      = e.data as { collection_addr: string; chunk_id: string; blob_id: string };
        const bucket = byCollection.get(d.collection_addr) ?? [];
        bucket.push({ chunkId: d.chunk_id, blobId: d.blob_id });
        byCollection.set(d.collection_addr, bucket);
      }

      for (const [addr, chunks] of byCollection) {
        let state = this.states.get(addr);
        if (!state) {
          state = {
            collectionAddr:  addr,
            lastKnownChunks: 0,
            indexedChunks:   0,
            indexBlobId:     "",
            chunkMap:        new Map(),
          };
          this.states.set(addr, state);
        }
        for (const { chunkId, blobId } of chunks) {
          state.chunkMap.set(chunkId, blobId);
          state.lastKnownChunks++;
        }

        const pending = state.lastKnownChunks - state.indexedChunks;
        if (pending >= this.config.rebuildEvery) {
          const newIds = chunks.map((c) => c.chunkId);
          const blobs  = chunks.map((c) => c.blobId);
          await this.onRebuild(addr, newIds, blobs).catch((err) =>
            console.error("[watcher] rebuild error:", err)
          );
        }
      }

      this.cursors.set(CHUNK_ADDED_EVENT, cursor + events.length);
    } catch (err) {
      console.error("[watcher] pollChunkAdded error:", err);
    }
  }

  private async pollIndexUpdated(): Promise<void> {
    const cursor = this.cursors.get(INDEX_UPDATED_EVENT) ?? 0;
    try {
      const events = await this.aptos.getModuleEventsByEventType({
        eventType: INDEX_UPDATED_EVENT,
        options:   { limit: 50, offset: cursor },
      });
      if (events.length === 0) return;

      for (const e of events) {
        const d = e.data as { collection_addr: string; new_index_blob_id: string };
        const state = this.states.get(d.collection_addr);
        if (state) {
          state.indexBlobId = d.new_index_blob_id;
          console.log(`[watcher] index updated for ${d.collection_addr} → ${d.new_index_blob_id}`);
        }
      }

      this.cursors.set(INDEX_UPDATED_EVENT, cursor + events.length);
    } catch (err) {
      console.error("[watcher] pollIndexUpdated error:", err);
    }
  }
}
