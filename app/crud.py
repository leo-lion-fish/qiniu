from app.models import CharacterInfo, ChatHistory
from sqlalchemy.orm import Session

# 获取角色信息
def get_character_info(db: Session, character_name: str):
    return db.query(CharacterInfo).filter(CharacterInfo.name == character_name).first()

# 存储聊天历史记录
def store_chat_history(db: Session, session_id: str, character_name: str, message: str):
    db_history = ChatHistory(session_id=session_id, character_name=character_name, message=message)
    db.add(db_history)
    db.commit()
    db.refresh(db_history)
