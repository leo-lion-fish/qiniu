# -*- coding: utf-8 -*-
"""
数据库 CRUD：会话与历史
"""
from typing import List, Dict, Optional
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from .models import ChatSession, ChatHistory

def upsert_session(db: Session, session_id: str, character_id: Optional[int]):
    """创建或更新会话的活跃时间"""
    s = db.get(ChatSession, session_id)
    if not s:
        s = ChatSession(id=session_id, character_id=character_id)
        db.add(s)
    s.last_active_at = func.now()
    return s

def add_turn(
    db: Session,
    *,
    session_id: str,
    character_id: Optional[int],
    character_name: Optional[str],
    user_msg: str,
    assistant_msg: str,
):
    """写入一轮问答两条记录，并更新会话活跃时间"""
    upsert_session(db, session_id, character_id)
    db.add_all([
        ChatHistory(session_id=session_id, character_id=character_id,
                    character_name=character_name or "", role="user", message=user_msg),
        ChatHistory(session_id=session_id, character_id=character_id,
                    character_name=character_name or "", role="assistant", message=assistant_msg),
    ])
    db.commit()

def load_history_from_db(db: Session, session_id: str, limit: int = 100) -> List[Dict]:
    """从 DB 读取最近若干条历史，升序返回"""
    q = (
        select(ChatHistory.role, ChatHistory.message)
        .where(ChatHistory.session_id == session_id)
        .order_by(ChatHistory.created_at.asc())
        .limit(limit)
    )
    rows = db.execute(q).all()
    return [{"role": r[0], "content": r[1]} for r in rows]

def list_sessions(db: Session, limit: int = 200) -> List[Dict]:
    """会话列表（含角色名与最近活跃时间）"""
    sql = """
      SELECT cs.id AS session_id,
             cs.character_id,
             COALESCE(ci.name, MAX(ch.character_name)) AS character_name,
             cs.last_active_at
        FROM chat_sessions cs
   LEFT JOIN character_info ci ON ci.id = cs.character_id
   LEFT JOIN chat_history ch   ON ch.session_id = cs.id
    GROUP BY cs.id, cs.character_id, ci.name
    ORDER BY cs.last_active_at DESC
      LIMIT :limit;
    """
    rows = db.execute(sql, {"limit": limit}).fetchall()
    return [dict(r) for r in rows]

def list_messages(db: Session, session_id: str, limit: int = 500) -> List[Dict]:
    sql = """
      SELECT role, message AS content, created_at
        FROM chat_history
       WHERE session_id = :sid
    ORDER BY created_at ASC
       LIMIT :limit;
    """
    rows = db.execute(sql, {"sid": session_id, "limit": limit}).fetchall()
    return [dict(r) for r in rows]
