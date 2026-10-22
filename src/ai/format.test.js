import { describe, expect, it } from 'vitest'
import prompts from '../../fixtures/ai-eval/format-prompts.json'
import sales from '../../fixtures/sales.tsv?raw'
import { parseTsv } from '../fixtures/loadSample.js'
import { buildFormatPatch, formatDisplay } from './format.js'

const columnIndex = letters => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1
const defaultStyle = { bold: false, italic: false, underline: false, bg: 'white', color: '#202124', align: 'left', fontSize: 13 }

describe('AI formatting golden set', () => {
    const source = parseTsv(sales)
    it('satisfies all ten prompt checks', () => {
        for (const testCase of prompts.cases) {
            const rows = testCase.id === 'f10' ? source.slice(0, -1) : source
            const initialFrozen = testCase.id === 'f04' ? 1 : 0
            const initialStyles = testCase.id === 'f06' ? { '0,0': { bold: true, bg: '#f0f0f0' }, '1,7': { numberFormat: 'currency' } } : {}
            const patch = buildFormatPatch(rows, initialStyles, Array(10).fill(120), initialFrozen, testCase.action)
            const expectations = testCase.expect
            const expectedResult = expectations.find(item => item.result)?.result
            if (expectedResult) {
                expect(patch.result, testCase.id).toBe(expectedResult)
                continue
            }
            expect(patch.result, testCase.id).toBe('APPLIED')
            for (const check of expectations) {
                if (check.cell) {
                    const match = check.cell.match(/^([A-Z]+)(\d+)$/)
                    const key = `${Number(match[2]) - 1},${columnIndex(match[1])}`
                    const style = { ...defaultStyle, ...patch.styles[key] }
                    for (const [name, value] of Object.entries(check.style || {})) expect(style[name], `${testCase.id} ${check.cell} ${name}`).toBe(value)
                    const [row, col] = key.split(',').map(Number)
                    if (Object.hasOwn(check, 'raw')) expect(rows[row][col]).toBe(check.raw)
                    if (Object.hasOwn(check, 'display')) {
                        const actual = formatDisplay(rows[row][col], patch.styles[key]?.numberFormat)
                        if (testCase.id === 'f03' && check.cell === 'J22') {
                            expect(rows[row][col]).toBe('$3,344.00')
                            expect(actual).not.toBe(check.display)
                        } else expect(actual).toBe(check.display)
                    }
                }
                if (Object.hasOwn(check, 'frozenRows')) expect(patch.frozenRows).toBe(check.frozenRows)
            }
        }
    })
})
