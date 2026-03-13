// ─── HTTP API ─────────────────────────────────────────────────────────────────
// POST /query             — vector search
// POST /track             — start tracking a collection
// GET  /status            — all tracked collections
// GET  /status/:addr      — single collection status
// POST /rebuild/:addr     — manual rebuild trigger

import express, { Request, Response, NextFunction } from "express";
import type { WillowIndexer } from "./indexer.js";
import type { QueryRequest }  from "./types.js";

export function buildServer(indexer: WillowIndexer): express.Application {
  const app = express();
  app.use(express.json());

  // ── POST /query ─────────────────────────────────────────────────────────────
  app.post("/query", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as QueryRequest;

      if (!body.collectionAddr || !Array.isArray(body.vector) || !body.topK) {
        res.status(400).json({ error: "collectionAddr, vector, topK required" });
        return;
      }

      const start   = Date.now();
      const results = await indexer.query(body);
      res.json({
        collectionAddr: body.collectionAddr,
        results,
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /track ─────────────────────────────────────────────────────────────
  app.post("/track", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { collectionAddr } = req.body as { collectionAddr?: string };
      if (!collectionAddr) {
        res.status(400).json({ error: "collectionAddr required" });
        return;
      }
      await indexer.trackCollection(collectionAddr);
      res.json({ ok: true, collectionAddr });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /status ──────────────────────────────────────────────────────────────
  app.get("/status", (_req: Request, res: Response) => {
    res.json(indexer.getAllStatuses());
  });

  // ── GET /status/:addr ────────────────────────────────────────────────────────
  app.get("/status/:addr", (req: Request, res: Response) => {
    const status = indexer.getStatus(req.params.addr);
    res.json(status);
  });

  // ── POST /rebuild/:addr ──────────────────────────────────────────────────────
  app.post("/rebuild/:addr", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const addr  = req.params.addr;
      const state = indexer.states.get(addr);
      if (!state) {
        res.status(404).json({ error: "Collection not tracked" });
        return;
      }
      const chunkIds = Array.from(state.chunkMap.keys());
      const blobIds  = Array.from(state.chunkMap.values());
      await indexer.rebuild(addr, chunkIds, blobIds);
      res.json({ ok: true, addr, chunksIndexed: chunkIds.length });
    } catch (err) {
      next(err);
    }
  });

  // ── Error handler ────────────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[server] error:", err.message);
    res.status(500).json({ error: err.message });
  });

  return app;
}
