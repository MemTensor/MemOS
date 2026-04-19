# Disk & Memory Audit — 2026-04-08

## Context
Session with Sergio to investigate why the system appeared to have only ~45 GB available, and why RAM/swap was under pressure.

---

## System Hardware

- **Storage**: Toshiba Q300 SSD, 111.8 GB total (NOT an HDD — it's solid-state)
- **RAM**: 15 GB total
- **Swap**: 4 GB

---

## Root Cause: Disk Was 96% Full

At the start of the session, disk was nearly full:
```
108G total | 99G used | 4.2G free (96% used)
```

The "45 GB" shown in the file manager was the size of the `/home/openclaw` folder — not a disk quota or partition limit.

---

## User Account Structure (important context)

There are **two real user accounts** on the same machine, same person:

| User | Home | Size |
|---|---|---|
| `sergio` (desktop GUI login) | `/home/sergio` | 14 GB |
| `openclaw` (Hermes/AI system user) | `/home/openclaw` | 31 GB |
| `linuxbrew` | `/home/linuxbrew` | 2 GB |
| `root` | `/root` | ~950 MB |

No per-user disk quota is in place. The full SSD is shared.

---

## Biggest Disk Consumers Found

| Path | Size | Notes |
|---|---|---|
| `~/.cache/uv` | 7.8 GB | Python package cache |
| `~/.cache/pip` | 5.5 GB | pip download cache |
| `polymarket-predicti...` (project) | 7.8 GB | Deleted by user |
| Docker build cache | 4.1 GB | Build layer cache |
| `~/.cache/whisper` | 3.6 GB | Whisper AI model weights |
| `~/.cache/camoufox` | 1.4 GB | Camoufox browser binaries |
| `~/.cache/ms-playwright` | 1.3 GB | Playwright browser binaries |
| `~/.cache/huggingface` | 1.3 GB | Sentence-transformers model |
| Docker images (unused) | 1.3 GB | Prunable |
| `~/.cache/puppeteer` | 626 MB | Puppeteer browser |

---

## Cleanup Performed (~14 GB reclaimed)

```bash
uv cache clean               # 7.6 GB
pip cache purge              # 5.5 GB
sudo docker builder prune -f # 4.0 GB
sudo docker volume prune -f  # 300 MB
# polymarket folder deleted manually by user: ~7.8 GB
```

**Result:** 15 GB free (was 4.2 GB). Disk now at 86% used.

---

## RAM / Swap Situation

- **Cache (6 GB)**: Normal Linux behavior — kernel fills idle RAM with disk cache, reclaimed instantly when apps need it. Not a problem.
- **Swap (4 GB, 100% used)**: Real pressure. Docker + MemOS (Qdrant + Neo4j) + other services are exhausting physical RAM.
  - Mitigation: restart unused services to free RAM.

---

## Do NOT Delete (would break system)

- `~/.cache/whisper` — Whisper model weights
- `~/.cache/huggingface` — sentence-transformers embedding model (used by MemOS)
- `~/.cache/camoufox` — needed for anti-bot browsing (Camofox)
- `~/.cache/ms-playwright` — needed by Firecrawl/Playwright scraping

---

## Next Cleanup Candidates (if space needed again)

- `~/.hermes` (7.7 GB) — inspect contents before touching
- `~/.npm` (2.5 GB) — npm cache, safe to clear with `npm cache clean --force`
- `~/.local/share/pnpm` (1.9 GB) — pnpm store, check if needed
- `~/.cache/go-build` (290 MB) — Go build cache, safe to clear
