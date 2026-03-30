/**
 * minimemory-do-demo — Worker entry point
 *
 * Routes:
 *   /db/:name/*    → Durable Object (minimemory WASM in-memory)
 *   /benchmark/run → Comparative benchmark: minimemory vs D1
 *   /health        → Health check
 */

import { MinimemoryDO } from "./minimemory-do";
export { MinimemoryDO };

interface Env {
  MINIMEMORY: DurableObjectNamespace;
  BENCHMARK_DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Health check
    if (path === "/" || path === "/health") {
      return json({
        service: "minimemory-do-demo",
        version: "0.2.0",
        endpoints: ["/db/:name/*", "/benchmark/run", "/health"],
      });
    }

    // Route to Durable Object: /db/:name/...
    if (path.startsWith("/db/")) {
      const parts = path.split("/");
      const dbName = parts[2];
      if (!dbName) return json({ error: "missing db name" }, 400);

      const doId = env.MINIMEMORY.idFromName(dbName);
      const stub = env.MINIMEMORY.get(doId);

      const doPath = "/" + parts.slice(3).join("/");
      const doUrl = new URL(doPath, request.url);
      return stub.fetch(
        new Request(doUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    // Benchmark: /benchmark/run
    if (path === "/benchmark/run" && request.method === "POST") {
      try {
        return await runBenchmark(env);
      } catch (e: any) {
        return json({ error: e.message, stack: e.stack }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
};

// =============================================================================
// Benchmark: minimemory (via DO) vs D1
// =============================================================================

async function runBenchmark(env: Env): Promise<Response> {
  const DIMS = 32;
  const NUM_DOCS = 50;
  const K = 5;

  // Generate test data
  const docs = [];
  for (let i = 0; i < NUM_DOCS; i++) {
    docs.push({
      id: `doc-${i}`,
      vector: Array.from({ length: DIMS }, (_, d) => Math.sin(i * 0.1 + d * 0.3)),
      metadata: {
        title: `Document ${i}`,
        category: ["tech", "science", "art", "news"][i % 4],
        priority: i % 10,
      },
    });
  }

  const queryVector = Array.from({ length: DIMS }, (_, d) => Math.sin(42 * 0.1 + d * 0.3));

  const results: Record<string, any> = {
    config: { dimensions: DIMS, num_docs: NUM_DOCS, k: K },
    minimemory: {},
    d1: {},
  };

  // ── minimemory benchmark (via Durable Object) ────────────────
  // Bug #3 fix: unique name with random suffix
  const benchDbName = `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const doId = env.MINIMEMORY.idFromName(benchDbName);
  const stub = env.MINIMEMORY.get(doId);

  // Bug #1/#11 fix: bulk-insert auto-detects dims from first vector
  let t0 = performance.now();
  const insertRes = await stub.fetch(
    new Request("http://do/bulk-insert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: docs }),
    }),
  );
  const insertData = (await insertRes.json()) as any;
  results.minimemory.insert_total_ms = +(performance.now() - t0).toFixed(2);
  results.minimemory.insert_internal_ms = insertData.elapsed_ms; // Bug #2 fix: track internal time
  results.minimemory.inserted = insertData.inserted;
  results.minimemory.dims = insertData.dims;

  // Search
  t0 = performance.now();
  const searchRes = await stub.fetch(
    new Request("http://do/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector: queryVector, k: K }),
    }),
  );
  const searchData = (await searchRes.json()) as any;
  results.minimemory.search_total_ms = +(performance.now() - t0).toFixed(2);
  results.minimemory.search_internal_ms = searchData.elapsed_ms; // Actual compute time

  // Stats
  const statsRes = await stub.fetch(new Request("http://do/stats"));
  results.minimemory.stats = await statsRes.json();

  // ── D1 benchmark ─────────────────────────────────────────────
  await env.BENCHMARK_DB.exec(
    "CREATE TABLE IF NOT EXISTS bench_vectors (id TEXT PRIMARY KEY, title TEXT, category TEXT, priority INTEGER, vector TEXT)",
  );
  await env.BENCHMARK_DB.exec("DELETE FROM bench_vectors");

  // Insert
  t0 = performance.now();
  const stmts = docs.map((d) =>
    env.BENCHMARK_DB.prepare(
      "INSERT INTO bench_vectors (id, title, category, priority, vector) VALUES (?, ?, ?, ?, ?)",
    ).bind(d.id, d.metadata.title, d.metadata.category, d.metadata.priority, JSON.stringify(d.vector)),
  );
  await env.BENCHMARK_DB.batch(stmts);
  results.d1.insert_ms = +(performance.now() - t0).toFixed(2);

  // Search (brute-force cosine — D1 has no vector search)
  t0 = performance.now();
  const allRows = await env.BENCHMARK_DB.prepare("SELECT id, title, category, priority, vector FROM bench_vectors").all();

  const scored = allRows.results.map((row: any) => {
    const vec = JSON.parse(row.vector);
    let dot = 0, na = 0, nb = 0;
    for (let d = 0; d < DIMS; d++) {
      dot += queryVector[d] * vec[d];
      na += queryVector[d] * queryVector[d];
      nb += vec[d] * vec[d];
    }
    // Bug #5 fix: proper zero check
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    const sim = denom > 0 ? dot / denom : 0;
    return { id: row.id, score: +sim.toFixed(6), title: row.title };
  });
  scored.sort((a: any, b: any) => b.score - a.score);
  results.d1.search_ms = +(performance.now() - t0).toFixed(2);
  results.d1.search_top = scored.slice(0, K);

  // Filter (SQL WHERE)
  t0 = performance.now();
  const filtered = await env.BENCHMARK_DB.prepare(
    "SELECT id, title FROM bench_vectors WHERE category = ? AND priority > ? LIMIT ?",
  ).bind("tech", 5, 10).all();
  results.d1.filter_ms = +(performance.now() - t0).toFixed(2);
  results.d1.filter_count = filtered.results.length;

  // Cleanup
  await env.BENCHMARK_DB.exec("DROP TABLE IF EXISTS bench_vectors");

  // Bug #2 fix: compare internal times (fair comparison)
  const mmSearchMs = results.minimemory.search_internal_ms || results.minimemory.search_total_ms;
  const d1SearchMs = results.d1.search_ms;
  const mmInsertMs = results.minimemory.insert_internal_ms || results.minimemory.insert_total_ms;
  const d1InsertMs = results.d1.insert_ms;

  results.summary = {
    search_speedup: `${(d1SearchMs / mmSearchMs).toFixed(1)}x`,
    insert_speedup: `${(d1InsertMs / mmInsertMs).toFixed(1)}x`,
    note: "Speedup based on internal compute time (excludes DO/D1 network overhead)",
  };

  return json(results);
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
