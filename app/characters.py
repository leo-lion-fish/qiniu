from sqlalchemy.orm import Session
from app.models import CharacterInfo

class Character:
    def __init__(self, name: str, personality: str, current_playstyle: str):
        self.name = name
        self.personality = personality
        self.current_playstyle = current_playstyle
    
    def respond(self, message: str):
        # 你可以基于性格来生成回复
        if "你好" in message:
            return f"你好，我是 {self.name}！"
        elif "技能" in message:
            return f"我的技能是 {self.current_playstyle}。"
        else:
            return f"{self.name} 的强势玩法是：{self.current_playstyle}"

# 从数据库获取角色
def get_character_from_db(character_name: str, db: Session):
    character = db.query(CharacterInfo).filter(
        CharacterInfo.name.ilike(character_name)  # 使用 ilike 来进行大小写不敏感查询
    ).first()
    if character:
        return Character(character.name, character.personality, character.current_playstyle)
    return None
