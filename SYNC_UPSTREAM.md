# Синхронизация с Upstream MemOS

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                    MemTensor/MemOS (upstream)               │
│                         Оригинал                            │
└─────────────────────────┬───────────────────────────────────┘
                          │ git fetch upstream
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  anatolykoptev/MemOS (fork)                 │
│  ┌────────────────────┐  ┌─────────────────────────────┐   │
│  │     src/memos/     │  │      overlays/krolik/       │   │
│  │   (base MemOS)     │  │  (auth, rate-limit, admin)  │   │
│  │                    │  │                             │   │
│  │  ← syncs with      │  │  ← НАШИ кастомизации       │   │
│  │    upstream        │  │    (никогда не конфликтуют) │   │
│  └────────────────────┘  └─────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │ Dockerfile.krolik
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                krolik-server (production)                   │
│           src/memos/ + overlays merged at build             │
└─────────────────────────────────────────────────────────────┘
```

## Регулярная синхронизация (еженедельно)

```bash
cd ~/CascadeProjects/piternow_project/MemOS

# 1. Получить изменения upstream
git fetch upstream

# 2. Посмотреть что нового
git log --oneline upstream/main..main    # Наши коммиты
git log --oneline main..upstream/main    # Новое в upstream

# 3. Merge upstream (overlays/ не затрагивается)
git checkout main
git merge upstream/main

# 4. Если конфликты (редко, только в src/):
#    - Разрешить конфликты
#    - git add .
#    - git commit

# 5. Push в наш fork
git push origin main
```

## Обновление production (krolik-server)

После синхронизации форка:

```bash
cd ~/krolik-server

# Пересобрать с новым MemOS
docker compose build --no-cache memos-api

# Перезапустить
docker compose up -d memos-api

# Проверить логи
docker logs -f memos-api
```

## Добавление новых фич в overlay

```bash
# 1. Создать файл в overlays/krolik/
vim overlays/krolik/api/middleware/new_feature.py

# 2. Импортировать в server_api_ext.py
vim overlays/krolik/api/server_api_ext.py

# 3. Commit в наш fork
git add overlays/
git commit -m "feat(krolik): add new_feature middleware"
git push origin main
```

## Важные правила

### ✅ Делать:
- Все кастомизации в `overlays/krolik/`
- Багфиксы в `src/` которые полезны upstream — создавать PR
- Регулярно синхронизировать с upstream

### ❌ НЕ делать:
- Модифицировать файлы в `src/memos/` напрямую
- Форкать API в overlay вместо расширения
- Игнорировать обновления upstream > 2 недель

## Структура overlays

```
overlays/
└── krolik/
    └── api/
        ├── middleware/
        │   ├── __init__.py
        │   ├── auth.py          # API Key auth (PostgreSQL)
        │   └── rate_limit.py    # Redis sliding window
        ├── routers/
        │   ├── __init__.py
        │   └── admin_router.py  # /admin/keys CRUD
        ├── utils/
        │   ├── __init__.py
        │   └── api_keys.py      # Key generation
        └── server_api_ext.py    # Entry point
```

## Environment Variables (Krolik)

```bash
# Authentication
AUTH_ENABLED=true
MASTER_KEY_HASH=<sha256-hash>
INTERNAL_SERVICE_SECRET=<secret>

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT=100
RATE_WINDOW_SEC=60
REDIS_URL=redis://redis:6379

# PostgreSQL (for API keys)
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=memos
POSTGRES_PASSWORD=<password>
POSTGRES_DB=memos

# CORS
CORS_ORIGINS=https://krolik.hully.one,https://memos.hully.one
```

## Миграция из текущего krolik-server

Текущий `krolik-server/services/memos-core/` содержит смешанный код.
После перехода на overlay pattern:

1. **krolik-server** будет использовать `Dockerfile.krolik` из форка
2. **Локальные изменения** удаляются из krolik-server
3. **Все кастомизации** живут в `MemOS/overlays/krolik/`

```yaml
# docker-compose.yml (krolik-server)
services:
  memos-api:
    build:
      context: ../MemOS           # Используем форк напрямую
      dockerfile: docker/Dockerfile.krolik
    # ... остальная конфигурация
```
