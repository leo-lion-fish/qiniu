# -*- coding: utf-8 -*-
"""
角色（人设）相关的查询与 system prompt 组装
"""
from typing import Optional
from sqlalchemy.orm import Session
from .models import CharacterInfo

def get_character_by_name(db: Session, name: str) -> Optional[CharacterInfo]:
    return db.query(CharacterInfo).filter(CharacterInfo.name == name).first()

def get_character_by_id(db: Session, cid: int) -> Optional[CharacterInfo]:
    return db.query(CharacterInfo).filter(CharacterInfo.id == cid).first()

def build_system_prompt(db: Session, character_name: Optional[str], character_id: Optional[int]) -> str:
    """根据角色信息组装 system prompt"""
    char: Optional[CharacterInfo] = None
    if character_id is not None:
        char = get_character_by_id(db, character_id)
    elif character_name:
        char = get_character_by_name(db, character_name)

    if not char:
        # 没有角色也允许对话，给一个通用的 system 作为兜底
        return "You are a helpful assistant."

    parts = []
    parts.append(f"你的名字：{char.name}")
    if char.background:
        parts.append(f"背景：{char.background}")
    if char.personality:
        parts.append(f"性格：{char.personality}")
    if char.skills:
        parts.append(f"技能：{char.skills}")
    if char.current_playstyle:
        parts.append(f"当前对话风格：{char.current_playstyle}")
    parts.append("请保持符合人设的语气进行多轮对话。")

    return "\n".join(parts)
