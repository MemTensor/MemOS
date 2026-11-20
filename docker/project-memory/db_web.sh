#!/usr/bin/env bash
# 在浏览器里只读查看项目记忆的 SQLite 库：http://127.0.0.1:8090 （Ctrl+C 关闭）
# 只在 PROJECT_MEMORY_GRAPH_DB=sqlite 时有用。默认的 Postgres 存储用任意客户端连
#   127.0.0.1:5433  用户 memos  密码 projectmemory  库 project_memory  schema project_memory
# 需要 memos-promem 容器在运行。用部署镜像起一个临时容器挂同一个数据卷，装 sqlite-web 后打开；
# 加载 sqlite-vec 扩展，否则 memory_vec（vec0 虚表）会让 sqlite-web 启动时报 no such module: vec0。
#   bash docker/project-memory/db_web.sh
#   PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple bash docker/project-memory/db_web.sh   # 换 PyPI 镜像
set -euo pipefail
PIP_INDEX="${PIP_INDEX:-https://mirrors.aliyun.com/pypi/simple/}"
PORT="${PORT:-8090}"

docker ps --format '{{.Names}}' | grep -q '^memos-promem$' \
  || { echo "memos-promem 容器没在运行，先执行 start.sh" >&2; exit 1; }

echo "打开 http://127.0.0.1:${PORT}（第一次要装 sqlite-web，几秒到几十秒）"
docker run --rm -p "${PORT}:8080" --volumes-from memos-promem memos-promem:local sh -c \
  'pip install -q --root-user-action=ignore -i "$0" sqlite-web \
   && exec sqlite_web -H 0.0.0.0 -p 8080 -x -r \
        -e "$(python -c "import sqlite_vec; print(sqlite_vec.loadable_path())")" \
        /data/project_memory/project_memory.db' "${PIP_INDEX}"
