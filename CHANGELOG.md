# Changelog

## 0.2.0

- Report per-process GPU memory from the Windows performance counters
  (`\GPU Process Memory(*)\Dedicated Usage`), so graphics-only holders are visible even though
  `nvidia-smi` prints `N/A` per process under WDDM and only lists compute contexts.
- Holders now carry `kind`: `compute` / `graphics` / `compute+graphics`, and are sorted by memory.
- Reaping also covers orphaned graphics-only trees (still gated by `protect` and the 8 MiB floor).

## 0.1.0

- First release: `gpu_status`, `gpu_reap` (dry-run by default), `gpu_guard` watchdog, CLI, scheduled-task example.
