from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base
import datetime

# PostgreSQL 配置
SQLALCHEMY_DATABASE_URL = "postgresql://qiniu:310270mjq@localhost/ai_chat"
engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# 角色信息模型
class CharacterInfo(Base):
    __tablename__ = 'character_info'
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    personality = Column(Text)
    background = Column(Text)
    skills = Column(Text)
    current_playstyle = Column(Text)

# 聊天记录模型
class ChatHistory(Base):
    __tablename__ = 'chat_history'
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True)
    character_name = Column(String)
    message = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

# 创建表（如果不存在）
Base.metadata.create_all(bind=engine)
