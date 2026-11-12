# qara-view

A browser canvas for **views**. Draw on a [tldraw](https://tldraw.dev) canvas, save your work by
name, and come back to it later: views are stored as JSON documents in a views directory, each
save captured with a PNG screenshot alongside it. A small Bun server fronts those files and
pushes save/rename events to open browsers over server-sent events.

## Quickstart

Requires [Bun](https://bun.sh):

```sh
bun install
bun run dev
```

`dev` starts the API server on port 7201 and the Vite dev server on port 5173; Vite proxies
`/api`, `/events` and `/health` to the API server. Open <http://localhost:5173/?file=my-view> —
the `file` parameter names the view to load (`current` when omitted).

- **Save** — the 💾 button or `Ctrl/Cmd+S` writes the document as `<name>.json` and captures a
  `<name>.png` screenshot alongside it.
- **v+** — saves the document as the next version, `<name>-v<N>.json`.
- **Rename** — click the view title in the top panel.

## Production build

```sh
bun run build   # bundle the frontend into dist/
bun run start   # serve dist/ and the API from one process
```

## Configuration

| Variable  | Default                  | Purpose                                      |
| --------- | ------------------------ | -------------------------------------------- |
| `PORT`    | `7201`                   | API server port                              |
| `VIEWS_DIR` | `thoughts/shared/views` | Directory holding view JSON and screenshots |

The views directory is created at startup if missing.

## Checks and tests

```sh
bun run check
```

runs the architecture check (only `src/main.tsx` may import `src/App.tsx`), Biome lint,
`tsc --noEmit`, and the test suite (`bun test`). Each piece also has its own script:
`check:architecture`, `check:lint`, `check:types`, `test`.

## API

| Method | Path                 | Purpose                                                  |
| ------ | -------------------- | -------------------------------------------------------- |
| GET    | `/health`            | uptime and views dir                                     |
| GET    | `/api/list`          | view names, sorted                                       |
| GET    | `/api/load?name=`    | one view's JSON document                                 |
| POST   | `/api/save`          | write `{ name, document }` as `<name>.json`              |
| POST   | `/api/rename`        | rename a view                                            |
| POST   | `/api/screenshot`    | PNG body stored as `<name>.png` (`X-View-Name` header)   |
| GET    | `/events`            | server-sent events fired on save and rename              |

## View files

A views directory holds:

- `<name>.json` — `{ name, savedAt, document }`
- `<name>-v<N>.json` — a numbered version of `<name>`
- `<name>.png` — the screenshot captured with a save

Filenames are sanitized: `/ \ : * ? " < > |` become `_`.
