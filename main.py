from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.crud import get_character_info, store_chat_history
from app.redis_cache import store_in_redis, get_from_redis
from app.characters import get_character_from_db
from pydantic import BaseModel
import uuid

# FastAPI 实例
app = FastAPI()

# 用户输入数据模型
class UserInput(BaseModel):
    character_name: str
    message: str
    session_id: str  # 用户会话 ID

@app.post("/chat/")
def chat(user_input: UserInput, db: Session = Depends(get_db)):
    # 生成会话 ID 如果用户未提供
    if not user_input.session_id:
        user_input.session_id = str(uuid.uuid4())

    character_name = user_input.character_name.lower()
    message = user_input.message
    session_id = user_input.session_id

    # 从数据库获取角色信息
    character = get_character_from_db(character_name, db)
    if not character:
        return {"message": "角色未找到"}

    # 获取角色的回复
    response = character.respond(message)

    # 获取或初始化 Redis 中的会话历史
    message_history = get_from_redis(session_id)

    # 将用户消息和角色回复添加到消息历史
    message_history.append({"role": "user", "message": message})
    message_history.append({"role": "ai", "message": response})

    # 更新 Redis 中的会话历史
    store_in_redis(session_id, message_history)

    # 存储聊天记录到数据库
    store_chat_history(db, session_id, character_name, message)
    store_chat_history(db, session_id, character_name, response)

    return {"message": response, "session_id": session_id}
