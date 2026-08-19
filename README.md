# Trials Operations Dashboard

Windows desktop app for the shared trials queue, backed by Supabase Realtime.

## What Is Included

- Electron desktop shell for Windows.
- Supabase-backed queue and GIPOD code inventory.
- Live refresh across multiple open app instances through Supabase Realtime.
- Bulk paste intake from Excel in the same column order as the attached workbook.
- SQL schema and seed data from `testing QUEUE.xlsx`.

## Supabase Setup

The schema has already been applied to project `Trials-Checkin-Sidekick`:

- Project ref: `jkmgxdhgnxozfzmtmjlb`
- URL: `https://jkmgxdhgnxozfzmtmjlb.supabase.co`

If you need to recreate it, run `supabase/schema.sql` in the Supabase SQL editor, then optionally run `supabase/seed.sql`.

The app needs a Supabase publishable or anon key. Copy `.env.example` to `.env` and replace the placeholder:

```env
VITE_SUPABASE_URL=https://jkmgxdhgnxozfzmtmjlb.supabase.co
VITE_SUPABASE_ANON_KEY=replace-with-your-supabase-publishable-or-anon-key
```

You can also launch the app without `.env`; it will show a setup screen and store the URL/key locally on that machine.

## Run Locally

Use the bundled Node path in this Codex environment if `node` is not on your normal `PATH`.

```powershell
$env:Path='C:\Users\Jorda\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
C:\Users\Jorda\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd install
C:\Users\Jorda\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe .\node_modules\vite\bin\vite.js --host 127.0.0.1
```

In another terminal:

```powershell
$env:Path='C:\Users\Jorda\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
.\node_modules\.bin\electron.cmd .
```

## Build Installer

```powershell
$env:Path='C:\Users\Jorda\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
powershell -ExecutionPolicy Bypass -File scripts/package-win.ps1
```

The package script stages a minimal Electron project in `.electron-package`, builds the web assets, and writes both an installer and portable build to `app-release`.

The installer is the file to share with other PCs. Auto-update support uses Electron Builder's NSIS update flow. For GitHub Releases, set the repo owner and repo name before building:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-win.ps1
```

Create a GitHub release for the same version and upload the matching files from `app-release`, including `latest.yml`, the installer `.exe`, and blockmap files. Increase the version in `package.json` before each update build.

If you are not using GitHub Releases, set `TRIALS_UPDATE_URL` instead and upload the same files to that static HTTPS folder.

## Publish To GitHub

Repo: `https://github.com/Smartbox-Trials-Builds/Trials-Dashboard`

Install Git and GitHub CLI, then sign in with `gh auth login`. From this project folder:

```powershell
git init
git add .
git commit -m "Initial Trials Operations Dashboard app"
git branch -M main
git remote add origin https://github.com/Smartbox-Trials-Builds/Trials-Dashboard.git
git push -u origin main
```

For each update:

```powershell
npm version patch
powershell -ExecutionPolicy Bypass -File scripts/package-win.ps1
gh release create "v$(node -p "require('./package.json').version")" app-release\latest.yml app-release\*.exe app-release\*.blockmap --title "Trials Operations Dashboard $(node -p "require('./package.json').version")"
```

## Security Note

The current free-plan setup is an internal shared queue with anonymous-key CRUD policies. Anyone with the app key can read and edit the queue. For wider distribution, add Supabase Auth and replace the open team policies with authenticated user policies.
