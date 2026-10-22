// ─────────────────────────────────────────────────────────────
//  Operator precedence for expression parsing
// ─────────────────────────────────────────────────────────────

const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }
const MAX_UNDO_HISTORY = 100

function formulaNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const text = String(value ?? '').trim()
    if (!text) return null
    const percent = text.endsWith('%')
    const cleaned = text.replace(/[$,%\s]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
    const number = Number(cleaned)
    return Number.isFinite(number) ? (percent ? number / 100 : number) : null
}

// ─────────────────────────────────────────────────────────────
//  Column / Cell coordinate utilities
// ─────────────────────────────────────────────────────────────

function columnLetterToIndex(columnLetter) {
    let index = 0
    for (let i = 0; i < columnLetter.length; i++) {
        index = index * 26 + (columnLetter.charCodeAt(i) - 64)
    }
    return index - 1
}

function indexToCellKey(row, col) {
    let columnLabel = ''
    let colNumber = col + 1
    while (colNumber > 0) {
        colNumber--
        columnLabel = String.fromCharCode(65 + (colNumber % 26)) + columnLabel
        colNumber = Math.floor(colNumber / 26)
    }
    return columnLabel + (row + 1)
}

function parseCellKey(cellKey) {
    const match = cellKey.match(/^([A-Z]+)(\d+)$/)
    if (!match) return null
    return { row: parseInt(match[2]) - 1, col: columnLetterToIndex(match[1]) }
}

// ─────────────────────────────────────────────────────────────
//  Dependency graph (tracks which cells depend on which)
// ─────────────────────────────────────────────────────────────

function createDependencyGraph() {
    const forwardEdges = new Map()
    const reverseEdges = new Map()

    function addDependency(cell, dependsOn) {
        if (!forwardEdges.has(cell)) forwardEdges.set(cell, new Set())
        if (!reverseEdges.has(dependsOn)) reverseEdges.set(dependsOn, new Set())
        forwardEdges.get(cell).add(dependsOn)
        reverseEdges.get(dependsOn).add(cell)
    }

    function removeAllDependencies(cell) {
        const deps = forwardEdges.get(cell)
        if (deps) {
            for (const dep of deps) {
                if (reverseEdges.has(dep)) {
                    reverseEdges.get(dep).delete(cell)
                    if (reverseEdges.get(dep).size === 0) reverseEdges.delete(dep)
                }
            }
            forwardEdges.delete(cell)
        }
        const dependents = reverseEdges.get(cell)
        if (dependents) {
            for (const dependent of dependents) {
                if (forwardEdges.has(dependent)) {
                    forwardEdges.get(dependent).delete(cell)
                    if (forwardEdges.get(dependent).size === 0) forwardEdges.delete(dependent)
                }
            }
            reverseEdges.delete(cell)
        }
    }

    function removeDependencies(cell) {
        const deps = forwardEdges.get(cell)
        if (!deps) return
        for (const dep of deps) {
            const dependents = reverseEdges.get(dep)
            if (dependents) {
                dependents.delete(cell)
                if (dependents.size === 0) reverseEdges.delete(dep)
            }
        }
        forwardEdges.delete(cell)
    }

    function getDependencies(cell) {
        return forwardEdges.get(cell) || new Set()
    }

    function getDependents(cell) {
        return reverseEdges.get(cell) || new Set()
    }

    function getAllDependentsRecursive(cell, visited = new Set()) {
        if (visited.has(cell)) return new Set()
        visited.add(cell)
        const result = new Set()
        for (const dependent of getDependents(cell)) {
            result.add(dependent)
            for (const indirect of getAllDependentsRecursive(dependent, visited)) {
                result.add(indirect)
            }
        }
        return result
    }

    function hasCycle(startCell) {
        const visited = new Set()
        const recursionStack = new Set()
        const dfs = (node) => {
            if (recursionStack.has(node)) return true
            if (visited.has(node)) return false
            visited.add(node)
            recursionStack.add(node)
            for (const dep of getDependencies(node)) {
                if (dfs(dep)) return true
            }
            recursionStack.delete(node)
            return false
        }
        return dfs(startCell)
    }

    function topologicalSort(affectedCells) {
        const inDegree = new Map()
        const queue = []
        const sorted = []

        for (const cell of affectedCells) inDegree.set(cell, 0)
        for (const cell of affectedCells) {
            for (const dep of getDependencies(cell)) {
                if (affectedCells.has(dep)) {
                    inDegree.set(cell, (inDegree.get(cell) || 0) + 1)
                }
            }
        }
        for (const cell of affectedCells) {
            if (inDegree.get(cell) === 0) queue.push(cell)
        }
        let queueIndex = 0
        while (queueIndex < queue.length) {
            const cell = queue[queueIndex++]
            sorted.push(cell)
            for (const dependent of getDependents(cell)) {
                if (affectedCells.has(dependent)) {
                    inDegree.set(dependent, inDegree.get(dependent) - 1)
                    if (inDegree.get(dependent) === 0) queue.push(dependent)
                }
            }
        }
        return sorted
    }

    function clear() {
        forwardEdges.clear()
        reverseEdges.clear()
    }

    return {
        addDependency,
        removeDependencies,
        removeAllDependencies,
        getDependencies,
        getDependents,
        getAllDependentsRecursive,
        hasCycle,
        topologicalSort,
        clear
    }
}

// ─────────────────────────────────────────────────────────────
//  Tokenizer — converts formula string into tokens
// ─────────────────────────────────────────────────────────────

function tokenize(expression) {
    const tokens = []
    let position = 0

    while (position < expression.length) {
        const char = expression[position]

        if (char === ' ') {
            position++
            continue
        }

        if (char === '(' || char === ')') {
            tokens.push({ type: 'paren', value: char })
            position++
            continue
        }

        if ('+-*/,'.includes(char)) {
            tokens.push({ type: 'operator', value: char })
            position++
            continue
        }

        if (char === ':') {
            tokens.push({ type: 'range', value: ':' })
            position++
            continue
        }

        if ((char >= '0' && char <= '9') || char === '.') {
            let numberStr = ''
            while (position < expression.length && ((expression[position] >= '0' && expression[position] <= '9') || expression[position] === '.')) {
                numberStr += expression[position]
                position++
            }
            tokens.push({ type: 'number', value: parseFloat(numberStr) })
            continue
        }

        if (char === '$' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) {
            const cellMatch = expression.slice(position).match(/^\$?([A-Za-z]+)\$?(\d+)/)
            if (cellMatch) {
                tokens.push({ type: 'cell', value: `${cellMatch[1].toUpperCase()}${cellMatch[2]}` })
                position += cellMatch[0].length
                continue
            }
            let identifier = ''
            while (position < expression.length && ((expression[position] >= 'A' && expression[position] <= 'Z') || (expression[position] >= 'a' && expression[position] <= 'z') || (expression[position] >= '0' && expression[position] <= '9'))) {
                identifier += expression[position].toUpperCase()
                position++
            }
            if (position < expression.length && expression[position] === ':') {
                tokens.push({ type: 'cell', value: identifier })
            } else {
                const cellMatch = identifier.match(/^([A-Z]+)(\d+)$/)
                if (cellMatch) {
                    tokens.push({ type: 'cell', value: identifier })
                } else {
                    tokens.push({ type: 'function', value: identifier })
                }
            }
            continue
        }

        throw new Error(`Unexpected character: ${char}`)
    }

    return tokens
}

// ─────────────────────────────────────────────────────────────
//  Parser — converts tokens into an AST using shunting-yard
// ─────────────────────────────────────────────────────────────

function parseTokensToAST(tokens) {
    const outputQueue = []
    const operatorStack = []
    let position = 0

    while (position < tokens.length) {
        const token = tokens[position]

        if (token.type === 'number' || token.type === 'cell') {
            outputQueue.push(token)
            position++
        } else if (token.type === 'function') {
            operatorStack.push(token)
            position++
        } else if (token.type === 'operator') {
            while (
                operatorStack.length > 0 &&
                operatorStack[operatorStack.length - 1].type === 'operator' &&
                OPERATOR_PRECEDENCE[operatorStack[operatorStack.length - 1].value] >= OPERATOR_PRECEDENCE[token.value]
            ) {
                outputQueue.push(operatorStack.pop())
            }
            operatorStack.push(token)
            position++
        } else if (token.type === 'paren' && token.value === '(') {
            operatorStack.push(token)
            position++
        } else if (token.type === 'paren' && token.value === ')') {
            while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value !== '(') {
                outputQueue.push(operatorStack.pop())
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value === '(') {
                operatorStack.pop()
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type === 'function') {
                const funcToken = operatorStack.pop()
                if (outputQueue.length > 0 && outputQueue[outputQueue.length - 1].type === 'range') {
                    const rangeToken = outputQueue.pop()
                    outputQueue.push({ type: 'function', name: funcToken.value, range: rangeToken })
                } else {
                    outputQueue.push(funcToken)
                }
            }
            position++
        } else if (token.type === 'range') {
            const startCell = outputQueue.pop()
            const endCell = tokens[position + 1]
            if (startCell?.type !== 'cell' || endCell?.type !== 'cell') {
                throw new Error('Range must be between two cell references')
            }
            outputQueue.push({ type: 'range', start: startCell.value, end: endCell.value })
            position += 2
        } else {
            position++
        }
    }

    while (operatorStack.length > 0) {
        if (operatorStack[operatorStack.length - 1].value === '(') {
            throw new Error('Mismatched parentheses')
        }
        outputQueue.push(operatorStack.pop())
    }

    return buildASTFromRPN(outputQueue)
}

function buildASTFromRPN(rpnTokens) {
    const stack = []

    for (const token of rpnTokens) {
        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
            stack.push(token)
        } else if (token.type === 'operator') {
            if (stack.length < 2) throw new Error('Invalid expression')
            const right = stack.pop()
            const left = stack.pop()
            stack.push({ type: 'binary', operator: token.value, left, right })
        } else if (token.type === 'function') {
            if (token.range) {
                stack.push(token)
            } else {
                if (stack.length === 0) throw new Error(`Function ${token.value} requires arguments`)
                const argument = stack.pop()
                if (argument.type === 'range') {
                    stack.push({ type: 'function', name: token.value, range: argument })
                } else {
                    throw new Error(`Function ${token.value} requires a range`)
                }
            }
        }
    }

    if (stack.length !== 1) throw new Error('Invalid expression')
    return stack[0]
}

// ─────────────────────────────────────────────────────────────
//  Evaluator — walks the AST and computes values
// ─────────────────────────────────────────────────────────────

function expandCellRange(startKey, endKey) {
    const startMatch = startKey.match(/^([A-Z]+)(\d+)$/)
    const endMatch = endKey.match(/^([A-Z]+)(\d+)$/)
    if (!startMatch || !endMatch) throw new Error('REF')

    const startCol = columnLetterToIndex(startMatch[1])
    const startRow = parseInt(startMatch[2]) - 1
    const endCol = columnLetterToIndex(endMatch[1])
    const endRow = parseInt(endMatch[2]) - 1

    const cells = []
    for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
        for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
            cells.push(indexToCellKey(r, c))
        }
    }
    return cells
}

function evaluateAST(ast, getCellValue, visited = new Set()) {
    if (!ast) return 0

    if (ast.type === 'number') return ast.value

    if (ast.type === 'cell') {
        const key = ast.value
        if (visited.has(key)) throw new Error('CIRCULAR')
        visited.add(key)
        const value = getCellValue(key, visited)
        visited.delete(key)
        return value
    }

    if (ast.type === 'range') throw new Error('VALUE')

    if (ast.type === 'binary') {
        const leftVal = formulaNumber(evaluateAST(ast.left, getCellValue, visited))
        const rightVal = formulaNumber(evaluateAST(ast.right, getCellValue, visited))
        if (leftVal === null || rightVal === null) throw new Error('VALUE')
        switch (ast.operator) {
            case '+': return leftVal + rightVal
            case '-': return leftVal - rightVal
            case '*': return leftVal * rightVal
            case '/':
                if (rightVal === 0) throw new Error('VALUE')
                return leftVal / rightVal
            default: throw new Error('VALUE')
        }
    }

    if (ast.type === 'function') {
        const rangeCells = expandCellRange(ast.range.start, ast.range.end)
        const values = rangeCells.map(cellKey => {
            if (visited.has(cellKey)) throw new Error('CIRCULAR')
            visited.add(cellKey)
            const value = getCellValue(cellKey, visited)
            visited.delete(cellKey)
            return formulaNumber(value) ?? 0
        })

        switch (ast.name) {
            case 'SUM': return values.reduce((sum, val) => sum + val, 0)
            case 'AVG': return values.length === 0 ? 0 : values.reduce((sum, val) => sum + val, 0) / values.length
            case 'MIN': return values.length === 0 ? 0 : Math.min(...values)
            case 'MAX': return values.length === 0 ? 0 : Math.max(...values)
            default: throw new Error('VALUE')
        }
    }

    throw new Error('VALUE')
}

function evaluateFormula(expression, getCellValue) {
    try {
        if (!expression || expression.trim() === '') return { value: '', error: null }
        if (!expression.startsWith('=')) return { value: expression, error: null }

        const formulaBody = expression.slice(1).trim()
        if (formulaBody === '') return { value: '', error: null }

        const tokens = tokenize(formulaBody)
        const ast = parseTokensToAST(tokens)
        const result = evaluateAST(ast, getCellValue)
        return { value: result, error: null }
    } catch (error) {
        if (error.message === 'CIRCULAR') return { value: null, error: '#CYCLE!' }
        if (error.message === 'REF') return { value: null, error: '#REF!' }
        if (error.message === 'VALUE') return { value: null, error: '#VALUE!' }
        return { value: null, error: '#PARSE!' }
    }
}

// ─────────────────────────────────────────────────────────────
//  Reference shifting (for insert/delete row/col)
// ─────────────────────────────────────────────────────────────

function shiftCellReferences(formula, rowShift, colShift, atIndex, isColumnOperation = false) {
    if (!formula || !formula.startsWith('=')) return formula

    // Shift cell references in formulas when rows/columns are inserted or deleted
    // Note: This function modifies ALL cell references in the formula, including those
    // in ranges. The logic ensures references shift correctly based on the operation type.
    return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, absCol, colLetter, absRow, rowStr) => {
        const colIdx = columnLetterToIndex(colLetter)
        const rowIdx = parseInt(rowStr) - 1
        let newRow = rowIdx
        let newCol = colIdx

        if (isColumnOperation) {
            // For column operations, only shift columns at or after the insertion/deletion point
            if (colIdx >= atIndex) newCol = colIdx + colShift
        } else if (!isColumnOperation) {
            // For row operations, only shift rows at or after the insertion/deletion point
            if (rowIdx >= atIndex) newRow = rowIdx + rowShift
        }

        // Preserve original reference if shifting would result in invalid coordinates
        // This prevents formulas from breaking when rows/cols are deleted at boundaries
        if (newRow < 0 || newCol < 0) return match
        const shifted = indexToCellKey(newRow, newCol)
        return `${absCol}${shifted.replace(/\d+$/, '')}${absRow}${newRow + 1}`
    })
}

function shiftFormulaForFill(formula, rowDelta, colDelta) {
    if (!formula?.startsWith('=')) return formula
    return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, absCol, col, absRow, row) => {
        const nextCol = columnLetterToIndex(col) + (absCol ? 0 : colDelta)
        const nextRow = Number(row) - 1 + (absRow ? 0 : rowDelta)
        if (nextCol < 0 || nextRow < 0) return '#REF!'
        return `${absCol}${indexToCellKey(0, nextCol).replace(/\d+$/, '')}${absRow}${nextRow + 1}`
    })
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function incrementSeries(first, second, offset, formatTemplate = first) {
    const a = String(first ?? ''), b = String(second ?? '')
    const preserveCase = (source, value) => source === source.toUpperCase() ? value.toUpperCase() : source[0] === source[0]?.toUpperCase() ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value.toLowerCase()
    for (const words of [WEEKDAYS, MONTHS]) {
        const ai = words.findIndex(word => word.toLowerCase().startsWith(a.toLowerCase()))
        const bi = words.findIndex(word => word.toLowerCase().startsWith(b.toLowerCase()))
        if (ai >= 0 && bi >= 0) {
            const delta = (bi - ai + words.length) % words.length || 1
            const source = a.length <= 3 ? words[(ai + delta * offset) % words.length].slice(0, 3) : words[(ai + delta * offset) % words.length]
            return preserveCase(a, source)
        }
    }
    const dateParts = value => {
        let match
        if ((match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return { date: new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])), format: d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(match[2].length, '0')}-${String(d.getUTCDate()).padStart(match[3].length, '0')}` }
        if ((match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { date: new Date(Date.UTC(+match[3], +match[1] - 1, +match[2])), format: d => `${String(d.getUTCMonth() + 1).padStart(match[1].length, '0')}/${String(d.getUTCDate()).padStart(match[2].length, '0')}/${d.getUTCFullYear()}` }
        if ((match = value.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/))) {
            const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
            const month = months.findIndex(name => name.toLowerCase().startsWith(match[2].slice(0, 3).toLowerCase()))
            if (month >= 0) return { date: new Date(Date.UTC(+match[3], month, +match[1])), format: d => `${String(d.getUTCDate()).padStart(match[1].length, '0')} ${match[2].length <= 3 ? months[d.getUTCMonth()].slice(0, 3) : months[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
        }
        return null
    }
    const dateA = dateParts(a), dateB = dateParts(b)
    if (dateA && dateB) {
        const delta = Math.round((dateB.date - dateA.date) / 86400000)
        const date = new Date(dateA.date.getTime() + delta * offset * 86400000)
        return (dateParts(String(formatTemplate ?? '')) || dateA).format(date)
    }
    const number = value => {
        const match = value.match(/^(.*?)(\d+)$/)
        return match ? { prefix: match[1], number: Number(match[2]), width: match[2].length } : null
    }
    const na = number(a), nb = number(b)
    if (na && nb && na.prefix === nb.prefix) return `${na.prefix}${String(na.number + (nb.number - na.number) * offset).padStart(na.width, '0')}`
    const numericA = Number(a), numericB = Number(b)
    if (a.trim() && b.trim() && Number.isFinite(numericA) && Number.isFinite(numericB)) return String(numericA + (numericB - numericA) * offset)
    return a
}

function extractCellReferences(formula) {
    const references = new Set()
    const rangeRegex = /\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/g
    let rangeMatch
    while ((rangeMatch = rangeRegex.exec(formula)) !== null) {
        const startCol = columnLetterToIndex(rangeMatch[1]), endCol = columnLetterToIndex(rangeMatch[3])
        const startRow = Number(rangeMatch[2]) - 1, endRow = Number(rangeMatch[4]) - 1
        for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row++) {
            for (let col = Math.min(startCol, endCol); col <= Math.max(startCol, endCol); col++) references.add(indexToCellKey(row, col))
        }
    }
    const regex = /\$?([A-Z]+)\$?(\d+)/g
    let match
    while ((match = regex.exec(formula)) !== null) {
        references.add(`${match[1]}${match[2]}`)
    }
    return references
}

// ─────────────────────────────────────────────────────────────
//  Main engine factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    const cells = new Map()
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()
    const undoStack = []
    const redoStack = []

    // Internal generation counter — incremented on every structural mutation.
    // Used by the cache to validate entries and by the engine to track state integrity.
    let _generation = 0
    let _batchMode = false
    let _batchCallbacks = []
    let _sortOriginalSnapshot = null
    let _sortOriginalRowMap = null

    // ── Internal helpers ──

    function cellKey(row, col) {
        return indexToCellKey(row, col)
    }

    function cellCoords(key) {
        return parseCellKey(key)
    }

    function isValidCellKey(key) {
        const coords = cellCoords(key)
        return coords && coords.row >= 0 && coords.row < rows && coords.col >= 0 && coords.col < cols
    }

    function updateDependencies(cell, rawFormula) {
        // Extract all cell references from the formula
        // Note: This includes references in ranges (e.g., A1:A5 includes A1, A2, A3, A4, A5)
        // but the current implementation only tracks the range endpoints
        for (const ref of extractCellReferences(rawFormula)) {
            if (isValidCellKey(ref)) graph.addDependency(cell, ref)
        }
        // TODO: Consider tracking individual cells within ranges for more granular dependency tracking
    }

    function markCellDirty(cell) {
        dirtyCells.add(cell)
        for (const dependent of graph.getAllDependentsRecursive(cell)) {
            dirtyCells.add(dependent)
        }
    }

    function markAllCellsDirty() {
        for (const key of cells.keys()) dirtyCells.add(key)
    }

    // ── Value resolution ──

    function resolveCellValue(cellKey, visited = new Set()) {
        if (visited.has(cellKey)) return '#CYCLE!'
        visited.add(cellKey)

        if (computedCache.has(cellKey)) {
            const cached = computedCache.get(cellKey)
            // Validate cache generation — stale entries from a previous generation are discarded
            // Note: _generation is incremented on structural changes, but cache validation
            // must account for cells that may have been invalidated by dependency changes
            if (cached._gen === _generation && !dirtyCells.has(cellKey)) {
                visited.delete(cellKey)
                return cached.error || cached.computed
            }
            computedCache.delete(cellKey)
        }

        const cell = cells.get(cellKey)
        if (!cell || !cell.raw) {
            visited.delete(cellKey)
            return ''
        }

        if (!cell.raw.startsWith('=')) {
            const numericValue = /^-?\d+(\.\d+)?$/.test(cell.raw.trim()) ? Number(cell.raw) : NaN
            visited.delete(cellKey)
            return isNaN(numericValue) ? cell.raw : numericValue
        }

        const result = evaluateFormula(cell.raw, (key) => resolveCellValue(key, visited))
        visited.delete(cellKey)

        if (result.error) {
            computedCache.set(cellKey, { computed: null, error: result.error, _gen: _generation })
            return result.error
        }

        computedCache.set(cellKey, { computed: result.value, error: null, _gen: _generation })
        return result.value
    }

    // ── Recalculation ──

    function recalculate() {
        if (dirtyCells.size === 0) return

        const affected = new Set(dirtyCells)
        const sorted = graph.topologicalSort(affected)
        const sortedSet = new Set(sorted)

        // Process sorted cells first (topological order ensures dependencies are resolved)
        for (const cell of sorted) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }
        // Process any remaining affected cells that weren't in the sorted list
        // (e.g., cells with no dependencies or circular dependencies)
        for (const cell of affected) {
            if (!sortedSet.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }

        dirtyCells.clear()

        // Notify batch listeners if in batch mode
        // WARNING: Batch mode is currently unused but may be needed for future features
        if (_batchMode) {
            _batchCallbacks.forEach(cb => cb())
        }
    }

    // ── Core cell operations ──

    function setCellRaw(row, col, raw) {
        const key = cellKey(row, col)
        graph.removeDependencies(key)
        computedCache.delete(key)

        if (!raw || raw.trim() === '') {
            cells.delete(key)
            markCellDirty(key)
            return
        }

        if (raw.startsWith('=')) {
            cells.set(key, { raw, computed: null, error: null })
            updateDependencies(key, raw)
            if (graph.hasCycle(key)) {
                graph.removeDependencies(key)
                cells.set(key, { raw, computed: null, error: '#CYCLE!' })
                markCellDirty(key)
                return
            }
        } else {
            cells.set(key, { raw, computed: null, error: null })
        }

        markCellDirty(key)
    }

    function getCellRaw(row, col) {
        const key = cellKey(row, col)
        const cell = cells.get(key)
        if (!cell) return { raw: '', computed: null, error: null }
        return { ...cell }
    }

    // ── Snapshot / Restore (for undo of structural changes) ──

    function takeSnapshot() {
        // Create a deep copy of all cell data for undo/redo operations
        // Note: This only captures cell data, not the dependency graph or cache
        // The dependency graph is rebuilt from the cell formulas when restoring
        const snapshot = new Map()
        for (const [key, value] of cells.entries()) {
            // Create a shallow copy of the cell object
            // The cell object contains: { raw: string, computed: number|null, error: string|null }
            // Note: computed and error are not persisted in snapshots - they're recalculated on restore
            snapshot.set(key, { ...value })
        }
        return snapshot
    }

    function restoreSnapshot(snapshot) {
        cells.clear()
        for (const [key, value] of snapshot.entries()) {
            cells.set(key, { ...value })
        }
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        // Rebuild dependency graph from restored cells
        // Important: This must happen before marking cells dirty to ensure correct dependency tracking
        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Row / Column structural operations ──

    function performInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                const newKey = cellKey(coords.row + 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            }
        }
        rows++
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row === atIndex) continue
            if (coords.row > atIndex) {
                const newKey = cellKey(coords.row - 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, -1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, -1, 0, atIndex) })
            }
        }
        rows--
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performInsertColumn(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                const newKey = cellKey(coords.row, coords.col + 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            }
        }
        cols++
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteColumn(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col === atIndex) continue
            if (coords.col > atIndex) {
                const newKey = cellKey(coords.row, coords.col - 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, -1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, -1, atIndex, true) })
            }
        }
        cols--
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Undo / Redo ──

    function pushToUndoStack(entry) {
        undoStack.push({ ...entry, _gen: _generation })
        if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
        redoStack.length = 0
    }

    function executeSetCell(row, col, value) {
        _sortOriginalSnapshot = null
        const previousValue = getCellRaw(row, col).raw
        // Only create undo entry if value actually changed
        // This prevents undo stack pollution with no-op edits
        if (previousValue !== value) {
            pushToUndoStack({ type: 'set', r: row, c: col, oldVal: previousValue, newVal: value })
        }
        setCellRaw(row, col, value)
        _generation++
        recalculate()
    }

    function executeInsertRow(atIndex, external = null) {
        _sortOriginalSnapshot = null
        const snapshot = takeSnapshot()
        const previousRows = rows
        pushToUndoStack({ type: 'rowins', snap: snapshot, oldRows: previousRows, undoExternal: external?.undo, redoExternal: external?.redo })
        performInsertRow(atIndex)
        external?.redo?.()
        recalculate()
    }

    function executeDeleteRow(atIndex, external = null) {
        _sortOriginalSnapshot = null
        const snapshot = takeSnapshot()
        const previousRows = rows
        pushToUndoStack({ type: 'rowdel', snap: snapshot, oldRows: previousRows, undoExternal: external?.undo, redoExternal: external?.redo })
        performDeleteRow(atIndex)
        external?.redo?.()
        recalculate()
    }

    function executeInsertColumn(atIndex, external = null) {
        _sortOriginalSnapshot = null
        const snapshot = takeSnapshot()
        const previousCols = cols
        pushToUndoStack({ type: 'colins', snap: snapshot, oldCols: previousCols, undoExternal: external?.undo, redoExternal: external?.redo })
        performInsertColumn(atIndex)
        external?.redo?.()
        recalculate()
    }

    function executeDeleteColumn(atIndex, external = null) {
        _sortOriginalSnapshot = null
        const snapshot = takeSnapshot()
        const previousCols = cols
        pushToUndoStack({ type: 'coldel', snap: snapshot, oldCols: previousCols, undoExternal: external?.undo, redoExternal: external?.redo })
        performDeleteColumn(atIndex)
        external?.redo?.()
        recalculate()
    }

    function undo() {
        if (undoStack.length === 0) return false
        const entry = undoStack.pop()

        if (entry.type === 'set') {
            // For cell edits, swap current value to redo stack and restore old value
            const currentValue = getCellRaw(entry.r, entry.c).raw
            redoStack.push({ ...entry, newVal: currentValue })
            setCellRaw(entry.r, entry.c, entry.oldVal)
            _generation++
            recalculate()
        } else if (entry.type === 'external') {
            redoStack.push(entry)
            entry.undo()
        } else if (entry.type === 'bulk') {
            redoStack.push({ ...entry })
            restoreSnapshot(entry.before)
            entry.undoExternal?.()
            recalculate()
        } else {
            // For structural changes (row/col insert/delete), save current state to redo
            // and restore the snapshot from undo entry
            // Note: The snapshot contains the cell data, but rows/cols must be restored separately
            redoStack.push({
                ...entry,
                restoreSnap: takeSnapshot(),
                restoreRows: rows,
                restoreCols: cols
            })
            restoreSnapshot(entry.snap)
            // Restore grid dimensions - this must happen after restoreSnapshot
            // because restoreSnapshot increments _generation but doesn't modify rows/cols
            if (entry.type === 'rowins' || entry.type === 'rowdel') rows = entry.oldRows
            else if (entry.type === 'colins' || entry.type === 'coldel') cols = entry.oldCols
            entry.undoExternal?.()
            recalculate()
        }
        return true
    }

    function redo() {
        if (redoStack.length === 0) return false
        const entry = redoStack.pop()

        if (entry.type === 'set') {
            const currentValue = getCellRaw(entry.r, entry.c).raw
            undoStack.push({ ...entry, oldVal: currentValue })
            setCellRaw(entry.r, entry.c, entry.newVal)
            _generation++
            recalculate()
        } else if (entry.type === 'external') {
            undoStack.push(entry)
            entry.redo()
        } else if (entry.type === 'bulk') {
            undoStack.push({ ...entry })
            restoreSnapshot(entry.after)
            entry.redoExternal?.()
            recalculate()
        } else {
            undoStack.push({
                ...entry,
                snap: takeSnapshot(),
                oldRows: rows,
                oldCols: cols
            })
            restoreSnapshot(entry.restoreSnap)
            rows = entry.restoreRows
            cols = entry.restoreCols
            entry.redoExternal?.()
            recalculate()
        }
        return true
    }

    // ── Public cell display (returns raw + computed + error) ──

    function getCellForDisplay(row, col) {
        const cell = getCellRaw(row, col)
        const key = cellKey(row, col)
        // Resolve the computed value (this may trigger recalculation if the cell is dirty)
        // The resolveCellValue function handles caching and dependency resolution
        const value = resolveCellValue(key)

        // Error values are strings starting with '#' (e.g., '#CYCLE!', '#VALUE!')
        if (typeof value === 'string' && value.startsWith('#')) {
            return { raw: cell.raw, computed: null, error: value }
        }
        // Return the computed value (which may be a number or string)
        // Note: Empty cells return '' as computed value, not null
        return { raw: cell.raw, computed: value, error: null }
    }

    function applyBatch(changes, external = null) {
        const before = takeSnapshot()
        for (const { row, col, raw } of changes) setCellRaw(row, col, String(raw ?? ''))
        const after = takeSnapshot()
        if (before.size === after.size && [...before].every(([key, value]) => after.get(key)?.raw === value.raw)) return false
        pushToUndoStack({ type: 'bulk', before, after, undoExternal: external?.undo, redoExternal: external?.redo })
        _generation++
        recalculate()
        return true
    }

    function getUsedRange() {
        let minRow = Infinity, minCol = Infinity, maxRow = -1, maxCol = -1
        for (const key of cells.keys()) {
            const { row, col } = cellCoords(key)
            minRow = Math.min(minRow, row); minCol = Math.min(minCol, col)
            maxRow = Math.max(maxRow, row); maxCol = Math.max(maxCol, col)
        }
        return maxRow < 0 ? { startRow: 0, startCol: 0, endRow: -1, endCol: -1, rowCount: 0, colCount: 0 }
            : { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol, rowCount: maxRow - minRow + 1, colCount: maxCol - minCol + 1 }
    }

    function getRows(startRow = 0, endRow = rows - 1, startCol = 0, endCol = cols - 1) {
        const result = []
        for (let r = startRow; r <= endRow; r++) {
            const row = []
            for (let c = startCol; c <= endCol; c++) {
                const cell = getCellForDisplay(r, c)
                row.push(cell.computed ?? cell.raw)
            }
            result.push(row)
        }
        return result
    }

    function fillRange(source, target, external = null, previousTarget = null) {
        const sourceRows = source.endRow - source.startRow + 1
        const sourceCols = source.endCol - source.startCol + 1
        const verticalSeries = sourceCols === 1 && sourceRows > 1
        const horizontalSeries = sourceRows === 1 && sourceCols > 1
        const seriesSeeds = verticalSeries
            ? Array.from({ length: sourceRows }, (_, offset) => getCellRaw(source.startRow + offset, source.startCol).raw)
            : horizontalSeries ? Array.from({ length: sourceCols }, (_, offset) => getCellRaw(source.startRow, source.startCol + offset).raw) : []
        const changes = []
        for (let r = Math.min(source.startRow, target.startRow); r <= Math.max(source.endRow, target.endRow); r++) {
            for (let c = Math.min(source.startCol, target.startCol); c <= Math.max(source.endCol, target.endCol); c++) {
                if (r >= source.startRow && r <= source.endRow && c >= source.startCol && c <= source.endCol) continue
                const seedRow = source.startRow + ((r - source.startRow) % sourceRows + sourceRows) % sourceRows
                const seedCol = source.startCol + ((c - source.startCol) % sourceCols + sourceCols) % sourceCols
                const seed = getCellRaw(seedRow, seedCol).raw
                let raw = shiftFormulaForFill(seed, r - seedRow, c - seedCol)
                if (!seed.startsWith('=') && verticalSeries && (r < source.startRow || r > source.endRow)) raw = incrementSeries(seriesSeeds[0], seriesSeeds[1], r - source.startRow, seed)
                if (!seed.startsWith('=') && horizontalSeries && (c < source.startCol || c > source.endCol)) raw = incrementSeries(seriesSeeds[0], seriesSeeds[1], c - source.startCol, seed)
                changes.push({ row: r, col: c, raw })
            }
        }
        if (previousTarget) {
            for (let r = previousTarget.startRow; r <= previousTarget.endRow; r++) for (let c = previousTarget.startCol; c <= previousTarget.endCol; c++) {
                if (r >= target.startRow && r <= target.endRow && c >= target.startCol && c <= target.endCol) continue
                if (r >= source.startRow && r <= source.endRow && c >= source.startCol && c <= source.endCol) continue
                changes.push({ row: r, col: c, raw: '' })
            }
        }
        if (target.endRow >= rows) rows = target.endRow + 1
        if (target.endCol >= cols) cols = target.endCol + 1
        return applyBatch(changes, external)
    }

    function sortRows(column, direction = 'asc', startRow = 1, endRow = getUsedRange().endRow, rowIndexes = null, external = null) {
        const used = getUsedRange()
        if (used.rowCount < 2 || column < 0 || column >= cols) return { changed: false, elapsedMs: 0 }
        const started = Date.now()
        if (direction === 'original') {
            if (!_sortOriginalSnapshot) return { changed: false, elapsedMs: 0 }
            const before = takeSnapshot()
            const rowMap = new Map([...( _sortOriginalRowMap || new Map())].map(([original, current]) => [current, original]))
            const externalHistory = external?.(rowMap)
            restoreSnapshot(_sortOriginalSnapshot)
            const after = takeSnapshot()
            pushToUndoStack({ type: 'bulk', before, after, undoExternal: externalHistory?.undo, redoExternal: externalHistory?.redo })
            externalHistory?.redo?.()
            recalculate()
            _sortOriginalSnapshot = null
            _sortOriginalRowMap = null
            return { changed: true, elapsedMs: Date.now() - started }
        }
        const end = Math.min(endRow, used.endRow)
        let lastDataRow = end
        const lastValues = Array.from({ length: used.colCount }, (_, c) => getCellForDisplay(end, used.startCol + c).computed ?? '')
        if (/^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(lastValues.find(value => String(value).trim()) ?? '').trim())) lastDataRow--
        const rowsToSort = []
        const sourceIndexes = rowIndexes || Array.from({ length: Math.max(0, lastDataRow - startRow + 1) }, (_, offset) => startRow + offset)
        for (const row of sourceIndexes) {
            const value = getCellForDisplay(row, column).computed ?? ''
            rowsToSort.push({ row, value, order: rowsToSort.length })
        }
        const numberValue = value => {
            const text = String(value).trim()
            if (!text) return null
            const percent = text.endsWith('%')
            const cleaned = text.replace(/[$,%\s]/g, '')
            if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
            const parsed = Number(cleaned)
            return Number.isFinite(parsed) ? (percent ? parsed / 100 : parsed) : null
        }
        const dateValue = value => {
            const text = String(value).trim()
            const parsed = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})$/.test(text) ? Date.parse(text) : NaN
            return Number.isNaN(parsed) ? null : parsed
        }
        rowsToSort.sort((a, b) => {
            const av = String(a.value).trim(), bv = String(b.value).trim()
            if (!av || !bv) {
                if (!av && !bv) return a.order - b.order
                return !av ? 1 : -1
            }
            const an = numberValue(av), bn = numberValue(bv)
            const ad = dateValue(av), bd = dateValue(bv)
            const aType = an !== null ? 0 : ad !== null ? 1 : 2
            const bType = bn !== null ? 0 : bd !== null ? 1 : 2
            if (aType !== bType) return aType - bType
            const order = aType === 0 ? an - bn : aType === 1 ? ad - bd : av.toLowerCase().localeCompare(bv.toLowerCase())
            return (direction === 'desc' ? -order : order) || a.order - b.order
        })
        const rowMap = new Map(rowsToSort.map((item, index) => [item.row, sourceIndexes[index]]))
        const before = takeSnapshot()
        if (!_sortOriginalSnapshot) {
            _sortOriginalSnapshot = before
            _sortOriginalRowMap = new Map(rowMap)
        } else {
            for (const [original, current] of _sortOriginalRowMap) _sortOriginalRowMap.set(original, rowMap.get(current) ?? current)
        }
        const externalHistory = external?.(rowMap)
        const next = new Map()
        const remapFormula = formula => {
            if (!formula?.startsWith('=')) return formula
            const fullBlockRanges = new Set()
            let rangeTokenIndex = 0
            for (const match of formula.matchAll(/(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)/g)) {
                const first = parseCellKey(match[1].replaceAll('$', ''))
                const last = parseCellKey(match[2].replaceAll('$', ''))
                if (first && last && first.row === startRow && last.row === lastDataRow) fullBlockRanges.add(match[0])
            }
            let rewritten = formula
            for (const range of fullBlockRanges) {
                const token = `__KEEP_RANGE_${rangeTokenIndex++}__`
                rewritten = rewritten.replace(range, token)
                fullBlockRanges.delete(range); fullBlockRanges.add(`${token}\n${range}`)
            }
            rewritten = rewritten.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, absCol, letters, absRow, digits) => {
                const target = Number(digits) - 1
                return rowMap.has(target) ? `${absCol}${letters}${absRow}${rowMap.get(target) + 1}` : match
            })
            for (const item of fullBlockRanges) { const [token, range] = item.split('\n'); rewritten = rewritten.replace(token, range) }
            return rewritten
        }
        for (const [key, cell] of before) {
            const coords = cellCoords(key)
            const newRow = rowMap.get(coords.row) ?? coords.row
            next.set(cellKey(newRow, coords.col), { ...cell, raw: remapFormula(cell.raw) })
        }
        restoreSnapshot(next)
        pushToUndoStack({ type: 'bulk', before, after: next, undoExternal: externalHistory?.undo, redoExternal: externalHistory?.redo })
        externalHistory?.redo?.()
        recalculate()
        return { changed: true, elapsedMs: Date.now() - started }
    }

    // ── Public API ──
    // The engine exposes a limited API to prevent direct access to internal state
    // All cell operations go through the public methods which handle undo/redo,
    // dependency tracking, and cache invalidation automatically

    return {
        get rows() { return rows },
        get cols() { return cols },
        getCell: getCellForDisplay,
        setCell: executeSetCell,
        applyBatch,
        recordUndoAction: (undoAction, redoAction) => pushToUndoStack({ type: 'external', undo: undoAction, redo: redoAction }),
        fillRange,
        sortRows,
        getRows,
        getUsedRange,
        insertRow: executeInsertRow,
        deleteRow: executeDeleteRow,
        insertColumn: executeInsertColumn,
        deleteColumn: executeDeleteColumn,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        // Grow the grid so that at least minRows x minCols exist. The engine is
        // sparse, so this only moves the bounds; nothing is allocated.
        ensureCapacity: (minRows, minCols) => {
            if (minRows > rows) rows = minRows
            if (minCols > cols) cols = minCols
        },
        // Internal state is not exposed - if you need to serialize/deserialize,
        // you'll need to work with the public API or add new methods
    }
}
