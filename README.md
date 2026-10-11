# Research GraphRAG

A lightweight GraphRAG implementation for research and knowledge discovery. It follows the GraphRAG pattern—graph extraction, relationship-aware retrieval, vector-assisted ranking, and grounded LLM generation—without requiring a heavy framework runtime. It searches real papers from [OpenAlex](https://openalex.org/), stores a connected paper graph in Neo4j, persists a deterministic embedding on every paper, and answers multi-hop questions with citations.

## What is included

- OpenAlex search and abstract reconstruction with no OpenAlex API key.
- Neo4j nodes for `Paper`, `Author`, `Concept`, `Method`, `Limitation`, and `Source`.
- Relationships for authorship, concepts, methods, limitations, citations, and related papers.
- A deterministic 384-dimensional hashed embedding stored as `Paper.embedding` and used for retrieval. No model is run locally.
- OpenRouter by default, with Groq and NVIDIA NIM support through their OpenAI-compatible APIs.
- FastAPI API plus a browser UI for discovery, ingestion, graph counts, and cited Q&A.
- Paper Studio with plain-language summaries, what was done, limitations, open work, practical next steps, improvement ideas, and hard-term explanations.
- A graph-grounded research paper chatbot and multi-paper comparison mode with inline citations.
- Fallback metadata extraction and answer generation when no LLM key is available.

## Recommended starting use case: Agent Memory

Start with one focused research question rather than a broad “search everything” workflow:

> Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?

This is a strong GraphRAG demo because the answer is inherently multi-hop:

```text
Paper → Author → Concept → Method → Limitation → Related Paper → Citation
```

### How to use it

1. Click **Start with Agent Memory** on the home screen, or search for `agent memory`.
2. Atlas retrieves real papers and abstracts from OpenAlex.
3. The service extracts methods and limitations with the configured OpenAI-compatible provider, or uses its deterministic fallback when the provider is unavailable.
4. Neo4j stores the entities, relationships, and a 384-dimensional paper embedding.
5. The graph view renders papers and their connected authors, concepts, methods, limitations, sources, citations, and related links.
6. Select a node to inspect it. Click **Expand connected evidence** to fetch its one-hop neighbors from Neo4j.
7. Ask the research question. The answer is synthesized from graph-retrieved evidence and linked back to source papers.

This flow is useful for literature reviews, research onboarding, finding gaps, comparing approaches, and discovering papers connected through a shared method or limitation.

### Real paper examples to try

| Use case | Search topic | Example paper/question |
| --- | --- | --- |
| Agent memory | `agent memory` | **MemGPT: Towards LLMs as Operating Systems** — What memory hierarchy does it propose and what remains difficult? |
| Tool-using agents | `reasoning acting language models` | **ReAct: Synergizing Reasoning and Acting in Language Models** — How do reasoning traces and actions complement each other? |
| Simulated memory | `generative agents memory` | **Generative Agents: Interactive Simulacra of Human Behavior** — How are experiences stored, reflected on, and retrieved? |
| Retrieval systems | `retrieval augmented generation` | **Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks** — What does retrieval improve and where can it fail? |
| Long-context limits | `language models long context` | **Lost in the Middle: How Language Models Use Long Contexts** — What does the evidence say about context placement? |

After discovery, select a paper to open **Paper Studio**. It gives you a readable summary, “what was done”, “what is left”, “what you can do”, improvement ideas, hard terms, a paper chatbot, and comparison checkboxes for multiple papers. Paste a methods/results/table excerpt with its page or table location when you need exact metric comparisons; it becomes a cited `Excerpt` node in Neo4j. You can also upload a PDF directly: the app extracts page-aware chunks and stores `Document` and `Chunk` nodes in Aura, linked to the selected paper.

## Run on Windows without Docker

Use Neo4j Desktop or a hosted Neo4j/Aura database. Docker is not required.

### 1. Get your Neo4j Aura connection values

In the Neo4j Aura console, open your instance and choose **Connect → Drivers**. Copy the URI that looks like:

```text
neo4j+s://xxxxxxxx.databases.neo4j.io
```

Aura normally uses database `neo4j`. Keep the supplied username/password from this project if they belong to that Aura instance; otherwise use the credentials shown by Aura.

### 2. Configure environment in PowerShell

```powershell
cd "C:\path\to\NEO 4J Hacthon"
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

The workspace `.env` is already populated with the supplied Aura instance URI, database ID, Query API URL, and provider keys; it is excluded by `.gitignore`. The value `f324a06a` is the Aura instance/database ID, not normally the database username. Set the database credentials in `.env`:

```env
NEO4J_URI=neo4j+s://YOUR_AURA_INSTANCE.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-aura-password
NEO4J_DATABASE=neo4j
NEO4J_QUERY_API_URL=https://YOUR_AURA_INSTANCE.databases.neo4j.io/db/neo4j/query/v2
```

Use a custom username only if you created that database user inside Aura. The password must be the database password shown/created in Aura under **Connect → Drivers**; an Aura console/account password will return `401 Unauthorized`.

Add an OpenRouter, Groq, or NVIDIA key if you want LLM-powered extraction and synthesis. All three supplied provider configurations are present in `.env`; OpenRouter is selected by default. The application does not require a provider key to discover papers or use its evidence fallback.

### 3. Install and start from PowerShell

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

If PowerShell blocks activation, run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If you do not want to activate the environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Open <http://localhost:8000>.

## Demo question

Search for `agent memory`, then ask:

> Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?

## API

- `GET /api/health` — Neo4j and LLM availability.
- `GET /api/stats` — graph node and relationship counts.
- `GET /api/graph?limit=24` — paper-centered graph nodes and relationships for the explorer.
- `GET /api/graph/expand?node_id=<neo4j-element-id>` — one-hop expansion for a selected node.
- `GET /api/papers/{openalex_id}/insights` — structured reading guide for a paper.
- `POST /api/papers/{openalex_id}/chat` — paper-specific chatbot grounded in graph context.
- `POST /api/papers/{openalex_id}/evidence` — attach a page/table/methods excerpt as cited graph evidence.
- `POST /api/documents` — upload a PDF or UTF-8 text file as Aura `Document`/`Chunk` nodes and link it to a paper.
- `POST /api/compare` — compare 2–4 ingested papers with citations.
- `POST /api/discover` — body `{ "topic": "agent memory", "limit": 8 }`.
- `POST /api/ask` — body `{ "question": "..." }`.

## Security

Credentials belong in `.env` or the deployment secret manager. Do not paste keys into source files or commit `.env`. Any credentials shared in chat or source control should be rotated before use.

## Next improvements

OpenAlex abstracts are not a substitute for full paper text. The comparison assistant will refuse to claim a numeric result is comparable unless the supplied evidence includes the relevant metric/context; attach focused excerpts for rigorous comparisons. The schema is ready for PDF/full-text ingestion, background jobs, richer citation edges, and graph physics/layout.
