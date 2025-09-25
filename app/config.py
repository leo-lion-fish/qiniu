# -*- coding: utf-8 -*-
"""
集中管理项目配置：
优先级：环境变量 > .env 文件 > 代码默认值
"""
import os
from pathlib import Path

# 允许使用 .env（可选安装：pip install python-dotenv）
try:
    from dotenv import load_dotenv  # type: ignore
    # 优先加载项目根目录的 .env（如果存在）
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        load_dotenv(env_file)  # 仅加载，不报错
except Exception:
    pass

# ====== 数据库配置 ======
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    # 你的原始连接串（默认值）
    "postgresql+psycopg2://qiniu:310270mjq@127.0.0.1:5432/ai_chat",
)
DB_POOL_SIZE    = int(os.getenv("DB_POOL_SIZE", "5"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "10"))
DB_POOL_RECYCLE = int(os.getenv("DB_POOL_RECYCLE", "1800"))  # 秒
DB_POOL_PRE_PING = os.getenv("DB_POOL_PRE_PING", "1") in ("1", "true", "True")

# ====== Redis ======
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
HISTORY_MAX_TURNS   = int(os.getenv("HISTORY_MAX_TURNS", "20"))
HISTORY_TTL_SECONDS = int(os.getenv("HISTORY_TTL_SECONDS", "259200"))  # 3 天

# ====== 七牛 OpenAI 代理 ======
QINIU_OPENAI_BASE = os.getenv("QINIU_OPENAI_BASE", "http://127.0.0.1:8000").rstrip("/")
QINIU_OPENAI_API_KEY = os.getenv("QINIU_OPENAI_API_KEY", "")

# ====== 其他 ======
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-v3")
