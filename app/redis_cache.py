# --- START OF FILE redis_cache.py ---

# -*- coding: utf-8 -*-
"""
Redis 缓存封装
- 优先使用 redis.asyncio（需要 redis>=4.2）
- 若环境不支持，则自动回退到同步 redis，并通过线程池适配到异步接口
"""
import os
import json
import asyncio # Add this import for ThreadPoolExecutor fallbacks

from typing import List, Dict, Any

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")

# 配置：每个会话最多保留最近 N 轮（每轮两条：user/assistant）
MAX_TURNS = int(os.getenv("HISTORY_MAX_TURNS", "20"))
TTL_SECONDS = int(os.getenv("HISTORY_TTL_SECONDS", "259200"))  # 3 天

# 新增：会话锁的 TTL
SESSION_LOCK_TTL_SECONDS = int(os.getenv("SESSION_LOCK_TTL_SECONDS", "60")) # 默认 60 秒

def _key(session_id: str) -> str:
    return f"chat:hist:{session_id}"

def _lock_key(session_id: str) -> str: # 新增：锁的 key
    return f"chat:lock:{session_id}"

# ========= 优先尝试异步 redis（redis>=4.2 提供 redis.asyncio） =========
try:
    import redis.asyncio as redis  # type: ignore
    from redis.asyncio.client import Redis # Type hinting for Redis client

    _ASYNC = True
    _client: Redis = redis.from_url(REDIS_URL, decode_responses=True)

    def get_redis():
        """FastAPI 依赖：返回异步 redis 客户端"""
        # asyncio 版客户端是连接池，不必每次关闭
        yield _client

    async def get_history(rds: Redis, session_id: str) -> List[Dict[str, Any]]:
        raw = await rds.get(_key(session_id))
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    async def set_history(rds: Redis, session_id: str, history: List[Dict[str, Any]]):
        if len(history) > MAX_TURNS * 2:
            history = history[-MAX_TURNS*2:]
        await rds.set(_key(session_id), json.dumps(history, ensure_ascii=False), ex=TTL_SECONDS)

    async def append_pair(rds: Redis, session_id: str, user_msg: str, assistant_msg: str):
        hist = await get_history(rds, session_id)
        hist.extend([
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": assistant_msg},
        ])
        await set_history(rds, session_id, hist)

    async def delete_history(rds: Redis, session_id: str):
        """从 Redis 删除指定会话的历史记录"""
        await rds.delete(_key(session_id))

    # 新增：获取会话锁
    async def acquire_session_lock(rds: Redis, session_id: str) -> bool:
        """尝试获取会话锁，成功返回 True，否则返回 False"""
        # value 可以是任意唯一标识符，但对于简单的锁，1 即可
        # SET key value NX EX seconds
        return await rds.set(_lock_key(session_id), 1, nx=True, ex=SESSION_LOCK_TTL_SECONDS)

    # 新增：释放会话锁
    async def release_session_lock(rds: Redis, session_id: str):
        """释放会话锁"""
        await rds.delete(_lock_key(session_id))

except Exception:
    # ========= 回退到同步 redis，适配异步接口 =========
    import redis  # 同步客户端
    from concurrent.futures import ThreadPoolExecutor

    _ASYNC = False
    _sync_client = redis.from_url(REDIS_URL, decode_responses=True)
    _executor = ThreadPoolExecutor(max_workers=8)

    def get_redis():
        """FastAPI 依赖：返回一个“伪异步”的句柄（其实内部用同步客户端）"""
        # 为了接口一致性，这里返回同步客户端本身
        yield _sync_client

    async def _run_in_thread(func, *args, **kwargs):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_executor, lambda: func(*args, **kwargs))

    async def get_history(rds, session_id: str) -> List[Dict[str, Any]]:
        raw = await _run_in_thread(rds.get, _key(session_id))
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    async def set_history(rds, session_id: str, history: List[Dict[str, Any]]):
        if len(history) > MAX_TURNS * 2:
            history = history[-MAX_TURNS*2:]
        data = json.dumps(history, ensure_ascii=False)
        # 兼容同步 set 的 ex 参数
        await _run_in_thread(rds.set, _key(session_id), data, ex=TTL_SECONDS)

    async def append_pair(rds, session_id: str, user_msg: str, assistant_msg: str):
        hist = await get_history(rds, session_id)
        hist.extend([
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": assistant_msg},
        ])
        await set_history(rds, session_id, hist)

    async def delete_history(rds, session_id: str):
        """从 Redis 删除指定会话的历史记录"""
        await _run_in_thread(rds.delete, _key(session_id))

    # 新增：获取会话锁
    async def acquire_session_lock(rds, session_id: str) -> bool:
        """尝试获取会话锁，成功返回 True，否则返回 False"""
        # SET key value NX EX seconds
        return await _run_in_thread(rds.set, _lock_key(session_id), 1, nx=True, ex=SESSION_LOCK_TTL_SECONDS)

    # 新增：释放会话锁
    async def release_session_lock(rds, session_id: str):
        """释放会话锁"""
        await _run_in_thread(rds.delete, _lock_key(session_id))

# --- END OF FILE redis_cache.py ---