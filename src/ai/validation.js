import { ACTION_TYPES, AGGREGATE_FNS, FILTER_OPS, NUMBER_FORMATS } from './contract.js'

const fail = message => ({ valid: false, error: message })
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateAction(action) {
    if (!isPlainObject(action)) return fail('Action must be a JSON object')
    if (action.type === ACTION_TYPES.CLARIFY) return typeof action.question === 'string' ? { valid: true, value: action } : fail('clarify.question must be a string')
    if (action.type === ACTION_TYPES.QUERY) {
        const allowed = new Set(['type', 'excludeTotalsRow', 'filters', 'groupBy', 'aggregates', 'columns', 'sort', 'limit'])
        if (Object.keys(action).some(key => !allowed.has(key))) return fail('query contains unsupported properties')
        if (action.excludeTotalsRow !== undefined && typeof action.excludeTotalsRow !== 'boolean') return fail('excludeTotalsRow must be boolean')
        if (action.limit !== undefined && (!Number.isInteger(action.limit) || action.limit < 1)) return fail('limit must be a positive integer')
        for (const field of ['groupBy', 'columns']) if (action[field] !== undefined && (!Array.isArray(action[field]) || action[field].some(item => typeof item !== 'string'))) return fail(`${field} must contain strings`)
        if (action.filters !== undefined && (!Array.isArray(action.filters) || action.filters.some(filter => !isPlainObject(filter) || Object.keys(filter).some(key => !['column', 'op', 'value'].includes(key)) || typeof filter.column !== 'string' || !FILTER_OPS.includes(filter.op) || (filter.value !== undefined && !['string', 'number'].includes(typeof filter.value) && filter.value !== null)))) return fail('filters contain an invalid filter')
        if (action.aggregates !== undefined && (!Array.isArray(action.aggregates) || action.aggregates.some(item => !isPlainObject(item) || Object.keys(item).some(key => !['fn', 'column', 'as'].includes(key)) || !AGGREGATE_FNS.includes(item.fn) || typeof item.column !== 'string' || (item.as !== undefined && typeof item.as !== 'string')))) return fail('aggregates contain an invalid aggregate')
        if (action.sort !== undefined && (!Array.isArray(action.sort) || action.sort.some(item => !isPlainObject(item) || Object.keys(item).some(key => !['column', 'dir'].includes(key)) || typeof item.column !== 'string' || (item.dir !== undefined && !['asc', 'desc'].includes(item.dir))))) return fail('sort contains an invalid sort entry')
        return { valid: true, value: action }
    }
    if (action.type === ACTION_TYPES.FORMAT_SHEET) {
        const allowed = new Set(['type', 'clearFormatting', 'headerStyle', 'bodyStyle', 'totalsStyle', 'columns', 'freezeRows', 'columnWidths', 'autoFitColumns'])
        if (Object.keys(action).some(key => !allowed.has(key))) return fail('format_sheet contains unsupported properties')
        if (action.clearFormatting !== undefined && typeof action.clearFormatting !== 'boolean') return fail('clearFormatting must be boolean')
        if (action.freezeRows !== undefined && action.freezeRows !== null && (!Number.isInteger(action.freezeRows) || action.freezeRows < 0)) return fail('freezeRows must be a non-negative integer or null')
        if (action.autoFitColumns !== undefined && typeof action.autoFitColumns !== 'boolean') return fail('autoFitColumns must be boolean')
        const style = value => isPlainObject(value) && Object.entries(value).every(([key, item]) => {
            if (key === 'bold' || key === 'italic' || key === 'underline') return typeof item === 'boolean'
            if (key === 'bg') return typeof item === 'string' && (/^#[\da-f]{6}$/i.test(item) || item === 'white')
            if (key === 'color') return typeof item === 'string' && /^#[\da-f]{6}$/i.test(item)
            if (key === 'align') return ['left', 'center', 'right'].includes(item)
            if (key === 'fontSize') return Number.isInteger(item) && item >= 8 && item <= 24
            if (key === 'numberFormat') return NUMBER_FORMATS.includes(item)
            return false
        })
        for (const field of ['headerStyle', 'bodyStyle', 'totalsStyle']) if (action[field] !== undefined && !style(action[field])) return fail(`${field} is invalid`)
        if (action.columns !== undefined && (!Array.isArray(action.columns) || action.columns.some(item => !isPlainObject(item) || Object.keys(item).some(key => !['col', 'style'].includes(key)) || !Number.isInteger(item.col) || item.col < 0 || !style(item.style)))) return fail('columns contain an invalid style entry')
        if (action.columnWidths !== undefined && (!Array.isArray(action.columnWidths) || action.columnWidths.some(item => !isPlainObject(item) || Object.keys(item).some(key => !['col', 'width'].includes(key)) || !Number.isInteger(item.col) || item.col < 0 || !Number.isInteger(item.width) || item.width < 30 || item.width > 600))) return fail('columnWidths contain an invalid entry')
        return { valid: true, value: action }
    }
    return fail(`Unsupported action type: ${String(action.type)}`)
}

export function parseActionText(text) {
    const source = String(text ?? '')
    for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
        let depth = 0, quoted = false, escaped = false
        for (let index = start; index < source.length; index++) {
            const char = source[index]
            if (quoted) {
                if (escaped) escaped = false
                else if (char === '\\') escaped = true
                else if (char === '"') quoted = false
                continue
            }
            if (char === '"') quoted = true
            else if (char === '{') depth++
            else if (char === '}' && --depth === 0) {
                try {
                    const action = JSON.parse(source.slice(start, index + 1))
                    if (action?.type === 'mutation') return action
                    const validation = validateAction(action)
                    if (!validation.valid) throw Object.assign(new Error(validation.error), { code: 'INVALID_RESPONSE' })
                    return action
                } catch (error) {
                    if (error.code === 'INVALID_RESPONSE') throw error
                    throw Object.assign(new Error(`INVALID_RESPONSE: ${error.message}`), { code: 'INVALID_RESPONSE' })
                }
            }
        }
    }
    throw Object.assign(new Error('INVALID_RESPONSE: no JSON object found'), { code: 'INVALID_RESPONSE' })
}
