// ─── HNSW index manager ───────────────────────────────────────────────────────

import * as path from "path";
import * as fs   from "fs";
import { HierarchicalNSW } from "hnswlib-node";

export interface HnswOptions {
  dimensions:   number;
  /** "cosine" | "l2" | "ip" */
  spaceType:    "cosine" | "l2" | "ip";
  maxElements:  number;
  efConstruction?: number;
  M?:           number;
}

export interface SearchResult {
  label:    number;
  distance: number;
}

export class WillowHnsw {
  private index:    HierarchicalNSW;
  private labels:   string[] = []; // label (index) → chunkId
  private chunkToLabel: Map<string, number> = new Map();

  constructor(private opts: HnswOptions) {
    this.index = new HierarchicalNSW(opts.spaceType, opts.dimensions);
    this.index.initIndex(opts.maxElements, opts.M ?? 16, opts.efConstruction ?? 200);
  }

  get size(): number { return this.labels.length; }

  /** Add a single vector. Returns the integer label assigned. */
  addItem(chunkId: string, vector: number[] | Float32Array): number {
    const label = this.labels.length;
    const vec   = Array.from(vector instanceof Float32Array ? vector : vector);
    this.index.addPoint(vec, label);
    this.labels.push(chunkId);
    this.chunkToLabel.set(chunkId, label);
    return label;
  }

  /** Bulk-add — faster than looping addItem for large batches */
  addItems(items: Array<{ chunkId: string; vector: number[] | Float32Array }>): void {
    for (const item of items) this.addItem(item.chunkId, item.vector);
  }

  /** k-nearest-neighbour search. Returns chunkIds + distances */
  search(queryVector: number[] | Float32Array, k: number): Array<{ chunkId: string; distance: number }> {
    if (this.labels.length === 0) return [];
    const topK   = Math.min(k, this.labels.length);
    const result = this.index.searchKnn(Array.from(queryVector), topK);
    return result.neighbors.map((label, i) => ({
      chunkId:  this.labels[label] ?? "",
      distance: result.distances[i] ?? 0,
    }));
  }

  /** Serialise to a Buffer (for Shelby upload) */
  serialize(): Buffer {
    const tmp = path.join(process.env.TMPDIR ?? "/tmp", `hnsw-${Date.now()}.bin`);
    this.index.writeIndex(tmp);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    // Prepend label table as JSON with 4-byte length prefix
    const labelJson = Buffer.from(JSON.stringify(this.labels));
    const header    = Buffer.alloc(4);
    header.writeUInt32LE(labelJson.length, 0);
    return Buffer.concat([header, labelJson, buf]);
  }

  /** Deserialise from a Buffer (fetched from Shelby) */
  static deserialize(buf: Buffer, opts: HnswOptions): WillowHnsw {
    const instance = new WillowHnsw(opts);
    const labelLen = buf.readUInt32LE(0);
    const labels   = JSON.parse(buf.subarray(4, 4 + labelLen).toString()) as string[];
    const hnswBuf  = buf.subarray(4 + labelLen);

    const tmp = path.join(process.env.TMPDIR ?? "/tmp", `hnsw-load-${Date.now()}.bin`);
    fs.writeFileSync(tmp, hnswBuf);
    instance.index   = new HierarchicalNSW(opts.spaceType, opts.dimensions);
    instance.index.readIndex(tmp, opts.maxElements);
    fs.unlinkSync(tmp);

    instance.labels = labels;
    labels.forEach((chunkId, i) => instance.chunkToLabel.set(chunkId, i));
    return instance;
  }

  /** Save to local file (data-dir persistence) */
  saveToFile(filePath: string): void {
    fs.writeFileSync(filePath, this.serialize());
  }

  /** Load from local file */
  static loadFromFile(filePath: string, opts: HnswOptions): WillowHnsw {
    const buf = fs.readFileSync(filePath);
    return WillowHnsw.deserialize(buf, opts);
  }
}
