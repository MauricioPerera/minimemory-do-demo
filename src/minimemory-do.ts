/**
 * MinimemoryDO — Durable Object wrapping minimemory WASM
 *
 * Each DO instance = one vector database persisted in memory.
 * State checkpoints to DO SQLite storage for recovery after eviction.
 */

// @ts-ignore — WASM module imported as ES module (Wrangler bundles it)
import wasmModule from "../wasm/minimemory_bg.wasm";
// @ts-ignore
import * as minimemory from "../wasm/minimemory.js";

export interface Env {
  MINIMEMORY: DurableObjectNamespace;
  BENCHMARK_DB: D1Database;
}

interface DBConfig {
  dims: number;
  distance: string;
  index: string;
}

const DEFAULT_CONFIG: DBConfig = {
  dims: 384,
  distance: "cosine",
  index: "flat",
};

export class MinimemoryDO implements DurableObject {
  private state: DurableObjectState;
  private db: any | null = null;
  private initialized = false;
  private wasmReady = false;
  private config: DBConfig = { ...DEFAULT_CONFIG };

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Bug #7 fix: don't blockConcurrencyWhile in constructor.
    // Initialize lazily on first fetch() with proper double-check.
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.initialized) return; // Double-check after acquiring lock

      // Bug #8 fix: initialize WASM only once
      if (!this.wasmReady) {
        await minimemory.default(wasmModule);
        this.wasmReady = true;
      }

      // Load saved config
      const savedConfig = await this.state.storage.get<DBConfig>("db_config");
      if (savedConfig) {
        this.config = savedConfig;
      }

      // Create DB with stored or default config
      this.db = new minimemory.WasmVectorDB(
        this.config.dims,
        this.config.distance,
        this.config.index,
      );

      // Restore from snapshot
      const saved = await this.state.storage.get<string>("db_snapshot");
      if (saved) {
        try {
          const snapshot = JSON.parse(saved);
          for (const entry of snapshot) {
            // Bug #9 fix: wrap each entry in try/catch
            try {
              if (entry.vector && Array.isArray(entry.vector) && entry.vector.length === this.config.dims) {
                this.db.insert_with_metadata(
                  entry.id,
                  new Float32Array(entry.vector),
                  JSON.stringify(entry.metadata || {}),
                );
              }
            } catch (_) {
              // Skip corrupted entries, don't break entire restore
            }
          }
        } catch (e) {
          console.error("Failed to restore snapshot:", e);
        }
      }

      this.initialized = true;
    });
  }

  /** Reconfigure DB dimensions (only when empty) */
  private reconfigureIfNeeded(dims: number): boolean {
    if (dims === this.config.dims) return true;
    if (this.db && this.db.len() > 0) return false; // Can't change after data inserted

    this.config = { ...this.config, dims };
    this.db = new minimemory.WasmVectorDB(
      this.config.dims,
      this.config.distance,
      this.config.index,
    );
    return true;
  }

  /** Persist state to DO storage — batched for efficiency (Bug #13 fix) */
  private async checkpoint() {
    if (!this.db || this.db.len() === 0) return;

    const idsJson = this.db.ids();
    const ids: string[] = JSON.parse(idsJson);

    // Bug #13 fix: batch checkpoint to limit memory
    const BATCH = 500;
    const allEntries: any[] = [];

    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      for (const id of batch) {
        try {
          const raw = this.db.get(id);
          if (!raw) continue;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (parsed.vector && Array.isArray(parsed.vector)) {
            allEntries.push({ id, vector: parsed.vector, metadata: parsed.metadata || {} });
          }
        } catch (_) {
          // Bug #9 fix: skip corrupted entries
        }
      }
    }

    await this.state.storage.put("db_snapshot", JSON.stringify(allEntries));
    await this.state.storage.put("db_config", this.config);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // POST /init — { dims?, distance?, index? }
      // Bug #11 fix: explicit endpoint to configure before inserting
      if (method === "POST" && path === "/init") {
        const body = (await request.json()) as any;
        const dims = body.dims || this.config.dims;
        const distance = body.distance || this.config.distance;
        const indexType = body.index || this.config.index;

        if (this.db && this.db.len() > 0 && dims !== this.config.dims) {
          return json({ error: "Cannot change dims after data inserted" }, 400);
        }

        this.config = { dims, distance, index: indexType };
        this.db = new minimemory.WasmVectorDB(dims, distance, indexType);
        await this.state.storage.put("db_config", this.config);
        return json({ ok: true, config: this.config });
      }

      // POST /insert — { id, vector, metadata? }
      if (method === "POST" && path === "/insert") {
        const body = (await request.json()) as any;
        const vector = new Float32Array(body.vector);

        // Bug #15 fix: validate dimensions
        if (vector.length !== this.config.dims) {
          return json({
            error: `Dimension mismatch: got ${vector.length}, expected ${this.config.dims}`,
          }, 400);
        }

        if (body.metadata) {
          this.db.insert_with_metadata(body.id, vector, JSON.stringify(body.metadata));
        } else {
          this.db.insert(body.id, vector);
        }

        // Bug #14 fix: checkpoint less aggressively
        if (this.db.len() % 200 === 0) {
          this.state.waitUntil(this.checkpoint());
        }
        return json({ ok: true, id: body.id, count: this.db.len() });
      }

      // POST /search — { vector, k }
      if (method === "POST" && path === "/search") {
        const body = (await request.json()) as any;
        const query = new Float32Array(body.vector);
        const k = body.k || 10;
        const start = performance.now();
        const resultsJson = this.db.search(query, k);
        const elapsed_ms = +(performance.now() - start).toFixed(3);
        return json({ results: JSON.parse(resultsJson), elapsed_ms });
      }

      // POST /keyword — { query, k }
      if (method === "POST" && path === "/keyword") {
        const body = (await request.json()) as any;
        const start = performance.now();
        const resultsJson = this.db.keyword_search(body.query, body.k || 10);
        const elapsed_ms = +(performance.now() - start).toFixed(3);
        return json({ results: JSON.parse(resultsJson), elapsed_ms });
      }

      // GET /get/:id
      if (method === "GET" && path.startsWith("/get/")) {
        const id = decodeURIComponent(path.slice(5));
        const raw = this.db.get(id);
        if (!raw) return json({ error: "not found" }, 404);
        return json(typeof raw === "string" ? JSON.parse(raw) : raw);
      }

      // DELETE /delete/:id
      if (method === "DELETE" && path.startsWith("/delete/")) {
        const id = decodeURIComponent(path.slice(8));
        const deleted = this.db.delete(id);
        if (deleted) this.state.waitUntil(this.checkpoint());
        return json({ deleted });
      }

      // GET /stats
      if (method === "GET" && path === "/stats") {
        return json({
          count: this.db.len(),
          dimensions: this.db.dimensions(),
          config: this.config,
          is_empty: this.db.is_empty(),
        });
      }

      // POST /checkpoint
      if (method === "POST" && path === "/checkpoint") {
        await this.checkpoint();
        return json({ ok: true, count: this.db.len() });
      }

      // POST /bulk-insert — { items: [{id, vector, metadata}], dims? }
      if (method === "POST" && path === "/bulk-insert") {
        const body = (await request.json()) as any;
        const items = body.items || [];

        // Bug #11 fix: auto-configure dims from first vector if DB is empty
        if (items.length > 0 && this.db.is_empty()) {
          const firstDims = items[0].vector.length;
          if (firstDims !== this.config.dims) {
            this.reconfigureIfNeeded(firstDims);
          }
        }

        const start = performance.now();
        let inserted = 0;
        let errors = 0;

        for (const item of items) {
          try {
            const vector = new Float32Array(item.vector);
            if (vector.length !== this.config.dims) {
              errors++;
              continue;
            }
            if (item.metadata) {
              this.db.insert_with_metadata(item.id, vector, JSON.stringify(item.metadata));
            } else {
              this.db.insert(item.id, vector);
            }
            inserted++;
          } catch (_) {
            errors++;
          }
        }

        const elapsed_ms = +(performance.now() - start).toFixed(3);
        this.state.waitUntil(this.checkpoint());
        return json({
          ok: true,
          inserted,
          errors,
          elapsed_ms,
          count: this.db.len(),
          dims: this.config.dims,
        });
      }

      // POST /benchmark — run benchmark entirely inside DO (no fetch overhead)
      // { docs: 1000, dims: 64, index: "flat"|"hnsw", quant: "none"|"int3"|"int8"|"binary", k: 10 }
      if (method === "POST" && path === "/benchmark") {
        const body = (await request.json()) as any;
        const numDocs = body.docs || 500;
        const dims = body.dims || 64;
        const indexType = body.index || "flat";
        const quant = body.quant || "none";
        const k = body.k || 10;

        // Create a fresh DB with requested config
        const benchDb = minimemory.WasmVectorDB.new_with_config(
          dims, "cosine", indexType, quant, 16, 200,
        );

        // Generate and insert vectors
        const insertStart = performance.now();
        for (let i = 0; i < numDocs; i++) {
          const vec = new Float32Array(dims);
          for (let d = 0; d < dims; d++) {
            vec[d] = Math.sin(i * 0.1 + d * 0.3);
          }
          benchDb.insert_with_metadata(
            `doc-${i}`,
            vec,
            JSON.stringify({ title: `Doc ${i}`, cat: ["tech", "sci", "art", "news"][i % 4], pri: i % 10 }),
          );
        }
        const insertMs = +(performance.now() - insertStart).toFixed(3);

        // Search
        const queryVec = new Float32Array(dims);
        for (let d = 0; d < dims; d++) queryVec[d] = Math.sin(42 * 0.1 + d * 0.3);

        // Warm up
        benchDb.search(queryVec, k);

        // Measure search (average of 5 runs)
        let searchTotal = 0;
        for (let r = 0; r < 5; r++) {
          const t = performance.now();
          benchDb.search(queryVec, k);
          searchTotal += performance.now() - t;
        }
        const searchMs = +(searchTotal / 5).toFixed(3);

        // Single search for results
        const searchResults = JSON.parse(benchDb.search(queryVec, k));

        // Memory estimate
        const memEstimate = benchDb.len() * dims * 4; // f32 bytes (unquantized)

        benchDb.free();

        return json({
          config: { docs: numDocs, dims, index: indexType, quant, k },
          insert_ms: insertMs,
          search_avg_ms: searchMs,
          search_top3: searchResults.slice(0, 3),
          docs_inserted: numDocs,
          memory_estimate_kb: +(memEstimate / 1024).toFixed(1),
          ops_per_sec: +(1000 / searchMs).toFixed(0),
        });
      }

      return json({
        error: "not found",
        routes: [
          "POST /init", "POST /insert", "POST /search", "POST /keyword",
          "POST /bulk-insert", "POST /checkpoint", "POST /benchmark",
          "GET /get/:id", "DELETE /delete/:id", "GET /stats",
        ],
      }, 404);
    } catch (e: any) {
      return json({ error: e.message || String(e) }, 400);
    }
  }
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
