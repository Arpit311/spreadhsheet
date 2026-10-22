# Design notes

## Challenges

- **1 — Selection/fill:** Added rectangular drag and Shift selection, fill series for numbers, identifier suffixes, dates and weekday/month names, formula-relative references with `$` pinning, copied styles, fill shrinking, and batch undo.
- **2 — Sort/filter:** Added header sorting, per-column value/condition filters, AND composition, row counts, formula-aware row movement, totals pinning, and ascending/descending/original-order cycle. Filtered sorts only move visible row identities.
- **3 — Virtualized grid:** Engine capacity is 100,000 × 200. The UI renders the viewport and overscan, uses prefix sums and binary search for variable row/column dimensions, supports a name box, frozen first row/column, resizing, auto-fit, and keyboard navigation.
- **4 — Ask your data:** Added query executor following `AI_CONTRACT.md`, deterministic prompt provider support, validated action parsing, bounded context, result cards, local re-run and insertion.
- **5 — Format with AI:** Added pure format planner, display-only number/date formats, format preview/apply/discard, auto-fit, column widths, freeze rows, and combined undo.

## Data model changes

- Sparse raw cell map remains the source of truth. Sorting preserves physical row identities by moving cell records and remapping references.
- Styles and dimensions remain UI-owned maps but are registered with engine history for atomic undo. `numberFormat` affects display only.
- Sort snapshots are retained to restore original row order. The grid's row/column dimensions are represented by prefix sums, not per-cell React state.

## Engine API

- `applyBatch(changes, external?)`: applies raw-cell edits and optional `{ undo, redo }` UI-state hooks as one undo entry.
- `fillRange(source, target, external?, previousTarget?)`: fills/shrinks a rectangle from seed cells, translating formula references and extending supported series; one undo restores prior cells/styles.
- `sortRows(column, direction, startRow, endRow, rowIndexes?, external?)`: stable physical sort, formula-reference remap, optional visible-row subset and `{ undo, redo }` UI-state hooks; `original` restores the saved input order.
- `getRows(startRow, endRow, startCol, endCol)`: returns computed values for a rectangular range; read-only.
- `getUsedRange()`: returns the sparse sheet's non-empty bounding box; read-only.
- `recordUndoAction(undo, redo)`: adds standalone UI-owned formatting/dimension state to the same undo/redo timeline.
- `insertRow(atIndex, external?)`, `deleteRow(atIndex, external?)`, `insertColumn(atIndex, external?)`, `deleteColumn(atIndex, external?)`: structural edits with optional UI-state hooks folded into the same undo entry.

## Undo semantics

- Fill: all filled cell values/formulas and copied styles.
- Sort: row contents/formulas and row positions; filtered sort leaves hidden row identities in place.
- AI apply: styles, widths, and frozen-row setting as one action; no-op makes no history entry.
- Query insert: inserted result cells as one batch.
- Selection delete: all selected raw cells as one batch.
- UI formatting and structural edits: style/dimension maps revert alongside the engine change.

## Defects found in the existing code

- `src/engine/core.js` formula parser: the tokenizer emitted `A1`, `:`, `A2`, but the parser popped both endpoints before consuming the colon. Thus the starter's documented `SUM(A1:A2)` failed with `#PARSE!`. The parser now consumes the next endpoint token and regression tests cover range evaluation.
- `src/engine/core.js` literal coercion: `parseFloat('2024-01-03')` returned `2024`, corrupting dates as soon as they entered the engine. Coercion now accepts only complete decimal literals; date and other text values remain intact.
- `src/engine/core.js` formula arithmetic: raw currency/percent cells were strings and failed arithmetic even though the challenge formulas use totals and prices. Arithmetic and range aggregates now coerce currency/percent values for calculation while preserving stored/displayed source text.
- `src/engine/core.js` dependency graph: changing a cell called a helper that removed both its own formula dependencies and all incoming dependent edges. A changed input could therefore stop invalidating formulas. Cell edits now remove only outgoing edges, and range references track every member cell; recalculation membership/queue processing is linear rather than quadratic.
- `src/ai/format.test.js` golden discrepancy: f03 expects J22 blank, while the checked-in `sales.tsv` has `$3,344.00` at J22. Implementation preserves the actual fixture value and formats it; the test notes the mismatch rather than rewriting the fixture or stored data.

## Measurements

- `scripts/measure.mjs` compares all 20 query golden plans/results and measures generated 10k-row sort, `sales-large.tsv` Date sort, 5k-cell fill, 20 query executions, and all ten formatting actions against `sales-large.tsv`.
- Local Node 24.15 run: 10k sort 59.92 ms; `sales-large.tsv` Date sort 141.08 ms; 5k fill 42.36 ms; 20 query executions 93.12 ms; ten large-fixture format actions 115.91 ms. All 20 query cases matched. Run `node scripts/measure.mjs` to repeat; figures are one-run timings, not averages.
- `npm run build` succeeds. Vite reports a 500 KB main-chunk advisory (current JS bundle ~532 KB uncompressed); no dependency was added.
- These are local Node measurements, not production-browser DevTools numbers. First paint, frame time, keystroke latency, and format timing under a recorded production browser session still require a screen recording/DevTools run.

## AI (if applicable)

- Provider: the supplied offline deterministic mock plus a generic OpenAI-compatible HTTP chat-completions provider using plain `fetch`; endpoint, key, and model are read from `VITE_AI_*`. No key is committed.
- Context sent: `{ range, rowCount, columns: [{ name, index, type, examples }], sampleRows, selection, hasTotalsRow }`; `sampleRows` is capped at five, headers are exact, and full data is never sent.
- The parser extracts the first balanced JSON object while respecting escaped strings, parses it, then validates against the action schema. Parse/schema/provider failures show an error and do not mutate the sheet. Unknown columns produce a clarification prompt; non-query mutations are rejected as `READ_ONLY`.
- Query execution uses computed sheet values and deterministic normalization/coercion/grouping/aggregation/sort/limit logic. Format actions preview before apply and return `NO_CHANGES`/`OUT_OF_RANGE` as specified.
- Golden discrepancy: f03 expects J22 blank but the fixture is `$3,344.00`; see defects above.

## Trade-offs and what you would do next

- UI sorting/filter state and full selection styling are intentionally modest compared with a production spreadsheet. Row-height/column-width state is UI-side; structural insert/delete shifts it with style maps.
- The current virtual grid uses a single table with viewport spacers. Next: add browser-level automated interaction/performance tests, persist stable row IDs separately, and benchmark on the production build in Chromium.
- The challenge requests one pull request in the recruiter message but the repository's submission section requests one pull request per challenge. This workspace contains one combined implementation; confirm which submission convention the hiring team expects.

## Use of AI tools

Used GitHub Copilot to inspect challenge instructions, implement/test the features, and prepare this write-up. No external runtime packages were introduced. Screen recording: `Assignment_Arpit_Bhatnagar.mp4` (repository root).
