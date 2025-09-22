from fastapi import FastAPI

# 创建 FastAPI 实例
app = FastAPI()

# 创建一个基础的路由，返回欢迎信息
@app.get("/")
def read_root():
    return {"message": "Welcome to the AI Chat App!"}

# 创建一个用户与 AI 交互的路由
@app.post("/chat/")
def chat(message: str):
    # 假设你在这里调用 AI 模型生成回复
    ai_reply = f"AI 回复: {message[::-1]}"  # 这里用倒序的方式模拟AI回复
    return {"message": ai_reply}
