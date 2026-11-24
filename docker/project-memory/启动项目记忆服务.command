#!/bin/bash
# 在 Finder 里双击即可：打开终端，执行 start.sh（起服务 + 灌样例数据）。
cd "$(dirname "$0")" || exit 1
bash ./start.sh "$@"
echo
read -r -p "按回车关闭窗口" _
