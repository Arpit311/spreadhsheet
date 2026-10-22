const norm = value => String(value ?? '').trim().toLowerCase()

export function toNum(value) {
    const text = String(value ?? '').trim()
    if (!text) return null
    const percent = text.endsWith('%')
    const cleaned = text.replace(/[$,%\s]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
    const number = Number(cleaned)
    return Number.isFinite(number) ? (percent ? number / 100 : number) : null
}

export function toDate(value) {
    const text = String(value ?? '').trim()
    let year, month, day, match
    if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, year, month, day] = match
    else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [, month, day, year] = match
    else if ((match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/))) {
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
        month = months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1
        day = match[1]; year = match[3]
    } else return null
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const isEmptyRow = row => row.every(value => norm(value) === '')
const looksLikeTotals = row => /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(row.find(v => norm(v) !== '') ?? '').trim())
const round = value => typeof value === 'number' && Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : value

function compare(a, b) {
    const an = toNum(a), bn = toNum(b)
    if (an !== null && bn !== null) return an - bn
    if (an !== null) return -1
    if (bn !== null) return 1
    return norm(a).localeCompare(norm(b))
}

export function executeQuery(inputRows, plan = {}) {
    if (plan.type !== 'query') return { error: 'READ_ONLY', detail: 'READ_ONLY' }
    const rows = inputRows.map(row => row.map(value => value == null ? '' : value))
    if (!rows.length) return { columns: [], rows: [], rowCount: 0, truncated: false }
    const headers = rows[0].map(value => String(value).trim())
    const indexes = new Map(headers.map((header, index) => [norm(header), index]))
    const colIndex = name => {
        const index = indexes.get(norm(name))
        if (index === undefined) throw Object.assign(new Error(`UNKNOWN_COLUMN:${name}`), { code: 'UNKNOWN_COLUMN' })
        return index
    }
    try {
        const last = rows.length - 1
        let data = rows.slice(1).map((row, index) => ({ row, sourceIndex: index + 1 })).filter(({ row }) => !isEmptyRow(row))
        if (plan.excludeTotalsRow !== false && last > 0 && looksLikeTotals(rows[last])) data = data.filter(({ sourceIndex }) => sourceIndex !== last)
        const filters = (plan.filters || []).map(filter => ({ ...filter, index: colIndex(filter.column) }))
        for (const filter of filters) if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith', 'isEmpty', 'notEmpty'].includes(filter.op)) throw Object.assign(new Error(`UNKNOWN_OP:${filter.op}`), { code: 'UNKNOWN_OP' })
        data = data.filter(({ row }) => filters.every(({ index, op, value }) => {
            const cell = row[index] ?? '', a = norm(cell), b = norm(value)
            if (op === 'isEmpty') return a === ''
            if (op === 'notEmpty') return a !== ''
            if (op === 'contains') return a.includes(b)
            if (op === 'startsWith') return a.startsWith(b)
            if (op === 'endsWith') return a.endsWith(b)
            if (op === 'eq' || op === 'neq') {
                const left = toNum(cell), right = toNum(value)
                const equal = left !== null && right !== null ? left === right : a === b
                return op === 'eq' ? equal : !equal
            }
            const date = toDate(value)
            const left = date ? toDate(cell) : toNum(cell), right = date || toNum(value)
            if (left === null || right === null) return false
            return op === 'gt' ? left > right : op === 'gte' ? left >= right : op === 'lt' ? left < right : left <= right
        }))

        const groupNames = plan.groupBy || []
        const aggregates = plan.aggregates || []
        const resultRows = []
        let outputColumns
        if (aggregates.length) {
            const groups = new Map()
            const groupIndexes = groupNames.map(colIndex)
            const aggDefs = aggregates.map(aggregate => ({ ...aggregate, index: colIndex(aggregate.column) }))
            for (const item of data) {
                const key = JSON.stringify(groupIndexes.map(index => norm(item.row[index])))
                let group = groups.get(key)
                if (!group) {
                    group = { labels: groupIndexes.map(index => String(item.row[index] ?? '').trim()), items: [] }
                    groups.set(key, group)
                }
                group.items.push(item.row)
            }
            outputColumns = [...groupNames, ...aggDefs.map(({ fn, column, as }) => as || `${fn}(${column})`)]
            for (const group of groups.values()) {
                resultRows.push([...group.labels, ...aggDefs.map(({ fn, index }) => {
                    const values = group.items.map(row => row[index] ?? '')
                    if (fn === 'count') return group.items.length
                    if (fn === 'countDistinct') return new Set(values.map(norm).filter(Boolean)).size
                    const nums = values.map(toNum).filter(value => value !== null)
                    if (!nums.length) return null
                    if (fn === 'sum') return round(nums.reduce((sum, value) => sum + value, 0))
                    if (fn === 'avg') return round(nums.reduce((sum, value) => sum + value, 0) / nums.length)
                    if (fn === 'min') return Math.min(...nums)
                    if (fn === 'max') return Math.max(...nums)
                    throw Object.assign(new Error(`UNKNOWN_FN:${fn}`), { code: 'UNKNOWN_FN' })
                })])
            }
        } else {
            const selected = plan.columns?.length ? plan.columns : headers
            const selectedIndexes = selected.map(colIndex)
            outputColumns = selected
            resultRows.push(...data.map(({ row }) => selectedIndexes.map(index => row[index] ?? '')))
        }
        const sorts = (plan.sort || []).map(sort => {
            const index = outputColumns.findIndex(name => norm(name) === norm(sort.column))
            if (index < 0) throw Object.assign(new Error(`UNKNOWN_SORT_COLUMN:${sort.column}`), { code: 'UNKNOWN_SORT_COLUMN' })
            return { index, dir: sort.dir === 'desc' ? -1 : 1 }
        })
        if (sorts.length) resultRows.sort((a, b) => {
            for (const { index, dir } of sorts) { const order = compare(a[index], b[index]); if (order) return order * dir }
            return 0
        })
        const requested = Number.isInteger(plan.limit) && plan.limit > 0 ? plan.limit : 500
        const limit = Math.min(requested, 500)
        const returnedRows = resultRows.slice(0, limit)
        return { columns: outputColumns, rows: returnedRows, rowCount: returnedRows.length, truncated: resultRows.length > limit }
    } catch (error) {
        return { error: error.code || 'UNKNOWN_COLUMN', detail: error.message }
    }
}
