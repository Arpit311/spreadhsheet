import { describe, expect, it } from 'vitest'
import sales from '../../fixtures/sales-large.tsv?raw'
import queries from '../../fixtures/ai-eval/queries.json'
import { parseTsv } from '../fixtures/loadSample.js'
import { executeQuery, toDate, toNum } from './query.js'
import { buildFormatPatch, formatDisplay } from './format.js'
import { parseActionText } from './validation.js'

describe('AI action contract', () => {
    const rows = parseTsv(sales)
    it('executes each golden query deterministically', () => {
        for (const testCase of queries.cases) {
            const result = executeQuery(rows, testCase.plan)
            if (testCase.expect.error) {
                expect(result.error, testCase.id).toBe(testCase.expect.error)
                if (testCase.expect.detail !== undefined) expect(result.detail, testCase.id).toBe(testCase.expect.detail)
                continue
            }
            expect(result.error, testCase.id).toBeUndefined()
            expect(result.columns, testCase.id).toEqual(testCase.expect.columns)
            expect(result.rowCount, testCase.id).toBe(testCase.expect.rowCount)
            expect(result.truncated, testCase.id).toBe(testCase.expect.truncated)
            const expectedRows = testCase.expect.rows || testCase.expect.rowsPreview
            if (expectedRows) expect(result.rows.slice(0, expectedRows.length), testCase.id).toEqual(expectedRows)
        }
    })

    it('coerces contract values and parses wrapped actions', () => {
        expect(toNum('$1,200.00')).toBe(1200)
        expect(toNum('10%')).toBe(0.1)
        expect(toNum('N/A')).toBeNull()
        expect(toDate('15 Jan 2024')).toBe('2024-01-15')
        expect(parseActionText('Plan follows: ```json\n{"type":"clarify","question":"Which column?"}\n```').type).toBe('clarify')
        expect(parseActionText('{"type":"mutation"}').type).toBe('mutation')
        expect(executeQuery([], { type: 'mutation' }).error).toBe('READ_ONLY')
    })

    it('keeps formatting in display only and detects no-op formatting', () => {
        expect(formatDisplay('10%', 'percent')).toBe('10%')
        expect(formatDisplay('2024-01-15', 'date')).toBe('2024-01-15')
        const action = { type: 'format_sheet', headerStyle: { bold: true }, freezeRows: 1 }
        const first = buildFormatPatch([['Name'], ['A']], {}, [], 0, action)
        expect(first.result).toBe('APPLIED')
        expect(first.styles['0,0'].bold).toBe(true)
        expect(buildFormatPatch([['Name'], ['A']], first.styles, first.widths, first.frozenRows, action).result).toBe('NO_CHANGES')
    })
})
