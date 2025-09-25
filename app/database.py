# -*- coding: utf-8 -*-
"""
数据库引擎与会话管理
- 避免循环依赖：在此处定义 Base，models.py 从这里导入 Base
- 支持环境变量覆盖 DATABASE_URL
- 设置连接池与健康探测，提升稳定性
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# 默认连接串（可被环境变量覆盖）
# 你原来的串是 postgresql://qiniu:310270mjq@localhost/ai_chat
DEFAULT_DB_URL = "postgresql+psycopg2://qiniu:310270mjq@localhost/ai_chat"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DB_URL)

# 创建引擎（推荐启用 pool_pre_ping，避免“server closed the connection unexpectedly”）
engine = create_engine(
    DATABASE_URL,
    pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
    max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "10")),
    pool_pre_ping=True,
    pool_recycle=int(os.getenv("DB_POOL_RECYCLE", "1800")),  # 秒，30分钟回收
    future=True,
)

# 会话工厂
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    future=True,
)

# Declarative Base（供 models.py 使用）
Base = declarative_base()

def get_db():
    """FastAPI 依赖：获取一次请求内的数据库会话"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
