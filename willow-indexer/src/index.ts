// ─── Willow Indexer — entrypoint ──────────────────────────────────────────────

import "dotenv/config";
import { WillowIndexer } from "./indexer.js";
import { AptosWatcher }  from "./watcher.js";
import { buildServer }   from "./server.js";
import type { IndexerConfig } from "./types.js";

const config: IndexerConfig = {
  network:      process.env.APTOS_NETWORK      ?? "testnet",
  privateKey:   process.env.APTOS_PRIVATE_KEY  ?? "",
  shelbyRpc:    process.env.SHELBY_RPC,
  port:         Number(process.env.PORT        ?? 3001),
  rebuildEvery: Number(process.env.REBUILD_EVERY ?? 10),
  dataDir:      process.env.DATA_DIR           ?? "./data",
};

if (!config.privateKey) {
  console.error("APTOS_PRIVATE_KEY is required");
  process.exit(1);
}

async function main(): Promise<void> {
  const indexer = new WillowIndexer(config);

  // Track collections from env (comma-separated)
  const tracked = (process.env.TRACK_COLLECTIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const addr of tracked) await indexer.trackCollection(addr);

  // Start event watcher
  const watcher = new AptosWatcher(
    config,
    indexer.states,
    (addr, ids, blobs) => indexer.rebuild(addr, ids, blobs)
  );
  watcher.start(Number(process.env.POLL_INTERVAL_MS ?? 5_000));

  // Start HTTP server
  const app = buildServer(indexer);
  app.listen(config.port, () => {
    console.log(`[willow-indexer] running on http://localhost:${config.port}`);
    console.log(`  tracking: ${tracked.length ? tracked.join(", ") : "(none — POST /track to add)"}`);
  });

  process.on("SIGINT",  () => { watcher.stop(); process.exit(0); });
  process.on("SIGTERM", () => { watcher.stop(); process.exit(0); });
}

main().catch((err) => { console.error(err); process.exit(1); });
