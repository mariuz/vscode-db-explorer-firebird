$(() => {
  const vscode = acquireVsCodeApi();

  vscode.postMessage({ command: "getData", data: {} });

  // ── Request/response helper ──────────────────────────────────────────────
  // getPrimaryKey/applyChanges are request/response round-trips over
  // postMessage; pair each request with a requestId so out-of-order or
  // concurrent (multi-panel) responses resolve the right caller.

  let nextRequestId = 1;
  const pendingRequests = {};

  function requestFromExtension(command, data) {
    return new Promise(resolve => {
      const requestId = String(nextRequestId++);
      pendingRequests[requestId] = resolve;
      vscode.postMessage({ command, data: Object.assign({ requestId }, data) });
    });
  }

  function resolveRequest(requestId, payload) {
    const resolve = pendingRequests[requestId];
    if (resolve) {
      delete pendingRequests[requestId];
      resolve(payload);
    }
  }

  // ── Configurable shortcuts (firebird.shortcuts, mirroring vscode-mssql) ────
  // Handled entirely here in the webview, not via VS Code's own keybindings
  // contribution mechanism, which can't reach into webview content.

  let shortcuts = {};
  let activeTableId = null;
  const tableActions = {}; // tableId -> { toggleEdit, addRow, apply, freeze, copyInsert, copyIn }

  // ── Grid font customization (firebird.resultsFontSize/resultsFontFamily, mirroring
  // vscode-mssql's mssql.resultsFontSize/resultsFontFamily) ──────────────────────────────
  // Applied as CSS custom properties on the document root rather than inline per-table styles,
  // so every batch panel (each its own <table>, rebuilt per query run) picks it up automatically
  // via app.css's `var(--fb-results-font-size, ...)` fallback -- no re-application needed when a
  // new table is built.

  function applyResultsFont(fontSize, fontFamily) {
    const props = resultsFontProperties(fontSize, fontFamily);
    Object.keys(props).forEach(key => document.documentElement.style.setProperty(key, props[key]));
  }

  $(document).on("keydown", event => {
    if (!activeTableId || !tableActions[activeTableId]) { return; }
    const actions = tableActions[activeTableId];
    const bindings = [
      ["event.toggleEditing", actions.toggleEdit],
      ["event.addRow", actions.addRow],
      ["event.applyChanges", actions.apply],
      ["event.toggleFreezeColumn", actions.freeze],
      ["event.copyAsInsert", actions.copyInsert],
      ["event.copyAsInClause", actions.copyIn],
    ];
    for (const [name, fn] of bindings) {
      if (matchesShortcut(event, parseShortcut(shortcuts[name]))) {
        event.preventDefault();
        fn();
        return;
      }
    }
  });

  window.addEventListener("message", event => {
    const msg = event.data;

    if (msg.command === "batchData") {
      shortcuts = msg.data.shortcuts || {};
      applyResultsFont(msg.data.resultsFontSize, msg.data.resultsFontFamily);
      activeTableId = null;
      renderBatch(msg.data.results, msg.data.recordsPerPage);
      $("body").addClass("loaded");
      return;
    }

    if (msg.command === "message") {
      const data = msg.data;
      shortcuts = data.shortcuts || {};
      applyResultsFont(data.resultsFontSize, data.resultsFontFamily);
      activeTableId = null;
      if (data.tableBody && data.tableBody.length) {
        $("#zero-results").hide();
        showData(data);
      } else {
        $("#zero-results").show();
        $("body").addClass("loaded");
      }
      return;
    }

    if (msg.command === "primaryKey" || msg.command === "applyResult" || msg.command === "queryPlanResult" || msg.command === "actualPlanResult" || msg.command === "pageResult") {
      resolveRequest(msg.data.requestId, msg.data);
      return;
    }
  });

  /**
   * Filter comparisons offered by the grid, in menu order. The `value`s are the operator names the
   * extension host's buildFilteredTableQuery() understands -- it rejects anything it does not
   * recognise, so a typo here fails loudly rather than producing broken SQL.
   */
  const FILTER_OPERATOR_CHOICES = [
    { value: "contains", label: "contains" },
    { value: "equals", label: "=" },
    { value: "notEquals", label: "≠" },
    { value: "startsWith", label: "starts with" },
    { value: "greaterThan", label: ">" },
    { value: "lessThan", label: "<" },
    { value: "isNull", label: "is null" },
    { value: "isNotNull", label: "is not null" },
  ];

  // ── Batch rendering ───────────────────────────────────────────────────────

  function renderBatch(results, recordsPerPage) {
    const $tabBar   = $("#tab-bar");
    const $batchDiv = $("#batch-results");
    $tabBar.empty();
    $batchDiv.empty();
    $("#single-result").hide();

    if (!results || results.length === 0) {
      $batchDiv.html("<p>No results.</p>");
      $tabBar.show();
      return;
    }

    results.forEach((r, i) => {
      // Tab button
      const tabClass = i === 0 ? "fb-tab active" : "fb-tab";
      const badge = r.error ? "⚠" : (r.rowCount != null ? r.rowCount : "✓");
      $tabBar.append(
        $("<button>")
          .addClass(tabClass)
          .attr("data-tab", i)
          .html(`<span class="tab-label">${escHtml(r.sql)}</span><span class="tab-badge">${badge}</span>`)
      );

      // Panel
      const $panel = $("<div>").addClass("batch-panel").attr("id", `panel-${i}`);
      if (i !== 0) { $panel.hide(); }

      const meta = `${r.durationMs} ms` + (r.rowCount ? ` · ${r.rowCount} row(s)` : "");
      $panel.append($("<div>").addClass("result-meta").text(meta));

      const note = truncationNote(r.truncatedFrom, r.rowCount, r.moreRows);
      if (note) { $panel.append($("<div>").addClass("result-message").text(note)); }

      if (r.error) {
        $panel.append($("<div>").addClass("result-error").text(r.error));
      } else if (r.message) {
        $panel.append($("<div>").addClass("result-message").text(r.message));
      } else if (r.tableBody && r.tableBody.length) {
        const tableId = `batch-table-${i}`;
        // The panel must be in the document *before* the grid is built: DataTables measures the
        // table to lay out its scroll container, and a detached one initialises to nothing. The
        // original batch code said so in a comment ("Initialise DataTable after appending to DOM");
        // extracting buildEditableTable() lost the ordering, and with it every batch row.
        $batchDiv.append($panel);
        buildEditableTable($panel, tableId, r.tableHeader, r.tableBody, recordsPerPage, r.editableTable, r.fullSql, r.paging);
        return; // don't fall through to append again
      } else {
        $panel.append($("<div>").addClass("result-message").text("0 rows returned."));
      }

      $batchDiv.append($panel);
    });

    // Tab switching
    $tabBar.off("click", ".fb-tab").on("click", ".fb-tab", function () {
      const idx = $(this).data("tab");
      $(".fb-tab").removeClass("active");
      $(this).addClass("active");
      $(".batch-panel").hide();
      $(`#panel-${idx}`).show();
      activeTableId = `batch-table-${idx}`;
    });

    $tabBar.show();
  }

  // ── Single-result (legacy) ────────────────────────────────────────────────

  function showData(data) {
    $("#batch-results").hide();
    $("#single-result").show();
    const $target = $("#single-result-table").empty();
    // Same disclosure as the batch view: a trimmed result must say so rather than look complete.
    const note = truncationNote(data.truncatedFrom, (data.tableBody || []).length, data.moreRows);
    if (note) { $target.append($("<div>").addClass("result-message").text(note)); }
    buildEditableTable($target, "query-results", data.tableHeader, data.tableBody, data.recordsPerPage, data.editableTable, undefined, data.paging);
    $("body").addClass("loaded");
  }

  // ── Editable result table (shared by both single and batch views) ────────

  function buildEditableTable($container, tableId, headers, tableBody, recordsPerPage, editableTable, sql, paging) {
    const $wrapper = $("<div>").addClass("container batch-table-wrapper");

    const $editToolbar = $("<div>").addClass("edit-toolbar");
    const $tableNameInput = $("<input>")
      .attr("type", "text")
      .attr("placeholder", "Table name")
      .addClass("edit-table-name")
      .val(editableTable || "");
    const $toggleEdit = $("<button>").addClass("btn-toggle-edit").text("Enable Editing");
    const $addRow     = $("<button>").addClass("btn-add-row").text("+ Add Row").hide();
    const $apply       = $("<button>").addClass("btn-apply-changes").text("Apply Changes").hide();
    const $freezeToggle  = $("<button>").addClass("btn-grid-action btn-freeze-col").text("❄ Freeze Column");
    const $viewDiagram  = $("<button>").addClass("btn-grid-action btn-view-diagram").text("🗺 View Table Diagram");
    const $copyInsert    = $("<button>").addClass("btn-grid-action btn-copy-insert").text("Copy as INSERT");
    const $copyInClause  = $("<button>").addClass("btn-grid-action btn-copy-in").text("Copy as IN (...)");
    const $chartToggle  = $("<button>").addClass("btn-grid-action btn-chart-toggle").text("📊 Chart");
    const $textViewToggle = $("<button>").addClass("btn-grid-action btn-text-view-toggle").text("📄 Text View");
    const $selectionStats = $("<span>").addClass("selection-stats");
    const $status       = $("<span>").addClass("edit-status");
    $editToolbar.append($tableNameInput, $toggleEdit, $addRow, $apply, $freezeToggle, $viewDiagram, $copyInsert, $copyInClause, $chartToggle, $textViewToggle, $selectionStats);

    // "🤖 Analyze" and "🧭 Query Plan" only make sense when we actually know the SQL that produced
    // this result set (the single/legacy display() path — predefined actions like Show Table Info
    // — doesn't track it, only batch results from firebird.runQuery do).
    let $planPanel = null;
    if (sql) {
      const $analyzeBtn = $("<button>").addClass("btn-grid-action btn-analyze-results").text("🤖 Analyze");
      $analyzeBtn.on("click", () => {
        $analyzeBtn.prop("disabled", true).text("🤖 Analyzing…");
        vscode.postMessage({
          command: "analyzeResults",
          data: { sql, headers: headers.map(h => h.title), rows: tableBody },
        });
        setTimeout(() => $analyzeBtn.prop("disabled", false).text("🤖 Analyze"), 3000);
      });
      $editToolbar.append($analyzeBtn);

      const $planToggle = $("<button>").addClass("btn-grid-action btn-plan-toggle").text("🧭 Query Plan");
      $planPanel = $("<div>").addClass("fb-plan-panel").hide();
      let planView = null;
      let planRequested = false;
      $planToggle.on("click", () => {
        const shown = $planPanel.toggle().is(":visible");
        $planToggle.toggleClass("active", shown);
        if (!shown) { return; }
        if (!planView) {
          planView = window.FirebirdPlanView.create($planPanel[0], {
            onAnalyze: raw => vscode.postMessage({ command: "analyzePlan", data: { sql, plan: raw } }),
            onGetActualPlan: () => requestFromExtension("getActualPlan", { sql }),
          });
        }
        if (!planRequested) {
          planRequested = true;
          planView.showLoading();
          requestFromExtension("getQueryPlan", { sql }).then(result => planView.show(result));
        }
      });
      $editToolbar.append($planToggle);
    }

    $editToolbar.append($status);

    const $table = $("<table>")
      .attr("id", tableId)
      .addClass("row-border order-column cell-border compact display")
      .css("width", "100%");

    // ── Chart panel (hidden until "📊 Chart" is toggled) ──────────────────────
    const $chartTypeSelect = $("<select>").addClass("chart-type-select").append(
      $("<option>").val("bar").text("Bar"),
      $("<option>").val("line").text("Line"),
      $("<option>").val("pie").text("Pie"),
      $("<option>").val("scatter").text("Scatter")
    );
    const $chartXSelect = $("<select>").addClass("chart-axis-select chart-x-select");
    const $chartYSelect = $("<select>").addClass("chart-axis-select chart-y-select");
    headers.forEach((h, i) => {
      $chartXSelect.append($("<option>").val(i).text(h.title));
      $chartYSelect.append($("<option>").val(i).text(h.title));
    });
    const $chartNote = $("<span>").addClass("chart-note");
    const $chartConfig = $("<div>").addClass("chart-config").append(
      $("<label>").text("Type ").append($chartTypeSelect),
      $("<label>").text(" X-axis ").append($chartXSelect),
      $("<label>").text(" Y-axis ").append($chartYSelect),
      $chartNote
    );
    const $chartContainer = $("<div>").addClass("chart-container");
    const $chartPanel = $("<div>").addClass("chart-panel").append($chartConfig, $chartContainer).hide();

    // Default Y-axis to the first numeric column found, if any — usually what you want charted.
    const numericColumns = detectNumericColumns(headers, tableBody);
    if (numericColumns.length > 0) { $chartYSelect.val(String(numericColumns[0])); }

    // ── Text View panel (hidden until "📄 Text View" is toggled) ──────────────
    const $textViewCopy = $("<button>").addClass("btn-grid-action btn-text-view-copy").text("Copy");
    const $textViewPre = $("<pre>").addClass("text-view-pre");
    const $textViewPanel = $("<div>").addClass("text-view-panel").append(
      $("<div>").addClass("text-view-toolbar").append($textViewCopy),
      $textViewPre
    ).hide();

    // Server-side pager (docs/roadmap/large-result-sets.md, phase 2). Created empty here so it sits
    // above the grid, and populated below once the DataTable it drives exists.
    const $pager = $("<div>").addClass("fb-pager").hide();

    // $planPanel is null when sql is unknown (see above) -- jQuery's append() no-ops on a null arg.
    $wrapper.append($editToolbar, $pager, $table, $chartPanel, $textViewPanel, $planPanel);
    $container.append($wrapper);

    // A leading "actions" column (row-delete toggle) is always present but
    // only shown while editing (toggled via the .fb-editing class — see CSS),
    // so DataTables never needs to be reinitialised when edit mode changes.
    const columns = [{
      title: "",
      orderable: false,
      data: null,
      defaultContent: '<button type="button" class="btn-row-delete" title="Delete row">✕</button>',
      className: "fb-row-actions",
    }].concat(headers);
    const data = tableBody.map(row => [""].concat(row));

    // On $table itself rather than $(`#${tableId}`): an id lookup searches the *document*, so it
    // silently returns nothing if the container has not been attached yet, and DataTables then
    // no-ops on an empty set instead of failing. Belt and braces with the append ordering above.
    const dt = $table.DataTable({
      scrollX: true,
      iDisplayLength: recordsPerPage === "All records" ? -1 : parseInt(recordsPerPage, 10),
      columns,
      data,
      order: [],
      dom: "Bfrtip",
      buttons: buildExportButtons(),
      lengthMenu: [[10, 25, 50, 100, -1], ["10 rows", "25 rows", "50 rows", "100 rows", "Show all"]],
    });

    // pending: array of { type: 'update'|'insert'|'delete', tr, values: Map<colIndex,value>, originalRow? }
    const pending = [];
    let editing = false;
    let pkColumns = [];

    // ── Server-side pager ────────────────────────────────────────────────────
    //
    // Each page is a fresh query with an OFFSET/FETCH window rather than a slice of rows already
    // in memory, so a large table never has to be held here in full. Only the grid's data is
    // swapped -- the columns cannot change between pages of the same statement, so the DataTable,
    // its export buttons, the chart panel and the plan tab all survive a page change untouched.
    if (paging && paging.sql) {
      let offset = paging.offset || 0;
      let hasMore = !!paging.hasMore;
      let shown = tableBody.length;
      let loading = false;
      let applyingRows = false;

      const $prev = $("<button>").addClass("btn-grid-action btn-page-prev").text("‹ Previous");
      const $next = $("<button>").addClass("btn-grid-action btn-page-next").text("Next ›");
      const $label = $("<span>").addClass("fb-page-label");
      const $pageStatus = $("<span>").addClass("fb-page-status");
      $pager.append($prev, $next, $label, $pageStatus).show();

      const warning = pagingOrderWarning(paging.ordered);
      if (warning) {
        $pager.append($("<div>").addClass("fb-page-warning").text(warning));
      }

      // ── Filter and sort push-down (phase 3) ────────────────────────────────
      //
      // Offered only when the statement is a plain whole-table SELECT, which the extension host
      // decides -- filtering anything else would mean rewriting the user's own query. The controls
      // send column/operator/value, never SQL: the statement is built on the extension side, where
      // identifiers are validated and values are bound as parameters.
      let filters = [];
      let sort = null;
      if (paging.filterTable) {
        const $filterColumn = $("<select>").addClass("fb-filter-column");
        headers.forEach(h => $filterColumn.append($("<option>").val(h.title).text(h.title)));
        const $filterOperator = $("<select>").addClass("fb-filter-operator");
        FILTER_OPERATOR_CHOICES.forEach(choice =>
          $filterOperator.append($("<option>").val(choice.value).text(choice.label))
        );
        const $filterValue = $("<input>").attr("type", "text").attr("placeholder", "Filter value").addClass("fb-filter-value");
        const $filterApply = $("<button>").addClass("btn-grid-action btn-filter-apply").text("Filter");
        const $filterClear = $("<button>").addClass("btn-grid-action btn-filter-clear").text("Clear");

        const readFilters = () => {
          const operator = String($filterOperator.val());
          const value = String($filterValue.val());
          const needsValue = operator !== "isNull" && operator !== "isNotNull";
          if (needsValue && !value) { return []; }
          return [{ column: String($filterColumn.val()), operator, value: needsValue ? value : undefined }];
        };

        const applyFilters = () => {
          filters = readFilters();
          // Back to the first page: the row at offset 900 of the unfiltered table is not the row at
          // offset 900 of the filtered one, and keeping the offset would land somewhere arbitrary.
          goTo(0);
        };

        $filterApply.on("click", applyFilters);
        $filterValue.on("keydown", event => { if (event.key === "Enter") { applyFilters(); } });
        $filterClear.on("click", () => { $filterValue.val(""); filters = []; goTo(0); });
        // Toggling to a null check makes the value box meaningless -- hide it rather than leave a
        // box whose contents are silently ignored.
        $filterOperator.on("change", () => {
          const operator = String($filterOperator.val());
          $filterValue.toggle(operator !== "isNull" && operator !== "isNotNull");
        });

        $pager.append(
          $("<div>").addClass("fb-filter-row").append(
            $("<span>").addClass("fb-filter-label").text("Filter the whole table:"),
            $filterColumn, $filterOperator, $filterValue, $filterApply, $filterClear
          )
        );

        // Sorting a column header re-queries rather than reordering the page. DataTables sorts the
        // page client-side as well, which is harmless -- the rows are replaced by the response.
        dt.on("order.dt", () => {
          if (loading || applyingRows) { return; } // our own draw(), not a user-initiated sort
          const order = dt.order();
          if (!order || !order.length) { return; }
          // Column 0 is the row-delete button, so header i maps to headers[i - 1].
          const header = headers[order[0][0] - 1];
          if (!header) { return; }
          const next = { column: header.title, descending: order[0][1] === "desc" };
          if (sort && sort.column === next.column && sort.descending === next.descending) { return; }
          sort = next;
          goTo(0);
        });
      }

      function refreshPager() {
        $label.text(pageRangeLabel(offset, shown, hasMore));
        $prev.prop("disabled", loading || offset <= 0);
        $next.prop("disabled", loading || !hasMore);
      }

      function goTo(nextOffset) {
        if (loading || nextOffset < 0) { return; }
        // A page change replaces every row in the grid, which would silently discard edits queued
        // against rows that are about to disappear. Refusing the move -- and saying why -- is the
        // honest option. Checked here rather than by disabling the buttons because `pending` is
        // mutated from eight places, and a disabled state that forgets to refresh is worse than
        // none at all.
        if (pending.length > 0) {
          $pageStatus.text("Apply or discard your changes before changing page.");
          return;
        }
        loading = true;
        refreshPager();
        $pageStatus.text("Fetching…");
        const request = { sql: paging.sql, offset: nextOffset };
        if (paging.filterTable) {
          request.table = paging.filterTable;
          request.filters = filters;
          if (sort) { request.sort = sort; }
        }
        requestFromExtension("fetchPage", request).then(result => {
          loading = false;
          if (result.error) {
            $pageStatus.text(result.error);
            refreshPager();
            return;
          }
          offset = result.offset;
          hasMore = !!result.hasMore;
          shown = (result.tableBody || []).length;
          // Swapping the rows must not look like a user sorting a column, or a fetch would
          // trigger another fetch.
          applyingRows = true;
          try {
            dt.clear();
            dt.rows.add((result.tableBody || []).map(row => [""].concat(row)));
            dt.draw();
          } finally {
            applyingRows = false;
          }
          refreshPager();
        });
      }

      $prev.on("click", () => goTo(offset - paging.pageSize));
      $next.on("click", () => goTo(offset + paging.pageSize));
      refreshPager();
    }

    function findPending(tr) {
      return pending.find(p => p.tr === tr);
    }

    function columnNames() {
      return headers.map(h => h.title);
    }

    // ── Cell selection (for "Copy as INSERT" / "Copy as IN (...)") ───────────
    // Disabled while editing: cells are contenteditable there, so a mousedown
    // drag is expected to place a text cursor / select text, not cells.
    let selAnchor = null; // { tr, colIndex }
    let selEnd = null;
    let selecting = false;

    function cellColIndex($td) {
      return $td.index() - 1; // account for the leading actions column
    }

    function clearSelection() {
      $(`#${tableId} td.fb-selected`).removeClass("fb-selected");
      selAnchor = null;
      selEnd = null;
      $selectionStats.text("");
    }

    function highlightSelection() {
      $(`#${tableId} td.fb-selected`).removeClass("fb-selected");
      if (!selAnchor || !selEnd) { return; }
      const $rows = $(`#${tableId} tbody tr`);
      const range = selectionRange(
        { row: $rows.index(selAnchor.tr), col: selAnchor.colIndex },
        { row: $rows.index(selEnd.tr), col: selEnd.colIndex }
      );
      $rows.slice(range.rowStart, range.rowEnd + 1).each(function () {
        $(this).find("td:not(.fb-row-actions)").each(function () {
          const c = cellColIndex($(this));
          if (c >= range.colStart && c <= range.colEnd) { $(this).addClass("fb-selected"); }
        });
      });
      // Selection aggregations (docs/roadmap/query-results-enhancements.md, phase 2): recomputed
      // here rather than at each caller, since every selection change funnels through this
      // function already.
      const sel = getSelectedGrid();
      $selectionStats.text(sel ? formatSelectionStats(computeSelectionStats(sel.rows)) : "");
    }

    function getSelectedGrid() {
      if (!selAnchor || !selEnd) { return null; }
      const $rows = $(`#${tableId} tbody tr`);
      const range = selectionRange(
        { row: $rows.index(selAnchor.tr), col: selAnchor.colIndex },
        { row: $rows.index(selEnd.tr), col: selEnd.colIndex }
      );
      const rows = $rows.slice(range.rowStart, range.rowEnd + 1).map(function () {
        const rowValues = [];
        $(this).find("td:not(.fb-row-actions)").each(function () {
          const c = cellColIndex($(this));
          if (c >= range.colStart && c <= range.colEnd) { rowValues.push($(this).text()); }
        });
        return rowValues;
      }).get();
      return { rows, colStart: range.colStart, colEnd: range.colEnd };
    }

    $(`#${tableId} tbody`).on("mousedown", "td:not(.fb-row-actions)", function (e) {
      if (editing) { return; }
      const tr = $(this).closest("tr")[0];
      const colIndex = cellColIndex($(this));
      if (e.shiftKey && selAnchor) {
        selEnd = { tr, colIndex };
      } else {
        selAnchor = { tr, colIndex };
        selEnd = { tr, colIndex };
        selecting = true;
      }
      highlightSelection();
      e.preventDefault();
    });

    $(`#${tableId} tbody`).on("mouseenter", "td:not(.fb-row-actions)", function () {
      if (!selecting) { return; }
      selEnd = { tr: $(this).closest("tr")[0], colIndex: cellColIndex($(this)) };
      highlightSelection();
    });

    // Namespaced + re-bound (rather than a bare document-level .on()) so
    // repeated buildEditableTable() calls for the same tableId (a batch panel
    // re-rendered on every query run) don't pile up duplicate handlers.
    $(document).off(`mouseup.fbSelect-${tableId}`).on(`mouseup.fbSelect-${tableId}`, () => {
      selecting = false;
    });

    // ── Row actions (delegated so they survive DataTables redraws) ─────────

    $(`#${tableId} tbody`).on("click", ".btn-row-delete", function () {
      if (!editing) { return; }
      const tr = $(this).closest("tr")[0];
      const existing = findPending(tr);

      if (existing && existing.type === "insert") {
        // Discard an unsaved new row entirely.
        dt.row(tr).remove().draw(false);
        pending.splice(pending.indexOf(existing), 1);
        return;
      }
      if (existing && existing.type === "delete") {
        // Un-mark: restore editing on this row.
        pending.splice(pending.indexOf(existing), 1);
        $(tr).removeClass("fb-row-deleted");
        $(tr).find("td:not(.fb-row-actions)").attr("contenteditable", "true");
        return;
      }
      // Mark for deletion — supersedes any pending (unsaved) edit on this row.
      if (existing && existing.type === "update") {
        pending.splice(pending.indexOf(existing), 1);
      }
      const rowData = dt.row(tr).data();
      pending.push({ type: "delete", tr, originalRow: rowData.slice(1) });
      $(tr).addClass("fb-row-deleted");
      $(tr).find("td:not(.fb-row-actions)").removeAttr("contenteditable").removeClass("fb-dirty");
    });

    $(`#${tableId} tbody`).on("input", "td.fb-editable", function () {
      const tr = $(this).closest("tr")[0];
      const colIndex = $(this).index() - 1; // account for the actions column
      const newValue = $(this).text();
      let entry = findPending(tr);
      if (!entry) {
        entry = { type: "update", tr, values: new Map(), originalRow: dt.row(tr).data().slice(1) };
        pending.push(entry);
      }
      entry.values.set(colIndex, newValue);
      $(this).addClass("fb-dirty");
    });

    // ── Toolbar ──────────────────────────────────────────────────────────────

    $toggleEdit.on("click", async () => {
      editing = !editing;
      $toggleEdit.text(editing ? "Disable Editing" : "Enable Editing");
      $addRow.toggle(editing);
      $apply.toggle(editing);
      $wrapper.toggleClass("fb-editing", editing);
      clearSelection();

      if (!editing) {
        // Discard any unapplied inserts and restore the grid.
        pending.filter(p => p.type === "insert").forEach(p => dt.row(p.tr).remove());
        dt.draw(false);
        pending.length = 0;
        $(`#${tableId} td[contenteditable]`).removeAttr("contenteditable").removeClass("fb-editable fb-dirty");
        $(`#${tableId} tr`).removeClass("fb-row-deleted");
        $status.text("");
        return;
      }

      $(`#${tableId} tbody td:not(.fb-row-actions)`).attr("contenteditable", "true").addClass("fb-editable");

      const tableName = $tableNameInput.val();
      if (tableName) {
        $status.text("Looking up primary key…");
        const result = await requestFromExtension("getPrimaryKey", { tableName });
        pkColumns = result.columns || [];
        $status.text(pkColumns.length
          ? `Primary key: ${pkColumns.join(", ")}`
          : "No primary key found — matching on all columns.");
      } else {
        $status.text("Enter a table name to enable safe row targeting.");
      }
    });

    $addRow.on("click", () => {
      const blankRow = ["", ...new Array(headers.length).fill("")];
      // .draw() before .node(): DataTables only builds a row's DOM node once it's been drawn.
      const tr = dt.row.add(blankRow).draw(false).node();
      dt.page("last").draw(false); // new rows land at the end — jump there so it's actually visible
      $(tr).addClass("fb-row-inserted");
      $(tr).find("td:not(.fb-row-actions)").attr("contenteditable", "true").addClass("fb-editable");
      pending.push({ type: "insert", tr, values: new Map() });
    });

    $apply.on("click", async () => {
      if (pending.length === 0) {
        $status.text("No changes to apply.");
        return;
      }
      const tableName = $tableNameInput.val();
      if (!tableName) {
        $status.text("Enter a table name before applying changes.");
        return;
      }

      const changes = pending.map(p => {
        const change = { type: p.type };
        if (p.originalRow) { change.originalRow = p.originalRow; }
        if (p.values) { change.values = Array.from(p.values, ([colIndex, value]) => ({ colIndex, value })); }
        return change;
      });

      $apply.prop("disabled", true);
      $status.text("Applying changes…");
      const result = await requestFromExtension("applyChanges", { tableName, columns: columnNames(), changes });
      $apply.prop("disabled", false);

      if (result.cancelled) {
        $status.text("Cancelled.");
        return;
      }

      const results = result.results || [];
      const stillPending = [];
      results.forEach((r, i) => {
        const entry = pending[i];
        if (!entry) { return; }
        if (r.error) {
          $(entry.tr).addClass("fb-row-error").attr("title", r.error);
          stillPending.push(entry);
          return;
        }
        // Applied successfully: clear this row's pending/dirty markers.
        if (entry.type === "delete") {
          dt.row(entry.tr).remove();
        } else {
          $(entry.tr).removeClass("fb-row-inserted fb-row-error").removeAttr("title");
          $(entry.tr).find("td.fb-dirty").removeClass("fb-dirty");
        }
      });
      dt.draw(false);
      pending.length = 0;
      stillPending.forEach(p => pending.push(p));
      clearSelection(); // rows may have been removed; stale tr references are no longer meaningful

      const failedCount = results.filter(r => r.error).length;
      $status.text(failedCount
        ? `${failedCount} of ${results.length} change(s) failed — see highlighted rows.`
        : `Applied ${results.length} change(s).`);
    });

    // ── Freeze column / copy selection ────────────────────────────────────────

    $freezeToggle.on("click", () => {
      const frozen = $wrapper.toggleClass("fb-frozen").hasClass("fb-frozen");
      $freezeToggle.toggleClass("active", frozen);
      $freezeToggle.text(frozen ? "❄ Unfreeze Column" : "❄ Freeze Column");
    });

    // "🗺 View Table Diagram" (docs/roadmap/query-results-enhancements.md, phase 5): opens the
    // existing Schema Designer webview, pre-focused on the table currently entered above --
    // extension-host side (ResultView#handleMessage()) resolves the actual connection, since the
    // webview itself only ever knows a table *name*, not any ConnectionOptions.
    $viewDiagram.on("click", () => {
      const tableName = $tableNameInput.val();
      if (!tableName) { $status.text("Enter a table name first."); return; }
      vscode.postMessage({ command: "viewTableDiagram", data: { tableName } });
    });

    $copyInsert.on("click", () => {
      const sel = getSelectedGrid();
      if (!sel) { $status.text("Select one or more cells first."); return; }
      const tableName = $tableNameInput.val() || "table_name";
      const cols = headers.slice(sel.colStart, sel.colEnd + 1).map(h => h.title);
      const stmts = sel.rows.map(values => buildInsertStatement(tableName, cols, values));
      copyToClipboard(stmts.join("\n"));
      $status.text(`Copied ${stmts.length} INSERT statement(s) to the clipboard.`);
    });

    $copyInClause.on("click", () => {
      const sel = getSelectedGrid();
      if (!sel) { $status.text("Select one or more cells first."); return; }
      const values = [];
      sel.rows.forEach(row => row.forEach(v => values.push(v)));
      copyToClipboard(buildInClause(values));
      $status.text(`Copied an IN (...) clause with ${values.length} value(s) to the clipboard.`);
    });

    // ── Chart panel ──────────────────────────────────────────────────────────
    // Renders straight from the original tableBody/headers (not DataTables' current
    // sort/filter/page state) — a deliberate scope cut for a first pass; capped to the
    // first CHART_MAX_ROWS rows so a huge result set doesn't produce an unreadable chart.
    const CHART_MAX_ROWS = 200;

    function renderChart() {
      const type = $chartTypeSelect.val();
      const xIndex = parseInt($chartXSelect.val(), 10);
      const yIndex = parseInt($chartYSelect.val(), 10);
      const rows = tableBody.slice(0, CHART_MAX_ROWS);
      const labels = rows.map(r => r[xIndex]);
      const yValues = rows.map(r => Number(r[yIndex]));

      if (yValues.some(v => Number.isNaN(v))) {
        $chartContainer.html('<p class="chart-error">The selected Y-axis column isn\'t numeric.</p>');
        $chartNote.text("");
        return;
      }

      let svg;
      if (type === "bar") {
        svg = buildBarChartSvg(labels, yValues);
      } else if (type === "line") {
        svg = buildLineChartSvg(labels, yValues);
      } else if (type === "pie") {
        svg = buildPieChartSvg(labels, yValues);
      } else {
        const xValues = rows.map(r => Number(r[xIndex]));
        if (xValues.some(v => Number.isNaN(v))) {
          $chartContainer.html('<p class="chart-error">Scatter charts need a numeric X-axis column too.</p>');
          $chartNote.text("");
          return;
        }
        svg = buildScatterChartSvg(xValues, yValues);
      }
      $chartContainer.html(svg);
      $chartNote.text(tableBody.length > CHART_MAX_ROWS ? `Showing first ${CHART_MAX_ROWS} of ${tableBody.length} rows.` : "");
    }

    $chartToggle.on("click", () => {
      const shown = $chartPanel.toggle().is(":visible");
      $chartToggle.toggleClass("active", shown);
      if (shown) { renderChart(); }
    });
    $chartTypeSelect.on("change", renderChart);
    $chartXSelect.on("change", renderChart);
    $chartYSelect.on("change", renderChart);

    // ── Text View toggle ────────────────────────────────────────────────────

    $textViewToggle.on("click", () => {
      const shown = $textViewPanel.toggle().is(":visible");
      $textViewToggle.toggleClass("active", shown);
      if (shown) { $textViewPre.text(buildTextView(headers, tableBody)); }
    });

    $textViewCopy.on("click", () => {
      copyToClipboard($textViewPre.text());
      $status.text("Copied the text view to the clipboard.");
    });

    // Registered for firebird.shortcuts dispatch; first table built becomes the
    // default active one (tab 0), later ones only via an explicit tab click.
    tableActions[tableId] = {
      toggleEdit: () => $toggleEdit.trigger("click"),
      addRow: () => { if (editing) { $addRow.trigger("click"); } },
      apply: () => { if (editing) { $apply.trigger("click"); } },
      freeze: () => $freezeToggle.trigger("click"),
      copyInsert: () => $copyInsert.trigger("click"),
      copyIn: () => $copyInClause.trigger("click"),
    };
    if (!activeTableId) { activeTableId = tableId; }
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  // The leading row-actions column (delete-toggle button) is a UI-only
  // affordance and must never appear in exported data.
  const EXPORT_OPTIONS = { columns: ":not(.fb-row-actions)" };

  function buildExportButtons() {
    return [
      "pageLength",
      {
        extend: "colvis",
        text: "Columns",
        columns: ":gt(0)", // exclude the leading, always-index-0 actions column from the picker
      },
      {
        extend: "collection",
        text: "Export data",
        autoClose: true,
        buttons: [
          {
            text: "as JSON",
            action: function (e, dt) {
              var exportData = dt.buttons.exportData(EXPORT_OPTIONS);
              $.fn.dataTable.fileSave(new Blob([JSON.stringify(exportData)]), "Export.json");
            },
            title: "Data export",
            titleAttr: "Export data to .json file.",
          },
          { extend: "csv",   text: "as CSV",  title: "Data export", exportOptions: EXPORT_OPTIONS },
          { extend: "excel", text: "as XLSX", title: "Data export", exportOptions: EXPORT_OPTIONS },
          { extend: "pdf",   text: "as PDF",  title: "Data export", exportOptions: EXPORT_OPTIONS },
        ],
      },
    ];
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Copy-selection-as-SQL helpers (pure — no DOM/jQuery) ────────────────────

  function sqlLiteral(value) {
    if (value === null || value === undefined || value === "") { return "NULL"; }
    if (/^-?\d+(\.\d+)?$/.test(value)) { return value; }
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  function buildInsertStatement(tableName, columns, values) {
    return `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")});`;
  }

  function buildInClause(values) {
    return `IN (${values.map(sqlLiteral).join(", ")})`;
  }

  // ── Text View (plain-text rendering of a result set) ───────────────────────
  // Renders the *original* headers/rows (not DataTables' current sort/filter/page state), the
  // same deliberate scope cut the chart panel above already established for the same reason:
  // a second, independent presentation of the query's actual result set, not a live mirror of
  // grid interaction state.

  const TEXT_VIEW_NULL = "NULL";
  const TEXT_VIEW_COLUMN_SEP = " | ";

  function textViewCell(value) {
    return value === null || value === undefined ? TEXT_VIEW_NULL : String(value);
  }

  /** Tab-client-style aligned plain text: a header row, a dashed separator, then one line per row. */
  function buildTextView(headers, rows) {
    const titles = headers.map(h => h.title);
    const widths = titles.map((title, colIndex) => {
      const cellWidths = rows.map(row => textViewCell(row[colIndex]).length);
      return Math.max(title.length, ...cellWidths);
    });
    const padCell = (str, width) => str + " ".repeat(Math.max(0, width - str.length));
    const formatRow = cells => cells.map((cell, i) => padCell(cell, widths[i])).join(TEXT_VIEW_COLUMN_SEP);

    const headerLine = formatRow(titles);
    const sepLine = widths.map(w => "-".repeat(w)).join("-+-");
    const dataLines = rows.map(row => formatRow(titles.map((_t, i) => textViewCell(row[i]))));

    return [headerLine, sepLine, ...dataLines].join("\n");
  }

  // ── Grid font customization (pure: CSS custom properties from settings values) ─────────────

  /** Returns CSS custom properties to set — {} when both settings are unset (0 / ""), meaning
   *  "use the webview's own default," matching app.css's own var(...) fallback values. */
  function resultsFontProperties(fontSize, fontFamily) {
    const props = {};
    if (fontSize) { props["--fb-results-font-size"] = `${fontSize}px`; }
    if (fontFamily) { props["--fb-results-font-family"] = fontFamily; }
    return props;
  }

  // ── Selection aggregations (status-bar readout for a cell-range selection) ─
  // Aggregates over whatever numeric-looking cells are actually in the selection, not requiring
  // an entire column to be numeric first (unlike detectNumericColumns(), which decides whether a
  // whole column is chart-worthy) — closer to how a spreadsheet's own selection status bar
  // behaves, and more useful for a selection spanning several columns of mixed types.

  /** Returns { count, numericCount, sum, avg, min, max } — the last four only set when numericCount > 0. */
  function computeSelectionStats(rows) {
    const numericRe = /^-?\d+(\.\d+)?$/;
    let count = 0;
    const numericValues = [];
    rows.forEach(row => row.forEach(cell => {
      count++;
      const trimmed = String(cell).trim();
      if (numericRe.test(trimmed)) { numericValues.push(Number(trimmed)); }
    }));
    const stats = { count, numericCount: numericValues.length };
    if (numericValues.length > 0) {
      stats.sum = numericValues.reduce((a, b) => a + b, 0);
      stats.avg = stats.sum / numericValues.length;
      stats.min = Math.min(...numericValues);
      stats.max = Math.max(...numericValues);
    }
    return stats;
  }

  /** Rounds to at most 2 decimal places, without padding a whole number with trailing zeros. */
  function formatSelectionNumber(n) {
    return String(Math.round(n * 100) / 100);
  }

  function formatSelectionStats(stats) {
    if (!stats || stats.count === 0) { return ""; }
    let text = `Count: ${stats.count}`;
    if (stats.numericCount > 0) {
      text += `  Sum: ${formatSelectionNumber(stats.sum)}` +
        `  Avg: ${formatSelectionNumber(stats.avg)}` +
        `  Min: ${formatSelectionNumber(stats.min)}` +
        `  Max: ${formatSelectionNumber(stats.max)}`;
    }
    return text;
  }

  /** Normalizes an (anchor, end) pair of {row,col} points into an inclusive rectangle. */
  function selectionRange(anchor, end) {
    return {
      rowStart: Math.min(anchor.row, end.row),
      rowEnd: Math.max(anchor.row, end.row),
      colStart: Math.min(anchor.col, end.col),
      colEnd: Math.max(anchor.col, end.col),
    };
  }

  // ── Shortcut parsing (pure — no DOM/jQuery) ─────────────────────────────────
  // Combo syntax mirrors vscode-mssql's own "mssql.shortcuts", not VS Code's
  // keybindings.json syntax: "+"-joined modifiers, "ctrlcmd" meaning Ctrl on
  // Windows/Linux and Cmd on macOS.

  function parseShortcut(combo) {
    if (!combo || typeof combo !== "string") { return null; }
    const parts = combo.toLowerCase().split("+").map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) { return null; }
    const key = parts[parts.length - 1];
    const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform || "");
    const parsed = { key, ctrl: false, alt: false, shift: false, meta: false };
    parts.slice(0, -1).forEach(mod => {
      if (mod === "ctrlcmd") {
        if (isMac) { parsed.meta = true; } else { parsed.ctrl = true; }
      } else if (mod === "ctrl" || mod === "control") {
        parsed.ctrl = true;
      } else if (mod === "cmd" || mod === "command" || mod === "meta" || mod === "win") {
        parsed.meta = true;
      } else if (mod === "alt" || mod === "option") {
        parsed.alt = true;
      } else if (mod === "shift") {
        parsed.shift = true;
      }
    });
    return parsed;
  }

  function matchesShortcut(event, parsed) {
    if (!parsed) { return false; }
    return (event.key || "").toLowerCase() === parsed.key
      && !!event.ctrlKey === parsed.ctrl
      && !!event.altKey === parsed.alt
      && !!event.shiftKey === parsed.shift
      && !!event.metaKey === parsed.meta;
  }

  // ── Chart rendering (pure — no DOM/jQuery; builds an SVG markup string) ─────
  // Hand-rolled rather than a vendored charting library, matching this repo's convention
  // (schema-designer's canvas, query-plan-view's diagram) of avoiding a new dependency for a
  // few SVG shapes.

  const CHART_WIDTH = 600;
  const CHART_HEIGHT = 360;
  const CHART_PADDING = 40;
  const CHART_COLOR = "#4a90d9";
  const CHART_PALETTE = ["#4a90d9", "#d94a4a", "#4ad97a", "#d9c94a", "#a94ad9", "#4ad9d0", "#d97a4a"];

  function chartEscapeXml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Returns the header titles of every column whose non-empty values are all numeric. */
  function detectNumericColumns(headers, rows) {
    const numericRe = /^-?\d+(\.\d+)?$/;
    const indices = [];
    headers.forEach((_h, colIndex) => {
      const values = rows.map(r => r[colIndex]).filter(v => v !== undefined && v !== null && v !== "");
      if (values.length > 0 && values.every(v => numericRe.test(String(v).trim()))) {
        indices.push(colIndex);
      }
    });
    return indices;
  }

  function chartAxes(width, height) {
    return `<line x1="${CHART_PADDING}" y1="${CHART_PADDING}" x2="${CHART_PADDING}" y2="${height - CHART_PADDING}" stroke="currentColor" />` +
      `<line x1="${CHART_PADDING}" y1="${height - CHART_PADDING}" x2="${width - CHART_PADDING}" y2="${height - CHART_PADDING}" stroke="currentColor" />`;
  }

  function buildBarChartSvg(labels, values, options) {
    const width = (options && options.width) || CHART_WIDTH;
    const height = (options && options.height) || CHART_HEIGHT;
    const plotWidth = width - CHART_PADDING * 2;
    const plotHeight = height - CHART_PADDING * 2;
    const maxValue = Math.max(0, ...values) || 1;
    const slot = values.length > 0 ? plotWidth / values.length : plotWidth;
    const barWidth = slot * 0.7;

    const bars = values.map((v, i) => {
      const barHeight = (v / maxValue) * plotHeight;
      const x = CHART_PADDING + i * slot + (slot - barWidth) / 2;
      const y = CHART_PADDING + plotHeight - barHeight;
      const label = chartEscapeXml(labels[i] != null ? labels[i] : "");
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${CHART_COLOR}"><title>${label}: ${v}</title></rect>`;
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%">${chartAxes(width, height)}${bars}</svg>`;
  }

  function buildLineChartSvg(labels, values, options) {
    const width = (options && options.width) || CHART_WIDTH;
    const height = (options && options.height) || CHART_HEIGHT;
    const plotWidth = width - CHART_PADDING * 2;
    const plotHeight = height - CHART_PADDING * 2;
    const maxValue = Math.max(0, ...values);
    const minValue = Math.min(0, ...values);
    const range = (maxValue - minValue) || 1;
    const step = values.length > 1 ? plotWidth / (values.length - 1) : 0;

    const points = values.map((v, i) => {
      const x = CHART_PADDING + i * step;
      const y = CHART_PADDING + plotHeight - ((v - minValue) / range) * plotHeight;
      return { x, y, label: labels[i], value: v };
    });
    const path = "M " + points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
    const circles = points.map(p => {
      const label = chartEscapeXml(p.label != null ? p.label : "");
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${CHART_COLOR}"><title>${label}: ${p.value}</title></circle>`;
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%">${chartAxes(width, height)}` +
      `<path d="${path}" fill="none" stroke="${CHART_COLOR}" stroke-width="2" />${circles}</svg>`;
  }

  function buildPieChartSvg(labels, values, options) {
    const width = (options && options.width) || CHART_WIDTH;
    const height = (options && options.height) || CHART_HEIGHT;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2 - CHART_PADDING;
    const total = values.reduce((a, b) => a + b, 0) || 1;

    let angle = -Math.PI / 2; // 12 o'clock
    const slices = values.map((v, i) => {
      const sliceAngle = (v / total) * Math.PI * 2;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const endAngle = angle + sliceAngle;
      const x2 = cx + radius * Math.cos(endAngle);
      const y2 = cy + radius * Math.sin(endAngle);
      const largeArc = sliceAngle > Math.PI ? 1 : 0;
      const path = `M ${cx.toFixed(1)},${cy.toFixed(1)} L ${x1.toFixed(2)},${y1.toFixed(2)} A ${radius.toFixed(1)},${radius.toFixed(1)} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
      angle = endAngle;
      const color = CHART_PALETTE[i % CHART_PALETTE.length];
      const label = chartEscapeXml(labels[i] != null ? labels[i] : "");
      return `<path d="${path}" fill="${color}"><title>${label}: ${v}</title></path>`;
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%">${slices}</svg>`;
  }

  function buildScatterChartSvg(xValues, yValues, options) {
    const width = (options && options.width) || CHART_WIDTH;
    const height = (options && options.height) || CHART_HEIGHT;
    const plotWidth = width - CHART_PADDING * 2;
    const plotHeight = height - CHART_PADDING * 2;
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;

    const points = xValues.map((x, i) => {
      const y = yValues[i];
      const px = CHART_PADDING + ((x - minX) / rangeX) * plotWidth;
      const py = CHART_PADDING + plotHeight - ((y - minY) / rangeY) * plotHeight;
      return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${CHART_COLOR}"><title>(${x}, ${y})</title></circle>`;
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%">${chartAxes(width, height)}${points}</svg>`;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const $ta = $("<textarea>").val(text).css({ position: "fixed", left: "-9999px", top: "0" }).appendTo("body");
    $ta[0].select();
    document.execCommand("copy");
    $ta.remove();
  }

  /**
   * The note shown when `firebird.maxResultRows` trimmed a result.
   *
   * Returns "" when nothing was dropped, so callers can append unconditionally. Pure, so it is
   * unit-testable the same way every other function in this hook is — the point of the note is
   * that a partial result is *stated* rather than silently displayed, which is exactly the
   * behaviour worth pinning down with a test.
   */
  function truncationNote(truncatedFrom, shown, moreRows) {
    if (truncatedFrom && truncatedFrom > shown) {
      return `Showing the first ${shown} of ${truncatedFrom} rows — raise or disable the limit with the "firebird.maxResultRows" setting.`;
    }
    // The total is unknown here: the statement asked the server for one row more than it shows and
    // got it, which proves there are more without saying how many. Claiming a total would be a lie,
    // and saying nothing would let a trimmed result look complete.
    if (moreRows) {
      return `Showing the first ${shown} rows — there are more. Raise or disable the limit with the "firebird.maxResultRows" setting.`;
    }
    return "";
  }

  /**
   * Label for the server-side pager: which rows of the whole result are on screen.
   *
   * Says "of more" rather than a total because no COUNT(*) is issued -- see the extension side's
   * handleFetchPage(). Ranges are 1-based because they are read by people, not by code.
   */
  function pageRangeLabel(offset, shown, hasMore) {
    if (!shown) { return "No rows at this offset"; }
    const range = `Rows ${offset + 1}–${offset + shown}`;
    return hasMore ? `${range} of more` : `${range} of ${offset + shown}`;
  }

  /** Warning shown alongside the pager when the statement has no ORDER BY. */
  function pagingOrderWarning(ordered) {
    if (ordered) { return ""; }
    return "This query has no ORDER BY, so Firebird may return its rows in a different order each time — pages can overlap or skip rows. Add an ORDER BY for a stable window.";
  }

  // Test-only hook: no-op in a real webview (there is no `module` global there).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports.__test__ = {
      sqlLiteral, buildInsertStatement, buildInClause, selectionRange,
      parseShortcut, matchesShortcut,
      detectNumericColumns, buildBarChartSvg, buildLineChartSvg, buildPieChartSvg, buildScatterChartSvg,
      buildTextView, truncationNote, pageRangeLabel, pagingOrderWarning, FILTER_OPERATOR_CHOICES,
      computeSelectionStats, formatSelectionStats,
      resultsFontProperties,
    };
  }
});
