import { toDate, toNum } from './query.js'

const totalPattern = /^(grand\s+)?(total|totals|subtotal|sum)\b/i
const text = value => String(value ?? '').trim()

export function formatDisplay(value, format = 'general') {
    const raw = String(value ?? '')
    if (format === 'general' || !raw.trim()) return raw
    if (format === 'date') return toDate(raw) ?? raw
    if (toDate(raw)) return raw
    const number = toNum(raw)
    if (number === null) return raw
    if (format === 'number') return number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (format === 'currency') return `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (format === 'percent') return `${(number * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
    return raw
}

export function looksLikeTotalsRow(row) {
    const first = text(row.find(value => text(value)))
    if (!first) return false
    if (totalPattern.test(first)) return true
    const filled = row.map(text).filter(Boolean)
    const hasGap = row.some(value => !text(value))
    const numbersAfterLabel = row.slice(1).filter(value => toNum(value) !== null).length
    return toNum(first) === null && numbersAfterLabel > 0 && hasGap && filled.length >= 2 && filled.length < row.length
}

/** Purely calculates a formatting patch. The caller owns committing it as one undoable action. */
export function buildFormatPatch(rows, currentStyles, currentWidths, frozenRows, action) {
    const rowCount = rows.length, colCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
    if (action.freezeRows != null && action.freezeRows >= rowCount && action.freezeRows !== 0) return { result: 'OUT_OF_RANGE' }
    const styles = { ...currentStyles }
    const widths = [...currentWidths]
    while (widths.length < colCount) widths.push(120)
    let nextFrozen = frozenRows
    let changed = false
    const usedRange = new Set()
    for (let r = 0; r < rowCount; r++) for (let c = 0; c < colCount; c++) usedRange.add(`${r},${c}`)
    const assign = (key, patch) => {
        const prior = styles[key] || {}
        const next = { ...prior, ...patch }
        if (Object.keys(next).every(k => next[k] === prior[k]) && Object.keys(prior).length === Object.keys(next).length) return
        styles[key] = next; changed = true
    }
    if (action.clearFormatting) for (const key of usedRange) if (styles[key]) { delete styles[key]; changed = true }
    if (action.bodyStyle) for (let r = rowCount > 1 ? 1 : rowCount; r < rowCount; r++) for (let c = 0; c < colCount; c++) assign(`${r},${c}`, action.bodyStyle)
    for (const entry of action.columns || []) {
        if (entry.col < 0 || entry.col >= colCount) continue
        const style = { ...entry.style }
        delete style.numberFormat
        for (let r = 1; r < rowCount; r++) assign(`${r},${entry.col}`, style)
        if (entry.style.numberFormat) for (let r = 1; r < rowCount; r++) assign(`${r},${entry.col}`, { numberFormat: entry.style.numberFormat })
    }
    const totals = rowCount > 1 && looksLikeTotalsRow(rows[rowCount - 1]) ? rowCount - 1 : -1
    if (action.totalsStyle && totals >= 0) for (let c = 0; c < colCount; c++) assign(`${totals},${c}`, action.totalsStyle)
    if (action.headerStyle && rowCount) for (let c = 0; c < colCount; c++) assign(`0,${c}`, action.headerStyle)
    for (const item of action.columnWidths || []) if (item.col < colCount && item.width >= 30 && item.width <= 600 && widths[item.col] !== item.width) { widths[item.col] = item.width; changed = true }
    if (action.autoFitColumns) {
        for (let c = 0; c < colCount; c++) {
            let max = 60
            for (const row of rows) max = Math.max(max, text(row[c]).length * 8 + 24)
            const width = Math.min(600, max)
            if (widths[c] !== width) { widths[c] = width; changed = true }
        }
    }
    if (action.freezeRows != null && nextFrozen !== action.freezeRows) { nextFrozen = action.freezeRows; changed = true }
    return changed ? { result: 'APPLIED', styles, widths, frozenRows: nextFrozen, changed } : { result: 'NO_CHANGES', styles: currentStyles, widths: currentWidths, frozenRows }
}
