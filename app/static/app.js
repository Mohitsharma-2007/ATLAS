const $ = (id) => document.getElementById(id);

const state = {
  graph: { nodes: [], edges: [], center: null },
  positions: new Map(),
  selected: null,
  papers: [],
  selectedPaperId: null,
  comparisonResult: null,
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
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('error', error);
}

// Markdown and AI Output Formatter
function formatAiMarkdown(rawText, sources = []) {
  if (!rawText) return '';
  let text = String(rawText);

  // Extract code blocks first to protect them
  const codeBlocks = [];
  text = text.replace(/```(?:([a-zA-Z0-9_-]+)?\n)?([\s\S]*?)```/g, (_, lang, code) => {
    const id = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre class="ai-code-block"><code>${escapeHtml(code.trim())}</code></pre>`);
    return id;
  });

  // Extract inline code
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const id = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(`<code class="ai-code">${escapeHtml(code)}</code>`);
    return id;
  });

  // Escape HTML in the remaining text
  text = escapeHtml(text);

  // Markdown Tables
  text = text.replace(/(?:^|\n)((?:\|[^\n]+\|\r?\n?)+)/g, (match, tableText) => {
    const lines = tableText.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return match;
    const parseRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headerCols = parseRow(lines[0]);
    const isSep = lines[1] && lines[1].replace(/^\||\|$/g, '').split('|').every(c => /^:?-+:?$/.test(c.trim()));
    const startIdx = isSep ? 2 : 1;
    let tHtml = '<div class="table-container"><table class="ai-table"><thead><tr>';
    headerCols.forEach(col => { tHtml += `<th>${col}</th>`; });
    tHtml += '</tr></thead><tbody>';
    for (let i = startIdx; i < lines.length; i++) {
      const cols = parseRow(lines[i]);
      tHtml += '<tr>';
      cols.forEach(c => { tHtml += `<td>${c}</td>`; });
      tHtml += '</tr>';
    }
    tHtml += '</tbody></table></div>';
    return `\n${tHtml}\n`;
  });

  // Headings
  text = text.replace(/^### (.*$)/gim, '<h4 class="ai-h4">$1</h4>');
  text = text.replace(/^## (.*$)/gim, '<h3 class="ai-h3">$1</h3>');
  text = text.replace(/^# (.*$)/gim, '<h2 class="ai-h2">$1</h2>');

  // Horizontal divider
  text = text.replace(/^---$/gim, '<hr class="ai-hr" />');

  // Blockquotes
  text = text.replace(/^>\s+(.*$)/gim, '<blockquote class="ai-quote">$1</blockquote>');

  // Bold & Italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Unordered lists
  text = text.replace(/(?:^|\n)((?:[ \t]*[-*]\s+[^\n]+\r?\n?)+)/g, (_, listText) => {
    const items = listText.trim().split(/\r?\n/).map(l => l.replace(/^[ \t]*[-*]\s+/, '').trim()).filter(Boolean);
    return `<ul class="ai-ul">${items.map(it => `<li class="ai-li">${it}</li>`).join('')}</ul>`;
  });

  // Ordered lists
  text = text.replace(/(?:^|\n)((?:[ \t]*\d+\.\s+[^\n]+\r?\n?)+)/g, (_, listText) => {
    const items = listText.trim().split(/\r?\n/).map(l => l.replace(/^[ \t]*\d+\.\s+/, '').trim()).filter(Boolean);
    return `<ol class="ai-ol">${items.map(it => `<li class="ai-li">${it}</li>`).join('')}</ol>`;
  });

  // Convert Citation Badges [P1], [P2], [P1-E1], [R1] to clickable chips
  text = text.replace(/\[((?:P|R)\d+(?:-E\d+)?)\]/g, '<button type="button" class="cite-pill" data-cite="$1" title="View citation $1">[$1]</button>');

  // Restore inline code & code blocks
  inlineCodes.forEach((codeHtml, i) => {
    text = text.replace(`__INLINE_CODE_${i}__`, codeHtml);
  });
  codeBlocks.forEach((blockHtml, i) => {
    text = text.replace(`__CODE_BLOCK_${i}__`, blockHtml);
  });

  // Linebreaks outside of HTML tags
  text = text.split('\n\n').map(p => {
    p = p.trim();
    if (!p) return '';
    if (p.startsWith('<div') || p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<ol') || p.startsWith('<blockquote') || p.startsWith('<pre') || p.startsWith('<hr')) {
      return p;
    }
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return text;
}

function bindCitations(container) {
  if (!container) return;
  container.querySelectorAll('.cite-pill').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const cite = pill.dataset.cite;
      const target = document.querySelector(`[data-source-cite="${cite}"]`) || $(`source-${cite}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('highlight-flash');
        void target.offsetWidth;
        target.classList.add('highlight-flash');
      }
    });
  });
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

const LOCAL_STORAGE_HISTORY_KEY = 'atlas_search_history';

function getSearchHistory() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function saveSearchHistory(topic, papers, stats = null) {
  if (!topic || !String(topic).trim()) return;
  const cleanTopic = String(topic).trim();
  try {
    const history = getSearchHistory().filter(
      (item) => item.topic.toLowerCase() !== cleanTopic.toLowerCase()
    );
    const entry = {
      topic: cleanTopic,
      timestamp: Date.now(),
      dateStr: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      count: Array.isArray(papers) ? papers.length : 0,
      papers: Array.isArray(papers) ? papers : [],
      stats: stats || null,
    };
    history.unshift(entry);
    const capped = history.slice(0, 10);
    localStorage.setItem(LOCAL_STORAGE_HISTORY_KEY, JSON.stringify(capped));
    renderSearchHistory();
  } catch (err) {
    console.warn('Could not save to localStorage:', err);
  }
}

function renderSearchHistory() {
  const container = $('saved-topics-chips');
  const clearBtn = $('clear-history-btn');
  if (!container) return;
  const history = getSearchHistory();

  if (!history.length) {
    container.innerHTML = '<span class="history-empty">No previous topics saved in localhost yet. Discover topics to save sessions.</span>';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }

  if (clearBtn) clearBtn.style.display = 'inline-block';
  container.innerHTML = history.map((item, idx) => {
    const isCurrent = $('topic') && $('topic').value.toLowerCase().trim() === item.topic.toLowerCase().trim();
    return `<button type="button" class="saved-topic-chip${isCurrent ? ' active-topic' : ''}" data-history-idx="${idx}" title="Open saved search: ${escapeHtml(item.topic)} (${item.count} papers · ${item.dateStr || ''})">
      <span class="chip-dot"></span>
      <span class="chip-name">${escapeHtml(item.topic)}</span>
      <span class="chip-count">${item.count}p</span>
    </button>`;
  }).join('');

  container.querySelectorAll('.saved-topic-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const idx = Number(chip.dataset.historyIdx);
      const item = history[idx];
      if (!item) return;
      restoreSearchSession(item);
    });
  });
}

function restoreSearchSession(item) {
  $('topic').value = item.topic;
  $('question').value = `Which approaches to ${item.topic} have been explored, what are their limitations, and which papers discuss related solutions?`;

  if (Array.isArray(item.papers) && item.papers.length > 0) {
    renderPapers(item.papers);
    focusPaper(item.papers[0].openalex_id);
    setMessage('discover-message', `Restored "${item.topic}" from local storage (${item.papers.length} papers saved locally).`);
  } else {
    setMessage('discover-message', `Selected saved topic "${item.topic}". Click "Build graph" to discover fresh papers.`);
  }

  renderSearchHistory();
  $('discover-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderInspectorDefault() {
  const quickList = $('inspector-quick-list');
  if (!quickList) return;

  if (!state.papers || !state.papers.length) {
    quickList.innerHTML = '<div class="inspector-quick-empty">No papers loaded in graph yet. Enter a topic above to discover papers and explore entities.</div>';
    return;
  }

  quickList.innerHTML = state.papers.map((paper, idx) => {
    const isSelected = state.selectedPaperId === paper.openalex_id;
    return `<div class="inspector-hub-card${isSelected ? ' active' : ''}" data-hub-paper="${escapeHtml(paper.openalex_id)}">
      <div class="hub-card-top">
        <span class="hub-paper-idx">#${idx + 1}</span>
        <span class="hub-paper-meta">${paper.year || 'Year ?'} · ${paper.cited_by_count || 0} cites</span>
      </div>
      <h4 class="hub-paper-title">${escapeHtml(paper.title)}</h4>
      <p class="hub-paper-authors">${escapeHtml((paper.authors || []).slice(0, 2).join(', ') || 'Authors not listed')}</p>
      <div class="hub-card-actions">
        <button type="button" class="hub-action-btn view-graph-btn" data-hub-trace="${escapeHtml(paper.openalex_id)}">View in graph ↗</button>
        <button type="button" class="hub-action-btn open-studio-btn" data-hub-studio="${escapeHtml(paper.openalex_id)}">Open Studio ✦</button>
      </div>
    </div>`;
  }).join('');

  quickList.querySelectorAll('[data-hub-trace]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const openalexId = btn.dataset.hubTrace;
      const node = state.graph.nodes.find((n) => n.external_id === openalexId);
      if (node) {
        selectNode(node.id);
        $('graph-stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  quickList.querySelectorAll('[data-hub-studio]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const openalexId = btn.dataset.hubStudio;
      openPaperWorkspace(openalexId);
    });
  });

  quickList.querySelectorAll('.inspector-hub-card').forEach((card) => {
    card.addEventListener('click', () => {
      const openalexId = card.dataset.hubPaper;
      focusPaper(openalexId);
    });
  });
}

function renderInspector(node) {
  const defaultView = $('inspector-default');
  const contentView = $('inspector-content');

  if (!node) {
    if (defaultView) defaultView.hidden = false;
    if (contentView) {
      contentView.hidden = true;
      contentView.innerHTML = '';
    }
    renderInspectorDefault();
    return;
  }

  if (defaultView) defaultView.hidden = true;
  if (!contentView) return;
  contentView.hidden = false;

  const props = node.properties || {};
  const type = node.type || 'Entity';
  const paper = type === 'Paper';
  const title = props.title || props.name || props.statement || node.label;
  const chips = [];
  if (props.year) chips.push(String(props.year));
  if (props.cited_by_count !== undefined) chips.push(`${props.cited_by_count} citations`);
  if (props.openalex_id) chips.push(props.openalex_id);
  const url = safeUrl(props.url || props.doi);

  contentView.innerHTML = `
    <button type="button" class="inspector-back-btn" id="inspector-back">← Back to Paper Navigator</button>
    <div class="inspector-top">
      <div>
        <span class="type-label">${escapeHtml(type.toUpperCase())}</span>
        <h2 class="inspector-title">${escapeHtml(title)}</h2>
      </div>
      <span class="node-key">${escapeHtml(node.id.split(':').pop())}</span>
    </div>
    <div class="inspector-props">${chips.map((chip) => `<span class="prop-chip">${escapeHtml(chip)}</span>`).join('')}</div>
    <button class="expand-button" id="expand-node">Expand connected evidence <span>↗</span></button>
    ${paper && props.openalex_id ? '<button class="expand-button studio-button" id="open-paper">Open paper studio <span>✦</span></button>' : ''}
    ${url ? `<a class="inspector-link" href="${url}" target="_blank" rel="noreferrer">Open source paper ↗</a>` : ''}
    ${paper && props.abstract ? `<div class="inspector-rule"></div><span class="inspector-section-label">ABSTRACT</span><p class="inspector-abstract">${escapeHtml(props.abstract)}</p>` : ''}
    <div class="inspector-rule"></div><span class="inspector-section-label">LOADED RELATIONSHIPS</span><div class="relation-list">${relationSummary(node.id)}</div>`;

  $('inspector-back').addEventListener('click', () => {
    state.selected = null;
    renderGraph();
    renderInspector(null);
  });
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

function updateStudioSelect() {
  const select = $('studio-paper-select');
  if (!select) return;
  select.innerHTML = '<option value="">Select a paper to inspect…</option>' +
    state.papers.map((p) => `<option value="${escapeHtml(p.openalex_id)}">${escapeHtml(shortText(p.title, 42))} (${p.year || 'Year unknown'})</option>`).join('');
  if (state.selectedPaperId) select.value = state.selectedPaperId;
}

function updateCompareToolbar() {
  const checked = document.querySelectorAll('.compare-check:checked');
  const count = checked.length;
  $('compare-selection-count').textContent = `${count} of 4 papers selected`;
  $('compare-button').disabled = count < 2;
}

function filterPaperItems(query) {
  const list = $('paper-list');
  if (!list) return;
  const q = String(query || '').toLowerCase().trim();
  const filtered = q
    ? state.papers.filter((p) => {
        const title = (p.title || '').toLowerCase();
        const authors = (p.authors || []).join(' ').toLowerCase();
        const abstract = (p.abstract || '').toLowerCase();
        const keywords = (p.keywords || []).join(' ').toLowerCase();
        return title.includes(q) || authors.includes(q) || abstract.includes(q) || keywords.includes(q);
      })
    : state.papers;

  $('collection-count').textContent = q ? `${filtered.length} of ${state.papers.length}` : state.papers.length;

  list.innerHTML = filtered.length ? filtered.map((paper) => {
    const url = safeUrl(paper.url);
    const pdf = safeUrl(paper.pdf_url);
    const isActive = state.selectedPaperId === paper.openalex_id ? ' active-paper' : '';
    return `<article class="paper-item${isActive}" data-paper-id="${escapeHtml(paper.openalex_id)}">
      <label title="Select for comparison" onclick="event.stopPropagation()">
        <input class="compare-check" type="checkbox" value="${escapeHtml(paper.openalex_id)}" />
      </label>
      <div class="paper-info-wrap">
        <span class="paper-meta">${paper.year || 'YEAR UNKNOWN'} · ${escapeHtml(paper.type || 'work')} · ${paper.cited_by_count || 0} CITATIONS</span>
        <h3>${escapeHtml(paper.title)}</h3>
        <p>${escapeHtml((paper.authors || []).slice(0, 2).join(', ') || 'Authors not listed')}</p>
        <p class="paper-abstract">${escapeHtml(shortText(paper.abstract || 'Abstract not available.', 240))}</p>
        <div class="paper-links-wrap" onclick="event.stopPropagation()">
          ${url ? `<a class="paper-link" href="${url}" target="_blank" rel="noreferrer">Metadata ↗</a>` : ''}
          ${pdf ? ` <a class="paper-link" href="${pdf}" target="_blank" rel="noreferrer">PDF ↗</a>` : ''}
        </div>
      </div>
      <button class="trace-button" data-trace-id="${escapeHtml(paper.openalex_id)}" title="Show this paper in the graph" onclick="event.stopPropagation()">↗</button>
    </article>`;
  }).join('') : '<div class="list-empty">No papers match your filter search.</div>';

  list.querySelectorAll('.paper-item').forEach((item) => {
    item.addEventListener('click', () => {
      const openalexId = item.dataset.paperId;
      if (openalexId) focusPaper(openalexId);
    });
  });

  list.querySelectorAll('[data-trace-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.traceId;
      const node = state.graph.nodes.find((n) => n.external_id === id);
      if (node) {
        selectNode(node.id);
        $('graph-stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  list.querySelectorAll('.compare-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const checked = document.querySelectorAll('.compare-check:checked');
      if (checked.length > 4) {
        checkbox.checked = false;
        alert('You can compare up to 4 papers at once.');
      }
      updateCompareToolbar();
    });
  });
}

function renderPapers(papers) {
  state.papers = papers || [];
  const filterInput = $('paper-filter-input');
  if (filterInput) filterInput.value = '';
  filterPaperItems('');
  updateStudioSelect();
  updateCompareToolbar();
  if (!state.selected) renderInspectorDefault();
}

function focusPaper(openalexId) {
  const node = state.graph.nodes.find((candidate) => candidate.external_id === openalexId);
  if (node) selectNode(node.id);
  openPaperWorkspace(openalexId);
}

function listMarkup(items) {
  if (!Array.isArray(items) || !items.length) return '<p>No explicit evidence was extracted for this section.</p>';
  return `<ul class="ai-ul">${items.map((item) => {
    const raw = typeof item === 'string' ? item : (item.explanation || '');
    return `<li class="ai-li">${formatAiMarkdown(raw)}</li>`;
  }).join('')}</ul>`;
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

  // Trace in graph button
  $('studio-trace-graph').onclick = () => {
    const node = state.graph.nodes.find((n) => n.external_id === paper.openalex_id);
    if (node) {
      selectNode(node.id);
      $('graph-stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

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

  // 3-Card Summary Overview
  $('studio-summary-text').innerHTML = formatAiMarkdown(insights.summary || 'Summary not available yet.');
  $('studio-problem-text').innerHTML = formatAiMarkdown(insights.problem || 'Problem statement not explicitly identified.');
  $('studio-why-matters-text').innerHTML = formatAiMarkdown(insights.why_it_matters || 'Impact summary not available.');
  bindCitations($('studio-summary-cards'));

  // 6-Card Insight Matrix
  const cards = [
    ['WHAT WAS DONE', 'what_was_done', 'done'],
    ['HOW IT WORKS', 'how_it_works', 'done'],
    ['LIMITATIONS', 'limitations', 'left'],
    ['WHAT IS LEFT', 'what_is_left', 'left'],
    ['WHAT YOU CAN DO', 'what_you_can_do', 'try'],
    ['HOW TO IMPROVE IT', 'improvement_ideas', 'improve'],
  ];
  $('insight-grid').innerHTML = cards.map(([title, key, color]) => `<div class="insight-box ${color}"><h4>${title}</h4>${listMarkup(insights[key])}</div>`).join('');
  bindCitations($('insight-grid'));

  // Hard Terms
  const terms = Array.isArray(insights.hard_terms) ? insights.hard_terms : [];
  $('term-count-badge').textContent = `${terms.length} terms`;
  $('hard-terms').innerHTML = terms.length ? terms.map((term) => `<div class="term-item"><b>${escapeHtml(term.term || '')}</b><p>${escapeHtml(term.explanation || '')}</p></div>`).join('') : '<p class="inspector-abstract">No difficult terms were extracted yet.</p>';

  $('chat-messages').innerHTML = '';
  updateStudioSelect();

  document.querySelectorAll('.paper-item').forEach((it) => {
    it.classList.toggle('active-paper', it.dataset.paperId === paper.openalex_id);
  });
  renderInspectorDefault();
}

async function openPaperWorkspace(openalexId) {
  state.selectedPaperId = openalexId;
  const select = $('studio-paper-select');
  if (select) select.value = openalexId;

  $('paper-studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('studio-empty').style.display = 'flex';
  $('studio-empty').innerHTML = '<span class="studio-icon">◌</span><b>Reading the paper and connected knowledge graph…</b><span>Synthesizing plain-language analysis, limitations, and actionable improvements.</span>';
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
  bubble.innerHTML = formatAiMarkdown(text);
  bindCitations(bubble);
  $('chat-messages').appendChild(bubble);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function renderComparison(result) {
  state.comparisonResult = result;
  const papers = result.papers || [];

  // Populate comparison section
  const section = $('comparison-section');
  section.hidden = false;

  // Render Paper Chips
  $('comparison-papers-row').innerHTML = papers.map((p) => {
    const pdf = safeUrl(p.pdf_url);
    const url = safeUrl(p.url || p.doi);
    return `<div class="comparison-paper-chip" data-source-cite="${escapeHtml(p.citation)}" id="source-${escapeHtml(p.citation)}">
      <span class="cite-tag">[${escapeHtml(p.citation)}]</span>
      <h4>${escapeHtml(p.title)}</h4>
      <p>${escapeHtml((p.authors || []).slice(0, 3).join(', '))} · ${p.year || 'Year unknown'} · ${p.cited_by_count || 0} citations</p>
      ${pdf ? `<a class="paper-link" href="${pdf}" target="_blank" rel="noreferrer">Open PDF ↗</a>` : (url ? `<a class="paper-link" href="${url}" target="_blank" rel="noreferrer">Open Metadata ↗</a>` : '')}
    </div>`;
  }).join('');

  // Render Metric Summary Banner
  const totalPapers = papers.length;
  const years = papers.map((p) => Number(p.year)).filter((y) => !isNaN(y) && y > 1900);
  const minYear = years.length ? Math.min(...years) : '—';
  const maxYear = years.length ? Math.max(...years) : '—';
  const yearSpan = minYear === maxYear ? String(minYear) : `${minYear} – ${maxYear}`;
  const totalCitations = papers.reduce((acc, p) => acc + (Number(p.cited_by_count) || 0), 0);
  const avgCitations = totalPapers ? Math.round(totalCitations / totalPapers) : 0;

  const banner = $('comparison-summary-banner');
  if (banner) {
    banner.innerHTML = `
      <div class="comp-stat-card">
        <span class="comp-stat-num">${totalPapers}</span>
        <span class="comp-stat-lbl">Papers Compared</span>
      </div>
      <div class="comp-stat-card">
        <span class="comp-stat-num">${yearSpan}</span>
        <span class="comp-stat-lbl">Publication Span</span>
      </div>
      <div class="comp-stat-card">
        <span class="comp-stat-num">${totalCitations.toLocaleString()}</span>
        <span class="comp-stat-lbl">Aggregate Citations</span>
      </div>
      <div class="comp-stat-card">
        <span class="comp-stat-num">${avgCitations}</span>
        <span class="comp-stat-lbl">Avg Impact / Paper</span>
      </div>
      <div class="comp-stat-card comp-stat-highlight">
        <span class="comp-stat-num">Full Study</span>
        <span class="comp-stat-lbl">Deep Architectural Synthesis</span>
      </div>
    `;
  }

  $('comparison-markdown-view').innerHTML = `<div class="ai-formatted-content">${formatAiMarkdown(result.answer || '', papers)}</div>`;
  bindCitations($('comparison-markdown-view'));

  // Update sidebar compare-output with quick button
  $('compare-output').innerHTML = `<div class="source-card">
    <b>Comparison matrix ready for ${papers.length} papers</b>
    <button type="button" id="view-matrix-btn" style="color:var(--green);font-weight:bold;margin-top:5px;cursor:pointer;">View full comparison study ↗</button>
  </div>`;
  $('view-matrix-btn').onclick = () => section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAnswer(result) {
  const sources = result.sources || [];
  const sourceCards = sources.map((source) => {
    const url = safeUrl(source.url || source.doi);
    return `<div class="source-card" data-source-cite="${escapeHtml(source.citation)}" id="source-${escapeHtml(source.citation)}">
      <b>[${escapeHtml(source.citation)}] ${escapeHtml(source.title)}</b>
      ${escapeHtml((source.authors || []).slice(0, 3).join(', '))} · ${source.year || 'year unknown'} · ${source.cited_by_count || 0} citations
      ${url ? `<br><a href="${url}" target="_blank" rel="noreferrer">Open paper ↗</a>` : ''}
      ${source.graph_id ? `<button type="button" data-source-id="${escapeHtml(source.graph_id)}">Trace in graph ↗</button>` : ''}
    </div>`;
  }).join('');

  $('answer-toolbar').hidden = false;
  $('answer').innerHTML = `<div class="ai-formatted-content">${formatAiMarkdown(result.answer || '', sources)}</div>${sourceCards ? `<div class="source-list">${sourceCards}</div>` : ''}`;
  bindCitations($('answer'));

  document.querySelectorAll('[data-source-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectNode(button.dataset.sourceId);
      $('graph-stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // Copy Answer button
  $('copy-answer-btn').onclick = () => {
    navigator.clipboard.writeText(result.answer || '').then(() => {
      $('copy-answer-btn').textContent = 'Copied!';
      setTimeout(() => { $('copy-answer-btn').textContent = 'Copy Answer'; }, 2000);
    });
  };
}

async function loadState() {
  try {
    const [health, stats, papers] = await Promise.all([
      request('/api/health'),
      request('/api/stats'),
      request('/api/papers').catch(() => []),
    ]);

    const status = $('status');
    status.title = health.connection_message || '';
    status.innerHTML = `<span class="pulse"></span><span>${health.neo4j ? (health.llm ? 'Neo4j + AI connected' : 'Neo4j connected · fallback AI') : 'Aura connection needs attention'}</span>`;
    status.classList.add(health.neo4j ? 'ready' : 'warn');

    renderStats(stats);
    renderPapers(papers);
    await loadGraph();

    // Initialize search history from local storage
    renderSearchHistory();
    const history = getSearchHistory();
    if (!history.length && papers && papers.length > 0) {
      // Auto-save existing papers session under 'agent memory' so user can see it right away
      saveSearchHistory('agent memory', papers, stats);
    }

    // If papers exist in DB, automatically load the first one into Paper Studio!
    if (papers && papers.length > 0 && !state.selectedPaperId) {
      openPaperWorkspace(papers[0].openalex_id);
    }
  } catch (_) {
    $('status').innerHTML = '<span class="pulse"></span><span>Service unavailable</span>';
    $('status').classList.add('warn');
    renderGraph();
    renderSearchHistory();
  }
}

// Event Listeners
$('discover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  const topicVal = $('topic').value.trim();
  setMessage('discover-message', 'Searching OpenAlex, extracting research entities, and mapping the graph…');
  try {
    const result = await request('/api/discover', { method: 'POST', body: JSON.stringify({ topic: topicVal, limit: Number($('limit').value) }) });
    renderPapers(result.papers);
    renderStats(result.stats);
    // Save to local storage
    saveSearchHistory(topicVal, result.papers, result.stats);

    if (result.stored) {
      await loadGraph(true);
      if (result.papers && result.papers[0]) openPaperWorkspace(result.papers[0].openalex_id);
      setMessage('discover-message', `${result.count} real papers connected in Neo4j and saved locally. Select a node or paper to explore.`);
    } else {
      setMessage('discover-message', `${result.count} real OpenAlex papers loaded for preview and saved locally. Neo4j storage is waiting: ${result.storage_message}`, true);
    }
  } catch (error) { setMessage('discover-message', error.message, true); }
  button.disabled = false;
});

$('ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  $('answer').innerHTML = '';
  $('answer-toolbar').hidden = true;
  setMessage('ask-message', 'Retrieving connected evidence and synthesizing a cited answer…');
  try {
    const result = await request('/api/ask', { method: 'POST', body: JSON.stringify({ question: $('question').value }) });
    renderAnswer(result);
    setMessage('ask-message', result.used_llm ? 'Answer synthesized with configured AI and grounded in Neo4j evidence.' : 'Answer grounded with graph metadata fallback.');
  } catch (error) { setMessage('ask-message', error.message, true); }
  button.disabled = false;
});

document.querySelectorAll('[data-topic]').forEach((button) => button.addEventListener('click', () => {
  $('topic').value = button.dataset.topic;
  $('question').value = `Which approaches to ${button.dataset.topic} have been explored, what are their limitations, and which papers discuss related solutions?`;
  $('discover-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}));

$('start-usecase').addEventListener('click', () => {
  $('topic').value = 'agent memory';
  $('question').value = 'Which approaches to agent memory have been explored, what are their limitations, and which papers discuss related solutions?';
  $('discover-form').requestSubmit();
});

// Clear history button
const clearHistBtn = $('clear-history-btn');
if (clearHistBtn) {
  clearHistBtn.addEventListener('click', () => {
    localStorage.removeItem(LOCAL_STORAGE_HISTORY_KEY);
    renderSearchHistory();
    setMessage('discover-message', 'Saved search history cleared from local storage.');
  });
}

// Paper live filter
const paperFilterInput = $('paper-filter-input');
if (paperFilterInput) {
  paperFilterInput.addEventListener('input', (e) => {
    filterPaperItems(e.target.value);
  });
}

// Research Prompt Pills (Question templates)
document.querySelectorAll('.template-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    $('question').value = pill.dataset.prompt;
    $('question').focus();
    $('ask-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

$('graph-filter').addEventListener('change', renderGraph);
$('refresh-graph').addEventListener('click', () => loadGraph(true));

// Paper Studio Select Change
$('studio-paper-select').addEventListener('change', (e) => {
  if (e.target.value) openPaperWorkspace(e.target.value);
});

// Chat form
$('paper-chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selectedPaperId) return;
  const input = $('paper-chat-question');
  const question = input.value.trim();
  if (!question) return;
  const button = event.target.querySelector('button');
  addChatBubble('user', question);
  input.value = '';
  button.disabled = true;
  setMessage('paper-chat-message', 'Synthesizing response grounded in paper abstract & graph evidence…');
  try {
    const result = await request(`/api/papers/${encodeURIComponent(state.selectedPaperId)}/chat`, { method: 'POST', body: JSON.stringify({ question }) });
    addChatBubble('bot', result.answer || 'No answer returned.');
    setMessage('paper-chat-message', result.used_llm ? 'Grounded AI answer.' : 'Fallback response.');
  } catch (error) {
    addChatBubble('bot', error.message);
    setMessage('paper-chat-message', 'The paper chatbot could not answer.', true);
  }
  button.disabled = false;
});

// Quick prompt pills for Chatbot
document.querySelectorAll('.prompt-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    $('paper-chat-question').value = pill.dataset.prompt;
    $('paper-chat-form').requestSubmit();
  });
});

// Evidence form
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
    setMessage('evidence-message', 'Excerpt attached. Reloading reading guide with citation tag.');
    await openPaperWorkspace(state.selectedPaperId);
  } catch (error) { setMessage('evidence-message', error.message, true); }
  button.disabled = false;
});

// Document Upload
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

// Compare Actions
$('select-top-two').addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.compare-check');
  checkboxes.forEach((cb, idx) => { cb.checked = idx < 2; });
  updateCompareToolbar();
});

$('compare-button').addEventListener('click', async () => {
  const selected = [...document.querySelectorAll('.compare-check:checked')].map((input) => input.value);
  if (selected.length < 2) { alert('Select at least two papers to compare.'); return; }
  const button = $('compare-button');
  button.disabled = true;
  button.textContent = 'Comparing…';
  $('compare-output').textContent = 'Synthesizing systematic comparison across approaches, datasets, and limitations…';
  try {
    const result = await request('/api/compare', {
      method: 'POST',
      body: JSON.stringify({
        openalex_ids: selected,
        question: 'Compare their approaches, architectures, experimental metrics, limitations, and key differentiators. Include a comprehensive markdown comparison table.'
      })
    });
    renderComparison(result);
  } catch (error) {
    $('compare-output').textContent = error.message;
  }
  button.disabled = false;
  button.innerHTML = 'Compare Selected <span>↗</span>';
});

// Close Comparison view
$('close-comparison-btn').addEventListener('click', () => {
  $('comparison-section').hidden = true;
});

// Copy Comparison Markdown
$('copy-comparison-btn').addEventListener('click', () => {
  if (state.comparisonResult && state.comparisonResult.answer) {
    navigator.clipboard.writeText(state.comparisonResult.answer).then(() => {
      $('copy-comparison-btn').textContent = 'Copied!';
      setTimeout(() => { $('copy-comparison-btn').textContent = 'Copy Markdown'; }, 2000);
    });
  }
});

// Initial boot
loadState();
