// Starter tests for the engine. Extend this file (or add more *.test.js
// files) for every behaviour you implement. Graders run `npm test` and add
// their own hidden tests against the public engine API you document in
// DESIGN_NOTES.md.
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('calculates with currency and percent text without rewriting source cells', () => {
        const engine = createEngine(5, 5)
        engine.setCell(0, 0, '$4,320.00')
        engine.setCell(0, 1, '4')
        engine.setCell(0, 2, '10%')
        engine.setCell(1, 0, '=A1/B1')
        engine.setCell(1, 1, '=A1*C1')
        expect(engine.getCell(1, 0).computed).toBe(1080)
        expect(engine.getCell(1, 1).computed).toBe(432)
        expect(engine.getCell(0, 0).raw).toBe('$4,320.00')
        expect(engine.getCell(0, 0).computed).toBe('$4,320.00')
    })

    it('keeps date-like values as text instead of parseFloat prefixes', () => {
        const engine = createEngine(5, 5)
        engine.setCell(0, 0, '2024-01-03')
        engine.setCell(0, 1, '1/8/2024')
        expect(engine.getCell(0, 0).computed).toBe('2024-01-03')
        expect(engine.getCell(0, 1).computed).toBe('1/8/2024')
    })

    it('recalculates direct and range dependents after an input changes', () => {
        const engine = createEngine(10, 5)
        engine.setCell(0, 0, '1')
        engine.setCell(1, 0, '2')
        engine.setCell(2, 0, '3')
        engine.setCell(0, 1, '=A1+A2')
        engine.setCell(0, 2, '=SUM(A1:A3)')
        engine.setCell(1, 0, '8')
        expect(engine.getCell(0, 1).computed).toBe(9)
        expect(engine.getCell(0, 2).computed).toBe(12)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })

    it('fills relative and absolute formula references in one undo step', () => {
        const engine = createEngine(20, 12)
        engine.setCell(1, 10, '=G2*H2')
        engine.setCell(1, 11, '=$G$2*H2')
        engine.fillRange({ startRow: 1, endRow: 1, startCol: 10, endCol: 11 }, { startRow: 1, endRow: 5, startCol: 10, endCol: 11 })
        expect(engine.getCell(5, 10).raw).toBe('=G6*H6')
        expect(engine.getCell(5, 11).raw).toBe('=$G$2*H6')
        expect(engine.undo()).toBe(true)
        expect(engine.getCell(5, 10).raw).toBe('')
        expect(engine.redo()).toBe(true)
        expect(engine.getCell(5, 11).raw).toBe('=$G$2*H6')
    })

    it('increments trailing numeric text and date series', () => {
        const engine = createEngine(12, 3)
        engine.setCell(0, 0, 'ORD-1001')
        engine.setCell(1, 0, 'ORD-1002')
        engine.fillRange({ startRow: 0, endRow: 1, startCol: 0, endCol: 0 }, { startRow: 0, endRow: 5, startCol: 0, endCol: 0 })
        expect(engine.getCell(5, 0).raw).toBe('ORD-1006')
        engine.setCell(0, 1, '2024-01-15')
        engine.setCell(1, 1, '2024-01-16')
        engine.fillRange({ startRow: 0, endRow: 1, startCol: 1, endCol: 1 }, { startRow: 0, endRow: 4, startCol: 1, endCol: 1 })
        expect(engine.getCell(4, 1).raw).toBe('2024-01-19')
    })

    it('preserves per-seed date formats, abbreviated cycles, and shrinks a previous fill', () => {
        const engine = createEngine(12, 3)
        engine.setCell(0, 0, '2024-01-03')
        engine.setCell(1, 0, '1/8/2024')
        engine.setCell(2, 0, '15 Jan 2024')
        const seeds = { startRow: 0, endRow: 2, startCol: 0, endCol: 0 }
        engine.fillRange(seeds, { startRow: 0, endRow: 6, startCol: 0, endCol: 0 })
        expect(engine.getCell(3, 0).raw).toMatch(/^2024-/)
        expect(engine.getCell(4, 0).raw).toMatch(/^\d+\/\d+\/2024$/)
        expect(engine.getCell(5, 0).raw).toMatch(/^\d+ Jan 2024$/)
        engine.fillRange(seeds, { startRow: 0, endRow: 4, startCol: 0, endCol: 0 }, null, { startRow: 0, endRow: 6, startCol: 0, endCol: 0 })
        expect(engine.getCell(5, 0).raw).toBe('')
        expect(engine.getCell(6, 0).raw).toBe('')
        engine.setCell(0, 1, 'Mon')
        engine.setCell(1, 1, 'Tue')
        engine.fillRange({ startRow: 0, endRow: 1, startCol: 1, endCol: 1 }, { startRow: 0, endRow: 4, startCol: 1, endCol: 1 })
        expect(engine.getCell(2, 1).raw).toBe('Wed')
    })

    it('sorts rows with formulas, restores original order, and undoes a sort once', () => {
        const engine = createEngine(8, 3)
        engine.setCell(0, 0, 'Item')
        engine.setCell(1, 0, 'B')
        engine.setCell(1, 1, '=A2')
        engine.setCell(2, 0, 'A')
        engine.setCell(2, 1, '=A3')
        engine.setCell(3, 0, 'C')
        engine.sortRows(0, 'asc', 1, 3)
        expect(engine.getCell(1, 0).raw).toBe('A')
        expect(engine.getCell(1, 1).raw).toBe('=A2')
        engine.sortRows(0, 'desc', 1, 3)
        expect(engine.getCell(1, 0).raw).toBe('C')
        engine.sortRows(0, 'original', 1, 2)
        expect(engine.getCell(1, 0).raw).toBe('B')
        expect(engine.undo()).toBe(true)
        expect(engine.getCell(1, 0).raw).toBe('C')
    })

    it('sorts currency text numerically with blanks last', () => {
        const engine = createEngine(8, 3)
        engine.setCell(0, 0, 'Total')
        engine.setCell(1, 0, '$900.00')
        engine.setCell(2, 0, '$1,080.00')
        engine.setCell(3, 0, '')
        engine.setCell(3, 1, 'row data')
        engine.sortRows(0, 'desc', 1, 3)
        expect(engine.getCell(1, 0).raw).toBe('$1,080.00')
        expect(engine.getCell(3, 0).raw).toBe('')
    })

    it('keeps row formulas attached when sorting currency totals', () => {
        const engine = createEngine(8, 5)
        engine.setCell(0, 0, 'Order')
        engine.setCell(0, 1, 'Units')
        engine.setCell(0, 2, 'Total')
        engine.setCell(0, 3, 'Per unit')
        engine.setCell(1, 0, 'ORD-A')
        engine.setCell(1, 1, '4')
        engine.setCell(1, 2, '$4,320.00')
        engine.setCell(1, 3, '=C2/B2')
        engine.setCell(2, 0, 'ORD-B')
        engine.setCell(2, 1, '5')
        engine.setCell(2, 2, '$5,400.00')
        engine.setCell(2, 3, '=C3/B3')
        engine.setCell(3, 0, 'Total')
        engine.sortRows(2, 'desc', 1, 3)
        expect(engine.getCell(1, 0).raw).toBe('ORD-B')
        expect(engine.getCell(1, 3).computed).toBe(1080)
        expect(engine.getCell(3, 0).raw).toBe('Total')
    })
})
