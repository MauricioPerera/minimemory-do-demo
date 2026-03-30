/**
 * minimemory-do-demo — Worker entry point
 *
 * Routes:
 *   /db/:name/*       → Durable Object (minimemory WASM in-memory)
 *   /benchmark/run     → Quick benchmark (50 docs)
 *   /benchmark/scale   → Scaled benchmark (100-5000 docs, HNSW, quantization)
 *   /health            → Health check
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

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (path === "/" || path === "/health") {
      return json({
        service: "minimemory-do-demo",
        version: "0.3.0",
        endpoints: ["/db/:name/*", "/benchmark/run", "/benchmark/scale", "/health"],
      });
    }

    // Route to Durable Object
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

    // Quick benchmark (50 docs, same as before)
    if (path === "/benchmark/run" && request.method === "POST") {
      try {
        return await runQuickBenchmark(env);
      } catch (e: any) {
        return json({ error: e.message, stack: e.stack }, 500);
      }
    }

    // Scaled benchmark (runs inside DO for more CPU time)
    if (path === "/benchmark/scale" && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        return await runScaledBenchmark(env, body);
      } catch (e: any) {
        return json({ error: e.message, stack: e.stack }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
};

// =============================================================================
// Quick benchmark: minimemory vs D1 (small, runs in Worker)
// =============================================================================

async function runQuickBenchmark(env: Env): Promise<Response> {
  const DIMS = 32;
  const NUM_DOCS = 50;
  const K = 5;

  const docs = [];
  for (let i = 0; i < NUM_DOCS; i++) {
    docs.push({
      id: `doc-${i}`,
      vector: Array.from({ length: DIMS }, (_, d) => Math.sin(i * 0.1 + d * 0.3)),
      metadata: { title: `Document ${i}`, category: ["tech", "science", "art", "news"][i % 4], priority: i % 10 },
    });
  }
  const queryVector = Array.from({ length: DIMS }, (_, d) => Math.sin(42 * 0.1 + d * 0.3));

  const results: Record<string, any> = { config: { dimensions: DIMS, num_docs: NUM_DOCS, k: K }, minimemory: {}, d1: {} };

  // minimemory via DO
  const benchName = `qbench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const stub = env.MINIMEMORY.get(env.MINIMEMORY.idFromName(benchName));

  let t0 = performance.now();
  const insertRes = await stub.fetch(new Request("http://do/bulk-insert", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: docs }),
  }));
  const insertData = (await insertRes.json()) as any;
  results.minimemory.insert_total_ms = +(performance.now() - t0).toFixed(2);
  results.minimemory.insert_internal_ms = insertData.elapsed_ms;
  results.minimemory.inserted = insertData.inserted;

  t0 = performance.now();
  const searchRes = await stub.fetch(new Request("http://do/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector: queryVector, k: K }),
  }));
  const searchData = (await searchRes.json()) as any;
  results.minimemory.search_total_ms = +(performance.now() - t0).toFixed(2);
  results.minimemory.search_internal_ms = searchData.elapsed_ms;

  // D1
  await env.BENCHMARK_DB.exec("CREATE TABLE IF NOT EXISTS bench_vectors (id TEXT PRIMARY KEY, title TEXT, category TEXT, priority INTEGER, vector TEXT)");
  await env.BENCHMARK_DB.exec("DELETE FROM bench_vectors");

  t0 = performance.now();
  await env.BENCHMARK_DB.batch(docs.map(d =>
    env.BENCHMARK_DB.prepare("INSERT INTO bench_vectors (id, title, category, priority, vector) VALUES (?, ?, ?, ?, ?)")
      .bind(d.id, d.metadata.title, d.metadata.category, d.metadata.priority, JSON.stringify(d.vector))
  ));
  results.d1.insert_ms = +(performance.now() - t0).toFixed(2);

  t0 = performance.now();
  const allRows = await env.BENCHMARK_DB.prepare("SELECT id, vector FROM bench_vectors").all();
  const scored = allRows.results.map((row: any) => {
    const vec = JSON.parse(row.vector);
    let dot = 0, na = 0, nb = 0;
    for (let d = 0; d < DIMS; d++) { dot += queryVector[d] * vec[d]; na += queryVector[d] ** 2; nb += vec[d] ** 2; }
    return { id: row.id, score: dot / (Math.sqrt(na * nb) || 1) };
  });
  scored.sort((a: any, b: any) => b.score - a.score);
  results.d1.search_ms = +(performance.now() - t0).toFixed(2);

  await env.BENCHMARK_DB.exec("DROP TABLE IF EXISTS bench_vectors");

  const mmS = results.minimemory.search_internal_ms || results.minimemory.search_total_ms;
  results.summary = {
    search_speedup: `${(results.d1.search_ms / mmS).toFixed(1)}x`,
    insert_speedup: `${(results.d1.insert_ms / (results.minimemory.insert_internal_ms || results.minimemory.insert_total_ms)).toFixed(1)}x`,
  };

  return json(results);
}

// =============================================================================
// Scaled benchmark: runs INSIDE the Durable Object for more CPU budget
// =============================================================================

async function runScaledBenchmark(env: Env, params: any): Promise<Response> {
  const configs = [
    { name: "100-flat-none",  docs: 100,  dims: 64,  index: "flat", quant: "none" },
    { name: "500-flat-none",  docs: 500,  dims: 64,  index: "flat", quant: "none" },
    { name: "1000-flat-none", docs: 1000, dims: 64,  index: "flat", quant: "none" },
    { name: "1000-flat-int3", docs: 1000, dims: 64,  index: "flat", quant: "int3" },
    { name: "1000-hnsw-none", docs: 1000, dims: 64,  index: "hnsw", quant: "none" },
    { name: "2000-flat-none", docs: 2000, dims: 64,  index: "flat", quant: "none" },
    { name: "5000-flat-int3", docs: 5000, dims: 64,  index: "flat", quant: "int3" },
  ];

  // Allow custom configs via POST body
  if (params.configs && Array.isArray(params.configs)) {
    configs.length = 0;
    configs.push(...params.configs);
  }

  const allResults: any[] = [];

  for (const cfg of configs) {
    const benchName = `scale-${cfg.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const stub = env.MINIMEMORY.get(env.MINIMEMORY.idFromName(benchName));

    // Run benchmark inside the DO (more CPU budget)
    const res = await stub.fetch(new Request("http://do/benchmark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docs: cfg.docs,
        dims: cfg.dims,
        index: cfg.index,
        quant: cfg.quant || "none",
        k: params.k || 10,
      }),
    }));

    const data = (await res.json()) as any;
    allResults.push({ config: cfg, ...data });
  }

  return json({
    benchmark: "minimemory scaled",
    timestamp: new Date().toISOString(),
    results: allResults,
  });
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
