# Tab Butler — menubar app

A macOS menubar agent showing **real Chrome per-process RAM**, system memory,
and running **localhost dev servers** (with one-click Kill). Built as a plain
Swift Package executable — no Xcode project needed.

## Run

```bash
cd menubar
swift run            # builds + launches; an item appears in your menubar
```

Click the menubar item for the dashboard. Quit from the power button in the
popover (or Ctrl+C in the terminal that launched it).

## What it shows

- **Chrome** total RAM (sum of all Chrome process RSS) + the top processes
- **System** memory used / total (from `vm_stat` + physical memory)
- **Localhost · servers running** — node/python/vite/etc. listening ports, each
  with **Kill** (SIGTERM); refreshes every 2s

## Honest limits

- RAM is per **process**, not per **tab**. Chrome's Site Isolation spreads a
  tab's memory across (and shares it between) renderer processes, so per-tab
  numbers aren't attainable — this mirrors Chrome's own Task Manager.
- v0.1 is standalone (OS-level data only). Linking processes to specific tab
  titles would need the extension to push tab→PID hints — a later iteration.

## Packaging (later)

For a double-click `.app` that autostarts at login, wrap this in an Xcode app
target, or `swift build -c release` + a minimal `.app` bundle with
`LSUIElement=YES`. v0.1 runs fine via `swift run`.
