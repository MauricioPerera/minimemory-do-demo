/**
 * External benchmark runner — calls the deployed Worker's /benchmark/run endpoint
 * and formats the results.
 *
 * Usage: node benchmark/bench.mjs [url]
 * Default URL: http://localhost:8787
 */

const BASE = process.argv[2] || "http://localhost:8787";

async function run() {
  console.log(`\n🏁 Running benchmark against ${BASE}\n`);

  const res = await fetch(`${BASE}/benchmark/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    console.error(`Error: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();

  console.log("┌──────────────────────────────────────────────────────┐");
  console.log("│         minimemory vs D1 Benchmark Results           │");
  console.log("├──────────────────────────────────────────────────────┤");
  console.log(`│  Config: ${data.config.num_docs} docs × ${data.config.dimensions}d, top-${data.config.k}          │`);
  console.log("├──────────────┬──────────────┬─────────────┬─────────┤");
  console.log("│  Operation   │  minimemory  │     D1      │ Speedup │");
  console.log("├──────────────┼──────────────┼─────────────┼─────────┤");

  const mm = data.minimemory;
  const d1 = data.d1;

  const padR = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);

  const insertSpeedup = (d1.insert_ms / mm.insert_ms).toFixed(1);
  const searchSpeedup = (d1.search_ms / mm.search_ms).toFixed(1);

  console.log(
    `│  Insert ${padL(data.config.num_docs, 4)} │ ${padL(mm.insert_ms + "ms", 12)} │ ${padL(d1.insert_ms + "ms", 11)} │ ${padL(insertSpeedup + "x", 7)} │`
  );
  console.log(
    `│  Search t${data.config.k}  │ ${padL(mm.search_ms + "ms", 12)} │ ${padL(d1.search_ms + "ms", 11)} │ ${padL(searchSpeedup + "x", 7)} │`
  );

  if (d1.filter_ms !== undefined) {
    console.log(
      `│  Filter      │     N/A      │ ${padL(d1.filter_ms + "ms", 11)} │   N/A   │`
    );
  }

  console.log("└──────────────┴──────────────┴─────────────┴─────────┘");

  if (mm.search_internal_ms !== undefined) {
    console.log(
      `\n  ⚡ minimemory internal search time: ${mm.search_internal_ms.toFixed(3)}ms`
    );
    console.log(
      `     (${mm.search_ms.toFixed(1)}ms includes DO fetch overhead)`
    );
  }

  console.log(`\n  📊 Summary: ${data.summary.search_speedup} for search`);
  console.log(`              ${data.summary.insert_speedup} for insert\n`);
}

run().catch(console.error);
