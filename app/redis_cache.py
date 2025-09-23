import redis
import json

# 配置 Redis
r = redis.Redis(host='localhost', port=6379, db=0)

# 存储会话历史到 Redis
def store_in_redis(session_id, message_history):
    r.set(session_id, json.dumps(message_history))

# 获取会话历史
def get_from_redis(session_id):
    message_history = r.get(session_id)
    if message_history:
        return json.loads(message_history)
    return []
