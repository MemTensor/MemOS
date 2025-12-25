## command + u/i启动聊天
# source /Users/wzwpro/MemOS/.venv/bin/activate
# docker start $(docker ps -aq)
# git reset --soft HEAD~1
poetry run python3 src/memos/api/server_api.py
# poetry run uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8001 --workers 8
