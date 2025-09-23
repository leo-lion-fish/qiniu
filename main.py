# main.py
# -*- coding: utf-8 -*-
from os import getenv
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.qiniu_llm import chat_completion, chat_stream, list_models, LLMError
from app.characters import get_character_from_db  # 若要附加人设提示词


app = FastAPI(title="LLM Gateway", version="1.0.0")

# CORS（按需收紧）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- I/O 模型 ----------
class LLMChatIn(BaseModel):
    message: str
    character_name: str = ""   # 可选：人设
    model: str = ""            # 可选：覆盖默认模型
    search: bool = False       # 可选：联网搜索（模型名后缀 ?search）
    temperature: float = 0.7

class LLMChatOut(BaseModel):
    reply: str


# ---------- 健康检查 ----------
@app.get("/healthz")
def healthz():
    return {"status": "ok"}


# ---------- 模型列表 ----------
@app.get("/llm/models")
def llm_models():
    try:
        return list_models()
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 非流式 ----------
@app.post("/llm/chat", response_model=LLMChatOut)
def llm_chat(body: LLMChatIn, db: Session = Depends(get_db)):
    # 组装 messages
    messages = []
    if body.character_name:
        ch = get_character_from_db(body.character_name, db)
        if ch:
            system_prompt = f"你现在扮演 {ch.name}。性格：{ch.personality}。回答需符合该人设。"
            messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": body.message})

    # 处理模型与 search
    model: Optional[str] = (body.model or "").strip() or None
    if body.search:
        if model:
            model = model + "?search"
        else:
            model = getenv("QINIU_OPENAI_MODEL", "deepseek-v3") + "?search"

    try:
        reply = chat_completion(messages, model=model, temperature=body.temperature)
        return {"reply": reply}
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 流式（SSE） ----------
@app.post("/llm/chat/stream")
def llm_chat_stream(body: LLMChatIn, db: Session = Depends(get_db)):
    # 组装 messages
    messages = []
    if body.character_name:
        ch = get_character_from_db(body.character_name, db)
        if ch:
            system_prompt = f"你现在扮演 {ch.name}。性格：{ch.personality}。回答需符合该人设。"
            messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": body.message})

    # 处理模型与 search（与非流式保持一致）
    model: Optional[str] = (body.model or "").strip() or None
    if body.search:
        if model:
            model = model + "?search"
        else:
            model = getenv("QINIU_OPENAI_MODEL", "deepseek-v3") + "?search"

    try:
        gen = chat_stream(messages, model=model, temperature=body.temperature)
        # 关键：指定 charset，避免代理/客户端误判导致乱码
        return StreamingResponse(gen, media_type="text/event-stream; charset=utf-8")
    except LLMError as e:
        # SSE 出错时返回标准 JSON 错误（便于 curl/浏览器调试）
        return JSONResponse({"error": str(e)}, status_code=502)
