# app/qiniu_llm.py
# -*- coding: utf-8 -*-
"""
七牛 OpenAI 兼容（/v1/chat/completions）
- 非流式：一次性返回 choices[0].message.content
- 流式：逐条解析 SSE 的 data 行，拼接 choices[0].delta.content
"""
import os
import json
from typing import AsyncGenerator, List, Dict, Optional

import aiohttp

# 环境变量
QINIU_BASE = os.getenv("QINIU_OPENAI_BASE", "").rstrip("/")  # 例如 https://openai.qiniu.com/v1
QINIU_KEY = os.getenv("QINIU_OPENAI_API_KEY", "")
DEFAULT_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")  # 你也可以在 .env 里换成你的模型名

# 可选：本地 mock 开关（没配上游时快速自测）
MOCK_LLM = os.getenv("MOCK_LLM", "0") == "1"


class LLMError(Exception):
    pass


def _endpoint() -> str:
    if not QINIU_BASE:
        raise LLMError("QINIU_OPENAI_BASE is empty – 请在 .env 里配置真实的 https://openai.qiniu.com/v1")
    return f"{QINIU_BASE}/chat/completions"


def _headers() -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if QINIU_KEY:
        h["Authorization"] = f"Bearer {QINIU_KEY}"
    return h


async def chat_completion(messages: List[Dict[str, str]], model: Optional[str] = None) -> str:
    """非流式：一次性拿完整回复"""
    if MOCK_LLM or not QINIU_BASE:
        return "（mock）" + messages[-1]["content"]

    url = _endpoint()
    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "stream": False,
    }

    async with aiohttp.ClientSession() as sess:
        async with sess.post(url, headers=_headers(), data=json.dumps(payload)) as resp:
            if resp.status != 200:
                raise LLMError(f"HTTP {resp.status}: {await resp.text()}")
            data = await resp.json()
            # OpenAI 兼容：choices[0].message.content
            try:
                return data["choices"][0]["message"]["content"]
            except Exception:
                raise LLMError(f"Unexpected response: {data}")


async def chat_completion_stream(messages: List[Dict[str, str]], model: Optional[str] = None) -> AsyncGenerator[str, None]:
    """流式：逐块 yield 内容（OpenAI SSE：一行一个 data: {}）"""
    if MOCK_LLM or not QINIU_BASE:
        txt = "（mock）" + messages[-1]["content"]
        for ch in txt:
            yield ch
        return

    url = _endpoint()
    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "stream": True,
    }

    async with aiohttp.ClientSession() as sess:
        async with sess.post(url, headers=_headers(), data=json.dumps(payload)) as resp:
            if resp.status != 200:
                raise LLMError(f"HTTP {resp.status}: {await resp.text()}")

            async for raw, _ in resp.content.iter_chunks():
                if not raw:
                    continue
                # OpenAI 流式是典型 SSE，每行以 "data: " 开头
                for line in raw.decode("utf-8", errors="ignore").splitlines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data_str = line[len("data:"):].strip()
                    if data_str == "[DONE]":
                        return
                    try:
                        obj = json.loads(data_str)
                        # 兼容 OpenAI：choices[0].delta.content
                        delta = obj.get("choices", [{}])[0].get("delta", {})
                        chunk = delta.get("content", "")
                        if chunk:
                            yield chunk
                    except Exception:
                        # 非法行忽略
                        pass
