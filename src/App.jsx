import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import { createProvider } from './ai/provider.js'
import { parseActionText } from './ai/validation.js'
import { executeQuery } from './ai/query.js'
import { buildFormatPatch, formatDisplay } from './ai/format.js'
import { CLARIFY_SCHEMA, FORMAT_SHEET_SCHEMA, QUERY_PLAN_SCHEMA } from './ai/contract.js'

const TOTAL_ROWS = 100000
const TOTAL_COLS = 200

function columnLabel(col) {
  let label = ''
  let num = col + 1
  while (num > 0) {
    num--
    label = String.fromCharCode(65 + (num % 26)) + label
    num = Math.floor(num / 26)
  }
  return label
}

function buildOffsets(count, sizeAt) {
  const offsets = new Float64Array(count + 1)
  for (let index = 0; index < count; index++) offsets[index + 1] = offsets[index] + sizeAt(index)
  return offsets
}

function offsetIndex(offsets, target) {
  let low = 0, high = offsets.length - 1
  while (low < high) {
    const mid = (low + high) >>> 1
    if (offsets[mid] < target) low = mid + 1
    else high = mid
  }
  return Math.max(0, low - 1)
}

export default function App() {
  // Engine instance is created once and reused across renders
  // Note: The engine maintains its own internal state, so React state is only used for UI updates
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [version, setVersion] = useState(0)
  const [selectedCell, setSelectedCell] = useState(null)
  const [selection, setSelection] = useState(null)
  const [selecting, setSelecting] = useState(false)
  const [fillStart, setFillStart] = useState(null)
  const [fillTarget, setFillTarget] = useState(null)
  const [fillSeed, setFillSeed] = useState(null)
  const [lastFillTarget, setLastFillTarget] = useState(null)
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  // Cell styles are stored separately from engine data
  // Format: { "row,col": { bold: bool, italic: bool, ... } }
  const [cellStyles, setCellStyles] = useState({})
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMessages, setAiMessages] = useState([])
  const [aiError, setAiError] = useState('')
  const [showPlan, setShowPlan] = useState(false)
  const [pendingFormat, setPendingFormat] = useState(null)
  const [nameValue, setNameValue] = useState('A1')
  const [frozenRows, setFrozenRows] = useState(1)
  const [columnWidths, setColumnWidths] = useState({})
  const [rowHeights, setRowHeights] = useState({})
  const [resizing, setResizing] = useState(null)
  const [filters, setFilters] = useState({})
  const [filterMenu, setFilterMenu] = useState(null)
  const [filterSearch, setFilterSearch] = useState('')
  const [sortState, setSortState] = useState({ column: null, direction: null })
  const [visible, setVisible] = useState({ row: 0, col: 0, rows: 30, cols: 12 })
  const gridScrollRef = useRef(null)
  const cellInputRef = useRef(null)
  const provider = useMemo(() => createProvider(), [])
  const rowOffsets = useMemo(() => { void version; return buildOffsets(engine.rows, row => rowHeights[row] || 28) }, [engine, rowHeights, version])
  const columnOffsets = useMemo(() => { void version; return buildOffsets(engine.cols, col => columnWidths[col] || 120) }, [engine, columnWidths, version])

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setAiOpen(open => !open)
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (engine.undo()) forceRerender()
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        if (engine.redo()) forceRerender()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [engine, forceRerender])

  const readUsedRows = useCallback(() => {
    const used = engine.getUsedRange()
    if (used.rowCount === 0) return []
    return engine.getRows(used.startRow, used.endRow, used.startCol, used.endCol)
  }, [engine])

  const makeSheetContext = useCallback(() => {
    const used = engine.getUsedRange()
    const rows = used.rowCount ? engine.getRows(used.startRow, Math.min(used.endRow, used.startRow + 5), used.startCol, used.endCol) : []
    const headers = rows[0] || []
    const columns = headers.map((name, index) => {
      const samples = rows.slice(1, 6).map(row => row[index] ?? '').filter(value => String(value).trim()).slice(0, 5)
      const values = samples.map(String)
      const type = /discount|percent|rate/i.test(name) || (values.length && values.every(value => /%/.test(value))) ? 'percent'
        : /date/i.test(name) || (values.length && values.every(value => /^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(value))) ? 'date'
          : /id|order/i.test(name) && values.some(value => /[a-z]/i.test(value) && /\d/.test(value)) ? 'id'
            : /price|total|amount|revenue/i.test(name) && values.some(value => /^\s*\$/.test(value)) ? 'currency'
              : values.length && values.every(value => /^-?\d+(\.\d+)?$/.test(value)) ? 'number'
                : 'text'
      return { name: String(name), index, type, examples: samples }
    })
    const first = used.rowCount ? engine.getRows(used.endRow, used.endRow, used.startCol, used.endCol)[0] : []
    const hasTotalsRow = /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(first.find(value => String(value).trim()) ?? '').trim())
    const currentSelection = selection || (selectedCell ? { startRow: selectedCell.r, endRow: selectedCell.r, startCol: selectedCell.c, endCol: selectedCell.c } : null)
    return {
      range: used.rowCount ? `${columnLabel(used.startCol)}${used.startRow + 1}:${columnLabel(used.endCol)}${used.endRow + 1}` : 'A1',
      rowCount: Math.max(0, used.rowCount - 1 - (hasTotalsRow ? 1 : 0)), columns,
      sampleRows: rows.slice(1, 6), selection: currentSelection ? `${columnLabel(currentSelection.startCol)}${currentSelection.startRow + 1}:${columnLabel(currentSelection.endCol)}${currentSelection.endRow + 1}` : null,
      hasTotalsRow,
    }
  }, [engine, selectedCell, selection])

  const runAiPrompt = useCallback(async (prompt = aiPrompt, existingMessages = aiMessages) => {
    setAiError(''); setPendingFormat(null)
    const context = makeSheetContext()
    const user = `${prompt}\n\nSheet context (at most five sample rows):\n${JSON.stringify(context)}`
    const system = `Translate the user's request into exactly one JSON action and no other text. The model only plans; application code computes results. Validate against one of these schemas: ${JSON.stringify([CLARIFY_SCHEMA, QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA])}. Use exact column names from context. Never invent result numbers. Context: ${JSON.stringify(context)}`
    setAiMessages(messages => [...messages, { role: 'user', content: prompt, timestamp: Date.now() }])
    try {
      const response = await provider.complete({ system, user, history: existingMessages.slice(-8).map(({ role, content }) => ({ role, content })) })
      const action = parseActionText(response.text)
      if (!['clarify', 'query', 'format_sheet'].includes(action.type)) throw Object.assign(new Error('READ_ONLY: this action is not allowed.'), { code: 'READ_ONLY' })
      if (action.type === 'clarify') setAiMessages(messages => [...messages, { role: 'assistant', content: action.question }])
      else if (action.type === 'query') {
        const rows = readUsedRows()
        const result = executeQuery(rows, action)
        if (result.error === 'UNKNOWN_COLUMN') setAiMessages(messages => [...messages, { role: 'assistant', content: `Which column did you mean? ${result.detail}` }])
        else {
          const plain = `Query: ${action.filters?.length || 0} filter(s), ${action.groupBy?.length ? `grouped by ${action.groupBy.join(', ')}` : 'matching rows'}${action.aggregates?.length ? ` with ${action.aggregates.map(a => a.fn).join(', ')} aggregate(s)` : ''}.`
          setAiMessages(messages => [...messages, { role: 'assistant', content: plain, action, result, provider: response.provider }])
        }
      } else {
        setPendingFormat({ action, provider: response.provider, rows: readUsedRows() })
        setAiMessages(messages => [...messages, { role: 'assistant', content: 'Formatting plan is ready for preview.' }])
      }
    } catch (error) {
      setAiError(error.message || String(error))
      setAiMessages(messages => [...messages, { role: 'assistant', content: `Error: ${error.message || String(error)}` }])
    }
  }, [aiPrompt, aiMessages, makeSheetContext, provider, readUsedRows])

  const rerunQuery = useCallback(action => {
    const result = executeQuery(readUsedRows(), action)
    setAiMessages(messages => [...messages, { role: 'assistant', content: 'Re-ran the saved plan locally; no model request was made.', action, result, provider: 'local' }])
  }, [readUsedRows])

  const applyAiFormat = useCallback(() => {
    if (!pendingFormat) return
    const patch = buildFormatPatch(pendingFormat.rows, cellStyles, Array.from({ length: engine.cols }, (_, col) => columnWidths[col] || 120), frozenRows, pendingFormat.action)
    if (patch.result === 'OUT_OF_RANGE') { setAiError('OUT_OF_RANGE: freezeRows must be less than the used row count.'); return }
    if (patch.result === 'APPLIED') {
        const previous = { styles: cellStyles, widths: columnWidths, frozenRows }
        const next = { styles: patch.styles, widths: Object.fromEntries(patch.widths.map((width, col) => [col, width])), frozenRows: patch.frozenRows }
        engine.recordUndoAction(
          () => { setCellStyles(previous.styles); setColumnWidths(previous.widths); setFrozenRows(previous.frozenRows); forceRerender() },
          () => { setCellStyles(next.styles); setColumnWidths(next.widths); setFrozenRows(next.frozenRows); forceRerender() },
        )
      setCellStyles(patch.styles); setColumnWidths(Object.fromEntries(patch.widths.map((width, col) => [col, width])))
      setFrozenRows(patch.frozenRows); forceRerender()
    }
    setPendingFormat(null)
  }, [pendingFormat, cellStyles, columnWidths, frozenRows, engine, forceRerender])

  const insertAiResult = useCallback((result) => {
    if (!selectedCell || !result) return
    const values = [result.columns, ...result.rows]
    const changes = []
    for (let r = 0; r < values.length; r++) for (let c = 0; c < values[r].length; c++) changes.push({ row: selectedCell.r + r, col: selectedCell.c + c, raw: String(values[r][c] ?? '') })
    engine.applyBatch(changes); forceRerender()
  }, [selectedCell, engine, forceRerender])

  const handleGridScroll = useCallback(event => {
    const element = event.currentTarget
    const row = Math.max(0, offsetIndex(rowOffsets, element.scrollTop) - 5)
    const col = Math.max(0, offsetIndex(columnOffsets, element.scrollLeft) - 2)
    setVisible({ row, col, rows: Math.ceil(element.clientHeight / 28) + 12, cols: Math.ceil(element.clientWidth / 120) + 4 })
  }, [rowOffsets, columnOffsets])

  useEffect(() => {
    if (!resizing) return undefined
    const move = event => {
      if (resizing.axis === 'column') setColumnWidths(current => ({ ...current, [resizing.index]: Math.max(40, Math.min(600, resizing.size + event.clientX - resizing.start)) }))
      else setRowHeights(current => ({ ...current, [resizing.index]: Math.max(20, Math.min(120, resizing.size + event.clientY - resizing.start)) }))
    }
    const up = () => setResizing(null)
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [resizing])

  const beginFill = (event, row, col) => {
    event.preventDefault(); event.stopPropagation()
    const source = fillSeed || selection || { startRow: row, endRow: row, startCol: col, endCol: col }
    setFillStart({ row, col, source })
    setFillTarget(null)
  }

  const completeFill = useCallback((row, col) => {
    if (!fillStart) return
    const source = fillStart.source
    const target = { startRow: Math.min(source.startRow, row), endRow: Math.max(source.endRow, row), startCol: Math.min(source.startCol, col), endCol: Math.max(source.endCol, col) }
    const previousStyles = cellStyles
    const nextStyles = { ...cellStyles }
    const seedRows = source.endRow - source.startRow + 1, seedCols = source.endCol - source.startCol + 1
    for (let r = target.startRow; r <= target.endRow; r++) for (let c = target.startCol; c <= target.endCol; c++) {
      if (r >= source.startRow && r <= source.endRow && c >= source.startCol && c <= source.endCol) continue
      const seedRow = source.startRow + ((r - source.startRow) % seedRows + seedRows) % seedRows
      const seedCol = source.startCol + ((c - source.startCol) % seedCols + seedCols) % seedCols
      const style = cellStyles[`${seedRow},${seedCol}`]
      if (style) nextStyles[`${r},${c}`] = { ...style }
    }
    if (lastFillTarget) {
      for (let r = lastFillTarget.startRow; r <= lastFillTarget.endRow; r++) for (let c = lastFillTarget.startCol; c <= lastFillTarget.endCol; c++) {
        if (r >= target.startRow && r <= target.endRow && c >= target.startCol && c <= target.endCol) continue
        if (r >= source.startRow && r <= source.endRow && c >= source.startCol && c <= source.endCol) continue
        delete nextStyles[`${r},${c}`]
      }
    }
    engine.fillRange(source, target, { undo: () => setCellStyles(previousStyles), redo: () => setCellStyles(nextStyles) }, lastFillTarget)
    setCellStyles(nextStyles)
    setFillSeed(source); setLastFillTarget(target)
    setSelection(target); setSelectedCell({ r: row, c: col }); setNameValue(`${columnLabel(col)}${row + 1}`)
    forceRerender(); setFillStart(null); setFillTarget(null)
  }, [fillStart, cellStyles, lastFillTarget, engine, forceRerender])

  useEffect(() => {
    const stop = () => {
      setSelecting(false)
      if (fillStart && fillTarget) completeFill(fillTarget.row, fillTarget.col)
      else setFillStart(null)
    }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [fillStart, fillTarget, completeFill])

  const selectedBounds = useMemo(() => selection || (selectedCell ? { startRow: selectedCell.r, endRow: selectedCell.r, startCol: selectedCell.c, endCol: selectedCell.c } : null), [selection, selectedCell])
  const selectedRangeStyle = useCallback(updates => {
    if (!selectedBounds) return
    const previous = cellStyles
    const next = { ...cellStyles }
    for (let row = selectedBounds.startRow; row <= selectedBounds.endRow; row++) for (let col = selectedBounds.startCol; col <= selectedBounds.endCol; col++) {
      const key = `${row},${col}`
      next[key] = { ...(next[key] || {}), ...updates }
    }
    engine.recordUndoAction(() => setCellStyles(previous), () => setCellStyles(next))
    setCellStyles(next)
  }, [selectedBounds, cellStyles, engine])

  const focusCell = useCallback((row, column, keepSelection = false) => {
    const r = Math.max(0, Math.min(engine.rows - 1, row))
    const c = Math.max(0, Math.min(engine.cols - 1, column))
    setSelectedCell({ r, c })
    if (!keepSelection) setSelection({ startRow: r, endRow: r, startCol: c, endCol: c })
    setNameValue(`${columnLabel(c)}${r + 1}`)
    const grid = gridScrollRef.current
    if (grid) {
      const rowTop = rowOffsets[r], colLeft = columnOffsets[c]
      if (r < visible.row || r >= visible.row + visible.rows) grid.scrollTop = rowTop
      if (c < visible.col || c >= visible.col + visible.cols) grid.scrollLeft = colLeft
    }
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`[data-cell="${r},${c}"]`)?.focus()))
  }, [engine, rowOffsets, columnOffsets, visible])

  const jumpToCell = useCallback(() => {
    const match = nameValue.toUpperCase().match(/^([A-Z]+)(\d+)$/)
    if (!match) return
    let col = 0
    for (const char of match[1]) col = col * 26 + char.charCodeAt(0) - 64
    const row = Math.max(0, Number(match[2]) - 1), column = col - 1
    setSelectedCell({ r: row, c: column }); setEditingCell(null)
    if (row >= engine.rows || column >= engine.cols) engine.ensureCapacity(Math.max(engine.rows, row + 1), Math.max(engine.cols, column + 1))
    focusCell(row, column)
    forceRerender()
  }, [nameValue, engine, focusCell, forceRerender])

  const used = useMemo(() => { void version; return engine.getUsedRange() }, [engine, version])
  const headers = useMemo(() => used.rowCount ? engine.getRows(used.startRow, used.startRow, used.startCol, used.endCol)[0] : [], [engine, used])
  const tableRows = useMemo(() => used.rowCount > 1 ? engine.getRows(used.startRow + 1, used.endRow, used.startCol, used.endCol) : [], [engine, used])
  const totalRowIndex = tableRows.length && /^\s*(grand\s+)?(total|totals|subtotal|sum)\b/i.test(String(tableRows.at(-1)?.find(value => String(value).trim()) ?? '')) ? tableRows.length - 1 : -1
  const visibleRows = tableRows.map((row, index) => ({ row, index })).filter(({ row, index }) => index === totalRowIndex || Object.entries(filters).every(([col, filter]) => {
    if (!filter) return true
    const value = String(row[Number(col)] ?? '').trim()
    if (filter.values && !filter.values.some(item => item.trim().toLowerCase() === value.toLowerCase())) return false
    const needle = (filter.search || '').trim().toLowerCase()
    if (needle && !value.toLowerCase().includes(needle)) return false
    const n = Number(value.replace(/[$,%\s]/g, '')), threshold = Number(filter.conditionValue)
    if (filter.condition === 'contains' && !value.toLowerCase().includes(String(filter.conditionValue || '').toLowerCase())) return false
    if (filter.condition === 'greater than' && !(n > threshold)) return false
    if (filter.condition === 'less than' && !(n < threshold)) return false
    if (filter.condition === 'is empty' && value !== '') return false
    if (filter.condition === 'not empty' && value === '') return false
    return true
  }))

  const sortColumn = column => {
    const direction = sortState.column !== column ? 'asc' : sortState.direction === 'asc' ? 'desc' : sortState.direction === 'desc' ? 'original' : 'asc'
    setSortState({ column, direction })
    const selectedRows = selection && selection.endRow > selection.startRow
    const blockStart = selectedRows ? Math.max(used.startRow + 1, selection.startRow) : used.startRow + 1
    const selectedEnd = selectedRows ? Math.min(used.endRow, selection.endRow) : used.endRow
    const pinTotal = totalRowIndex >= 0 && selectedEnd === used.endRow
    const blockEnd = pinTotal ? used.endRow - 1 : selectedEnd
    const remapStyles = rowMap => {
      const previous = cellStyles
      const next = {}
      for (const [key, value] of Object.entries(previous)) {
        const [row, col] = key.split(',').map(Number)
        next[`${rowMap.get(row) ?? row},${col}`] = value
      }
      return { undo: () => setCellStyles(previous), redo: () => setCellStyles(next) }
    }
    if (Object.keys(filters).length) {
      if (direction === 'original') { engine.sortRows(column + used.startCol, direction, blockStart, blockEnd, null, remapStyles); forceRerender(); return }
      const rowIndexes = visibleRows.filter(({ index }) => index !== totalRowIndex).map(({ index }) => used.startRow + 1 + index).filter(row => row >= blockStart && row <= blockEnd)
      engine.sortRows(column + used.startCol, direction, blockStart, blockEnd, rowIndexes, remapStyles)
    } else engine.sortRows(column + used.startCol, direction, blockStart, blockEnd, null, remapStyles)
    forceRerender()
  }

  // ────── Cell style helpers ──────

  const getCellStyle = useCallback((row, col) => {
    const key = `${row},${col}`
    return cellStyles[key] || {
      bold: false, italic: false, underline: false,
      bg: 'white', color: '#202124', align: 'left', fontSize: 13
    }
  }, [cellStyles])

  // ────── Cell editing ──────

  const startEditing = useCallback((row, col) => {
    setSelectedCell({ r: row, c: col })
    setEditingCell({ r: row, c: col })
    const cellData = engine.getCell(row, col)
    setEditValue(cellData.raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const commitEdit = useCallback((row, col) => {
    // Only commit if the value actually changed to avoid unnecessary recalculations
    const currentCell = engine.getCell(row, col)
    if (currentCell.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  // ────── Keyboard navigation ──────

  const handleKeyDown = useCallback((event, row, col) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      const range = engine.getUsedRange()
      if (range.rowCount) { setSelection({ startRow: range.startRow, endRow: range.endRow, startCol: range.startCol, endCol: range.endCol }); setSelectedCell({ r: range.startRow, c: range.startCol }) }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    } else if (event.key === 'Escape') {
      setEditValue(engine.getCell(row, col).raw)
      setEditingCell(null)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      commitEdit(row, col)
      if (event.shiftKey) setSelection(current => ({ startRow: current?.startRow ?? row, endRow: row + 1, startCol: current?.startCol ?? col, endCol: current?.endCol ?? col }))
      focusCell(Math.min(row + 1, engine.rows - 1), col, event.shiftKey)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      commitEdit(row, col)
      if (event.shiftKey) setSelection(current => ({ startRow: current?.startRow ?? row - 1, endRow: current?.endRow ?? row, startCol: current?.startCol ?? col, endCol: current?.endCol ?? col }))
      focusCell(Math.max(row - 1, 0), col, event.shiftKey)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitEdit(row, col)
      const next = col > 0 ? { r: row, c: col - 1 } : { r: Math.max(0, row - 1), c: col > 0 ? col - 1 : engine.cols - 1 }
      if (event.shiftKey) setSelection(current => ({ startRow: Math.min(current?.startRow ?? row, next.r), endRow: Math.max(current?.endRow ?? row, next.r), startCol: Math.min(current?.startCol ?? col, next.c), endCol: Math.max(current?.endCol ?? col, next.c) }))
      focusCell(next.r, next.c, event.shiftKey)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitEdit(row, col)
      if (event.shiftKey) setSelection(current => ({ startRow: current?.startRow ?? row, endRow: current?.endRow ?? row, startCol: current?.startCol ?? col, endCol: col + 1 }))
      focusCell(row, Math.min(col + 1, engine.cols - 1), event.shiftKey)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      const bounds = selection || { startRow: row, endRow: row, startCol: col, endCol: col }
      const changes = []
      for (let r = bounds.startRow; r <= bounds.endRow; r++) for (let c = bounds.startCol; c <= bounds.endCol; c++) changes.push({ row: r, col: c, raw: '' })
      engine.applyBatch(changes); forceRerender()
    }
  }, [engine, commitEdit, startEditing, selection, forceRerender, focusCell])

  // ────── Formula bar handlers ──────

  const handleFormulaBarKeyDown = useCallback((event) => {
    if (!editingCell) return
    handleKeyDown(event, editingCell.r, editingCell.c)
  }, [editingCell, handleKeyDown])

  const handleFormulaBarFocus = useCallback(() => {
    if (selectedCell && !editingCell) {
      setEditingCell(selectedCell)
      setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw)
    }
  }, [selectedCell, editingCell, engine])

  const handleFormulaBarChange = useCallback((value) => {
    if (!editingCell && selectedCell) setEditingCell(selectedCell)
    setEditValue(value)
  }, [editingCell, selectedCell])

  // ────── Undo / Redo ──────

  const handleUndo = useCallback(() => { if (engine.undo()) forceRerender() }, [engine, forceRerender])
  const handleRedo = useCallback(() => { if (engine.redo()) forceRerender() }, [engine, forceRerender])

  // ────── Formatting toggles ──────

  const toggleBold = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    selectedRangeStyle({ bold: !style.bold })
  }, [selectedCell, getCellStyle, selectedRangeStyle])

  const toggleItalic = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    selectedRangeStyle({ italic: !style.italic })
  }, [selectedCell, getCellStyle, selectedRangeStyle])

  const toggleUnderline = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    selectedRangeStyle({ underline: !style.underline })
  }, [selectedCell, getCellStyle, selectedRangeStyle])

  const changeFontSize = useCallback((size) => {
    if (!selectedCell) return
    selectedRangeStyle({ fontSize: size })
  }, [selectedCell, selectedRangeStyle])

  const changeAlignment = useCallback((align) => {
    if (!selectedCell) return
    selectedRangeStyle({ align })
  }, [selectedCell, selectedRangeStyle])

  const changeFontColor = useCallback((color) => {
    if (!selectedCell) return
    selectedRangeStyle({ color })
  }, [selectedCell, selectedRangeStyle])

  const changeBackgroundColor = useCallback((color) => {
    if (!selectedCell) return
    selectedRangeStyle({ bg: color })
  }, [selectedCell, selectedRangeStyle])

  // ────── Clear operations ──────

  const clearSelectedCell = useCallback(() => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
    // Remove style entry for cleared cell
    // Note: This deletes the style object entirely - if you need to preserve default styles,
    // you may want to set them explicitly rather than deleting
    const key = `${selectedCell.r},${selectedCell.c}`
    setCellStyles(prev => { const next = { ...prev }; delete next[key]; return next })
    setEditValue('')
  }, [selectedCell, engine, forceRerender])

  const clearAllCells = useCallback(() => {
    for (let r = 0; r < engine.rows; r++) {
      for (let c = 0; c < engine.cols; c++) {
        engine.setCell(r, c, '')
      }
    }
    forceRerender()
    setCellStyles({})
    setSelectedCell(null)
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  // ────── Sample data (fixtures/sales.tsv) ──────

  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setSelectedCell({ r: 0, c: 0 })
    setSelection({ startRow: 0, endRow: 0, startCol: 0, endCol: 0 })
    setNameValue('A1')
    setFillSeed(null); setLastFillTarget(null)
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  // ────── Row / Column operations ──────

  const insertRow = useCallback(() => {
    if (!selectedCell) return
    const previous = { styles: cellStyles, widths: columnWidths, heights: rowHeights }
    const styles = Object.fromEntries(Object.entries(cellStyles).map(([key, value]) => { const [row, col] = key.split(',').map(Number); return [`${row >= selectedCell.r ? row + 1 : row},${col}`, value] }))
    const heights = Object.fromEntries(Object.entries(rowHeights).map(([row, value]) => [Number(row) >= selectedCell.r ? Number(row) + 1 : Number(row), value]))
    engine.insertRow(selectedCell.r, { undo: () => { setCellStyles(previous.styles); setColumnWidths(previous.widths); setRowHeights(previous.heights) }, redo: () => { setCellStyles(styles); setRowHeights(heights) } })
    setCellStyles(styles); setRowHeights(heights)
    forceRerender()
    setSelectedCell({ r: selectedCell.r + 1, c: selectedCell.c })
  }, [selectedCell, engine, forceRerender, cellStyles, columnWidths, rowHeights])

  const deleteRow = useCallback(() => {
    if (!selectedCell) return
    const previous = { styles: cellStyles, widths: columnWidths, heights: rowHeights }
    const styles = Object.fromEntries(Object.entries(cellStyles).flatMap(([key, value]) => { const [row, col] = key.split(',').map(Number); return row === selectedCell.r ? [] : [[`${row > selectedCell.r ? row - 1 : row},${col}`, value]] }))
    const heights = Object.fromEntries(Object.entries(rowHeights).flatMap(([row, value]) => Number(row) === selectedCell.r ? [] : [[Number(row) > selectedCell.r ? Number(row) - 1 : Number(row), value]]))
    engine.deleteRow(selectedCell.r, { undo: () => { setCellStyles(previous.styles); setColumnWidths(previous.widths); setRowHeights(previous.heights) }, redo: () => { setCellStyles(styles); setRowHeights(heights) } })
    setCellStyles(styles); setRowHeights(heights)
    forceRerender()
    if (selectedCell.r >= engine.rows) {
      setSelectedCell({ r: engine.rows - 1, c: selectedCell.c })
    }
  }, [selectedCell, engine, forceRerender, cellStyles, columnWidths, rowHeights])

  const insertColumn = useCallback(() => {
    if (!selectedCell) return
    const previous = { styles: cellStyles, widths: columnWidths, heights: rowHeights }
    const styles = Object.fromEntries(Object.entries(cellStyles).map(([key, value]) => { const [row, col] = key.split(',').map(Number); return [`${row},${col >= selectedCell.c ? col + 1 : col}`, value] }))
    const widths = Object.fromEntries(Object.entries(columnWidths).map(([col, value]) => [Number(col) >= selectedCell.c ? Number(col) + 1 : Number(col), value]))
    engine.insertColumn(selectedCell.c, { undo: () => { setCellStyles(previous.styles); setColumnWidths(previous.widths); setRowHeights(previous.heights) }, redo: () => { setCellStyles(styles); setColumnWidths(widths) } })
    setCellStyles(styles); setColumnWidths(widths)
    forceRerender()
    setSelectedCell({ r: selectedCell.r, c: selectedCell.c + 1 })
  }, [selectedCell, engine, forceRerender, cellStyles, columnWidths, rowHeights])

  const deleteColumn = useCallback(() => {
    if (!selectedCell) return
    const previous = { styles: cellStyles, widths: columnWidths, heights: rowHeights }
    const styles = Object.fromEntries(Object.entries(cellStyles).flatMap(([key, value]) => { const [row, col] = key.split(',').map(Number); return col === selectedCell.c ? [] : [[`${row},${col > selectedCell.c ? col - 1 : col}`, value]] }))
    const widths = Object.fromEntries(Object.entries(columnWidths).flatMap(([col, value]) => Number(col) === selectedCell.c ? [] : [[Number(col) > selectedCell.c ? Number(col) - 1 : Number(col), value]]))
    engine.deleteColumn(selectedCell.c, { undo: () => { setCellStyles(previous.styles); setColumnWidths(previous.widths); setRowHeights(previous.heights) }, redo: () => { setCellStyles(styles); setColumnWidths(widths) } })
    setCellStyles(styles); setColumnWidths(widths)
    forceRerender()
    if (selectedCell.c >= engine.cols) {
      setSelectedCell({ r: selectedCell.r, c: engine.cols - 1 })
    }
  }, [selectedCell, engine, forceRerender, cellStyles, columnWidths, rowHeights])

  // ────── Derived state ──────

  const selectedCellStyle = useMemo(() => {
    return selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null
  }, [selectedCell, getCellStyle])

  const getColumnLabel = useCallback((col) => {
    let label = ''
    let num = col + 1
    while (num > 0) {
      num--
      label = String.fromCharCode(65 + (num % 26)) + label
      num = Math.floor(num / 26)
    }
    return label
  }, [])

  const selectedCellLabel = selectedCell
    ? `${getColumnLabel(selectedCell.c)}${selectedCell.r + 1}`
    : 'No cell'

  // Formula bar shows the raw formula text, not the computed value
  // When editing, show the current editValue; otherwise show the cell's raw content
  // Note: This is different from the cell display, which shows computed values
  const formulaBarValue = editingCell
    ? editValue
    : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')

  // ────── Render ──────

  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
      </div>

      <div className="main-content">

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <span className="row-status">{visibleRows.length} of {tableRows.length} rows</span>
          {Object.keys(filters).length > 0 && <button className="toolbar-btn" onClick={() => setFilters({})}>Clear filters</button>}
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${selectedCellStyle?.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${selectedCellStyle?.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${selectedCellStyle?.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${selectedCellStyle?.align === 'left' ? 'active' : ''}`} onClick={() => changeAlignment('left')} title="Align Left">⬤←</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Align Center">⬤</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'right' ? 'active' : ''}`} onClick={() => changeAlignment('right')} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={selectedCellStyle?.color || '#000000'}
              onChange={(e) => changeFontColor(e.target.value)}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={selectedCellStyle?.bg || 'white'} onChange={(e) => changeBackgroundColor(e.target.value)}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo">↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow} title="Insert Row">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Column">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearSelectedCell}>✕ Cell</button>
            <button className="toolbar-btn danger" onClick={clearAllCells}>✕ All</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
            <button className="toolbar-btn" onClick={() => setAiOpen(open => !open)} title="Ask your data (Ctrl+K)">✦ AI</button>
          </div>
        </div>

        {/* ── Formula Bar ── */}
        <div className="formula-bar">
          <input className="name-box" aria-label="Name box" value={nameValue} onChange={event => setNameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') jumpToCell() }} onBlur={jumpToCell} />
          <span className="formula-bar-label">{selectedCellLabel}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
          />
        </div>

        {/* ── Grid ── */}
        <div className="grid-scroll" ref={gridScrollRef} onScroll={handleGridScroll}>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {visible.col > 0 && <th className="col-header frozen-column" style={{ width: columnWidths[0] || 120, minWidth: columnWidths[0] || 120, left: 50 }}>A</th>}
                {visible.col > 0 && <th className="virtual-spacer" style={{ width: columnOffsets[visible.col] - columnOffsets[1] }} />}
                {Array.from({ length: Math.max(0, Math.min(engine.cols - visible.col, visible.cols)) }, (_, offset) => {
                  const colIndex = visible.col + offset
                  return <th key={colIndex} className="col-header" style={{ width: columnWidths[colIndex] || 120, minWidth: columnWidths[colIndex] || 120 }}>
                    <span onClick={() => { setSelection({ startRow: 0, endRow: engine.rows - 1, startCol: colIndex, endCol: colIndex }); setSelectedCell({ r: 0, c: colIndex }); sortColumn(colIndex) }} onDoubleClick={() => { const width = Math.max(60, ...tableRows.map(row => String(row[colIndex] ?? '').length * 8 + 24)); setColumnWidths(current => ({ ...current, [colIndex]: Math.min(600, width) })) }}>{getColumnLabel(colIndex)} {sortState.column === colIndex ? (sortState.direction === 'asc' ? '↑' : sortState.direction === 'desc' ? '↓' : '') : ''}</span>
                    <button className="filter-trigger" title={`Filter ${headers[colIndex] || getColumnLabel(colIndex)}`} onClick={event => { event.stopPropagation(); setFilterMenu(filterMenu === colIndex ? null : colIndex); setFilterSearch('') }}>▾</button>
                    <span className="resize-column" onDoubleClick={event => { event.stopPropagation(); const width = Math.max(60, ...tableRows.map(row => String(row[colIndex] ?? '').length * 8 + 24)); setColumnWidths(current => ({ ...current, [colIndex]: Math.min(600, width) })) }} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); setResizing({ axis: 'column', index: colIndex, start: event.clientX, size: columnWidths[colIndex] || 120 }) }} />
                    {filterMenu === colIndex && <div className="filter-menu" onClick={event => event.stopPropagation()}>
                      <strong>{String(headers[colIndex] ?? getColumnLabel(colIndex))}</strong>
                      <input placeholder="Search values" value={filterSearch} onChange={event => setFilterSearch(event.target.value)} />
                      <select value={filters[colIndex]?.condition || ''} onChange={event => setFilters(current => ({ ...current, [colIndex]: { ...current[colIndex], condition: event.target.value } }))}>
                        <option value="">No condition</option><option>contains</option><option>greater than</option><option>less than</option><option>is empty</option><option>not empty</option>
                      </select>
                      {['greater than', 'less than', 'contains'].includes(filters[colIndex]?.condition) && <input placeholder="Condition value" value={filters[colIndex]?.conditionValue || ''} onChange={event => setFilters(current => ({ ...current, [colIndex]: { ...current[colIndex], conditionValue: event.target.value } }))} />}
                      <div className="filter-values">{[...new Set(tableRows.map(row => String(row[colIndex] ?? '').trim().toLowerCase()))].filter(value => value.includes(filterSearch.toLowerCase())).map(value => <label key={value}><input type="checkbox" checked={filters[colIndex]?.values ? filters[colIndex].values.includes(value) : true} onChange={event => setFilters(current => {
                        const prior = current[colIndex]?.values ?? [...new Set(tableRows.map(row => String(row[colIndex] ?? '').trim().toLowerCase()))]
                        const values = event.target.checked ? [...prior, value] : prior.filter(item => item !== value)
                        return { ...current, [colIndex]: { ...current[colIndex], values } }
                      })} />{value || '(Blanks)'}</label>)}</div>
                      <button className="toolbar-btn" onClick={() => { setFilters(current => { const next = { ...current }; delete next[colIndex]; return next }); setFilterMenu(null) }}>Clear column</button>
                    </div>}
                  </th>
                })}
                {visible.col + visible.cols < engine.cols && <th className="virtual-spacer" style={{ width: columnOffsets[engine.cols] - columnOffsets[Math.min(engine.cols, visible.col + visible.cols)] }} />}
              </tr>
            </thead>
            <tbody>
              {visible.row > 0 && frozenRows > 0 && Array.from({ length: frozenRows }, (_, index) => index).map(rowIndex => <tr key={`frozen-${rowIndex}`} className="frozen-row">
                <td className="row-header" style={{ height: rowHeights[rowIndex] || 28 }}>{rowIndex + 1}</td>
                {visible.col > 0 && (() => { const cell = engine.getCell(rowIndex, 0); const style = cellStyles[`${rowIndex},0`] || {}; const display = cell.error || (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw); return <td className="cell frozen-column" style={{ position: 'sticky', left: 50, zIndex: 12, width: columnWidths[0] || 120, minWidth: columnWidths[0] || 120, height: rowHeights[rowIndex] || 28, background: style.bg || 'white' }}>{formatDisplay(display, style.numberFormat)}</td> })()}
                {visible.col > 0 && <td className="virtual-spacer" style={{ width: columnOffsets[visible.col] - columnOffsets[1] }} />}
                {Array.from({ length: Math.max(0, Math.min(engine.cols - visible.col, visible.cols)) }, (_, offsetCol) => {
                  const colIndex = visible.col + offsetCol
                  const cell = engine.getCell(rowIndex, colIndex)
                  const style = cellStyles[`${rowIndex},${colIndex}`] || {}
                  const display = cell.error || (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw)
                  return <td key={colIndex} className="cell" style={{ height: rowHeights[rowIndex] || 28, width: columnWidths[colIndex] || 120, minWidth: columnWidths[colIndex] || 120, background: style.bg || 'white', position: colIndex === 0 ? 'sticky' : undefined, left: colIndex === 0 ? 50 : undefined, zIndex: colIndex === 0 ? 11 : undefined }} onClick={() => { setSelectedCell({ r: rowIndex, c: colIndex }); setNameValue(`${getColumnLabel(colIndex)}${rowIndex + 1}`) }}>{formatDisplay(display, style.numberFormat)}</td>
                })}
                {visible.col + visible.cols < engine.cols && <td className="virtual-spacer" style={{ width: columnOffsets[engine.cols] - columnOffsets[Math.min(engine.cols, visible.col + visible.cols)] }} />}
              </tr>)}
              {visible.row > frozenRows && <tr className="virtual-row-spacer"><td colSpan={Math.min(engine.cols, visible.cols) + 3} style={{ height: rowOffsets[visible.row] - rowOffsets[frozenRows] }} /></tr>}
              {Array.from({ length: Math.max(0, Math.min(engine.rows - visible.row, visible.rows)) }, (_, offset) => {
                let rowIndex = visible.row + offset
                if (totalRowIndex >= 0 && rowIndex === used.startRow + 1 + totalRowIndex) rowIndex = used.endRow
                if (rowIndex > 0 && rowIndex <= tableRows.length && !visibleRows.some(item => item.index === rowIndex - 1)) return null
                return (
                <tr key={rowIndex}>
                  <td className="row-header" style={{ height: rowHeights[rowIndex] || 28, position: rowIndex < frozenRows ? 'sticky' : undefined, top: rowIndex < frozenRows ? 28 + rowIndex * 28 : undefined, zIndex: rowIndex < frozenRows ? 8 : undefined }} onClick={() => { setSelection({ startRow: rowIndex, endRow: rowIndex, startCol: 0, endCol: engine.cols - 1 }); setSelectedCell({ r: rowIndex, c: 0 }) }}><span>{rowIndex + 1}</span><span className="resize-row" onMouseDown={event => { event.preventDefault(); event.stopPropagation(); setResizing({ axis: 'row', index: rowIndex, start: event.clientY, size: rowHeights[rowIndex] || 28 }) }} /></td>
                  {visible.col > 0 && (() => { const cell = engine.getCell(rowIndex, 0); const style = cellStyles[`${rowIndex},0`] || {}; const display = cell.error || (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw); return <td className={`cell frozen-column ${rowIndex < frozenRows ? 'frozen-row-cell' : ''}`} style={{ background: style.bg || 'white', width: columnWidths[0] || 120, minWidth: columnWidths[0] || 120, height: rowHeights[rowIndex] || 28, position: 'sticky', left: 50, top: rowIndex < frozenRows ? 28 + rowIndex * 28 : undefined, zIndex: rowIndex < frozenRows ? 14 : 3 }} onClick={() => { setSelectedCell({ r: rowIndex, c: 0 }); setNameValue(`A${rowIndex + 1}`) }}>{formatDisplay(display, style.numberFormat)}</td> })()}
                  {visible.col > 0 && <td className="virtual-spacer" style={{ width: columnOffsets[visible.col] - columnOffsets[1] }} />}
                  {Array.from({ length: Math.max(0, Math.min(engine.cols - visible.col, visible.cols)) }, (_, offsetCol) => {
                    const colIndex = visible.col + offsetCol
                    const isSelected = selectedBounds && rowIndex >= selectedBounds.startRow && rowIndex <= selectedBounds.endRow && colIndex >= selectedBounds.startCol && colIndex <= selectedBounds.endCol
                    const isEditing = editingCell?.r === rowIndex && editingCell?.c === colIndex
                    const cellData = engine.getCell(rowIndex, colIndex)
                    const style = cellStyles[`${rowIndex},${colIndex}`] || {}
                    const displayValue = cellData.error
                      ? cellData.error
                      : (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

                    return (
                      <td
                        key={colIndex}
                        data-cell={`${rowIndex},${colIndex}`}
                        className={`cell ${isSelected ? 'selected' : ''}`}
                        style={{ background: style.bg || 'white', width: columnWidths[colIndex] || 120, minWidth: columnWidths[colIndex] || 120, height: rowHeights[rowIndex] || 28, position: colIndex === 0 || rowIndex < frozenRows ? 'sticky' : undefined, left: colIndex === 0 ? 50 : undefined, top: rowIndex < frozenRows ? 28 + rowIndex * 28 : undefined, zIndex: colIndex === 0 && rowIndex < frozenRows ? 9 : colIndex === 0 ? 2 : rowIndex < frozenRows ? 7 : undefined }}
                        tabIndex={isSelected ? 0 : -1}
                        onMouseDown={(e) => { e.preventDefault(); e.currentTarget.focus(); if (fillStart) { completeFill(rowIndex, colIndex); return } const next = e.shiftKey && selectedCell ? { startRow: Math.min(selectedCell.r, rowIndex), endRow: Math.max(selectedCell.r, rowIndex), startCol: Math.min(selectedCell.c, colIndex), endCol: Math.max(selectedCell.c, colIndex) } : { startRow: rowIndex, endRow: rowIndex, startCol: colIndex, endCol: colIndex }; setFillSeed(null); setLastFillTarget(null); setSelection(next); setSelectedCell({ r: rowIndex, c: colIndex }); setNameValue(`${getColumnLabel(colIndex)}${rowIndex + 1}`); setSelecting(true) }}
                        onMouseEnter={() => { if (fillStart) setFillTarget({ row: rowIndex, col: colIndex }); else if (selecting) { setSelection({ startRow: Math.min(selectedCell?.r ?? rowIndex, rowIndex), endRow: Math.max(selectedCell?.r ?? rowIndex, rowIndex), startCol: Math.min(selectedCell?.c ?? colIndex, colIndex), endCol: Math.max(selectedCell?.c ?? colIndex, colIndex) }) } }}
                        onDoubleClick={() => startEditing(rowIndex, colIndex)}
                        onKeyDown={event => {
                          if ((event.ctrlKey || event.metaKey) && event.key === 'Home') { event.preventDefault(); focusCell(0, 0); return }
                          if ((event.ctrlKey || event.metaKey) && event.key === 'End') { event.preventDefault(); const range = engine.getUsedRange(); focusCell(Math.max(0, range.endRow), Math.max(0, range.endCol)); return }
                          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (engine.undo()) forceRerender(); return }
                          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); if (engine.redo()) forceRerender(); return }
                          if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); const r = Math.max(0, Math.min(engine.rows - 1, rowIndex + (event.key === 'PageDown' ? visible.rows : -visible.rows))); focusCell(r, colIndex); return }
                          if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); startEditing(rowIndex, colIndex) }
                          else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); const bounds = selection || { startRow: rowIndex, endRow: rowIndex, startCol: colIndex, endCol: colIndex }; const changes = []; for (let r = bounds.startRow; r <= bounds.endRow; r++) for (let c = bounds.startCol; c <= bounds.endCol; c++) changes.push({ row: r, col: c, raw: '' }); engine.applyBatch(changes); forceRerender() }
                          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                            event.preventDefault()
                            event.stopPropagation()
                            setSelectedCell({ r: rowIndex, c: colIndex })
                            setSelection({ startRow: rowIndex, endRow: rowIndex, startCol: colIndex, endCol: colIndex })
                            setEditingCell({ r: rowIndex, c: colIndex })
                            setEditValue(event.key)
                            setTimeout(() => cellInputRef.current?.focus(), 0)
                          }
                          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                            event.preventDefault()
                            const r = Math.max(0, Math.min(engine.rows - 1, rowIndex + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)))
                            const c = Math.max(0, Math.min(engine.cols - 1, colIndex + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)))
                            if (event.shiftKey) setSelection({ startRow: Math.min(selectedCell?.r ?? rowIndex, r), endRow: Math.max(selectedCell?.r ?? rowIndex, r), startCol: Math.min(selectedCell?.c ?? colIndex, c), endCol: Math.max(selectedCell?.c ?? colIndex, c) })
                            else setSelection({ startRow: r, endRow: r, startCol: c, endCol: c })
                            focusCell(r, c, event.shiftKey)
                          }
                        }}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(rowIndex, colIndex)}
                            onKeyDown={(e) => {
                              e.stopPropagation()
                              if (e.key === 'Backspace' || e.key === 'Delete') return
                              handleKeyDown(e, rowIndex, colIndex)
                            }}
                            ref={isSelected ? cellInputRef : undefined}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: style.color || '#202124',
                              fontSize: (style.fontSize || 13) + 'px',
                              textAlign: style.align || 'left',
                              background: style.bg || 'white',
                            }}
                          />
                        ) : (
                          <div
                            className={`cell-display align-${style.align || 'left'} ${cellData.error ? 'error' : ''}`}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: cellData.error ? '#d93025' : (style.color || '#202124'),
                              fontSize: (style.fontSize || 13) + 'px',
                            }}
                          >
                            {formatDisplay(displayValue, style.numberFormat)}
                            {selectedCell?.r === rowIndex && selectedCell?.c === colIndex && selectedBounds?.endRow === rowIndex && selectedBounds?.endCol === colIndex && <button className="fill-handle" aria-label="Drag to fill" onMouseDown={event => beginFill(event, rowIndex, colIndex)} />}
                          </div>
                        )}
                      </td>
                    )
                  })}
                  {visible.col + visible.cols < engine.cols && <td className="virtual-spacer" style={{ width: columnOffsets[engine.cols] - columnOffsets[Math.min(engine.cols, visible.col + visible.cols)] }} />}
                </tr>
              )})}
              {visible.row + visible.rows < engine.rows && <tr className="virtual-row-spacer"><td colSpan={Math.min(engine.cols, visible.cols) + 3} style={{ height: rowOffsets[engine.rows] - rowOffsets[Math.min(engine.rows, visible.row + visible.rows)] }} /></tr>}
            </tbody>
          </table>
        </div>

        {aiOpen && <aside className="ai-panel" aria-label="Ask your data">
          <div className="ai-panel-title"><div><strong>Workbook AI</strong><span>Plans and computes locally</span></div><button className="icon-btn" onClick={() => setAiOpen(false)} aria-label="Close AI panel">×</button></div>
          <div className="ai-history">
            {aiMessages.map((message, index) => <div className={`ai-message ${message.role}`} key={`${message.timestamp || index}-${index}`}>
              <p>{message.content}</p>
              {message.action && <>
                <div className="ai-result-meta">{message.result?.rowCount ?? 0} result rows · {message.provider}</div>
                {showPlan && <pre className="ai-plan">{JSON.stringify(message.action, null, 2)}</pre>}
                {message.result?.columns && <div className="ai-result-table"><table><thead><tr>{message.result.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{message.result.rows.slice(0, 30).map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, colIndex) => <td key={colIndex}>{String(value ?? '')}</td>)}</tr>)}</tbody></table></div>}
                <div className="ai-actions"><button className="toolbar-btn" onClick={() => rerunQuery(message.action)}>Re-run</button><button className="toolbar-btn" onClick={() => insertAiResult(message.result)}>Insert at selected cell</button></div>
              </>}
            </div>)}
            {pendingFormat && <div className="format-preview"><strong>Formatting preview</strong><p>{pendingFormat.action.headerStyle ? 'Header styling; ' : ''}{pendingFormat.action.columns?.length || 0} formatted columns; {pendingFormat.action.freezeRows !== undefined ? `freeze ${pendingFormat.action.freezeRows} rows; ` : ''}{pendingFormat.action.totalsStyle ? 'totals style; ' : ''}{pendingFormat.action.autoFitColumns ? 'auto-fit columns' : ''}</p>{showPlan && <pre className="ai-plan">{JSON.stringify(pendingFormat.action, null, 2)}</pre>}<div className="ai-actions"><button className="toolbar-btn active" onClick={applyAiFormat}>Apply</button><button className="toolbar-btn" onClick={() => setPendingFormat(null)}>Discard</button></div></div>}
          </div>
          {aiError && <div className="ai-error" role="alert">{aiError}</div>}
          <label className="plan-toggle"><input type="checkbox" checked={showPlan} onChange={event => setShowPlan(event.target.checked)} /> Show action plan</label>
          <form className="ai-composer" onSubmit={event => { event.preventDefault(); if (aiPrompt.trim()) { runAiPrompt(); setAiPrompt('') } }}>
            <textarea value={aiPrompt} onChange={event => setAiPrompt(event.target.value)} placeholder="Ask a question or describe a format…" rows={3} />
            <button type="submit" className="toolbar-btn active">Send</button>
          </form>
        </aside>}

        <p className="footer-hint">
          Click a cell to edit · Enter/Tab/Arrow keys to navigate · Formulas: =A1+B1 · =SUM(A1:A5) · =AVG(A1:A5) · =MAX(A1:A5) · =MIN(A1:A5)
        </p>
      </div>
    </div>
  )
}
