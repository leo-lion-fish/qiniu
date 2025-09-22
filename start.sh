#!/bin/bash

# 启动 FastAPI 后端服务
echo "启动 FastAPI 服务..."
uvicorn main:app --reload --host 0.0.0.0 --port 8000
