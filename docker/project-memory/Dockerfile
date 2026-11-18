# 本地部署镜像：在仓库自带镜像上加两样东西
#   1. psycopg2-binary（项目记忆的 Postgres 存储）、sqlite-vec（改回 SQLite 时的向量索引）
#   2. pip install -e . --no-deps —— 让 pyproject 里的插件入口点（dream、project_memory）注册进镜像。
#      仓库自带的 docker/Dockerfile 只设了 PYTHONPATH=/app/src，entry_points 查不到，内置插件不会加载。
FROM memos-base:promem

RUN pip install --no-cache-dir sqlite-vec cachetools psycopg2-binary

COPY pyproject.toml README.md /app/
COPY src/ /app/src/
RUN pip install --no-cache-dir --no-deps -e /app \
    && python -c "import importlib.metadata as m; print([e.name for e in m.entry_points(group='memos.plugins')])"

ENV PYTHONPATH=/app/src
WORKDIR /app

CMD ["uvicorn", "memos.api.server_api:app", "--host", "0.0.0.0", "--port", "8000"]
