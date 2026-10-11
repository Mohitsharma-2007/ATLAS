# Atlas Research Graph

## Project overview

Atlas Research Graph is an AI-powered research and knowledge discovery assistant. It helps a researcher move from a broad topic to a connected understanding of the literature.

Instead of returning only a list of search results, the application connects:

```text
Paper → Author → Concept → Method → Limitation → Related Paper → Citation
```

The system can explain difficult papers, answer questions across multiple papers, compare research approaches, identify limitations, and suggest what could be explored next.

The project is implemented as a lightweight GraphRAG system using:

- **OpenAlex** for real research paper metadata and abstracts.
- **Neo4j Aura** for the research knowledge graph, document evidence, relationships, and stored embeddings.
- **OpenRouter, Groq, or NVIDIA-compatible APIs** for optional extraction, summarization, comparison, and chatbot responses.
- **FastAPI** for the backend API.
- **A light-theme interactive web UI** for graph exploration and paper analysis.

## Problem we are solving

Research information is connected, but traditional paper search usually presents it as isolated records. A researcher may find a paper, but still need to manually determine:

- Which authors worked on related ideas?
- Which concepts and methods are shared across papers?
- What limitations were reported?
- Which papers propose related or alternative solutions?
- Which papers cite or are cited by the selected work?
- Are two reported results actually comparable?
- What can be built or tested based on the research?

These questions require multiple related pieces of information. They are not simple keyword lookups.

Atlas represents those connections explicitly so the AI can retrieve and explain them.

## Main use case: Agent memory research

The recommended starting question is:

> Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?

This question can require a traversal such as:

```text
Question
  ↓
Relevant papers
  ↓
Authors and concepts
  ↓
Memory methods
  ↓
Reported limitations
  ↓
Related papers and citations
  ↓
Evidence-grounded answer
```

Real paper examples to explore include:

- **A-Mem: Agentic Memory for LLM Agents** — dynamic memory organization and linking.
- **MemGPT: Towards LLMs as Operating Systems** — memory hierarchy and context management.
- **ReAct: Synergizing Reasoning and Acting in Language Models** — reasoning and tool use.
- **Generative Agents: Interactive Simulacra of Human Behavior** — storing, reflecting on, and retrieving experiences.
- **Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks** — retrieval-supported language generation.
- **Lost in the Middle: How Language Models Use Long Contexts** — long-context retrieval limitations.

## Why Neo4j was used

Neo4j is useful because the central problem is about relationships, not only documents.

### 1. Research is naturally a graph

Research papers are connected through authors, concepts, methods, limitations, citations, institutions, and sources. Neo4j stores these relationships directly instead of forcing the application to reconstruct them from separate tables.

Example:

```cypher
(paper:Paper)-[:AUTHORED_BY]->(author:Author)
(paper:Paper)-[:ABOUT]->(concept:Concept)
(paper:Paper)-[:USES_METHOD]->(method:Method)
(paper:Paper)-[:HAS_LIMITATION]->(limitation:Limitation)
(paper:Paper)-[:RELATED_TO]->(related:Paper)
(paper:Paper)-[:CITES]->(cited:Paper)
```

### 2. Neo4j supports multi-hop questions

A question such as:

> Which memory approaches are connected to papers that report context-length limitations?

can require multiple hops across the graph. Neo4j makes this traversal natural with Cypher.

### 3. Neo4j makes answers explainable

The application can show why a paper was included:

```text
Question
 → Agent memory concept
 → Episodic memory method
 → Paper A
 → Limitation: fixed memory structure
 → Related Paper B
```

This is more transparent than returning a similarity score without showing the supporting path.

### 4. Neo4j supports graph and vector retrieval together

Every ingested paper receives an embedding stored on the `Paper` node. The application uses that embedding for topic ranking and then expands through graph relationships.

This combines:

```text
Vector retrieval = find semantically/lexically relevant papers
Graph retrieval  = explain their connected evidence
LLM generation   = synthesize a grounded response
```

### 5. Neo4j Aura removes local database setup

The application connects to Neo4j Aura using the `neo4j+s://` URI. No Docker container or local Neo4j server is required.

The application uses:

- Neo4j Bolt for transactional graph operations and schema setup.
- The supplied Aura Query API v2 URL for connectivity verification.
- Aura as the persistent database for papers, entities, relationships, documents, chunks, and evidence.

### 6. Neo4j has a flexible schema

Research metadata changes over time. New entities such as institutions, datasets, experiments, excerpts, or claims can be added without redesigning a large relational schema.

## Graph data model

### Core nodes

| Node | Purpose |
| --- | --- |
| `Paper` | Research title, abstract, DOI, year, PDF URL, source, citations, FWCI, open-access status, and embedding. |
| `Author` | Paper authors and OpenAlex author identifiers. |
| `Concept` | Topics and research concepts extracted from OpenAlex. |
| `Method` | Methods or approaches extracted by the AI or fallback rules. |
| `Limitation` | Explicit or strongly implied limitations and open problems. |
| `Source` | Journal, repository, or publication source. |
| `Document` | Uploaded PDF or text document metadata. |
| `Chunk` | Page-aware text extracted from an uploaded document, with an embedding. |
| `Excerpt` | Focused user-provided methods, results, or table evidence. |

### Relationships

```text
(:Paper)-[:AUTHORED_BY]->(:Author)
(:Paper)-[:ABOUT]->(:Concept)
(:Paper)-[:USES_METHOD]->(:Method)
(:Paper)-[:HAS_LIMITATION]->(:Limitation)
(:Paper)-[:FROM_SOURCE]->(:Source)
(:Paper)-[:RELATED_TO {score}]->(:Paper)
(:Paper)-[:CITES]->(:Paper)
(:Document)-[:HAS_CHUNK]->(:Chunk)
(:Document)-[:ABOUT_PAPER]->(:Paper)
(:Paper)-[:HAS_EVIDENCE]->(:Excerpt)
```

## How GraphRAG works in this project

### Step 1: Discover real papers

The user searches for a topic such as `agent memory`. OpenAlex returns real research works.

The application collects:

- Title
- Full abstract when available
- Authors
- Institutions
- Publication date and year
- Publication type
- Journal or source
- DOI and landing page
- Open-access status
- PDF URL when available
- Citation count
- FWCI when available
- Referenced work count
- Related work count
- Yearly citation data
- Concepts, topics, and keywords

OpenAlex does not require an API key for the basic discovery flow.

### Step 2: Enrich the graph

Methods and limitations are extracted from titles and abstracts using the configured AI provider. If the AI provider is unavailable, deterministic fallback extraction keeps the paper usable.

Each paper is then stored in Aura with its entities and relationships.

### Step 3: Store embeddings

The MVP stores a deterministic 384-dimensional feature-hash embedding on each `Paper` node. This avoids running a model locally and keeps the project fast to start.

The embedding can later be replaced with a remote embedding provider without changing the graph model.

### Step 4: Retrieve connected evidence

For a user question, the application:

1. Embeds the question.
2. Ranks stored papers.
3. Selects the strongest paper candidates.
4. Expands their authors, concepts, methods, limitations, related papers, and citations.
5. Builds a compact evidence context.
6. Sends that context to the configured AI provider.
7. Requires citations such as `[P1]`, `[R1]`, and `[P1-E1]`.

### Step 5: Generate a grounded answer

The AI is instructed to:

- Use only supplied evidence.
- Explain difficult concepts plainly.
- Cite substantive claims.
- Separate reported findings from suggested improvements.
- Avoid inventing metrics or experiments.
- State when evidence is missing.

## Paper Studio

The Paper Studio makes a difficult paper easier to read.

It provides:

- Plain-language summary
- Why the paper matters
- What the authors did
- How the approach works
- Limitations
- What is left according to the available evidence
- What a researcher could try next
- Improvement ideas labeled as suggestions
- Hard terms explained simply
- Full OpenAlex metadata
- Landing-page and PDF links
- Connected-paper evidence
- Paper-specific chatbot
- Multi-paper comparison

## Comparing actual research results

OpenAlex often provides metadata and abstracts, but abstracts do not contain every experiment table or metric.

For rigorous comparisons, Paper Studio allows the user to attach evidence such as:

```text
Location: page 6, Table 2
Text: Model A achieved 84.3 F1 on the test split...
```

The application stores this as an `Excerpt` node and cites it as:

```text
[P1-E1]
```

The comparison assistant is instructed to check:

- Dataset
- Dataset split
- Metric
- Units
- Evaluation conditions
- Baseline definition

It should not rank results from different evaluation setups as if they were directly comparable.

## Document upload flow

The application supports PDF and UTF-8 text uploads from Paper Studio.

```text
PDF or TXT
  ↓
Page-aware text extraction
  ↓
Document node
  ↓
Chunk nodes
  ↓
Chunk embeddings
  ↓
ABOUT_PAPER relationship
  ↓
Paper chatbot and comparison evidence
```

The original file is not retained by the application. Extracted text, page locations, provenance, and embeddings are stored in Aura.

## Where Neo4j helped us

### During ingestion

Neo4j provided one persistent place for papers and the entities extracted from them. Ingestion is idempotent because nodes are merged by stable identifiers.

### During question answering

The graph connects the top-ranked papers to evidence that pure vector search would not automatically reveal.

### During visual exploration

The UI renders Neo4j nodes and relationships directly. A researcher can click a paper, author, method, or limitation and expand its one-hop neighborhood.

### During citation tracing

The graph can represent citation edges, related-paper edges, and source links. This creates a visible evidence path for generated answers.

### During document intelligence

Uploaded paper content becomes page-aware graph evidence instead of remaining an unsearchable file. Chunks can be linked to the paper and used by the chatbot with provenance.

### During future growth

The graph can be extended with:

- Claims
- Datasets
- Experiments
- Metrics
- Institutions
- Research questions
- Grant or project relationships
- Contradictory findings
- Reproduction attempts

## Current limitations

- OpenAlex metadata is not the same as complete full-text paper ingestion.
- PDF extraction quality depends on the document layout and text layer.
- The MVP embedding is deterministic feature hashing, not a transformer embedding model.
- Citation links are strongest when both papers are present in the graph.
- Numeric comparisons require attached evidence excerpts when the abstract does not contain the result.
- The AI provider can fail or rate-limit, so deterministic fallbacks are included.

## Definition of success

The project succeeds when a researcher can:

1. Search a real research topic.
2. See real paper metadata and PDF links.
3. Store papers and relationships in Neo4j Aura.
4. Inspect a paper’s connected graph.
5. Understand a difficult paper in plain language.
6. Ask a paper-specific research question.
7. Compare multiple papers with citations.
8. Attach page/table evidence for reliable metric comparison.
9. Identify what has been done, what remains, and what can be tried next.
