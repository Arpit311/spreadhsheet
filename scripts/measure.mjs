import fs from 'node:fs'
import { createEngine } from '../src/engine/core.js'
import { executeQuery } from '../src/ai/query.js'
import { buildFormatPatch } from '../src/ai/format.js'

const rows = fs.readFileSync(new URL('../fixtures/sales-large.tsv', import.meta.url), 'utf8').trimEnd().split(/\r?\n/).map(line => line.split('\t'))
const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/ai-eval/queries.json', import.meta.url), 'utf8')).cases
const mismatches = []
for (const testCase of cases) {
    const result = executeQuery(rows, testCase.plan)
    const expected = testCase.expect
    const sample = expected.rows ?? expected.rowsPreview ?? []
    if (result.error !== expected.error || (!result.error && (
        JSON.stringify(result.columns) !== JSON.stringify(expected.columns) ||
        result.rowCount !== expected.rowCount ||
        result.truncated !== expected.truncated ||
        JSON.stringify(result.rows.slice(0, sample.length)) !== JSON.stringify(sample)
    ))) mismatches.push({ id: testCase.id, expected, result })
}
const engine = createEngine(10000, 10)
for (let row = 0; row < 10000; row++) engine.setCell(row, 0, String(10000 - row))
const start = performance.now()
engine.sortRows(0, 'asc', 0, 9999)
const sortMilliseconds = performance.now() - start
const fixtureEngine = createEngine(rows.length + 10, rows[0].length)
const fixtureChanges = []
for (let row = 0; row < rows.length; row++) for (let col = 0; col < rows[row].length; col++) fixtureChanges.push({ row, col, raw: rows[row][col] })
fixtureEngine.applyBatch(fixtureChanges)
const fixtureSortStart = performance.now()
fixtureEngine.sortRows(1, 'asc', 1, rows.length - 1)
const fixtureSortMilliseconds = performance.now() - fixtureSortStart
const fillEngine = createEngine(6000, 2)
fillEngine.setCell(0, 0, 'ORD-1001'); fillEngine.setCell(1, 0, 'ORD-1002')
const fillStart = performance.now()
fillEngine.fillRange({ startRow: 0, endRow: 1, startCol: 0, endCol: 0 }, { startRow: 0, endRow: 4999, startCol: 0, endCol: 0 })
const fillMilliseconds = performance.now() - fillStart
const queryStart = performance.now()
for (const testCase of cases) executeQuery(rows, testCase.plan)
const queryMilliseconds = performance.now() - queryStart
const formatActions = JSON.parse(fs.readFileSync(new URL('../fixtures/ai-eval/format-prompts.json', import.meta.url), 'utf8')).cases
const largeTotalsAt = rows.findIndex((row, index) => index > 0 && index === rows.length - 1 && /^\s*(grand\s+)?(total|totals|subtotal|sum)\b/i.test(row[0] || ''))
const formatRows = largeTotalsAt >= 0 ? rows : rows
const formatStart = performance.now()
for (const testCase of formatActions) buildFormatPatch(formatRows, {}, Array(rows[0].length).fill(120), 0, testCase.action)
const formatMilliseconds = performance.now() - formatStart
console.log(JSON.stringify({ goldenQueryCases: cases.length, goldenMismatches: mismatches.map(({ id }) => id), sort10kMilliseconds: +sortMilliseconds.toFixed(2), salesLargeDateSortMilliseconds: +fixtureSortMilliseconds.toFixed(2), fill5kMilliseconds: +fillMilliseconds.toFixed(2), query20CasesMilliseconds: +queryMilliseconds.toFixed(2), formatCasesOnLargeFixture: formatActions.length, formatBatchMilliseconds: +formatMilliseconds.toFixed(2) }, null, 2))
