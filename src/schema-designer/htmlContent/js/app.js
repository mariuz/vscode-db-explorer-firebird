(function () {
  const vscode = acquireVsCodeApi();
  const SVG_NS = "http://www.w3.org/2000/svg";

  const el = {
    canvas: document.getElementById("canvas"),
    viewport: document.getElementById("viewport"),
    edgesLayer: document.getElementById("edges"),
    nodesLayer: document.getElementById("nodes"),
    minimap: document.getElementById("minimap"),
    minimapNodes: document.getElementById("minimap-nodes"),
    minimapViewport: document.getElementById("minimap-viewport"),
    loading: document.getElementById("loading"),
    loadingText: document.getElementById("loading-text"),
    errorBanner: document.getElementById("error-banner"),
    emptyBanner: document.getElementById("empty-banner"),
    status: document.getElementById("status"),
    btnAddTable: document.getElementById("btn-add-table"),
    btnRefresh: document.getElementById("btn-refresh"),
    btnAutoLayout: document.getElementById("btn-auto-layout"),
    btnFit: document.getElementById("btn-fit"),
    btnSchemaLegend: document.getElementById("btn-schema-legend"),
    schemaLegend: document.getElementById("schema-legend"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
    generateBtn: document.getElementById("generateBtn"),
    executeBtn: document.getElementById("executeBtn"),
    ddlOutput: document.getElementById("ddl-output"),
    inspector: document.getElementById("inspector"),
    inspectorHeading: document.getElementById("inspector-heading"),
    tableNameInput: document.getElementById("tableName"),
    columnsBody: document.getElementById("columnsBody"),
    addColumnBtn: document.getElementById("addColumnBtn"),
    closeInspectorBtn: document.getElementById("closeInspectorBtn"),
    btnAskCopilot: document.getElementById("btn-ask-copilot"),
    copilotPanel: document.getElementById("copilot-panel"),
    copilotInstruction: document.getElementById("copilot-instruction"),
    copilotSend: document.getElementById("copilot-send"),
    copilotClose: document.getElementById("copilot-close"),
    copilotStatus: document.getElementById("copilot-status"),
  };

  const ROW_HEIGHT = 18;
  const HEADER_HEIGHT = 24;
  const COL_PADDING = 10;
  const MIN_NODE_WIDTH = 150;
  const MIN_SCALE = 0.15;
  const MAX_SCALE = 3;
  const TYPES = ['VARCHAR', 'CHAR', 'INTEGER', 'SMALLINT', 'INT64', 'FLOAT', 'DOUBLE', 'DATE', 'TIME', 'TIMESTAMP', 'BLOB', 'BOOLEAN'];
  const SIZED_TYPES = ['VARCHAR', 'CHAR', 'CSTRING'];

  // ── Editable schema state ────────────────────────────────────────────────
  //
  // draftGraph is the *sole* source of truth for both rendering and DDL generation — unlike the
  // single-table designer this replaces (which read the DOM directly at DDL-generation time,
  // safe there because only one table's rows were ever in the DOM at once). With N tables and
  // only one inspector panel visible at a time, the inspector is a transient view: populated
  // from the selected table's entry in draftGraph.tables, and every field writes straight back
  // into that same object on change — draftGraph is never reconstructed from the DOM.
  //
  // Tables carry a stable synthetic `id` (never derived from the name) because a new table's
  // name is editable — a relationship keyed by name would silently go stale the moment that
  // table gets renamed. Relationships reference columns by direct object identity (`fromColumn`/
  // `toColumn` point at the actual column object inside some table's `columns` array), which
  // sidesteps the same staleness risk for column renames (also editable, on any table) without
  // needing a parallel id scheme for columns too.
  let draftGraph = { tables: [], relationships: [] };
  let nextTableId = 0;
  let selectedTableId = null;
  let selectedRelationship = null;
  /** tableId -> { x, y, width, height } */
  let positions = {};
  /** tableId -> primary key constraint name, for tables that have one. */
  let pkConstraintNames = {};
  /** Every constraint name seen when the schema was (last) loaded, for detecting deleted edges. */
  let originalConstraintNames = new Set();
  /** constraintName -> the table id that HELD that foreign key (the "from"/child side), captured
   *  at load time since a deleted relationship no longer has this once removed from draftGraph. */
  let originalFromTableByConstraint = {};
  /** { addNewTable?: boolean, focusTable?: string } from the extension's "init" message — applied
   *  once the first schemaData arrives, whichever comes first. */
  let pendingInit = null;

  const view = { x: 0, y: 0, scale: 1 };

  /** Shown before the extension host reports a stage, and again whenever a refresh restarts. */
  const DEFAULT_LOADING_TEXT = "Loading schema…";

  function setLoadingText(text) {
    // Writes the text node beside the spinner rather than the container's own textContent, which
    // would replace the spinner element along with the caption.
    if (el.loadingText) { el.loadingText.textContent = text; }
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  window.addEventListener("message", event => {
    const msg = event.data;
    if (msg.command === "schemaData") { handleSchemaData(msg.data); return; }
    if (msg.command === "schemaProgress") { handleSchemaProgress(msg.data); return; }
    if (msg.command === "result") { appendResult(msg.data.text); return; }
    if (msg.command === "init") { pendingInit = msg.data; return; }
    if (msg.command === "copilotSchemaEdit") { handleCopilotSchemaEdit(msg.data); return; }
  });

  vscode.postMessage({ command: "ready" });
  vscode.postMessage({ command: "getData" });

  function requestRefresh() {
    setStatus("Refreshing…");
    setLoadingText(DEFAULT_LOADING_TEXT);
    // "flex", not "block": the placeholder lays the spinner out beside the caption, and an inline
    // display:block would override that rule and drop the spinner onto its own line.
    el.loading.style.display = "flex";
    el.errorBanner.style.display = "none";
    vscode.postMessage({ command: "refresh" });
  }

  el.btnRefresh.addEventListener("click", () => {
    if (buildDDL() !== "-- No changes detected." && !confirmDiscard()) { return; }
    requestRefresh();
  });

  function confirmDiscard() {
    // window.confirm() works inside a VS Code webview; if the environment ever blocks it, this
    // just falls through to "true" (proceed) rather than throwing.
    try {
      return window.confirm("You have unsaved changes on the canvas. Discard them and refresh from the database?");
    } catch {
      return true;
    }
  }

  // ── Loading schema into draftGraph ───────────────────────────────────────

  function escAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Replaces the loading caption as the extension host reaches each stage of the fetch.
   *
   * Deliberately does *not* re-show the placeholder if it has been hidden: a stray progress
   * message arriving after schemaData — a refresh racing a previous load — would otherwise throw
   * a "Loading…" overlay back over a diagram that is already on screen.
   */
  function handleSchemaProgress(data) {
    if (el.loading.style.display === "none") { return; }
    setLoadingText((data && data.text) || DEFAULT_LOADING_TEXT);
  }

  function handleSchemaData(data) {
    el.loading.style.display = "none";

    if (data.error) {
      el.errorBanner.textContent = data.error;
      el.errorBanner.style.display = "block";
      el.emptyBanner.style.display = "none";
      return;
    }
    el.errorBanner.style.display = "none";

    const graph = data.graph;

    // Preserve on-canvas positions for tables that survive a refresh, keyed by name since ids
    // are re-minted on every load.
    const previousPositionsByName = {};
    draftGraph.tables.forEach(t => { if (positions[t.id]) { previousPositionsByName[t.name] = positions[t.id]; } });

    positions = {};
    const idByName = new Map();
    draftGraph.tables = (graph.tables || []).map(t => {
      const id = 't' + (nextTableId++);
      idByName.set(t.name, id);
      if (previousPositionsByName[t.name]) { positions[id] = previousPositionsByName[t.name]; }
      const originalColumns = t.columns.map(c => ({
        name: c.name, type: c.type, length: c.length, notNull: c.notNull, isPrimaryKey: c.isPrimaryKey, dflt: c.dflt,
      }));
      const columns = t.columns.map((c, i) => ({
        name: c.name, type: c.type, length: c.length, notNull: c.notNull, isPrimaryKey: c.isPrimaryKey, dflt: c.dflt,
        original: originalColumns[i],
      }));
      // `name` stays the qualified identity (it is what DDL and relationship endpoints use);
      // `displayName` is only what the box shows — see SchemaTable in schema-graph.ts.
      return { id, name: t.name, displayName: t.displayName, schema: t.schema, isNew: false, columns, originalColumns };
    });

    pkConstraintNames = {};
    Object.keys(data.pkConstraintNames || {}).forEach(tableName => {
      const id = idByName.get(tableName);
      if (id) { pkConstraintNames[id] = data.pkConstraintNames[tableName]; }
    });

    originalConstraintNames = new Set();
    originalFromTableByConstraint = {};
    draftGraph.relationships = (graph.relationships || []).map(r => {
      const fromTableId = idByName.get(r.table);
      const toTableId = idByName.get(r.refTable);
      originalConstraintNames.add(r.constraintName);
      originalFromTableByConstraint[r.constraintName] = fromTableId;
      const fromTable = draftGraph.tables.find(t => t.id === fromTableId);
      const toTable = draftGraph.tables.find(t => t.id === toTableId);
      const fromColumn = fromTable && fromTable.columns.find(c => c.name === r.column);
      const toColumn = toTable && toTable.columns.find(c => c.name === r.refColumn);
      return { constraintName: r.constraintName, fromTableId, fromColumn, toTableId, toColumn };
    }).filter(r => r.fromTableId && r.toTableId && r.fromColumn && r.toColumn);

    selectedTableId = null;
    selectedRelationship = null;
    closeInspector();

    if (draftGraph.tables.length === 0) {
      el.emptyBanner.style.display = "block";
      clearDiagram();
    } else {
      el.emptyBanner.style.display = "none";
      measureAll();
      const newTableIds = draftGraph.tables.filter(t => !positions[t.id]).map(t => t.id);
      if (newTableIds.length > 0) {
        runAutoLayout(Object.keys(previousPositionsByName).length > 0 ? newTableIds : null);
      }
      render();
      fitToView();
    }
    setStatus(`${draftGraph.tables.length} table(s), ${draftGraph.relationships.length} relationship(s)`);
    applyPendingInit();
  }

  function applyPendingInit() {
    if (!pendingInit) { return; }
    const init = pendingInit;
    pendingInit = null;
    if (init.addNewTable) {
      addTable();
    } else if (init.focusTable) {
      const table = draftGraph.tables.find(t => t.name === init.focusTable);
      if (table) { selectTable(table.id); centerOnTable(table.id); }
    }
  }

  function clearDiagram() {
    el.nodesLayer.innerHTML = "";
    el.edgesLayer.innerHTML = "";
    el.minimapNodes.innerHTML = "";
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────

  function measureTextWidth(text, className) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", className);
    t.textContent = text;
    t.style.visibility = "hidden";
    el.nodesLayer.appendChild(t);
    const width = t.getBBox().width;
    el.nodesLayer.removeChild(t);
    return width;
  }

  function columnLabel(col) {
    return col.isPrimaryKey ? `🔑 ${col.name || '(unnamed)'}` : (col.name || '(unnamed)');
  }

  function columnTypeLabel(col) {
    return (col.length && SIZED_TYPES.includes(col.type)) ? `${col.type}(${col.length})` : col.type;
  }

  function measureAll() {
    draftGraph.tables.forEach(table => {
      let maxWidth = measureTextWidth(tableTitle(table), "fb-table-header-text") + 24;
      table.columns.forEach(col => {
        const w =
          measureTextWidth(columnLabel(col), "fb-col-text") +
          measureTextWidth(columnTypeLabel(col), "fb-col-type") +
          COL_PADDING * 3;
        if (w > maxWidth) { maxWidth = w; }
      });
      const width = Math.max(MIN_NODE_WIDTH, Math.ceil(maxWidth));
      const height = HEADER_HEIGHT + Math.max(1, table.columns.length) * ROW_HEIGHT;
      const existing = positions[table.id];
      positions[table.id] = { x: existing ? existing.x : 0, y: existing ? existing.y : 0, width, height };
    });
  }

  // ── Force-directed auto layout ───────────────────────────────────────────

  function runAutoLayout(onlyTheseIds) {
    const tables = draftGraph.tables;
    const n = tables.length;
    if (n === 0) { return; }

    const fullRelayout = !onlyTheseIds;
    const movable = fullRelayout ? tables.map(t => t.id) : onlyTheseIds;
    const movableSet = new Set(movable);

    const R = Math.max(260, n * 55);
    let seedIndex = 0;
    tables.forEach(t => {
      if (!movableSet.has(t.id)) { return; }
      const angle = (seedIndex / Math.max(1, movable.length)) * Math.PI * 2;
      seedIndex++;
      const p = positions[t.id];
      p.x = R * Math.cos(angle) - p.width / 2;
      p.y = R * Math.sin(angle) - p.height / 2;
    });

    const indexById = {};
    tables.forEach((t, i) => { indexById[t.id] = i; });
    const edges = draftGraph.relationships
      .map(r => ({ a: indexById[r.fromTableId], b: indexById[r.toTableId] }))
      .filter(e => e.a !== undefined && e.b !== undefined && e.a !== e.b);

    const ITERATIONS = 300;
    const REPULSION = 14000;
    const SPRING = 0.02;
    const IDEAL_EDGE_LEN = 260;

    function center(p) {
      return { cx: p.x + p.width / 2, cy: p.y + p.height / 2 };
    }

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const cooling = 1 - iter / ITERATIONS;
      const forces = tables.map(() => ({ x: 0, y: 0 }));

      for (let i = 0; i < n; i++) {
        const pi = center(positions[tables[i].id]);
        for (let j = i + 1; j < n; j++) {
          const pj = center(positions[tables[j].id]);
          let dx = pi.cx - pj.cx;
          let dy = pi.cy - pj.cy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = REPULSION / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          forces[i].x += dx; forces[i].y += dy;
          forces[j].x -= dx; forces[j].y -= dy;
        }
      }

      edges.forEach(e => {
        const pa = center(positions[tables[e.a].id]);
        const pb = center(positions[tables[e.b].id]);
        const dx = pb.cx - pa.cx;
        const dy = pb.cy - pa.cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - IDEAL_EDGE_LEN) * SPRING;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces[e.a].x += fx; forces[e.a].y += fy;
        forces[e.b].x -= fx; forces[e.b].y -= fy;
      });

      tables.forEach((t, i) => {
        if (!movableSet.has(t.id)) { return; }
        const p = positions[t.id];
        p.x += forces[i].x * cooling * 0.05;
        p.y += forces[i].y * cooling * 0.05;
      });
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    // Kept in step with the diagram it explains, rather than only on load: adding a table from
    // another schema should light up the legend without a refresh.
    renderSchemaLegend();
    clearDiagram();
    draftGraph.tables.forEach(renderTableNode);
    draftGraph.relationships.forEach(renderEdge);
    renderMinimap();
  }

  function renderTableNode(table) {
    const pos = positions[table.id];
    if (!pos) { return; }
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "fb-table-node"
      + (table.isNew ? " fb-new-table" : "")
      + (table.id === selectedTableId ? " fb-selected" : ""));
    g.setAttribute("transform", `translate(${pos.x},${pos.y})`);
    g.dataset.tableId = table.id;

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("class", "fb-table-body");
    body.setAttribute("width", pos.width);
    body.setAttribute("height", pos.height);
    g.appendChild(body);

    const header = document.createElementNS(SVG_NS, "rect");
    header.setAttribute("class", "fb-table-header");
    // Only when there is something to distinguish: one schema means every box would be the same
    // colour, which is noise rather than information.
    const schemas = schemasInDraft();
    if (schemas.length > 1 && table.schema) {
      const colour = schemaColor(table.schema, schemas);
      if (colour) { header.style.fill = colour; }
    }
    header.setAttribute("width", pos.width);
    header.setAttribute("height", HEADER_HEIGHT);
    g.appendChild(header);

    const headerText = document.createElementNS(SVG_NS, "text");
    headerText.setAttribute("class", "fb-table-header-text");
    headerText.setAttribute("x", COL_PADDING);
    headerText.setAttribute("y", HEADER_HEIGHT / 2);
    headerText.textContent = tableTitle(table) + (table.isNew ? " (new)" : "");
    g.appendChild(headerText);

    table.columns.forEach((col, i) => {
      const rowY = HEADER_HEIGHT + i * ROW_HEIGHT;

      if (i > 0) {
        const sep = document.createElementNS(SVG_NS, "line");
        sep.setAttribute("class", "fb-table-row-sep");
        sep.setAttribute("x1", 0);
        sep.setAttribute("x2", pos.width);
        sep.setAttribute("y1", rowY);
        sep.setAttribute("y2", rowY);
        g.appendChild(sep);
      }

      const nameText = document.createElementNS(SVG_NS, "text");
      nameText.setAttribute("class", "fb-col-text" + (col.isPrimaryKey ? " fb-pk" : ""));
      nameText.setAttribute("x", COL_PADDING);
      nameText.setAttribute("y", rowY + ROW_HEIGHT / 2);
      nameText.textContent = columnLabel(col);
      g.appendChild(nameText);

      const typeText = document.createElementNS(SVG_NS, "text");
      typeText.setAttribute("class", "fb-col-type");
      typeText.setAttribute("x", pos.width - COL_PADDING - 10);
      typeText.setAttribute("y", rowY + ROW_HEIGHT / 2);
      typeText.setAttribute("text-anchor", "end");
      typeText.textContent = columnTypeLabel(col);
      g.appendChild(typeText);

      const handle = document.createElementNS(SVG_NS, "circle");
      handle.setAttribute("class", "fb-fk-handle");
      handle.setAttribute("cx", pos.width);
      handle.setAttribute("cy", rowY + ROW_HEIGHT / 2);
      handle.setAttribute("r", 4);
      handle.addEventListener("mousedown", event => onFkHandleMouseDown(event, table, col));
      g.appendChild(handle);
    });

    g.addEventListener("mousedown", event => onNodeMouseDown(event, table.id));
    el.nodesLayer.appendChild(g);
  }

  /** Anchor point for a column on a table's right edge, in diagram coordinates. */
  function columnAnchorRight(tableId, columnName) {
    const pos = positions[tableId];
    const table = draftGraph.tables.find(t => t.id === tableId);
    const colIndex = table ? table.columns.findIndex(c => c.name === columnName) : -1;
    const rowY = colIndex >= 0 ? HEADER_HEIGHT + colIndex * ROW_HEIGHT + ROW_HEIGHT / 2 : pos.height / 2;
    return { x: pos.x + pos.width, y: pos.y + rowY };
  }

  function columnAnchor(tableId, columnName, side) {
    const pos = positions[tableId];
    const table = draftGraph.tables.find(t => t.id === tableId);
    const colIndex = table ? table.columns.findIndex(c => c.name === columnName) : -1;
    const rowY = colIndex >= 0 ? HEADER_HEIGHT + colIndex * ROW_HEIGHT + ROW_HEIGHT / 2 : pos.height / 2;
    return { x: pos.x + (side === "right" ? pos.width : 0), y: pos.y + rowY };
  }

  function renderEdge(rel) {
    const sourcePos = positions[rel.fromTableId];
    const targetPos = positions[rel.toTableId];
    if (!sourcePos || !targetPos) { return; }

    const sourceOnLeft = sourcePos.x + sourcePos.width / 2 <= targetPos.x + targetPos.width / 2;
    const from = columnAnchor(rel.fromTableId, rel.fromColumn.name, sourceOnLeft ? "right" : "left");
    const to = columnAnchor(rel.toTableId, rel.toColumn.name, sourceOnLeft ? "left" : "right");

    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    const c1x = sourceOnLeft ? from.x + dx : from.x - dx;
    const c2x = sourceOnLeft ? to.x - dx : to.x + dx;

    const isSelected = selectedRelationship === rel;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "fb-edge" + (isSelected ? " fb-edge-selected" : ""));
    path.dataset.sourceTableId = rel.fromTableId;
    path.dataset.targetTableId = rel.toTableId;
    path.setAttribute("d", `M${from.x},${from.y} C${c1x},${from.y} ${c2x},${to.y} ${to.x},${to.y}`);
    path.addEventListener("click", event => {
      event.stopPropagation();
      selectedRelationship = rel;
      render();
    });
    el.edgesLayer.appendChild(path);
  }

  // ── Highlighting (hover a table to see just its relationships) ─────────────

  el.nodesLayer.addEventListener("mouseover", event => {
    const nodeEl = event.target.closest(".fb-table-node");
    if (!nodeEl) { return; }
    const tableId = nodeEl.dataset.tableId;
    const edges = el.edgesLayer.querySelectorAll(".fb-edge");
    edges.forEach(edge => {
      const related = edge.dataset.sourceTableId === tableId || edge.dataset.targetTableId === tableId;
      edge.classList.toggle("fb-edge-dim", !related);
    });
  });
  el.nodesLayer.addEventListener("mouseleave", () => {
    el.edgesLayer.querySelectorAll(".fb-edge").forEach(edge => edge.classList.remove("fb-edge-dim"));
  });

  // ── Deleting a selected relationship ─────────────────────────────────────

  window.addEventListener("keydown", event => {
    if ((event.key === "Delete" || event.key === "Backspace") && selectedRelationship && document.activeElement === document.body) {
      draftGraph.relationships = draftGraph.relationships.filter(r => r !== selectedRelationship);
      selectedRelationship = null;
      render();
    }
  });

  el.canvas.addEventListener("mousedown", event => {
    if (event.target.closest(".fb-edge")) { return; }
    if (selectedRelationship) { selectedRelationship = null; render(); }
  });

  // ── Minimap ──────────────────────────────────────────────────────────────

  function schemaBounds() {
    const ids = Object.keys(positions);
    if (ids.length === 0) { return { minX: 0, minY: 0, maxX: 100, maxY: 100 }; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(id => {
      const p = positions[id];
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width);
      maxY = Math.max(maxY, p.y + p.height);
    });
    return { minX, minY, maxX, maxY };
  }

  function renderMinimap() {
    el.minimapNodes.innerHTML = "";
    const bounds = schemaBounds();
    const w = bounds.maxX - bounds.minX || 1;
    const h = bounds.maxY - bounds.minY || 1;
    const mmWidth = el.minimap.clientWidth || 160;
    const mmHeight = el.minimap.clientHeight || 110;
    const scale = Math.min(mmWidth / w, mmHeight / h) * 0.9;
    el.minimap.dataset.scale = String(scale);
    el.minimap.dataset.minX = String(bounds.minX);
    el.minimap.dataset.minY = String(bounds.minY);

    Object.keys(positions).forEach(id => {
      const p = positions[id];
      const r = document.createElementNS(SVG_NS, "rect");
      r.setAttribute("x", (p.x - bounds.minX) * scale);
      r.setAttribute("y", (p.y - bounds.minY) * scale);
      r.setAttribute("width", Math.max(2, p.width * scale));
      r.setAttribute("height", Math.max(2, p.height * scale));
      el.minimapNodes.appendChild(r);
    });
    updateMinimapViewport();
  }

  function updateMinimapViewport() {
    const scale = parseFloat(el.minimap.dataset.scale || "1");
    const minX = parseFloat(el.minimap.dataset.minX || "0");
    const minY = parseFloat(el.minimap.dataset.minY || "0");
    const canvasWidth = el.canvas.clientWidth || 1;
    const canvasHeight = el.canvas.clientHeight || 1;

    const visX = -view.x / view.scale;
    const visY = -view.y / view.scale;
    const visW = canvasWidth / view.scale;
    const visH = canvasHeight / view.scale;

    el.minimapViewport.setAttribute("x", (visX - minX) * scale);
    el.minimapViewport.setAttribute("y", (visY - minY) * scale);
    el.minimapViewport.setAttribute("width", Math.max(1, visW * scale));
    el.minimapViewport.setAttribute("height", Math.max(1, visH * scale));
  }

  el.minimap.addEventListener("mousedown", event => {
    const scale = parseFloat(el.minimap.dataset.scale || "1");
    const minX = parseFloat(el.minimap.dataset.minX || "0");
    const minY = parseFloat(el.minimap.dataset.minY || "0");
    const rect = el.minimap.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const targetDiagramX = clickX / scale + minX;
    const targetDiagramY = clickY / scale + minY;
    const canvasWidth = el.canvas.clientWidth || 1;
    const canvasHeight = el.canvas.clientHeight || 1;
    view.x = -(targetDiagramX * view.scale) + canvasWidth / 2;
    view.y = -(targetDiagramY * view.scale) + canvasHeight / 2;
    applyViewTransform();
  });

  // ── Pan / zoom / fit-to-view ─────────────────────────────────────────────

  function applyViewTransform() {
    el.viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.scale})`);
    updateMinimapViewport();
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  function clientToDiagram(clientX, clientY) {
    const rect = el.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    return { x: (cx - view.x) / view.scale, y: (cy - view.y) / view.scale };
  }

  let panState = null;
  el.canvas.addEventListener("mousedown", event => {
    if (event.target.closest(".fb-table-node") || event.target.closest(".fb-edge")) { return; }
    panState = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
    el.canvas.classList.add("panning");
  });
  window.addEventListener("mousemove", event => {
    if (!panState) { return; }
    view.x = panState.originX + (event.clientX - panState.startX);
    view.y = panState.originY + (event.clientY - panState.startY);
    applyViewTransform();
  });
  window.addEventListener("mouseup", () => {
    panState = null;
    el.canvas.classList.remove("panning");
  });

  el.canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    zoomAt(mouseX, mouseY, event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  function zoomAt(pointX, pointY, factor) {
    const newScale = clampScale(view.scale * factor);
    const ratio = newScale / view.scale;
    view.x = pointX - (pointX - view.x) * ratio;
    view.y = pointY - (pointY - view.y) * ratio;
    view.scale = newScale;
    applyViewTransform();
  }

  el.btnZoomIn.addEventListener("click", () => {
    const canvasWidth = el.canvas.clientWidth || 0;
    const canvasHeight = el.canvas.clientHeight || 0;
    zoomAt(canvasWidth / 2, canvasHeight / 2, 1.2);
  });
  el.btnZoomOut.addEventListener("click", () => {
    const canvasWidth = el.canvas.clientWidth || 0;
    const canvasHeight = el.canvas.clientHeight || 0;
    zoomAt(canvasWidth / 2, canvasHeight / 2, 1 / 1.2);
  });

  function fitToView() {
    if (draftGraph.tables.length === 0) { return; }
    const bounds = schemaBounds();
    const w = bounds.maxX - bounds.minX || 1;
    const h = bounds.maxY - bounds.minY || 1;
    const canvasWidth = el.canvas.clientWidth || 800;
    const canvasHeight = el.canvas.clientHeight || 600;
    const padding = 60;
    const scale = clampScale(Math.min((canvasWidth - padding) / w, (canvasHeight - padding) / h));
    view.scale = scale;
    view.x = canvasWidth / 2 - (bounds.minX + w / 2) * scale;
    view.y = canvasHeight / 2 - (bounds.minY + h / 2) * scale;
    applyViewTransform();
  }

  function centerOnTable(tableId) {
    const p = positions[tableId];
    if (!p) { return; }
    const canvasWidth = el.canvas.clientWidth || 800;
    const canvasHeight = el.canvas.clientHeight || 600;
    view.x = canvasWidth / 2 - (p.x + p.width / 2) * view.scale;
    view.y = canvasHeight / 2 - (p.y + p.height / 2) * view.scale;
    applyViewTransform();
  }

  el.btnFit.addEventListener("click", fitToView);
  // Toggle, not a permanent panel: the legend sits over the canvas, so it should be dismissable.
  el.btnSchemaLegend.addEventListener("click", () => {
    el.schemaLegend.hidden = !el.schemaLegend.hidden;
  });

  el.btnAutoLayout.addEventListener("click", () => {
    runAutoLayout(null);
    render();
    fitToView();
  });

  // ── Node dragging + click-to-select ──────────────────────────────────────

  let dragState = null;
  function onNodeMouseDown(event, tableId) {
    if (event.target.closest(".fb-fk-handle")) { return; } // handled separately
    event.stopPropagation();
    const pos = positions[tableId];
    dragState = {
      tableId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
      moved: false,
    };
  }
  window.addEventListener("mousemove", event => {
    if (!dragState) { return; }
    const dx = (event.clientX - dragState.startX) / view.scale;
    const dy = (event.clientY - dragState.startY) / view.scale;
    if (Math.abs(event.clientX - dragState.startX) > 3 || Math.abs(event.clientY - dragState.startY) > 3) {
      dragState.moved = true;
    }
    const p = positions[dragState.tableId];
    p.x = dragState.originX + dx;
    p.y = dragState.originY + dy;
    render();
  });
  window.addEventListener("mouseup", () => {
    if (dragState && !dragState.moved) {
      selectTable(dragState.tableId);
      centerOnTable(dragState.tableId);
    }
    dragState = null;
  });

  // ── Drawing a new foreign key relationship ───────────────────────────────

  let fkDragState = null;
  let tempEdge = null;

  function onFkHandleMouseDown(event, table, col) {
    event.stopPropagation();
    event.preventDefault();
    fkDragState = { fromTable: table, fromColumn: col };
    tempEdge = document.createElementNS(SVG_NS, "path");
    tempEdge.setAttribute("class", "fb-temp-edge");
    el.edgesLayer.appendChild(tempEdge);
  }

  window.addEventListener("mousemove", event => {
    if (!fkDragState || !tempEdge) { return; }
    const from = columnAnchorRight(fkDragState.fromTable.id, fkDragState.fromColumn.name);
    const p = clientToDiagram(event.clientX, event.clientY);
    tempEdge.setAttribute("d", `M${from.x},${from.y} L${p.x},${p.y}`);
  });

  window.addEventListener("mouseup", event => {
    if (!fkDragState) { return; }
    const p = clientToDiagram(event.clientX, event.clientY);
    const hit = hitTestColumn(p.x, p.y);
    if (hit && hit.column && hit.column !== fkDragState.fromColumn) {
      addRelationship(fkDragState.fromTable.id, fkDragState.fromColumn, hit.table.id, hit.column);
    }
    if (tempEdge) { tempEdge.remove(); }
    tempEdge = null;
    fkDragState = null;
    render();
  });

  function hitTestColumn(x, y) {
    for (const t of draftGraph.tables) {
      const p = positions[t.id];
      if (!p) { continue; }
      if (x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height) {
        if (y < p.y + HEADER_HEIGHT) { return { table: t, column: null }; }
        const idx = Math.floor((y - p.y - HEADER_HEIGHT) / ROW_HEIGHT);
        return { table: t, column: t.columns[idx] || null };
      }
    }
    return null;
  }

  function addRelationship(fromTableId, fromColumn, toTableId, toColumn) {
    if (fromColumn === toColumn) { return; }
    const dup = draftGraph.relationships.some(r => r.fromColumn === fromColumn && r.toColumn === toColumn);
    if (dup) { return; }
    draftGraph.relationships.push({ fromTableId, fromColumn, toTableId, toColumn });
  }

  // ── Add Table ─────────────────────────────────────────────────────────────

  el.btnAddTable.addEventListener("click", () => addTable());

  function addTable() {
    const id = 't' + (nextTableId++);
    const table = {
      id,
      name: 'NEW_TABLE',
      isNew: true,
      columns: [{ name: 'ID', type: 'INTEGER', length: 0, notNull: true, isPrimaryKey: true, dflt: undefined }],
      originalColumns: [],
    };
    draftGraph.tables.push(table);
    const canvasWidth = el.canvas.clientWidth || 800;
    const canvasHeight = el.canvas.clientHeight || 600;
    const centerX = (canvasWidth / 2 - view.x) / view.scale;
    const centerY = (canvasHeight / 2 - view.y) / view.scale;
    positions[id] = { x: centerX - 90, y: centerY - 30, width: MIN_NODE_WIDTH, height: HEADER_HEIGHT + ROW_HEIGHT };
    measureAll();
    render();
    selectTable(id);
    setStatus(`${draftGraph.tables.length} table(s), ${draftGraph.relationships.length} relationship(s)`);
  }

  // ── Inspector panel ───────────────────────────────────────────────────────

  function selectTable(tableId) {
    selectedTableId = tableId;
    renderInspector();
    render();
  }

  function closeInspector() {
    selectedTableId = null;
    el.inspector.style.display = "none";
    render();
  }

  el.closeInspectorBtn.addEventListener("click", closeInspector);

  function renderInspector() {
    const table = draftGraph.tables.find(t => t.id === selectedTableId);
    if (!table) {
      el.inspector.style.display = "none";
      return;
    }
    el.inspector.style.display = "block";
    el.inspectorHeading.textContent = table.isNew ? "New Table" : `Table: ${table.name}`;
    el.tableNameInput.value = table.name;
    el.tableNameInput.readOnly = !table.isNew;
    el.columnsBody.innerHTML = "";
    table.columns.forEach(col => addInspectorRow(table, col));
  }

  el.tableNameInput.addEventListener("change", () => {
    const table = draftGraph.tables.find(t => t.id === selectedTableId);
    if (!table || !table.isNew) { return; }
    table.name = el.tableNameInput.value.trim().toUpperCase() || table.name;
    el.tableNameInput.value = table.name;
    measureAll();
    render();
  });

  el.addColumnBtn.addEventListener("click", () => {
    const table = draftGraph.tables.find(t => t.id === selectedTableId);
    if (!table) { return; }
    const col = { name: '', type: 'VARCHAR', length: 0, notNull: false, isPrimaryKey: false, dflt: undefined };
    table.columns.push(col);
    addInspectorRow(table, col);
  });

  function addInspectorRow(table, col) {
    const tr = document.createElement("tr");
    const options = (col.type && !TYPES.includes(col.type)) ? [col.type, ...TYPES] : TYPES;
    tr.innerHTML = `
      <td><input type="text" class="col-name" value="${escAttr(col.name)}" placeholder="COLUMN_NAME"></td>
      <td>
        <select class="col-type">
          ${options.map(t => `<option value="${escAttr(t)}"${t === (col.type || 'VARCHAR') ? ' selected' : ''}>${escAttr(t)}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" class="col-size" value="${escAttr(col.length || '')}" placeholder="e.g. 100"></td>
      <td style="text-align:center"><input type="checkbox" class="col-notnull"${col.notNull ? ' checked' : ''}></td>
      <td style="text-align:center"><input type="checkbox" class="col-pk"${col.isPrimaryKey ? ' checked' : ''}></td>
      <td><input type="text" class="col-default" value="${escAttr(col.dflt || '')}" placeholder="default value"></td>
      <td><button class="remove-col" title="Remove column">&times;</button></td>
    `;

    const writeBack = () => {
      col.name = tr.querySelector('.col-name').value.trim().toUpperCase();
      col.type = tr.querySelector('.col-type').value;
      const sizeVal = tr.querySelector('.col-size').value.trim();
      col.length = sizeVal ? (parseInt(sizeVal, 10) || 0) : 0;
      col.notNull = tr.querySelector('.col-notnull').checked;
      col.isPrimaryKey = tr.querySelector('.col-pk').checked;
      col.dflt = tr.querySelector('.col-default').value.trim() || undefined;
      measureAll();
      render();
    };
    tr.querySelectorAll('input, select').forEach(input => input.addEventListener('change', writeBack));

    tr.querySelector('.remove-col').addEventListener('click', () => {
      // Cascade: a relationship whose local or referenced column is being removed can't survive
      // — the column it points at is genuinely gone, so there's nothing to re-add later.
      draftGraph.relationships = draftGraph.relationships.filter(r => r.fromColumn !== col && r.toColumn !== col);
      const idx = table.columns.indexOf(col);
      if (idx >= 0) { table.columns.splice(idx, 1); }
      renderInspector();
      measureAll();
      render();
    });

    el.columnsBody.appendChild(tr);
  }

  // ── DDL generation (Phase-3 diff engine) ──────────────────────────────────

  function typeString(type, length) {
    return (length && SIZED_TYPES.includes(type)) ? `${type}(${length})` : type;
  }

  function pkColumnsChanged(table) {
    if (table.isNew) { return false; }
    const current = table.columns.filter(c => c.isPrimaryKey).map(c => c.name).sort().join(',');
    const original = table.originalColumns.filter(c => c.isPrimaryKey).map(c => c.name).sort().join(',');
    return current !== original;
  }

  function buildTableAlterStatements(table) {
    const statements = [];
    const seenOriginalNames = new Set();

    table.columns.forEach(col => {
      if (!col.original) {
        let colDef = `${col.name} ${col.type}`;
        if (col.length && SIZED_TYPES.includes(col.type)) { colDef += `(${col.length})`; }
        if (col.dflt) { colDef += ` DEFAULT ${col.dflt}`; }
        if (col.notNull) {
          colDef += ' NOT NULL';
          if (!col.dflt) {
            statements.push(`ALTER TABLE ${table.name} ADD ${colDef}; -- If this table already has rows, this may fail without a DEFAULT`);
            return;
          }
        }
        statements.push(`ALTER TABLE ${table.name} ADD ${colDef};`);
        return;
      }

      seenOriginalNames.add(col.original.name);

      if (col.name !== col.original.name) {
        statements.push(`ALTER TABLE ${table.name} ALTER COLUMN ${col.original.name} TO ${col.name};`);
      }
      if (typeString(col.original.type, col.original.length) !== typeString(col.type, col.length)) {
        statements.push(`ALTER TABLE ${table.name} ALTER COLUMN ${col.name} TYPE ${typeString(col.type, col.length)};`);
      }
      if ((col.original.dflt || '') !== (col.dflt || '')) {
        statements.push(col.dflt
          ? `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} SET DEFAULT ${col.dflt};`
          : `ALTER TABLE ${table.name} ALTER COLUMN ${col.name} DROP DEFAULT;`);
      }
      if (Boolean(col.original.notNull) !== col.notNull) {
        const clause = col.notNull ? 'SET NOT NULL' : 'DROP NOT NULL';
        statements.push(`ALTER TABLE ${table.name} ALTER COLUMN ${col.name} ${clause}; -- Requires Firebird 4.0 or later`);
      }
    });

    table.originalColumns.forEach(oc => {
      if (!seenOriginalNames.has(oc.name)) {
        statements.push(`ALTER TABLE ${table.name} DROP ${oc.name};`);
      }
    });

    return statements;
  }

  function buildCreateTableStatement(table) {
    const pkCols = [];
    const colDefs = table.columns.filter(c => c.name).map(c => {
      let def = `  ${c.name} ${c.type}`;
      if (c.length && SIZED_TYPES.includes(c.type)) { def += `(${c.length})`; }
      if (c.dflt) { def += ` DEFAULT ${c.dflt}`; }
      if (c.notNull) { def += ' NOT NULL'; }
      if (c.isPrimaryKey) { pkCols.push(c.name); }
      return def;
    });
    if (pkCols.length > 0) { colDefs.push(`  PRIMARY KEY (${pkCols.join(', ')})`); }
    return `CREATE TABLE ${table.name} (\n${colDefs.join(',\n')}\n);`;
  }

  function buildDDL() {
    const statements = [];

    // Step 1: constraints that must be dropped before anything else —
    //   (a) relationships the user deleted (never re-added), and
    //   (b) relationships that survive but reference a table whose PK set is about to change
    //       (Firebird refuses to drop/replace a PRIMARY KEY while a live FOREIGN KEY depends on
    //       it), re-added in step 5 using the *same* constraint name.
    const currentConstraintNames = new Set(draftGraph.relationships.filter(r => r.constraintName).map(r => r.constraintName));
    const deletedConstraintNames = Array.from(originalConstraintNames).filter(name => !currentConstraintNames.has(name));

    const pkChangedTableIds = new Set(draftGraph.tables.filter(pkColumnsChanged).map(t => t.id));
    const forcedDrops = draftGraph.relationships.filter(r => r.constraintName && pkChangedTableIds.has(r.toTableId));
    const forcedDropNames = new Set(forcedDrops.map(r => r.constraintName));

    function tableNameById(id) {
      const t = draftGraph.tables.find(x => x.id === id);
      return t ? t.name : '?';
    }

    deletedConstraintNames.forEach(name => {
      const fromTableId = originalFromTableByConstraint[name];
      statements.push(`ALTER TABLE ${tableNameById(fromTableId)} DROP CONSTRAINT ${name};`);
    });
    forcedDrops.forEach(r => {
      statements.push(`ALTER TABLE ${tableNameById(r.fromTableId)} DROP CONSTRAINT ${r.constraintName};`);
    });

    // Step 2 + 3: existing tables — column diff, then PK change.
    draftGraph.tables.forEach(table => {
      if (table.isNew) { return; }
      statements.push(...buildTableAlterStatements(table));
      if (pkChangedTableIds.has(table.id)) {
        const pkNames = table.columns.filter(c => c.isPrimaryKey).map(c => c.name);
        const oldPkConstraintName = pkConstraintNames[table.id];
        if (oldPkConstraintName) {
          statements.push(`ALTER TABLE ${table.name} DROP CONSTRAINT ${oldPkConstraintName};`);
        }
        if (pkNames.length > 0) {
          statements.push(`ALTER TABLE ${table.name} ADD PRIMARY KEY (${pkNames.join(', ')});`);
        }
      }
    });

    // Step 4: new tables.
    draftGraph.tables.forEach(table => {
      if (table.isNew) { statements.push(buildCreateTableStatement(table)); }
    });

    // Step 5: add constraints — new relationships, plus anything forced-dropped in step 1(b).
    draftGraph.relationships.forEach(r => {
      const isForcedReadd = forcedDropNames.has(r.constraintName);
      if (r.constraintName && !isForcedReadd) { return; } // untouched, already exists as-is
      const fromTable = draftGraph.tables.find(t => t.id === r.fromTableId);
      const toTable = draftGraph.tables.find(t => t.id === r.toTableId);
      if (!fromTable || !toTable || !fromTable.columns.includes(r.fromColumn) || !toTable.columns.includes(r.toColumn)) {
        statements.push(`-- Skipped: relationship referencing a removed table or column`);
        return;
      }
      const constraintClause = r.constraintName ? ` CONSTRAINT ${r.constraintName}` : '';
      statements.push(`ALTER TABLE ${fromTable.name} ADD${constraintClause} FOREIGN KEY (${r.fromColumn.name}) REFERENCES ${toTable.name} (${r.toColumn.name});`);
    });

    return statements.length > 0 ? statements.join('\n') : '-- No changes detected.';
  }

  // ── Generate / Execute ────────────────────────────────────────────────────

  el.generateBtn.addEventListener("click", () => {
    const ddl = buildDDL();
    el.ddlOutput.style.display = "block";
    el.ddlOutput.textContent = ddl;
    vscode.postMessage({ command: "openInEditor", ddl });
  });

  el.executeBtn.addEventListener("click", () => {
    const ddl = buildDDL();
    el.ddlOutput.style.display = "block";
    el.ddlOutput.textContent = ddl;
    vscode.postMessage({ command: "executeDDL", ddl });
  });

  function appendResult(text) {
    el.ddlOutput.style.display = "block";
    el.ddlOutput.textContent = (el.ddlOutput.textContent || '') + '\n-- ' + text;
  }

  // ── Ask Copilot (schema editing via natural language) ────────────────────
  //
  // Deliberately asks the model for a small structured JSON edit (add/modify/remove tables,
  // columns, relationships) rather than raw DDL: applying it as ordinary draftGraph mutations
  // reuses the exact same rename-safe diff engine (buildDDL() above) real edits already go
  // through, instead of asking the model to get Firebird DDL syntax/statement-ordering right.

  let copilotBusy = false;

  el.btnAskCopilot.addEventListener("click", () => {
    const isOpen = el.copilotPanel.style.display !== "none";
    el.copilotPanel.style.display = isOpen ? "none" : "block";
    if (!isOpen) { el.copilotInstruction.focus(); }
  });

  el.copilotClose.addEventListener("click", () => {
    el.copilotPanel.style.display = "none";
  });

  el.copilotSend.addEventListener("click", () => {
    if (copilotBusy) { return; }
    const instruction = el.copilotInstruction.value.trim();
    if (!instruction) { return; }
    copilotBusy = true;
    el.copilotSend.textContent = "Thinking…";
    el.copilotStatus.classList.remove("error");
    el.copilotStatus.textContent = "";
    vscode.postMessage({ command: "askCopilot", instruction, schemaSummary: serializeSchemaSummary() });
  });

  function serializeSchemaSummary() {
    const lines = [];
    draftGraph.tables.forEach(table => {
      lines.push(`Table ${table.name}${table.isNew ? ' (not yet created)' : ''}:`);
      table.columns.forEach(col => {
        const bits = [col.type];
        if (col.length && SIZED_TYPES.includes(col.type)) { bits.push(`(${col.length})`); }
        if (col.notNull) { bits.push('NOT NULL'); }
        if (col.isPrimaryKey) { bits.push('PK'); }
        if (col.dflt) { bits.push(`DEFAULT ${col.dflt}`); }
        lines.push(`  ${col.name} ${bits.join(' ')}`);
      });
    });
    if (draftGraph.relationships.length > 0) {
      lines.push('Relationships:');
      draftGraph.relationships.forEach(r => {
        const fromTable = draftGraph.tables.find(t => t.id === r.fromTableId);
        const toTable = draftGraph.tables.find(t => t.id === r.toTableId);
        if (fromTable && toTable) {
          lines.push(`  ${fromTable.name}.${r.fromColumn.name} -> ${toTable.name}.${r.toColumn.name}`);
        }
      });
    }
    return lines.length > 0 ? lines.join('\n') : '(empty schema)';
  }

  function handleCopilotSchemaEdit(data) {
    copilotBusy = false;
    el.copilotSend.textContent = "Send";
    if (data.error) {
      el.copilotStatus.classList.add("error");
      el.copilotStatus.textContent = data.error;
      return;
    }
    el.copilotStatus.classList.remove("error");
    applyCopilotEdit(data.edit);
    el.copilotStatus.textContent = (data.edit && data.edit.explanation) ? data.edit.explanation : "Done.";
    el.copilotInstruction.value = "";
  }

  /**
   * Applies the model's proposed edit to draftGraph exactly like a user edit would — whether a
   * table/column is "new" is decided by whether it already exists in the draft, not by trusting
   * the model's self-reported "action" field (defensive: a model that mislabels an edit still
   * produces the correct result here).
   */
  function applyCopilotEdit(edit) {
    if (!edit) { return; }

    (edit.tables || []).forEach(t => {
      if (!t || !t.name) { return; }
      const name = String(t.name).trim().toUpperCase();
      let table = draftGraph.tables.find(tt => tt.name === name);
      if (!table) {
        const id = 't' + (nextTableId++);
        table = { id, name, isNew: true, columns: [], originalColumns: [] };
        draftGraph.tables.push(table);
        const canvasWidth = el.canvas.clientWidth || 800;
        const canvasHeight = el.canvas.clientHeight || 600;
        const centerX = (canvasWidth / 2 - view.x) / view.scale;
        const centerY = (canvasHeight / 2 - view.y) / view.scale;
        const jitter = (Math.random() - 0.5) * 80;
        positions[id] = { x: centerX - 90 + jitter, y: centerY - 30 + jitter, width: MIN_NODE_WIDTH, height: HEADER_HEIGHT + ROW_HEIGHT };
      }

      (t.columns || []).forEach(c => {
        if (!c || !c.name) { return; }
        const colName = String(c.name).trim().toUpperCase();
        const existing = table.columns.find(cc => cc.name === colName);
        if (c.action === 'remove') {
          if (existing) {
            draftGraph.relationships = draftGraph.relationships.filter(r => r.fromColumn !== existing && r.toColumn !== existing);
            table.columns.splice(table.columns.indexOf(existing), 1);
          }
          return;
        }
        if (existing) {
          if (c.type) { existing.type = c.type; }
          if (typeof c.length === 'number') { existing.length = c.length; }
          if (typeof c.notNull === 'boolean') { existing.notNull = c.notNull; }
          if (typeof c.isPrimaryKey === 'boolean') { existing.isPrimaryKey = c.isPrimaryKey; }
          if ('dflt' in c) { existing.dflt = c.dflt || undefined; }
        } else {
          table.columns.push({
            name: colName,
            type: c.type || 'VARCHAR',
            length: typeof c.length === 'number' ? c.length : 0,
            notNull: !!c.notNull,
            isPrimaryKey: !!c.isPrimaryKey,
            dflt: c.dflt || undefined,
          });
        }
      });
    });

    (edit.relationships || []).forEach(r => {
      if (!r) { return; }
      const fromTable = draftGraph.tables.find(t => t.name === String(r.fromTable || '').trim().toUpperCase());
      const toTable = draftGraph.tables.find(t => t.name === String(r.toTable || '').trim().toUpperCase());
      if (!fromTable || !toTable) { return; }
      const fromColumn = fromTable.columns.find(c => c.name === String(r.fromColumn || '').trim().toUpperCase());
      const toColumn = toTable.columns.find(c => c.name === String(r.toColumn || '').trim().toUpperCase());
      if (!fromColumn || !toColumn) { return; }
      if (r.action === 'remove') {
        draftGraph.relationships = draftGraph.relationships.filter(rel => !(rel.fromColumn === fromColumn && rel.toColumn === toColumn));
        return;
      }
      addRelationship(fromTable.id, fromColumn, toTable.id, toColumn);
    });

    measureAll();
    render();
  }

  /**
   * A stable colour per schema.
   *
   * Deterministic by *sorted position* rather than by hashing the name, so the same database
   * always produces the same assignment and two schemas can never collide on one colour. Hues are
   * spread evenly around the wheel; saturation and lightness are fixed at values that stay legible
   * against both light and dark editor themes, which a random palette would not guarantee.
   */
  function schemaColor(schema, allSchemas) {
    const index = allSchemas.indexOf(schema);
    if (index < 0) { return null; }
    const hue = Math.round((360 / Math.max(allSchemas.length, 1)) * index);
    return `hsl(${hue}, 45%, 42%)`;
  }

  /** Distinct schemas in the draft, sorted — the input to schemaColor(). */
  function schemasInDraft() {
    return Array.from(new Set(draftGraph.tables.map(t => t.schema).filter(Boolean))).sort();
  }

  /**
   * What a table's box is labelled with: the display name when the graph supplied one (i.e. the
   * qualified name minus a redundant default-schema prefix), otherwise the name itself.
   */
  function tableTitle(table) {
    return table.displayName || table.name;
  }

  /** Renders the legend body; returns the schemas it listed, so callers can tell if it is useful. */
  function renderSchemaLegend() {
    const legend = document.getElementById("schema-legend");
    const button = document.getElementById("btn-schema-legend");
    const schemas = schemasInDraft();
    if (!legend || !button) { return schemas; }

    // The button appears only when a legend would say something — a single-schema database gets
    // neither, exactly as before Firebird 6 existed.
    button.hidden = schemas.length <= 1;
    if (schemas.length <= 1) {
      legend.hidden = true;
      return schemas;
    }

    legend.innerHTML = "";
    schemas.forEach(schema => {
      const row = document.createElement("div");
      row.className = "fb-legend-row";
      const swatch = document.createElement("span");
      swatch.className = "fb-legend-swatch";
      swatch.style.background = schemaColor(schema, schemas);
      row.appendChild(swatch);
      const label = document.createElement("span");
      label.textContent = schema;
      row.appendChild(label);
      legend.appendChild(row);
    });
    return schemas;
  }

  // Test-only hook: no-op in a real webview (there is no `module` global there), lets a
  // Node-based verification harness drive this script's internal state directly rather than
  // simulating raw mouse/SVG events for every interaction.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = {
      handleSchemaData, handleSchemaProgress, buildDDL, addTable, addRelationship, measureAll, render, tableTitle,
      schemaColor, schemasInDraft, renderSchemaLegend,
      applyCopilotEdit, serializeSchemaSummary,
      getDraftGraph: () => draftGraph,
      // The placeholder's two observable properties. `document.getElementById()` hands back a
      // fresh stub on every call under the test harness, so a test cannot reach the element
      // app.js captured at load — same reason getDraftGraph() exists.
      getLoadingState: () => ({
        visible: el.loading.style.display !== "none",
        caption: el.loadingText.textContent,
      }),
      setLoadingVisible: visible => { el.loading.style.display = visible ? "flex" : "none"; },
    };
  }
})();
