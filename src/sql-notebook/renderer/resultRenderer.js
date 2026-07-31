'use strict';

// Firebird SQL Notebook custom result renderer (docs/roadmap/sql-notebooks.md phase 2).
//
// Registered via package.json's contributes.notebookRenderer for the
// "application/x-firebird-notebook-result+json" mime type controller.ts emits alongside a plain
// markdown fallback (see resultToOutputItems() there). Hand-rolled vanilla DOM/CSS rather than
// pulling result-view's jQuery/DataTables stack into a second bundle — this repo's established
// convention for self-contained webview-ish surfaces (schema-designer's canvas, profiler's
// dashboard, query-plan-view's diagram) is to hand-roll a small renderer rather than add a
// dependency. A notebook output cell also doesn't need row *editing* the way the full result-view
// panel does — there's no bound table name/primary key to write edits back to here — so this
// covers sort/filter/paginate/copy only.
//
// Runs in VS Code's sandboxed notebook renderer context (loaded as an ES module — hence
// `export const activate`), not a regular webview: no acquireVsCodeApi(), no extension-host
// round trip. Everything here operates on the JSON payload already embedded in the output item.

const PAGE_SIZES = [10, 25, 50, 100, 'All'];
const DEFAULT_PAGE_SIZE = 25;

let stylesInjected = false;

export const activate = (context) => ({
  renderOutputItem(outputItem, element) {
    injectStylesOnce();
    const table = outputItem.json();
    // `context.postMessage` only exists when the renderer contribution declares requiresMessaging
    // and the host side registered a messaging channel; the Export button is hidden without it
    // rather than throwing (docs/roadmap/sql-notebooks.md, phase 4).
    element.replaceChildren(renderTable(table, context && context.postMessage ? context : undefined));
  },
});

function renderTable(table, messaging) {
  const root = document.createElement('div');
  root.className = 'fb-nb-result';

  let sortColumn = null; // index into table.headers, or null for insertion order
  let sortDir = 1; // 1 = ascending, -1 = descending
  let filterText = '';
  let pageSize = DEFAULT_PAGE_SIZE;
  let page = 0;

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Filter rows…';
  filterInput.className = 'fb-nb-filter';
  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    page = 0;
    render();
  });

  const pageSizeSelect = document.createElement('select');
  pageSizeSelect.className = 'fb-nb-page-size';
  PAGE_SIZES.forEach(size => {
    const opt = document.createElement('option');
    opt.value = String(size);
    opt.textContent = size === 'All' ? 'All rows' : `${size} rows`;
    pageSizeSelect.appendChild(opt);
  });
  pageSizeSelect.value = String(DEFAULT_PAGE_SIZE);
  pageSizeSelect.addEventListener('change', () => {
    pageSize = pageSizeSelect.value === 'All' ? Infinity : parseInt(pageSizeSelect.value, 10);
    page = 0;
    render();
  });

  const status = document.createElement('span');
  status.className = 'fb-nb-status';

  const copyCsvBtn = button('Copy as CSV', () => copyToClipboard(toCsv(filteredSortedRows(), table.headers), status, 'CSV'));
  const copyJsonBtn = button('Copy as JSON', () => copyToClipboard(toJson(filteredSortedRows(), table.headers), status, 'JSON'));

  // Export to a file goes through the extension host: a notebook renderer runs in a sandboxed
  // iframe where triggering a download isn't reliable, and only the host can show a save dialog.
  // Exports exactly what's on screen -- the current filter/sort, same as the copy buttons above.
  const exportBtn = messaging
    ? button('Export…', () => {
        messaging.postMessage({
          type: 'exportResult',
          headers: table.headers,
          rows: filteredSortedRows(),
          truncated: !!table.truncated,
          totalRowCount: table.totalRowCount,
        });
        status.textContent = 'Exporting…';
      })
    : undefined;

  const prevBtn = button('‹', () => { if (page > 0) { page--; render(); } });
  const nextBtn = button('›', () => { page++; render(); });
  const pageLabel = document.createElement('span');
  pageLabel.className = 'fb-nb-page-label';

  const toolbar = document.createElement('div');
  toolbar.className = 'fb-nb-toolbar';
  toolbar.append(filterInput, pageSizeSelect, copyCsvBtn, copyJsonBtn);
  if (exportBtn) { toolbar.append(exportBtn); }
  toolbar.append(prevBtn, pageLabel, nextBtn, status);

  const tableEl = document.createElement('table');
  tableEl.className = 'fb-nb-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  tableEl.append(thead, tbody);

  const truncationNote = document.createElement('div');
  truncationNote.className = 'fb-nb-truncation';
  if (table.truncated) {
    truncationNote.textContent =
      `Showing first ${table.rows.length} of ${table.totalRowCount} rows — narrow the query ` +
      '(e.g. FIRST/ROWS) to see the rest.';
  }

  root.append(toolbar, tableEl, truncationNote);

  function filteredSortedRows() {
    let rows = table.rows;
    const needle = filterText.trim().toLowerCase();
    if (needle) {
      rows = rows.filter(row => row.some(cell => cell !== null && String(cell).toLowerCase().includes(needle)));
    }
    if (sortColumn !== null) {
      rows = rows.slice().sort((a, b) => compareCells(a[sortColumn], b[sortColumn]) * sortDir);
    }
    return rows;
  }

  function render() {
    const rows = filteredSortedRows();
    const totalPages = pageSize === Infinity ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(page, totalPages - 1);
    const start = pageSize === Infinity ? 0 : page * pageSize;
    const end = pageSize === Infinity ? rows.length : start + pageSize;

    renderHead();
    renderBody(rows.slice(start, end));

    prevBtn.disabled = page <= 0;
    nextBtn.disabled = page >= totalPages - 1;
    pageLabel.textContent = rows.length === 0 ? '0 rows' : `${start + 1}–${Math.min(end, rows.length)} of ${rows.length}`;
  }

  function renderHead() {
    thead.replaceChildren();
    const tr = document.createElement('tr');
    table.headers.forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h + (sortColumn === i ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
      th.classList.toggle('fb-nb-sorted', sortColumn === i);
      th.addEventListener('click', () => {
        sortDir = sortColumn === i ? -sortDir : 1;
        sortColumn = i;
        render();
      });
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  }

  function renderBody(rows) {
    tbody.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = table.headers.length || 1;
      td.className = 'fb-nb-empty';
      td.textContent = table.rows.length === 0 ? '0 rows returned.' : 'No rows match the filter.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(row => {
      const tr = document.createElement('tr');
      row.forEach(cell => {
        const td = document.createElement('td');
        if (cell === null) {
          td.textContent = 'NULL';
          td.className = 'fb-nb-null';
        } else {
          td.textContent = cell;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  render();
  return root;
}

function button(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.className = 'fb-nb-btn';
  btn.addEventListener('click', onClick);
  return btn;
}

/** Numeric-aware compare so a numeric column sorts by value, not lexically ("2" before "10"); null always sorts first. */
function compareCells(a, b) {
  if (a === null && b === null) { return 0; }
  if (a === null) { return -1; }
  if (b === null) { return 1; }
  const numA = Number(a);
  const numB = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(numA) && !Number.isNaN(numB)) {
    return numA - numB;
  }
  return String(a).localeCompare(String(b));
}

function csvCell(value) {
  if (value === null) { return ''; }
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, headers) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(row => lines.push(row.map(csvCell).join(',')));
  return lines.join('\n');
}

function toJson(rows, headers) {
  return JSON.stringify(rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  }), null, 2);
}

// Test-only export: harmless in the real renderer context (VS Code's Notebook Renderer API only
// ever imports `activate`) — lets a Node-based test load this module's pure helpers directly via
// dynamic import(), the ESM equivalent of the CommonJS `module.exports.__test__` hook the other
// three webview app.js files use (see src/test/webview-harness.ts's doc comment for why).
export const __test__ = { compareCells, csvCell, toCsv, toJson };

function copyToClipboard(text, statusEl, label) {
  const ok = () => { statusEl.textContent = `Copied as ${label}.`; setTimeout(() => { statusEl.textContent = ''; }, 2000); };
  const fail = () => { statusEl.textContent = `Could not copy ${label} to the clipboard.`; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok, fail);
  } else {
    fail();
  }
}

function injectStylesOnce() {
  if (stylesInjected) { return; }
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .fb-nb-result { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); }
    .fb-nb-toolbar { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
    .fb-nb-filter { flex: 1; min-width: 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 6px; border-radius: 2px; }
    .fb-nb-page-size, .fb-nb-btn { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); border: none; padding: 2px 8px; border-radius: 2px; cursor: pointer; }
    .fb-nb-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
    .fb-nb-btn:disabled { opacity: 0.5; cursor: default; }
    .fb-nb-status { color: var(--vscode-descriptionForeground); font-size: 0.9em; min-width: 5em; }
    .fb-nb-page-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; }
    .fb-nb-table { border-collapse: collapse; width: 100%; }
    .fb-nb-table th, .fb-nb-table td { border: 1px solid var(--vscode-panel-border, #80808040); padding: 2px 6px; text-align: left; white-space: nowrap; }
    .fb-nb-table th { cursor: pointer; background: var(--vscode-editorWidget-background); user-select: none; }
    .fb-nb-table th.fb-nb-sorted { font-weight: bold; }
    .fb-nb-null { font-style: italic; color: var(--vscode-descriptionForeground); }
    .fb-nb-empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 8px; }
    .fb-nb-truncation { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
  `;
  document.head.appendChild(style);
}
