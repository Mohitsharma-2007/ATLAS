const $ = (id) => document.getElementById(id);

const state = {
  graph: { nodes: [], edges: [], center: null },
  positions: new Map(),
  selected: null,
  papers: [],
  selectedPaperId: null,
};

async function request(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
  });
  let payload;
  try { payload = await response.json(); } catch (_) { payload = {}; }
  if (!response.ok) throw new Error(payload.detail || 'Request failed');
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? escapeHtml(url.href) : '';
  } catch (_) { return ''; }
}

function shortText(value, length = 27) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function setMessage(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle('error', error);
}

function renderStats(stats) {
  const labels = [
    ['papers', 'Papers', '▱'],
    ['authors', 'Authors', '○'],
    ['concepts', 'Concepts', '◇'],
    ['methods', 'Methods', '⌁'],
    ['limitations', 'Limitations', '△'],
    ['citations', 'Citations', '↗'],
    ['related', 'Related links', '∞'],
  ];
  $('stats').innerHTML = labels.map(([key, label, icon]) => `<div class="metric"><b>${stats[key] || 0}</b><span>${icon} &nbsp;${label}</span></div>`).join('');
}

function mergeGraph(incoming) {
  const nodeMap = new Map(state.graph.nodes.map((node) => [node.id, node]));
  (incoming.nodes || []).forEach((node) => nodeMap.set(node.id, { ...nodeMap.get(node.id), ...node }));
  const edgeMap = new Map(state.graph.edges.map((edge) => [edge.id, edge]));
  (incoming.edges || []).forEach((edge) => edgeMap.set(edge.id, edge));
  state.graph = { nodes: [...nodeMap.values()], edges: [...edgeMap.values()], center: incoming.center || state.graph.center };
  renderGraph();
}

function nodeClass(type) { return `node-${String(type || 'source').toLowerCase()}`; }

function buildPositions(nodes) {
  const positions = new Map();
  const width = 1000;
  const height = 570;
  const papers = nodes.filter((node) => node.type === 'Paper');
  const other = nodes.filter((node) => node.type !== 'Paper');
  const paperRadius = Math.min(195, 75 + papers.length * 15);
  papers.forEach((node, index) => {
    const angle = (Math.PI * 2 * index / Math.max(papers.length, 1)) - Math.PI / 2;
    positions.set(node.id, { x: width / 2 + paperRadius * Math.cos(angle), y: height / 2 + paperRadius * Math.sin(angle) });
  });
  const columns = { Author: 132, Concept: 298, Method: 702, Limitation: 868, Source: 500 };
  const byType = new Map();
  other.forEach((node) => {
    if (!byType.has(node.type)) byType.set(node.type, []);
    byType.get(node.type).push(node);
  });
  byType.forEach((items, type) => {
    const x = columns[type] || 500;
    items.forEach((node, index) => {
      const rowHeight = Math.min(55, (height - 90) / Math.max(items.length, 1));
      positions.set(node.id, { x, y: 52 + rowHeight * index + (index % 2 ? 5 : 0) });
    });
  });
  return positions;
}

function renderGraph() {
  const filter = $('graph-filter').value;
  const nodes = state.graph.nodes.filter((node) => filter === 'all' || node.type === filter);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = state.graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  state.positions = buildPositions(nodes);
  $('graph-count').textContent = `${nodes.length} nodes · ${edges.length} relations`;
  $('graph-empty').style.display = nodes.length ? 'none' : 'flex';
  const edgeMarkup = edges.map((edge) => {
    const left = state.positions.get(edge.source); const right = state.positions.get(edge.target);
    if (!left || !right) return '';
    const type = String(edge.type || '').toLowerCase();
    const midX = (left.x + right.x) / 2; const midY = (left.y + right.y) / 2;
    const edgeLabel = edges.length < 36 ? `<text class="edge-label" x="${midX}" y="${midY - 3}" text-anchor="middle">${escapeHtml(edge.type.replaceAll('_', ' '))}</text>` : '';
    return `<g><line class="graph-edge ${type}" x1="${left.x}" y1="${left.y}" x2="${right.x}" y2="${right.y}"></line>${edgeLabel}</g>`;
  }).join('');
  const nodeMarkup = nodes.map((node) => {
    const point = state.positions.get(node.id); if (!point) return '';
    const selected = state.selected && state.selected.id === node.id ? ' selected' : '';
    const paper = node.type === 'Paper'; const radius = paper ? 21 : 12;
    const label = shortText(node.label || node.type, paper ? 31 : 19);
    return `<g class="graph-node ${paper ? 'paper-node' : ''}${selected}" data-node-id="${escapeHtml(node.id)}" transform="translate(${point.x},${point.y})"><circle class="${nodeClass(node.type)}" r="${radius}"></circle><text y="${paper ? 36 : 27}" text-anchor="middle">${escapeHtml(label)}</text></g>`;
  }).join('');
  $('graph-edges').innerHTML = edgeMarkup;
  $('graph-nodes').innerHTML = nodeMarkup;
  document.querySelectorAll('.graph-node').forEach((element) => element.addEventListener('click', () => selectNode(element.dataset.nodeId)));
}

function getNode(nodeId) { return state.graph.nodes.find((node) => node.id === nodeId); }

function relationSummary(nodeId) {
  const summaries = [];
  state.graph.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId).slice(0, 14).forEach((edge) => {
    const other = getNode(edge.source === nodeId ? edge.target : edge.source);
    if (other) summaries.push(`<div class="relation-item"><i class="${nodeClass(other.type)}"></i><span>${escapeHtml(edge.type.replaceAll('_', ' ').toLowerCase())} · </span><b>${escapeHtml(shortText(other.label, 32))}</b></div>`);
  });
  return summaries.join('') || '<div class="relation-item"><span>No connected nodes loaded yet.</span></div>';
}

function renderInspector(node) {
  if (!node) {
    $('inspector').innerHTML = '<div class="inspector-empty"><span class="inspector-symbol">◌</span><p class="eyebrow">NODE INSPECTOR</p><h3>Select a node</h3><p>Explore a paper, author, method, or limitation to reveal its connected evidence.</p></div>';
    return;
  }
  const props = node.properties || {};
  const type = node.type || 'Entity';
  const paper = type === 'Paper';
  const title = props.title || props.name || props.statement || node.label;
  const chips = [];
  if (props.year) chips.push(String(props.year));
  if (props.cited_by_count !== undefined) chips.push(`${props.cited_by_count} citations`);
  if (props.openalex_id) chips.push(props.openalex_id);
  const url = safeUrl(props.url || props.doi);
  $('inspector').innerHTML = `<div class="inspector-top"><div><span class="type-label">${escapeHtml(type.toUpperCase())}</span><h2 class="inspector-title">${escapeHtml(title)}</h2></div><span class="node-key">${escapeHtml(node.id.split(':').pop())}</span></div>
    <div class="inspector-props">${chips.map((chip) => `<span class="prop-chip">${escapeHtml(chip)}</span>`).join('')}</div>
    <button class="expand-button" id="expand-node">Expand connected evidence <span>↗</span></button>
    ${paper && props.openalex_id ? '<button class="expand-button studio-button" id="open-paper">Open paper studio <span>✦</span></button>' : ''}
    ${url ? `<a class="inspector-link" href="${url}" target="_blank" rel="noreferrer">Open source paper ↗</a>` : ''}
    ${paper && props.abstract ? `<div class="inspector-rule"></div><span class="inspector-section-label">ABSTRACT</span><p class="inspector-abstract">${escapeHtml(props.abstract)}</p>` : ''}
    <div class="inspector-rule"></div><span class="inspector-section-label">LOADED RELATIONSHIPS</span><div class="relation-list">${relationSummary(node.id)}</div>`;
  $('expand-node').addEventListener('click', () => expandNode(node.id));
  if (paper && props.openalex_id) $('open-paper').addEventListener('click', () => openPaperWorkspace(props.openalex_id));
}

function selectNode(nodeId) {
  const node = getNode(nodeId); if (!node) return;
  state.selected = node;
  renderGraph();
  renderInspector(node);
  if (window.innerWidth < 820) $('inspector').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function expandNode(nodeId) {
  const button = $('expand-node'); if (button) { button.disabled = true; button.textContent = 'Loading relationships…'; }
  try {
    const expanded = await request(`/api/graph/expand?node_id=${encodeURIComponent(nodeId)}`);
    mergeGraph(expanded);
    selectNode(nodeId);
  } catch (error) { if (button) { button.disabled = false; button.textContent = 'Could not expand — retry'; } }
}

async function loadGraph(reset = false) {
  try {
    const graph = await request('/api/graph?limit=24');
    if (reset) { state.graph = { nodes: [], edges: [], center: null }; state.selected = null; }
    mergeGraph(graph);
    if (state.graph.center && !state.selected) selectNode(state.graph.center);
  } catch (_) { renderGraph(); }
}

function renderPapers(papers) {
  state.papers = papers;
  $('collection-count').textContent = papers.length;
  $('paper-list').innerHTML = papers.length ? papers.map((paper) => {
    const url = safeUrl(paper.url);
    const pdf = safeUrl(paper.pdf_url);
    return `<article class="paper-item"><label title="Select for comparison"><input class="compare-check" type="checkbox" value="${escapeHtml(paper.openalex_id)}" /></label><div><span class="paper-meta">${paper.year || 'YEAR UNKNOWN'} · ${escapeHtml(paper.type || 'work')} · ${paper.cited_by_count || 0} CITATIONS</span><h3>${escapeHtml(paper.title)}</h3><p>${escapeHtml((paper.authors || []).slice(0, 2).join(', ') || 'Authors not listed')}</p><p class="paper-abstract">${escapeHtml(shortText(paper.abstract || 'Abstract not available.', 240))}</p>${url ? `<a class="paper-link" href="${url}" target="_blank" rel="noreferrer">Metadata ↗</a>` : ''}${pdf ? ` <a class="paper-link" href="${pdf}" target="_blank" rel="noreferrer">PDF ↗</a>` : ''}</div><button class="trace-button" data-paper-id="${escapeHtml(paper.openalex_id)}" title="Show this paper in the graph">↗</button></article>`;
  }).join('') : '<div class="list-empty">Your discovered papers will appear here.</div>';
  document.querySelectorAll('[data-paper-id]').forEach((button) => button.addEventListener('click', () => focusPaper(button.dataset.paperId)));
}

function focusPaper(openalexId) {
  const node = state.graph.nodes.find((candidate) => candidate.external_id === openalexId);
  if (node) { selectNode(node.id); openPaperWorkspace(openalexId); return; }
  const paper = state.papers.find((candidate) => candidate.openalex_id === openalexId);
  if (paper) { setMessage('discover-message', `Opening ${paper.title} in the paper studio.`); openPaperWorkspace(openalexId); }
}

function listMarkup(items) {
  if (!Array.isArray(items) || !items.length) return '<p>No explicit evidence was extracted for this section.</p>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(typeof item === 'string' ? item : item.explanation || '')}</li>`).join('')}</ul>`;
}

function renderPaperStudio(data) {
  const paper = data.paper || {};
  const insights = data.insights || {};
  $('studio-empty').style.display = 'none';
  $('studio-content').hidden = false;
  $('studio-title').textContent = paper.title || 'Selected paper';
  $('studio-meta').textContent = `${paper.publication_date || paper.year || 'Year unknown'} · ${(paper.authors || []).slice(0, 4).join(', ') || 'Authors not listed'} · ${paper.journal || 'Source not listed'}`;
  const source = safeUrl(paper.url || paper.doi);
  $('studio-source').href = source || '#';
  $('studio-source').style.display = source ? 'inline-block' : 'none';
  const pdf = safeUrl(paper.pdf_url);
  $('studio-pdf').href = pdf || '#';
  $('studio-pdf').style.display = pdf ? 'inline-block' : 'none';
  const facts = [
    ['FWCI', paper.fwci ?? '—'],
    ['Cited by', paper.cited_by_count || 0],
    ['References', paper.references_count || 0],
    ['Related works', paper.related_count || 0],
    ['Type', paper.type || '—'],
    ['Open access', paper.is_oa ? 'Yes' : 'No'],
    ['Language', paper.language || '—'],
    ['Journal / source', paper.journal || '—'],
    ['Institutions', (paper.institutions || []).join(', ') || 'Not listed'],
    ['Keywords', (paper.keywords || []).join(', ') || 'Not listed'],
  ];
  $('studio-facts').innerHTML = facts.map(([label, value], index) => `<div class="paper-fact ${index > 7 ? 'paper-fact-wide' : ''}"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('');
  $('studio-summary').innerHTML = `<b>IN PLAIN ENGLISH</b>${escapeHtml(insights.summary || 'The AI reading guide is not available yet.')}<br><br><b>WHY IT MATTERS</b>${escapeHtml(insights.why_it_matters || '')}`;
  const cards = [
    ['WHAT WAS DONE', 'what_was_done', 'done'],
    ['HOW IT WORKS', 'how_it_works', 'done'],
    ['LIMITATIONS', 'limitations', 'left'],
    ['WHAT IS LEFT', 'what_is_left', 'left'],
    ['WHAT YOU CAN DO', 'what_you_can_do', 'try'],
    ['HOW TO IMPROVE IT', 'improvement_ideas', 'improve'],
  ];
  $('insight-grid').innerHTML = cards.map(([title, key, color]) => `<div class="insight-box ${color}"><h4>${title}</h4>${listMarkup(insights[key])}</div>`).join('');
  const terms = Array.isArray(insights.hard_terms) ? insights.hard_terms : [];
  $('hard-terms').innerHTML = terms.length ? terms.map((term) => `<div class="term-item"><b>${escapeHtml(term.term || '')}</b><p>${escapeHtml(term.explanation || '')}</p></div>`).join('') : '<p class="inspector-abstract">No difficult terms were extracted yet.</p>';
  $('chat-messages').innerHTML = '';
}

async function openPaperWorkspace(openalexId) {
  state.selectedPaperId = openalexId;
  $('paper-studio').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('studio-empty').style.display = 'flex';
  $('studio-empty').innerHTML = '<span class="studio-icon">◌</span><b>Reading the paper and its graph context…</b><span>Preparing the plain-language guide.</span>';
  $('studio-content').hidden = true;
  try {
    const data = await request(`/api/papers/${encodeURIComponent(openalexId)}/insights`);
    renderPaperStudio(data);
  } catch (error) {
    $('studio-empty').innerHTML = `<span class="studio-icon">!</span><b>Paper studio could not load</b><span>${escapeHtml(error.message)}</span>`;
  }
}

function addChatBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  $('chat-messages').appendChild(bubble);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function renderComparison(result) {
  $('compare-output').innerHTML = `<div>${escapeHtml(result.answer || '')}</div><div class="source-list">${(result.papers || []).map((paper) => `<div class="source-card"><b>[${escapeHtml(paper.citation)}] ${escapeHtml(paper.title)}</b>${escapeHtml((paper.authors || []).slice(0, 2).join(', '))}</div>`).join('')}</div>`;
}

function renderAnswer(result) {
  const sourceCards = (result.sources || []).map((source) => {
    const url = safeUrl(source.url || source.doi);
    return `<div class="source-card"><b>[${escapeHtml(source.citation)}] ${escapeHtml(source.title)}</b>${escapeHtml((source.authors || []).slice(0, 3).join(', '))} · ${source.year || 'year unknown'}${url ? `<br><a href="${url}" target="_blank" rel="noreferrer">Open paper ↗</a>` : ''}${source.graph_id ? `<button data-source-id="${escapeHtml(source.graph_id)}">Trace in graph ↗</button>` : ''}</div>`;
  }).join('');
  $('answer').innerHTML = `<div>${escapeHtml(result.answer || '')}</div>${sourceCards ? `<div class="source-list">${sourceCards}</div>` : ''}`;
  document.querySelectorAll('[data-source-id]').forEach((button) => button.addEventListener('click', () => { selectNode(button.dataset.sourceId); $('graph-stage').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
}

async function loadState() {
  try {
    const [health, stats] = await Promise.all([request('/api/health'), request('/api/stats')]);
    const status = $('status');
    status.title = health.connection_message || '';
    status.innerHTML = `<span class="pulse"></span><span>${health.neo4j ? (health.llm ? 'Neo4j + AI connected' : 'Neo4j connected · fallback AI') : 'Aura connection needs attention'}</span>`;
    status.classList.add(health.neo4j ? 'ready' : 'warn');
    renderStats(stats);
    await loadGraph();
  } catch (_) { $('status').innerHTML = '<span class="pulse"></span><span>Service unavailable</span>'; $('status').classList.add('warn'); renderGraph(); }
}

$('discover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
  setMessage('discover-message', 'Searching OpenAlex, extracting research entities, and mapping the graph…');
  try {
    const result = await request('/api/discover', { method: 'POST', body: JSON.stringify({ topic: $('topic').value, limit: Number($('limit').value) }) });
    renderPapers(result.papers); renderStats(result.stats);
    if (result.stored) {
      await loadGraph(true);
      if (result.papers && result.papers[0]) openPaperWorkspace(result.papers[0].openalex_id);
      setMessage('discover-message', `${result.count} real papers are connected in Neo4j. Select a node to explore.`);
    } else {
      setMessage('discover-message', `${result.count} real OpenAlex papers loaded for preview. Neo4j storage is waiting: ${result.storage_message}`, true);
    }
  } catch (error) { setMessage('discover-message', error.message, true); }
  button.disabled = false;
});

$('ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true; $('answer').innerHTML = '';
  setMessage('ask-message', 'Retrieving connected evidence and synthesizing a cited answer…');
  try { const result = await request('/api/ask', { method: 'POST', body: JSON.stringify({ question: $('question').value }) }); renderAnswer(result); setMessage('ask-message', result.used_llm ? 'Answer grounded with the configured AI provider.' : 'Answer grounded with the built-in evidence fallback.'); }
  catch (error) { setMessage('ask-message', error.message, true); }
  button.disabled = false;
});

document.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => { $('topic').value = button.dataset.topic; $('question').value = `Which approaches to ${button.dataset.topic} have been explored, what are their limitations, and which papers discuss related solutions?`; $('discover-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
$('start-usecase').addEventListener('click', () => { $('topic').value = 'agent memory'; $('question').value = 'Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?'; $('discover-form').requestSubmit(); });
$('graph-filter').addEventListener('change', renderGraph);
$('refresh-graph').addEventListener('click', () => loadGraph(true));

$('paper-chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selectedPaperId) return;
  const input = $('paper-chat-question');
  const question = input.value.trim();
  if (!question) return;
  const button = event.target.querySelector('button');
  addChatBubble('user', question); input.value = ''; button.disabled = true;
  setMessage('paper-chat-message', 'Following the paper and connected evidence…');
  try {
    const result = await request(`/api/papers/${encodeURIComponent(state.selectedPaperId)}/chat`, { method: 'POST', body: JSON.stringify({ question }) });
    addChatBubble('bot', result.answer || 'No answer returned.');
    setMessage('paper-chat-message', result.used_llm ? 'Cited response from the configured AI provider.' : 'Evidence fallback response.');
  } catch (error) { addChatBubble('bot', error.message); setMessage('paper-chat-message', 'The paper chatbot could not answer.', true); }
  button.disabled = false;
});

$('evidence-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selectedPaperId) return;
  const button = event.target.querySelector('button'); button.disabled = true;
  setMessage('evidence-message', 'Saving a cited evidence excerpt in Neo4j…');
  try {
    await request(`/api/papers/${encodeURIComponent(state.selectedPaperId)}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ locator: $('evidence-locator').value, text: $('evidence-text').value }),
    });
    $('evidence-text').value = '';
    setMessage('evidence-message', 'Excerpt attached. Reloading the reading guide with its citation label.');
    await openPaperWorkspace(state.selectedPaperId);
  } catch (error) { setMessage('evidence-message', error.message, true); }
  button.disabled = false;
});

$('upload-document').addEventListener('click', async () => {
  if (!state.selectedPaperId) return;
  const file = $('paper-upload').files[0];
  if (!file) { setMessage('evidence-message', 'Choose a PDF or UTF-8 text file first.', true); return; }
  const button = $('upload-document'); button.disabled = true;
  setMessage('evidence-message', 'Extracting pages and uploading document chunks to Aura…');
  const form = new FormData(); form.append('file', file);
  try {
    const result = await request(`/api/documents?paper_id=${encodeURIComponent(state.selectedPaperId)}`, { method: 'POST', body: form });
    setMessage('evidence-message', `${result.filename} uploaded to Aura as ${result.chunks} page-aware chunks.`);
    $('paper-upload').value = '';
    await openPaperWorkspace(state.selectedPaperId);
  } catch (error) { setMessage('evidence-message', error.message, true); }
  button.disabled = false;
});

$('compare-button').addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('.compare-check:checked')].map((input) => input.value);
  if (selected.length < 2) { $('compare-output').textContent = 'Select at least two papers to compare.'; return; }
  const button = $('compare-button'); button.disabled = true; $('compare-output').textContent = 'Comparing approaches, limitations, and evidence…';
  try {
    const result = await request('/api/compare', { method: 'POST', body: JSON.stringify({ openalex_ids: selected, question: 'Compare the approaches, evidence, limitations, and what each paper enables next. Cite every claim.' }) });
    renderComparison(result);
  } catch (error) { $('compare-output').textContent = error.message; }
  button.disabled = false;
});

loadState();
