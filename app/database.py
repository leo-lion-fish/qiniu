from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.models import Base

# 数据库连接设置
SQLALCHEMY_DATABASE_URL = "postgresql://qiniu:310270mjq@localhost/ai_chat"
engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# 获取数据库会话
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
