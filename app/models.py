# -*- coding: utf-8 -*-
"""
SQLAlchemy ORM 模型定义
与当前数据库表结构保持一致：
- character_info
- chat_sessions
- chat_history
注意：
1) 这里不做 Base.metadata.create_all()，避免误改现有库结构；
2) Base 请从 app.database 导入，避免循环依赖。
"""

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, func
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import TIMESTAMP

# 从 database.py 导入 Base（database.py 中定义了 engine/SessionLocal/Base）
from .database import Base


# =========================
# 角色信息表：character_info
# =========================
class CharacterInfo(Base):
    __tablename__ = "character_info"

    # 与数据库中定义一致：id SERIAL PRIMARY KEY
    id = Column(Integer, primary_key=True, autoincrement=True)

    # varchar(255) NOT NULL
    name = Column(String(255), nullable=False, index=True)

    # 其余为 text，可空
    background = Column(Text)
    skills = Column(Text)
    current_playstyle = Column(Text)
    personality = Column(Text)

    def __repr__(self):
        return f"<CharacterInfo id={self.id} name={self.name!r}>"


# =======================
# 会话表：chat_sessions
# =======================
class ChatSession(Base):
    __tablename__ = "chat_sessions"

    # 注意：表里 id 是 TEXT 主键（= 前端生成的 session_id）
    id = Column(String, primary_key=True)

    # 角色 ID（可空）；未加外键约束到 character_info.id（与现库一致）
    character_id = Column(Integer, nullable=True)

    # 会话标题（可空），varchar(128)
    title = Column(String(128), nullable=True)

    # timestamptz NOT NULL DEFAULT now()
    created_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    last_active_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())

    # 方便通过会话拿到消息（lazy=selectin 减少 N+1）
    messages = relationship(
        "ChatHistory",
        primaryjoin="ChatSession.id==ChatHistory.session_id",
        backref="session",
        lazy="selectin",
        cascade="all, delete-orphan",
        passive_deletes=True,  # 与 ON DELETE CASCADE 对齐
    )

    def __repr__(self):
        return f"<ChatSession id={self.id!r} character_id={self.character_id}>"


# =======================
# 消息表：chat_history
# =======================
class ChatHistory(Base):
    __tablename__ = "chat_history"

    # id SERIAL PRIMARY KEY
    id = Column(Integer, primary_key=True, autoincrement=True)

    # 会话 ID：varchar(255) NOT NULL，外键到 chat_sessions(id) 且 ON DELETE CASCADE
    session_id = Column(
        String(255),
        ForeignKey("chat_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # 角色名：varchar(255) NOT NULL（为兼容旧数据而保留）
    character_name = Column(String(255), nullable=False)

    # 文本内容：text NOT NULL
    message = Column(Text, nullable=False)

    # created_at：数据库中是 timestamp without time zone，默认 CURRENT_TIMESTAMP
    created_at = Column(DateTime(timezone=False), server_default=func.current_timestamp())

    # 发送方角色（可空）：'user' | 'assistant' | 'system'
    role = Column(String(16), nullable=True)

    # 角色 ID（可空），当前库未加外键，保持一致
    character_id = Column(Integer, nullable=True)

    def __repr__(self):
        return f"<ChatHistory id={self.id} sid={self.session_id!r} role={self.role!r}>"
