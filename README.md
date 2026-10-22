# SpreadsheetApp

A small browser spreadsheet built with React and Vite: a sparse cell engine with formulas, dependency tracking and undo, and a single-file grid UI.

**Candidates: the tasks are in [`CHALLENGE.md`](./CHALLENGE.md).** The AI tasks are specified in [`AI_CONTRACT.md`](./AI_CONTRACT.md). Write up your work in [`DESIGN_NOTES.md`](./DESIGN_NOTES.md).

## Prerequisites

- Node.js 18 or newer
- npm
- Git

## Getting started

```bash
git clone https://github.com/tauhidst07/spreadhsheet.git
cd spreadhsheet
npm install
npm run dev
```

Open `http://localhost:5173`. The toolbar has two sample loaders: **⬇ Sample 33** loads `fixtures/sales.tsv` (33 rows) and **⬇ Sample 3k** loads `fixtures/sales-large.tsv` (about 3,000 rows) at `A1`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint |
| `npm test` | Run the Vitest suite once (`npm run test:watch` to keep it running) |

For the AI tasks, copy `.env.example` to `.env.local` and fill in the `VITE_AI_*` values for whichever LLM API you choose. The default provider is an offline mock, so the app runs without any key. A backend is optional; if you add one, it lives in `server/` and starts with `npm run server`.

## Project structure

```
spreadhsheet/
├── src/
│   ├── engine/
│   │   ├── core.js            # Engine: formulas, dependency graph, undo/redo, row/col ops (no React here)
│   │   └── core.test.js       # Starter tests — extend these
│   ├── ai/
│   │   ├── contract.js        # The JSON actions a model may return, with schemas
│   │   ├── provider.js        # Provider interface; mock + the http provider you implement
│   │   └── mockProvider.js    # Offline provider that answers the prompts in fixtures/ai-eval
│   ├── fixtures/loadSample.js # The two "Sample" toolbar actions
│   ├── App.jsx                # All of the UI
│   └── App.css
├── fixtures/
│   ├── sales.tsv              # 33 rows of deliberately messy sample data
│   ├── sales-large.tsv        # ~3,000 rows of the same; the AI tasks are judged on this one
│   └── ai-eval/               # Golden answers for the AI tasks (queries.json, format-prompts.json)
├── CHALLENGE.md               # The tasks
├── AI_CONTRACT.md             # Semantics of the AI actions
└── DESIGN_NOTES.md            # Your write-up
```

## What works today

- Click a cell to edit; `Enter`/`Tab`/arrow keys to move; `Escape` to cancel; a formula bar showing the raw content.
- Formulas: `=A1+B1`, `=(A1+B1)*2`, and the range functions `SUM`, `AVG`, `MIN`, `MAX`.
- Cycle detection (`#CYCLE!`), `#VALUE!`, `#REF!`, `#PARSE!`.
- Bold / italic / underline, font size, alignment, text and background colour, per cell.
- Undo / redo of cell edits and of row/column insert and delete, with formula references shifted.

## Demo

A screen recording of the implemented features is included in the repository root as `Assignment_Arpit_Bhatnagar.mp4`.

## Browser support
Current Chrome, Firefox, Safari and Edge.

## Troubleshooting

- **Install fails:** `rm -rf node_modules package-lock.json && npm install`.
- **Port 5173 busy:** Vite picks the next free port, or run `npm run dev -- --port 3000`.
- **Build fails:** make sure `npm install` completed, then `rm -rf dist && npm run build`.
