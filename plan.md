# Research & Knowledge Discovery GraphRAG

## Goal

Build a fast research assistant that discovers real papers, stores paper metadata and embeddings in Neo4j, connects papers to authors/concepts/methods/limitations, and answers multi-hop questions with cited evidence.

Example question:

> Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?

## Two-hour MVP plan

### 0–15 minutes — Foundation and safety

- Create a small Python service with a browser UI.
- Load all credentials from `.env`; never commit secrets.
- Default to a local Neo4j Bolt connection, while allowing Neo4j Aura or another hosted instance through `NEO4J_URI`.
- Use OpenAlex as the default paper source because it exposes real research metadata and abstracts without requiring an API key.

### 15–35 minutes — Neo4j graph model

Nodes:

- `Paper`: OpenAlex ID, DOI, title, abstract, year, URL, citation count, embedding.
- `Author`: OpenAlex ID and display name.
- `Concept`: normalized research concept.
- `Method`: extracted approach or technique.
- `Limitation`: extracted limitation or open problem.
- `Source`: source/provider metadata.
- `Document`: uploaded research-paper metadata.
- `Chunk`: page-aware document text with an embedding.
- `Excerpt`: focused user-provided methods/results/table evidence.

Relationships:

- `(:Paper)-[:AUTHORED_BY]->(:Author)`
- `(:Paper)-[:ABOUT]->(:Concept)`
- `(:Paper)-[:USES_METHOD]->(:Method)`
- `(:Paper)-[:HAS_LIMITATION]->(:Limitation)`
- `(:Paper)-[:CITES]->(:Paper)` when citation metadata is available.
- `(:Paper)-[:FROM_SOURCE]->(:Source)`
- `(:Document)-[:HAS_CHUNK]->(:Chunk)`
- `(:Document)-[:ABOUT_PAPER]->(:Paper)`
- `(:Paper)-[:HAS_EVIDENCE]->(:Excerpt)`
- `(:Paper)-[:RELATED_TO {score}]->(:Paper)` for discovered semantic/keyword similarity.

Create uniqueness constraints and a vector index when the connected Neo4j version supports it. The service also has a safe fallback for older Neo4j versions.

### 35–60 minutes — Real paper ingestion

- Search OpenAlex by the user’s topic.
- Fetch complete work metadata, reconstruct abstracts from OpenAlex’s inverted index, and normalize authors/concepts.
- Extract methods and limitations through the configured OpenAI-compatible provider (OpenRouter by default, Groq fallback).
- If an LLM is unavailable, retain the paper and derive useful method/limitation candidates from metadata and abstract text.
- Store each paper idempotently with `MERGE` and update its embedding.

### 60–85 minutes — GraphRAG answering

- Search the graph for papers, authors, concepts, methods, limitations, and related papers.
- Rank candidate papers with a deterministic hashed text embedding/cosine score. This keeps the MVP runnable without downloading or running a local model; the vector remains a real numeric embedding stored on `Paper.embedding`.
- Expand candidates one hop through the graph to expose connected authors, methods, limitations, and related papers.
- Send only the compact evidence context to an OpenAI-compatible chat model.
- Require inline `[P1]`, `[P2]` citations and return the source list from the database.
- Fall back to an evidence-based formatted response if the provider is unavailable.

### 85–105 minutes — Product surface

- Add endpoints for health, topic search/ingestion, graph stats, and question answering.
- Add a single-page UI with:
  - “Discover papers” topic search;
  - ingestion progress/result;
  - research question box;
  - cited answer and evidence cards;
  - graph counts.

### 105–120 minutes — Verification and handoff

- Add `.env.example`, `requirements.txt`, and setup instructions.
- Run Python compilation and unit tests for abstract reconstruction, embedding/ranking, parsing, and fallback behavior.
- Document Neo4j setup, provider configuration, and the demo flow.

## MVP architecture

```text
Browser UI
    |
FastAPI service ── OpenAlex (real papers, no API key)
    |       └──── OpenRouter / Groq / NVIDIA (optional OpenAI-compatible LLM)
    |
Neo4j ── graph entities, relationships, Paper.embedding, vector index
```

The only required external service for paper discovery is OpenAlex. An LLM provider is optional for extraction and polished synthesis; deterministic extraction and answer fallbacks keep the demo functional when an LLM quota or network call is unavailable.

Uploaded PDFs or UTF-8 text files are extracted into page-aware `Document`/`Chunk` nodes and stored in Neo4j Aura. The app does not retain the original file; it stores text, provenance, and embeddings for grounded retrieval. The Paper Studio also accepts focused methods/results/table excerpts as `Excerpt` nodes so comparisons can cite exact locations.

## Demo flow

1. Start Neo4j and configure `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD`.
2. Start the service with `uvicorn app.main:app --reload`.
3. Open `http://localhost:8000`.
4. Search for `agent memory`, ingest 8–12 papers, and inspect the graph counts.
5. Ask: “Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?”
6. Show the answer with paper citations and the connected evidence cards.

## Out of scope for the two-hour MVP

- Full PDF crawling or paywalled content extraction.
- Background queues and distributed ingestion.
- Production authentication, rate limiting, and multi-tenant isolation.
- A separate embedding model service. The MVP uses a deterministic local hashed embedding so no model is run locally; it can be replaced by Neo4j/remote embeddings later without changing the graph schema.

## Acceptance criteria

- A user can discover and ingest real OpenAlex papers with no OpenAlex API key.
- Paper, author, concept, method, limitation, and source relationships are visible in Neo4j.
- Paper embeddings are persisted and used for candidate ranking.
- A multi-hop question returns a grounded answer with paper citations and source metadata.
- The app starts from documented environment variables and does not contain hard-coded secrets.
