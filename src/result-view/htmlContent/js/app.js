$(() => {
  const vscode = acquireVsCodeApi();

  vscode.postMessage({ command: "getData", data: {} });

  window.addEventListener("message", event => {
    const msg = event.data;

    if (msg.command === "batchData") {
      renderBatch(msg.data.results, msg.data.recordsPerPage);
      $("body").addClass("loaded");
      return;
    }

    if (msg.command === "message") {
      const data = msg.data;
      if (data.tableBody && data.tableBody.length) {
        $("#zero-results").hide();
        showData(data);
      } else {
        $("#zero-results").show();
        $("body").addClass("loaded");
      }
      return;
    }

    if (msg.command === "updateSql") {
      showUpdateModal(msg.data.sql);
      return;
    }
  });

  // ── Update-SQL modal helpers ──────────────────────────────────────────────

  $("#btn-close-modal").on("click", () => { $("#update-modal").hide(); });
  $("#btn-copy-update").on("click", () => {
    const text = $("#update-sql-text").text();
    navigator.clipboard.writeText(text).catch(() => {});
  });

  function showUpdateModal(sql) {
    $("#update-sql-text").text(sql);
    $("#update-modal").show();
  }

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

      if (r.error) {
        $panel.append($("<div>").addClass("result-error").text(r.error));
      } else if (r.message) {
        $panel.append($("<div>").addClass("result-message").text(r.message));
      } else if (r.tableBody && r.tableBody.length) {
        const tableId = `batch-table-${i}`;
        const $wrapper = $("<div>").addClass("container batch-table-wrapper");
        const $editToolbar = $("<div>").addClass("edit-toolbar").hide();
        const $tableNameInput = $("<input>")
          .attr("type", "text")
          .attr("placeholder", "Table name (for UPDATE generation)")
          .addClass("edit-table-name");
        const $toggleEdit = $("<button>").addClass("btn-toggle-edit").text("Enable Editing");
        const $genUpdate  = $("<button>").addClass("btn-gen-update").text("Generate UPDATE").hide();
        $editToolbar.append($tableNameInput, $toggleEdit, $genUpdate);

        const $table = $("<table>")
          .attr("id", tableId)
          .addClass("row-border order-column cell-border compact display")
          .css("width", "100%");
        $wrapper.append($editToolbar, $table);
        $panel.append($wrapper);

        $batchDiv.append($panel);

        // Initialise DataTable after appending to DOM
        const dt = $(`#${tableId}`).DataTable({
          scrollX: true,
          iDisplayLength: recordsPerPage === "All records" ? -1 : parseInt(recordsPerPage, 10),
          columns: r.tableHeader,
          data: r.tableBody,
          order: [],
          dom: "Bfrtip",
          buttons: buildExportButtons(),
          lengthMenu: [[10, 25, 50, 100, -1], ["10 rows", "25 rows", "50 rows", "100 rows", "Show all"]],
        });

        // Editable grid logic
        let editMode = false;
        let originalRowData = null;
        let changedFields   = [];

        $toggleEdit.on("click", () => {
          editMode = !editMode;
          $toggleEdit.text(editMode ? "Disable Editing" : "Enable Editing");
          $genUpdate.toggle(editMode);
          if (!editMode) {
            // restore table cells
            $(`#${tableId} td[contenteditable]`).removeAttr("contenteditable").removeClass("fb-editable");
            changedFields = [];
          } else {
            makeCellsEditable($(`#${tableId}`), r.tableHeader, changedFields, $genUpdate);
          }
        });

        $genUpdate.on("click", () => {
          const tblName = $tableNameInput.val() || "";
          vscode.postMessage({
            command: "generateUpdate",
            data: {
              tableName: tblName,
              originalRow: originalRowData || [],
              changedFields: changedFields,
              columns: r.tableHeader.map(h => h.title),
            },
          });
        });

        // Track which row was clicked (for WHERE clause)
        $(`#${tableId} tbody`).on("click", "tr", function () {
          const rowData = dt.row(this).data();
          if (rowData) { originalRowData = rowData; }
        });

        return; // don't fall through to append again
      } else {
        $panel.append($("<div>").addClass("result-message").text("0 rows returned."));
      }

      $batchDiv.append($panel);
    });

    // Tab switching
    $tabBar.on("click", ".fb-tab", function () {
      const idx = $(this).data("tab");
      $(".fb-tab").removeClass("active");
      $(this).addClass("active");
      $(".batch-panel").hide();
      $(`#panel-${idx}`).show();
    });

    $tabBar.show();
  }

  // ── Cell editing ─────────────────────────────────────────────────────────

  function makeCellsEditable($table, headers, changedFields, $genUpdate) {
    $table.find("tbody tr").each(function (rowIndex) {
      $(this).find("td").each(function (colIndex) {
        const $cell = $(this);
        $cell
          .attr("contenteditable", "true")
          .addClass("fb-editable")
          .off("input.fb")
          .on("input.fb", function () {
            const newValue = $(this).text();
            const key = rowIndex + "_" + colIndex;
            const existing = changedFields.findIndex(cf => cf.key === key);
            if (existing >= 0) {
              changedFields[existing].newValue = newValue;
            } else {
              changedFields.push({ key, rowIndex, colIndex, newValue });
            }
          });
      });
    });
  }

  // ── Single-result (legacy) ────────────────────────────────────────────────

  function showData(data) {
    $("#batch-results").hide();
    $("#single-result").show();
    $("#query-results").DataTable({
      scrollX: true,
      iDisplayLength: data.recordsPerPage === "All records" ? -1 : parseInt(data.recordsPerPage, 10),
      columns: data.tableHeader,
      data: data.tableBody,
      order: [],
      dom: "Bfrtip",
      buttons: buildExportButtons(),
      lengthMenu: [[10, 25, 50, 100, -1], ["10 rows", "25 rows", "50 rows", "100 rows", "Show all"]],
    });
    $("body").addClass("loaded");
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  function buildExportButtons() {
    return [
      "pageLength",
      {
        extend: "collection",
        text: "Export data",
        autoClose: true,
        buttons: [
          {
            text: "as JSON",
            action: function (e, dt) {
              var exportData = dt.buttons.exportData();
              $.fn.dataTable.fileSave(new Blob([JSON.stringify(exportData)]), "Export.json");
            },
            title: "Data export",
            titleAttr: "Export data to .json file.",
          },
          { extend: "csv",   text: "as CSV",  title: "Data export" },
          { extend: "excel", text: "as XLSX", title: "Data export" },
          { extend: "pdf",   text: "as PDF",  title: "Data export" },
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
});
