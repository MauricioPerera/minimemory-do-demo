# minimemory-do-demo

minimemory WASM running in Cloudflare Durable Objects -- benchmark vs D1

**Live:** https://minimemory-do-demo.rckflr.workers.dev

## What it is

Proof of concept showing [minimemory](https://www.npmjs.com/package/@rckflr/minimemory) as an in-memory vector database inside Cloudflare Workers via Durable Objects. Each Durable Object instance holds a full minimemory WASM vector DB in memory, with automatic checkpointing to DO SQLite storage for persistence across evictions.

## Architecture

```
Client request
  --> Worker (src/index.ts) routes by path
    --> Durable Object (src/minimemory-do.ts)
      --> minimemory WASM in-memory vector DB
        --> checkpoint to DO SQLite storage on writes
```

- The Worker routes `/db/:name/*` requests to a named Durable Object instance
- Each DO lazily initializes the WASM module and restores state from its SQLite snapshot
- Benchmark endpoints run directly in the Worker (quick) or inside the DO (scaled) for more CPU budget
- D1 is used only as a comparison target in benchmarks

## API endpoints

All database endpoints are prefixed with `/db/:name` where `:name` is the database instance name.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check and endpoint listing |
| `POST` | `/db/:name/init` | Configure DB (dims, distance, index type) |
| `POST` | `/db/:name/insert` | Insert a single vector with optional metadata |
| `POST` | `/db/:name/bulk-insert` | Bulk insert vectors (auto-configures dims) |
| `POST` | `/db/:name/search` | Vector similarity search |
| `POST` | `/db/:name/keyword` | Keyword search |
| `GET` | `/db/:name/get/:id` | Get a document by ID |
| `DELETE` | `/db/:name/delete/:id` | Delete a document by ID |
| `GET` | `/db/:name/stats` | DB stats (count, dimensions, config) |
| `POST` | `/db/:name/checkpoint` | Force a persistence checkpoint |
| `POST` | `/benchmark/run` | Quick benchmark: minimemory vs D1 (50 docs) |
| `POST` | `/benchmark/scale` | Scaled benchmark (100-5000 docs, HNSW, quantization) |

## Benchmark results

### Quick benchmark (50 docs, 32 dims)

minimemory is approximately **3x faster** than D1 for vector search at small scale.

### Scaled benchmark

5000 documents with search completing in **under 1ms**.

| Config | Docs | Dims | Index | Quantization |
|--------|------|------|-------|--------------|
| 100-flat-none | 100 | 64 | flat | none |
| 500-flat-none | 500 | 64 | flat | none |
| 1000-flat-none | 1,000 | 64 | flat | none |
| 1000-flat-int3 | 1,000 | 64 | flat | int3 |
| 1000-hnsw-none | 1,000 | 64 | hnsw | none |
| 2000-flat-none | 2,000 | 64 | flat | none |
| 5000-flat-int3 | 5,000 | 64 | flat | int3 |

Custom configs via POST body to `/benchmark/scale`.

## How to run locally

```bash
npm install
npm run dev
```

## How to deploy

```bash
wrangler deploy
```

## Running benchmarks

```bash
# Quick (50 docs, minimemory vs D1)
curl -X POST https://minimemory-do-demo.rckflr.workers.dev/benchmark/run

# Scaled (100-5000 docs)
curl -X POST https://minimemory-do-demo.rckflr.workers.dev/benchmark/scale

# Custom config
curl -X POST https://minimemory-do-demo.rckflr.workers.dev/benchmark/scale \
  -H "Content-Type: application/json" \
  -d '{"configs": [{"name": "custom", "docs": 3000, "dims": 128, "index": "hnsw", "quant": "int8"}]}'
```

## Tech stack

- **minimemory WASM** (493KB) -- in-memory vector database
- **Cloudflare Workers** -- serverless compute at the edge
- **Durable Objects** -- stateful actors with SQLite storage
- **D1** -- Cloudflare's SQL database (benchmark comparison only)

## Powered by

[@rckflr/minimemory](https://www.npmjs.com/package/@rckflr/minimemory)

## License

MIT
