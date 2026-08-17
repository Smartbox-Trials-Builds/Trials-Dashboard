# Trials Dashboard

A shared, live-updating operations dashboard. Changes are stored on the server and
are pushed to every open browser using Server-Sent Events, so the team does not
need to refresh the page.

## Run locally

Requires Node.js 18 or newer. No package installation is needed.

```bash
npm start
```

Open <http://localhost:3000>. Persistent data is written to
`data/dashboard.json` (intentionally ignored by Git). Set `PORT` or `DATA_DIR` to
override those defaults.

## Test

```bash
npm test
```
