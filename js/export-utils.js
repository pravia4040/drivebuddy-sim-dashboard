/* ============================================================
   export-utils.js — safe CSV + XLSX export helpers
   ------------------------------------------------------------
   Solves ICCID / SIM number corruption in Excel by:
   • CSV  : prefix cell with ="VALUE" so Excel reads it as text
   • XLSX : set cell type 's' (string) + number format '@' (text)
            so Excel never coerces the value to a number

   SheetJS (XLSX) must already be loaded before this script.
   ============================================================ */

(function () {

  /* ── CSV helper ────────────────────────────────────────────
     simColIndices: Set of column indexes that hold SIM numbers.
     Those cells are emitted as ="VALUE" so Excel treats them
     as text formulas — the only reliable way to suppress
     scientific notation for 19-20 digit ICCIDs in CSV.        */
  function exportCsv(filename, headers, rows, simColIndices) {
    const simSet = new Set(simColIndices || []);

    function cell(val, isSimNo) {
      const s = String(val ?? '');
      if (isSimNo && s) return '="' + s.replace(/"/g, '""') + '"';
      // Normal cell: quote if it contains comma, quote, or newline
      if (s.search(/[,"\n]/) !== -1) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }

    const lines = [
      headers.join(','),
      ...rows.map(row => row.map((v, i) => cell(v, simSet.has(i))).join(','))
    ];

    // UTF-8 BOM so Excel opens accented characters correctly
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    _triggerDownload(blob, filename);
  }

  /* ── XLSX helper ───────────────────────────────────────────
     simColIndices: array of column indexes that hold SIM numbers.
     Each cell in those columns is set to type 's' (string) with
     number format '@' so Excel can never auto-convert it.       */
  function exportXlsx(filename, headers, rows, simColIndices) {
    if (typeof XLSX === 'undefined') {
      console.error('[export-utils] SheetJS (XLSX) not loaded');
      return;
    }

    const simSet = new Set(simColIndices || []);

    // Build data as array-of-arrays; SIM columns stay as string
    const aoa = [
      headers,
      ...rows.map(row =>
        row.map((v, i) => simSet.has(i) ? String(v ?? '') : v)
      )
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Column widths + number format for SIM columns
    if (!ws['!cols']) ws['!cols'] = [];
    simColIndices && simColIndices.forEach(ci => {
      ws['!cols'][ci] = { wch: 24 };
    });

    // Overwrite every SIM cell: type='s', z='@'
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let ri = 1; ri <= range.e.r; ri++) {
      simSet.forEach(ci => {
        const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
        const cell = ws[addr];
        if (!cell) return;
        const raw = String(cell.v ?? '');
        // Replace cell object entirely so SheetJS writes as string
        ws[addr] = { t: 's', v: raw, z: '@' };
      });
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Export');
    XLSX.writeFile(wb, filename);
  }

  /* ── download trigger ──────────────────────────────────── */
  function _triggerDownload(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ── public API ────────────────────────────────────────── */
  window.ExportUtils = { csv: exportCsv, xlsx: exportXlsx };

})();
