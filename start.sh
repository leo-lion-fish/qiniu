#!/usr/bin/env bash
set -euo pipefail

# 进入脚本所在目录（确保在 code/ 目录启动）
cd "$(dirname "$0")"

echo "启动 FastAPI 服务..."

# 1) 统一 UTF-8 环境
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export PYTHONIOENCODING=utf-8

# 2) 让 Python 能找到 app 包（main.py 里 from app.xxx import ...）
export PYTHONPATH="$(pwd)"

# 3) 确保 app 是个包
[ -f app/__init__.py ] || touch app/__init__.py

# 4) 选择 uvicorn 启动命令：优先用当前环境 PATH 里的 uvicorn
UV=""
if command -v uvicorn >/dev/null 2>&1; then
  UV="uvicorn"
elif [ -x "./venv/bin/uvicorn" ]; then
  UV="./venv/bin/uvicorn"
elif [ -x "../venv/bin/uvicorn" ]; then
  UV="../venv/bin/uvicorn"
elif [ -x "/root/qiniu/venv/bin/uvicorn" ]; then
  UV="/root/qiniu/venv/bin/uvicorn"
else
  # 兜底用 python -m uvicorn（会走当前激活的 venv）
  if command -v python >/dev/null 2>&1; then
    UV="python -m uvicorn"
  else
    UV="python3 -m uvicorn"
  fi
fi

# 5) 端口和HOST可自定义（有需要的话在 .env 里覆盖）
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

# 6) 如果存在 .env 就加载（非必须，不存在就不用 --env-file）
if [ -f .env ]; then
  echo "使用 .env 环境变量文件"
  exec $UV main:app --host "$HOST" --port "$PORT" --reload --env-file .env
else
  echo "未发现 .env，直接启动（请确保环境变量已在系统/当前会话中设置）"
  exec $UV main:app --host "$HOST" --port "$PORT" --reload
fi
