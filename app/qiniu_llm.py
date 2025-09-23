# app/qiniu_llm.py
# -*- coding: utf-8 -*-
"""
Qiniu OpenAI 兼容接口封装：
- 修复流式接口(SSE)中文乱码：禁用 requests 自动解码，统一按 UTF-8 解码
- ensure_ascii=False，避免 \\uXXXX
- 补充 Accept: text/event-stream 头
"""

import os
import json
import requests


BASE_URL = os.getenv("QINIU_OPENAI_BASE", "https://openai.qiniu.com/v1")
API_KEY = os.getenv("QINIU_OPENAI_API_KEY")
DEFAULT_MODEL = os.getenv("QINIU_OPENAI_MODEL", "deepseek-v3")


class LLMError(Exception):
    """LLM 相关异常"""
    pass


def _headers():
    """构造公共请求头"""
    if not API_KEY:
        raise LLMError("缺少 QINIU_OPENAI_API_KEY 环境变量")
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }


def list_models():
    """获取模型列表（一次性返回 JSON）"""
    url = f"{BASE_URL}/models"
    resp = requests.get(url, headers=_headers(), timeout=20)
    if resp.status_code != 200:
        raise LLMError(f"列举模型失败 {resp.status_code}: {resp.text}")
    return resp.json()


def chat_completion(messages, model=None, temperature=0.7, stream=False, extra=None):
    """
    非流式聊天接口：直接返回完整文本
    - messages: OpenAI 兼容消息数组
    - model: 模型名
    - temperature: 采样温度
    - extra: 透传额外参数（字典）
    """
    url = f"{BASE_URL}/chat/completions"
    payload = {
        "model": (model or DEFAULT_MODEL),
        "messages": messages,
        "temperature": temperature,
        "stream": bool(stream),
    }
    if extra:
        payload.update(extra)

    resp = requests.post(url, headers=_headers(), json=payload, timeout=60)
    if resp.status_code != 200:
        raise LLMError(f"LLM接口错误 {resp.status_code}: {resp.text}")

    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception:
        raise LLMError(f"LLM响应解析失败: {data}")


def chat_stream(messages, model=None, temperature=0.7, extra=None):
    """
    流式聊天接口：以 SSE (Server-Sent Events) 的 data: 行逐块输出
    —— 关键修复点：
      1) requests.post(..., stream=True) + iter_lines(decode_unicode=False)
      2) 统一使用 UTF-8 对上游字节解码
      3) 输出时 ensure_ascii=False，避免中文被转义
    - 该函数返回生成器，供 FastAPI StreamingResponse 包装
    """
    url = f"{BASE_URL}/chat/completions"
    payload = {
        "model": (model or DEFAULT_MODEL),
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if extra:
        payload.update(extra)

    headers = _headers()
    # 告知上游我们期望的是 SSE
    headers["Accept"] = "text/event-stream"

    # 注：此处不设置 resp.encoding，保持 bytes 读取，手动 utf-8 解码
    with requests.post(url, headers=headers, json=payload, stream=True) as r:
        if r.status_code != 200:
            # 用原始字节解码为 utf-8（容错）
            try:
                text = r.content.decode("utf-8", errors="replace")
            except Exception:
                text = str(r.content)
            yield f"data: {json.dumps({'error': f'{r.status_code} {text}'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return

        # 逐行读取上游 SSE；decode_unicode=False，得到 bytes
        for raw in r.iter_lines(decode_unicode=False):
            if not raw:
                # 跳过心跳或空行
                continue

            # SSE 规范：形如 b"data: {...}" 或 b"data: [DONE]"
            if raw.startswith(b"data: "):
                line_bytes = raw[6:].strip()
                if line_bytes == b"[DONE]":
                    # 明确转发 DONE
                    yield "data: [DONE]\n\n"
                    break

                # 将本行 JSON 按 UTF-8 解码
                try:
                    line = line_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    # 兜底：以替换策略解码，避免阻断
                    line = line_bytes.decode("utf-8", errors="replace")

                # 解析上游 JSON，取出增量文本
                try:
                    obj = json.loads(line)
                    delta = obj["choices"][0].get("delta", {}).get("content")
                    if delta:
                        # 只透传增量文本；ensure_ascii=False 以传递中文
                        yield f"data: {json.dumps({'content': delta}, ensure_ascii=False)}\n\n"
                except Exception:
                    # 调试透传原始 JSON 字符串
                    yield f"data: {json.dumps({'raw': line}, ensure_ascii=False)}\n\n"

        # 如果上游未明确发送 [DONE]，此处保证结束一个 [DONE]
        yield "data: [DONE]\n\n"
