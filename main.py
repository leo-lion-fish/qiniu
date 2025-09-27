# --- START OF FILE main.py ---

# -*- coding: utf-8 -*-
"""
项目根目录的 main.py（与 app/ 目录同级）
- 聊天（非流式/流式）
- 会话/历史查询、会话重命名、删除
- 角色：列表、创建、绑定到会话
- 会话中未显式传角色时，自动读取会话已绑定的角色
- 模型选择：优先 本轮指定 -> 会话默认(如实现) -> 全局默认（.env 的 LLM_MODEL）
"""

import json
import logging
from typing import Optional, List, Dict

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

# ✅ 绝对导入 app 包内模块（确保 app/ 下有 __init__.py）
from app.database import get_db
# 导入新增的锁相关函数
from app.redis_cache import get_redis, get_history, append_pair, delete_history, acquire_session_lock, release_session_lock
from app.characters import build_system_prompt
from app.crud import (
    add_turn,
    load_history_from_db,
    list_sessions,
    list_messages,
    rename_session,
    delete_session,
)
from app.qiniu_llm import chat_completion, chat_completion_stream
from app.models import CharacterInfo, ChatSession

logger = logging.getLogger(__name__)

# =========================
# FastAPI 初始化与中间件
# =========================
app = FastAPI(title="AI 角色扮演聊天后端", version="0.2.0")

# 开放跨域（按需收紧 allow_origins）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# Pydantic 入参模型
# =========================
class ChatIn(BaseModel):
    """聊天入参：支持多轮会话（基于 session_id）与人设/模型选择"""
    message: str
    session_id: str
    character_name: Optional[str] = None   # 过渡期可用 name
    character_id: Optional[int] = None     # 推荐使用 id
    model: Optional[str] = None            # 可选模型名覆盖（本轮）

class CharacterIn(BaseModel):
    name: str
    background: Optional[str] = None
    personality: Optional[str] = None
    skills: Optional[str] = None
    current_playstyle: Optional[str] = None

class BindCharacterIn(BaseModel):
    character_id: Optional[int] = None
    character_name: Optional[str] = None

class SessionTitleIn(BaseModel):
    """重命名会话"""
    title: str

# =========================
# 工具函数
# =========================
def assemble_messages(system_prompt: str, history: List[Dict], user_msg: str) -> List[Dict[str, str]]:
    """
    组装标准 messages 列表：
    [system] + 历史（[{role, content}, ...]） + 当前 user
    """
    msgs = [{"role": "system", "content": system_prompt}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": user_msg})
    return msgs

def _choose_model(body_model: Optional[str]) -> Optional[str]:
    """
    清洗 Swagger 占位符，返回有效模型名或 None（由下游用默认）
    """
    if body_model is None:
        return None
    val = body_model.strip()
    if not val or val.lower() == "string":
        return None
    return val

def _fill_bound_character_if_absent(db: Session, body: ChatIn) -> None:
    """
    如果本次请求没传角色，则尝试从会话绑定里取（chat_sessions.character_id）
    """
    if (body.character_id is None) and (not body.character_name):
        s = db.get(ChatSession, body.session_id)
        if s and s.character_id:
            body.character_id = s.character_id

# =========================
# 路由：非流式聊天
# =========================
@app.post("/chat")
async def chat(body: ChatIn, db=Depends(get_db), rds=Depends(get_redis)):
    """
    非流式回复：
    1) 读取会话历史（优先 Redis，缺失用 DB 兜底）
    2) 若未显式传角色 -> 尝试使用会话已绑定角色
    3) 组装 system prompt + 历史 + 用户消息
    4) 请求大模型得到完整回复
    5) 写回 Redis + 落库两条（user/assistant）
    """
    if not body.session_id:
        raise HTTPException(status_code=400, detail="session_id required")

    # --- 并发控制：尝试获取会话锁 ---
    lock_acquired = await acquire_session_lock(rds, body.session_id)
    if not lock_acquired:
        raise HTTPException(status_code=409, detail="会话正在处理中，请稍后再试。") # 409 Conflict

    try:
        # 1) 会话历史
        history = await get_history(rds, body.session_id)
        if not history:
            history = load_history_from_db(db, body.session_id, limit=100)

        # 2) 会话绑定角色（若未显式传）
        _fill_bound_character_if_absent(db, body)

        # 3) system prompt（基于角色人设）
        system_prompt = build_system_prompt(db, body.character_name, body.character_id)
        messages = assemble_messages(system_prompt, history, body.message)

        # 4) 调大模型（带模型清洗）
        chosen_model = _choose_model(body.model)
        try:
            reply = await chat_completion(messages, model=chosen_model)
        except Exception as e:
            logger.exception("LLM upstream error")
            raise HTTPException(status_code=502, detail=f"LLM upstream error: {e}")

        # 5) 写缓存 + 落库
        await append_pair(rds, body.session_id, body.message, reply)
        add_turn(
            db,
            session_id=body.session_id,
            character_id=body.character_id,
            character_name=body.character_name,
            user_msg=body.message,
            assistant_msg=reply,
        )
        return {"reply": reply}
    finally:
        # --- 并发控制：无论成功失败，都释放锁 ---
        await release_session_lock(rds, body.session_id)

# =========================
# 路由：流式聊天（SSE）
# =========================
@app.post("/chat/stream")
async def chat_stream(body: ChatIn, db=Depends(get_db), rds=Depends(get_redis)):
    """
    流式回复（Server-Sent Events）：
    - 逐段返回 content 字段，完成后发送 [DONE]
    - 结束时一次性写入 Redis 与数据库
    """
    if not body.session_id:
        raise HTTPException(status_code=400, detail="session_id required")

    # --- 并发控制：尝试获取会话锁 ---
    lock_acquired = await acquire_session_lock(rds, body.session_id)
    if not lock_acquired:
        raise HTTPException(status_code=409, detail="会话正在处理中，请稍后再试。") # 409 Conflict

    async def gen():
        full_reply_content = [] # 收集完整回复
        try:
            # 1) 会话历史
            history = await get_history(rds, body.session_id)
            if not history:
                history = load_history_from_db(db, body.session_id, limit=100)

            # 2) 会话绑定角色（若未显式传）
            _fill_bound_character_if_absent(db, body)

            # 3) system prompt
            system_prompt = build_system_prompt(db, body.character_name, body.character_id)
            messages = assemble_messages(system_prompt, history, body.message)

            chosen_model = _choose_model(body.model)

            try:
                async for chunk in chat_completion_stream(messages, model=chosen_model):
                    full_reply_content.append(chunk)
                    # SSE 格式：以 data: 开头，空行分隔
                    yield f"data: {json.dumps({'content': chunk}, ensure_ascii=False)}\n\n"
            except Exception as e:
                logger.exception("LLM upstream error (stream)")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                # 即使有错误，也发送 DONE 标记，让前端知道流结束
                yield "data: [DONE]\n\n"
                return # 异常时不再进行后续的数据库和Redis操作

            full_text = "".join(full_reply_content)
            # 写缓存 + 落库
            await append_pair(rds, body.session_id, body.message, full_text)
            add_turn(
                db,
                session_id=body.session_id,
                character_id=body.character_id,
                character_name=body.character_name,
                user_msg=body.message,
                assistant_msg=full_text,
            )
            # 结束标记
            yield "data: [DONE]\n\n"

        finally:
            # --- 并发控制：无论成功失败，都释放锁 ---
            await release_session_lock(rds, body.session_id)


    return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8")

# =========================
# 路由：角色管理
# =========================
@app.get("/characters")
def list_characters(db: Session = Depends(get_db)):
    """
    列出所有可选角色（包含基本设定，便于前端展示）
    """
    rows = db.query(CharacterInfo).order_by(CharacterInfo.id.asc()).all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "background": r.background,
            "personality": r.personality,
            "skills": r.skills,
            "current_playstyle": r.current_playstyle,
        }
        for r in rows
    ]

@app.post("/characters")
def create_character(body: CharacterIn, db: Session = Depends(get_db)):
    """
    新增一个角色（name 建议唯一；若重复可返回 409）
    """
    exists = db.query(CharacterInfo).filter(CharacterInfo.name == body.name).first()
    if exists:
        raise HTTPException(status_code=409, detail="character name already exists")
    ch = CharacterInfo(
        name=body.name,
        background=body.background,
        personality=body.personality,
        skills=body.skills,
        current_playstyle=body.current_playstyle,
    )
    db.add(ch)
    db.commit()
    db.refresh(ch)
    return {"id": ch.id, "name": ch.name}

@app.post("/sessions/{sid}/bind-character")
def bind_character(sid: str, body: BindCharacterIn, db: Session = Depends(get_db)):
    """
    将会话绑定到某个角色（之后 /chat 不传角色字段也能自动应用人设）
    """
    # 允许通过 id 或 name 绑定；优先 id
    char = None
    if body.character_id is not None:
        char = db.query(CharacterInfo).get(body.character_id)
    elif body.character_name:
        char = db.query(CharacterInfo).filter(CharacterInfo.name == body.character_name).first()
    if not char:
        raise HTTPException(status_code=404, detail="character not found")

    s = db.get(ChatSession, sid)
    if not s:
        s = ChatSession(id=sid, character_id=char.id)
        db.add(s)
    else:
        s.character_id = char.id
    db.commit()
    return {"session_id": sid, "character_id": char.id, "character_name": char.name}

# =========================
# 路由：会话列表/消息/重命名/删除
# =========================
@app.get("/sessions")
def sessions(db=Depends(get_db)):
    """会话列表：当前按最近活跃时间倒序返回（包含 title/created_at/last_active_at）"""
    return list_sessions(db)

@app.get("/sessions/{sid}/messages")
def session_messages(sid: str, limit: int = 500, db=Depends(get_db)):
    """某个会话的消息记录（升序返回）"""
    return list_messages(db, sid, limit=limit)

@app.patch("/sessions/{sid}")
def patch_session(sid: str, body: SessionTitleIn, db: Session = Depends(get_db)):
    """重命名会话"""
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    try:
        return rename_session(db, sid, title)
    except ValueError:
        raise HTTPException(status_code=404, detail="session not found")

@app.delete("/sessions/{sid}")
async def remove_session(sid: str, db=Depends(get_db), rds=Depends(get_redis)):
    """删除会话（级联删除消息）"""
    result = delete_session(db, sid)
    if result.get("deleted") == 1:
        await delete_history(rds, sid)
        # 删除会话时，也应尝试释放锁，防止残留
        await release_session_lock(rds, sid)
    return result

# =========================
# 健康检查
# =========================
@app.get("/health")
def health():
    return {"ok": True}

# =========================
# 精选模型 & 语音 TTS 代理
# =========================
import os
import aiohttp

@app.get("/models")
async def list_models():
    """
    返回用于前端展示的“精选模型”列表 + 默认模型。
    - MODELS_CURATED: 逗号分隔的模型ID（只展示这些）
    - VERIFY_MODELS=1: 会调上游 /v1/models 过滤不可用项；否则直接返回白名单
    """
    curated = [m.strip() for m in os.getenv("MODELS_CURATED", "deepseek-v3").split(",") if m.strip()]
    default_model = os.getenv("LLM_MODEL", "deepseek-v3")
    verify = os.getenv("VERIFY_MODELS", "0") == "1"

    available = set(curated)
    if verify:
        base = os.getenv("QINIU_OPENAI_BASE", "").rstrip("/")
        key  = os.getenv("QINIU_OPENAI_API_KEY", "")
        if base:
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(f"{base}/models",
                                        headers={"Authorization": f"Bearer {key}"} if key else {}) as resp:
                        data = await resp.json()
                        ids = {item["id"] for item in data.get("data", []) if "id" in item}
                        available = set(curated) & ids
            except Exception:
                # 上游异常时，退回本地白名单
                available = set(curated)

    models = [{"id": m, "label": m, "recommended": (m == default_model)} for m in curated if m in available]
    # 确保默认模型一定在列表里
    if default_model not in [x["id"] for x in models]:
        models.insert(0, {"id": default_model, "label": default_model, "recommended": True})

    return {"default": default_model, "models": models}

# ---- TTS & VoiceList 代理 ----
from fastapi import Body  # 已在上面导入过 fastapi，这里仅确保 Body 可用
import os as _os, aiohttp as _aiohttp, base64

QINIU_BASE = _os.getenv("QINIU_OPENAI_BASE", "https://openai.qiniu.com/v1").rstrip("/")
QINIU_KEY  = _os.getenv("QINIU_OPENAI_API_KEY", "")

@app.get("/voice/list")
async def voice_list_proxy():
    url = f"{QINIU_BASE}/voice/list"
    headers = {"Authorization": f"Bearer {QINIU_KEY}"} if QINIU_KEY else {}
    async with _aiohttp.ClientSession() as s:
        async with s.get(url, headers=headers) as r:
            return await r.json()

class TTSIn(BaseModel):
    voice_type: str
    text: str
    encoding: str = "mp3"
    speed_ratio: float = 1.0

@app.post("/voice/tts")
async def tts_proxy(body: TTSIn):
    """
    请求七牛 /voice/tts，返回 { audio: <data:audio/mp3;base64,...> , duration_ms }
    """
    url = f"{QINIU_BASE}/voice/tts"
    headers = {
        "Authorization": f"Bearer {QINIU_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "audio": {
            "voice_type": body.voice_type,
            "encoding": body.encoding,
            "speed_ratio": body.speed_ratio
        },
        "request": { "text": body.text }
    }
    async with _aiohttp.ClientSession() as s:
        async with s.post(url, headers=headers, json=payload) as r:
            data = await r.json()
            # 七牛返回 data 为 base64 音频，addition.duration 为毫秒
            b64 = data.get("data", "")
            dur = (data.get("addition") or {}).get("duration")
            return { "audio": f"data:audio/{body.encoding};base64,{b64}", "duration_ms": int(dur) if dur else None }

# --- END OF FILE main.py ---