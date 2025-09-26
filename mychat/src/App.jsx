import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * App.jsx — 前端最小成品（多轮会话 / 角色会话级绑定 / 模型选择 / 流式SSE / TTS / 浏览器ASR）
 *
 * 后端接口（FastAPI）：
 *   GET  /characters
 *   GET  /sessions                      -> 建议返回 { session_id, character_id?, character_name?, created_at, last_active_at }
 *   GET  /sessions/{sid}/messages
 *   POST /sessions/{sid}/bind-character -> { character_id }
 *   POST /chat                          -> { session_id, message, model? }
 *   POST /chat/stream                   -> SSE（data:{"content"} | "[DONE]")
 *   GET  /models                        -> { default, models: [{id,label?,recommended?}] }
 *   GET  /voice/list                    -> [{ voice_name, voice_type, ... }]
 *   POST /voice/tts                     -> { audio: "data:audio/mp3;base64,...", duration_ms }
 */

const BASE_URL_DEFAULT =
  typeof window !== "undefined"
    ? `${window.location.origin.replace(/\/+$|$/g, "")}`
    : "http://127.0.0.1:8000";

/* ---------------- utils ---------------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function clsx(...a) {
  return a.filter(Boolean).join(" ");
}
function useLocalStorage(key, initialValue) {
  const [state, setState] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);
  return [state, setState];
}
// 简单时间格式化，用于左侧会话列表显示“最后活跃时间”
function fmtTime(s) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/* ======================================================================= */
export default function App() {
  /* ---------- Settings ---------- */
  const [baseUrl, setBaseUrl] = useLocalStorage("cfg.baseUrl", BASE_URL_DEFAULT);
  const [defaultModel, setDefaultModel] = useLocalStorage(
    "cfg.defaultModel",
    "deepseek-v3"
  );

  /* ---------- Sessions ---------- */
  const [sessions, setSessions] = useState([]);
  const [sid, setSid] = useLocalStorage("chat.sid", "");

  /* ---------- Characters ---------- */
  const [chars, setChars] = useState([]);
  // 当前“会话”的绑定角色，仅用于UI展示
  const [currentCharId, setCurrentCharId] = useState(null);

  /* ---------- Models (curated + custom) ---------- */
  const [models, setModels] = useState([]); // [{id,label?,recommended?}]
  const [modelSelect, setModelSelect] = useLocalStorage("cfg.modelSelect", "");
  const [modelCustom, setModelCustom] = useLocalStorage("cfg.modelCustom", "");

  /* ---------- Messages ---------- */
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useLocalStorage("chat.input", "");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");

  /* ---------- TTS ---------- */
  const [voices, setVoices] = useState([]); // from /voice/list
  const [voiceType, setVoiceType] = useLocalStorage(
    "cfg.voiceType",
    "qiniu_zh_female_tmjxxy"
  );
  const [autoSpeak, setAutoSpeak] = useLocalStorage("cfg.autoSpeak", true);
  const audioRef = useRef(null);

  /* ---------- ASR (Web Speech API) ---------- */
  const [recOn, setRecOn] = useState(false);
  const recognitionRef = useRef(null);

  /* ---------- Refs ---------- */
  const listBottomRef = useRef(null);
  const inputRef = useRef(null);
  const [showSettings, setShowSettings] = useState(false); // 左侧底部折叠

  /* ---------- API helpers ---------- */
  const api = useMemo(
    () => ({
      async getCharacters() {
        const r = await fetch(`${baseUrl}/characters`);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async getSessions() {
        const r = await fetch(`${baseUrl}/sessions`);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async getMessages(sid) {
        const r = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sid)}/messages`);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async bindCharacter(sid, character_id) {
        const r = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sid)}/bind-character`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ character_id }),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async chat(body) {
        const r = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async *chatStream(body) {
        const r = await fetch(`${baseUrl}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());

        const reader = r.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split(new RegExp('\\r?\\n'));
            buf = lines.pop() || "";
            for (const line of lines) {
              const s = line.trim();
              if (!s.startsWith("data:")) continue;
              const payload = s.slice(5).trim();
              if (payload === "[DONE]") return;
              try {
                const obj = JSON.parse(payload);
                if (obj.content) yield obj.content;
                if (obj.error) throw new Error(obj.error);
              } catch {
                /* ignore malformed chunk */
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
      async getVoiceList() {
        const r = await fetch(`${baseUrl}/voice/list`);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async tts(voice_type, text, encoding = "mp3", speed_ratio = 1.0) {
        const r = await fetch(`${baseUrl}/voice/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice_type, text, encoding, speed_ratio }),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json(); // { audio, duration_ms }
      },
    }),
    [baseUrl]
  );

  /* ---------- Initial load ---------- */
  useEffect(() => {
    (async () => {
      try {
        setError("");
        const [cRes, sRes] = await Promise.allSettled([
          api.getCharacters(),
          api.getSessions(),
        ]);
        if (cRes.status === "fulfilled") setChars(cRes.value || []);
        if (sRes.status === "fulfilled") setSessions(sRes.value || []);

        // curated models
        try {
          const r = await fetch(`${baseUrl}/models`);
          if (r.ok) {
            const data = await r.json();
            setModels(Array.isArray(data.models) ? data.models : []);
            if (!modelSelect && data.default) setModelSelect(data.default);
            if (!defaultModel && data.default) setDefaultModel(data.default);
          }
        } catch {
          /* optional */
        }

        // voice list
        try {
          const vs = await api.getVoiceList();
          setVoices(vs || []);
          if (!voiceType) {
            const v = (vs || []).find((x) => String(x.voice_type || "").startsWith("qiniu_zh_female")) || vs?.[0];
            if (v?.voice_type) setVoiceType(v.voice_type);
          }
        } catch {
          /* optional */
        }

        // ensure sid
        if (!sid) {
          const first = sRes.status === "fulfilled" ? sRes.value?.[0]?.session_id : null;
          setSid(first || uuidv4());
        }
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Load messages on sid change ---------- */
  useEffect(() => {
    if (!sid) return;
    (async () => {
      try {
        setError("");
        const msgs = await api.getMessages(sid);
        setMessages(msgs || []);
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
  }, [sid, api]);

  /* ---------- 当会话或会话列表变化时，同步当前会话的角色到下拉框 ---------- */
  useEffect(() => {
    if (!sid) return;
    const cur = sessions.find((s) => s.session_id === sid);
    // 后端若返回 character_id 则直接用；否则尝试由 character_name 反查
    if (cur?.character_id != null) {
      setCurrentCharId(cur.character_id);
    } else if (cur?.character_name) {
      const found = chars.find((c) => c.name === cur.character_name);
      setCurrentCharId(found?.id ?? null);
    } else {
      setCurrentCharId(null);
    }
  }, [sid, sessions, chars]);

  /* ---------- Autoscroll ---------- */
  useEffect(() => {
    listBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  /* ---------- Actions ---------- */
  async function handleCreateSession() {
    const newSid = uuidv4();
    setSid(newSid);
    setMessages([]);
    setCurrentCharId(null);
  }

  async function handleBindCharacter(val) {
    if (!sid) return;
    // 允许“未绑定”
    if (val === "" || val === null) {
      setCurrentCharId(null);
      // 如需后端“解绑”可在此调用相应接口
      setSessions((prev) => prev.map((s) => (s.session_id === sid ? { ...s, character_id: null, character_name: undefined } : s)));
      return;
    }
    const idNum = Number(val);
    if (Number.isNaN(idNum)) return;
    try {
      await api.bindCharacter(sid, idNum);
      setCurrentCharId(idNum);
      const newName = chars.find((c) => c.id === idNum)?.name;
      setSessions((prev) =>
        prev.map((s) => (s.session_id === sid ? { ...s, character_id: idNum, character_name: newName ?? s.character_name } : s))
      );
    } catch (e) {
      setError("绑定角色失败：" + String(e));
    }
  }

  async function speakIfNeeded(text) {
    if (!autoSpeak || !text) return;
    try {
      const { audio } = await api.tts(voiceType, text, "mp3", 1.0);
      if (audioRef.current) {
        audioRef.current.src = audio;
        await audioRef.current.play().catch(() => {
          /* 首次可能需要用户手势 */
        });
      }
    } catch (e) {
      console.warn("TTS 播放失败：", e);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending || streaming) return;
    setError("");
    setSending(true);

    // model resolution: custom > dropdown > fallback > backend default
    const candidate = (modelCustom || "").trim();
    const selected = (modelSelect || "").trim();
    const fallback = (defaultModel || "").trim();
    const finalModel = candidate || selected || fallback || undefined;

    // optimistic append user msg
    const newUser = {
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newUser]);
    setInput("");

    // streaming path
    setStreaming(true);
    let acc = "";
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "",
        created_at: new Date().toISOString(),
        _streaming: true,
      },
    ]);

    try {
      const body = { session_id: sid, message: text };
      if (finalModel) body.model = finalModel;

      let gotChunk = false;
      for await (const chunk of api.chatStream(body)) {
        gotChunk = true;
        acc += chunk;
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant" && copy[i]._streaming) {
              copy[i] = { ...copy[i], content: acc };
              break;
            }
          }
          return copy;
        });
      }

      if (!gotChunk && acc === "") {
        const r = await api.chat(body);
        acc = r?.reply || "";
        setMessages((prev) => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant" && copy[i]._streaming) {
              copy[i] = { ...copy[i], content: acc, _streaming: false };
              break;
            }
          }
          return copy;
        });
      } else {
        setMessages((prev) => prev.map((m) => (m._streaming ? { ...m, _streaming: false } : m)));
      }

      // TTS
      await speakIfNeeded(acc);
    } catch (e) {
      console.error(e);
      setError("发送失败：" + String(e));
      setMessages((prev) => prev.filter((m) => !m._streaming));
    } finally {
      setStreaming(false);
      setSending(false);
      inputRef.current?.focus();
      try {
        setSessions(await api.getSessions()); // 刷新会话，带出最新角色/时间
      } catch {}
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  /* ---------- ASR handlers ---------- */
  function ensureASR() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    if (!SR) {
      setError("当前浏览器不支持语音识别，请使用 Chrome/Edge。");
      return null;
    }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.continuous = false;
    rec.interimResults = true;
    return rec;
  }
  function startASR() {
    const rec = ensureASR();
    if (!rec) return;
    recognitionRef.current = rec;
    setRecOn(true);
    let finalTxt = "";
    rec.onresult = (evt) => {
      let txt = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const res = evt.results[i];
        txt += res[0].transcript;
        if (res.isFinal) finalTxt = txt;
      }
      setInput(txt); // 实时写入输入框
    };
    rec.onerror = (e) => {
      setError("ASR 错误：" + e.error);
      setRecOn(false);
    };
    rec.onend = () => {
      setRecOn(false);
      if (finalTxt.trim()) sendMessage();
    };
    try {
      rec.start();
    } catch {}
  }
  function stopASR() {
    recognitionRef.current?.stop();
    setRecOn(false);
  }

  /* ---------------- UI ---------------- */
  return (
    // 两列布局：左侧固定宽度，右侧自适应；全高填充
    <div
      className="grid h-screen w-screen bg-slate-50 text-slate-900"
      style={{ gridTemplateColumns: "var(--sidebar-width, 320px) 1fr" }}
    >
      {/* 左侧边栏：会话 + 可折叠设置 */}
      <aside className="col-start-1 bg-white border-r border-slate-200 flex flex-col overflow-y-auto h-full">
        <div className="p-3 border-b border-slate-200 flex items-center gap-2 flex-shrink-0">
          <span className="font-semibold">会话</span>
          <button
            onClick={handleCreateSession}
            className="ml-auto px-2 py-1 rounded-md text-sm bg-slate-900 text-white hover:bg-black"
          >
            新建
          </button>
        </div>

        <div className="p-2 flex-1 overflow-y-auto">
          {sessions?.length ? (
            sessions.map((s) => (
              <button
                key={s.session_id}
                onClick={() => setSid(s.session_id)}
                className={clsx(
                  "w-full text-left px-3 py-2 rounded-md mb-2 border",
                  sid === s.session_id
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white hover:bg-slate-50 border-slate-200"
                )}
                title={`SID: ${s.session_id}
最后活跃：${fmtTime(s.last_active_at || s.created_at)}`}
              >
                <div className="text-sm font-medium truncate">
                  {s.character_name || "未绑定角色"}
                </div>
                <div className="text-xs opacity-70 truncate">
                  {fmtTime(s.last_active_at || s.created_at) || "—"}
                </div>
              </button>
            ))
          ) : (
            <div className="text-sm text-slate-500 p-3">暂无会话，点“新建”创建一个。</div>
          )}
        </div>

        {/* 底部：应用设置（可折叠） */}
        <div className="border-t border-slate-200 p-3 flex-shrink-0 mt-auto">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="w-full text-left font-semibold text-sm py-1 flex items-center justify-between"
          >
            应用设置
            <span>{showSettings ? "▲" : "▼"}</span>
          </button>
          {showSettings && (
            <div className="text-xs space-y-3 pt-2">
              {/* backend */}
              <div className="flex items-center gap-2 min-w-[200px]">
                <span className="shrink-0">后端地址</span>
                <input
                  className="border rounded px-2 py-1 w-full"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>

              {/* curated models + custom */}
              <div className="space-y-1 min-w-[300px]">
                <div className="text-[11px] opacity-70">推荐模型（选其一，右侧手写优先生效）</div>
                <div className="flex items-center gap-2">
                  <select
                    className="border rounded px-2 py-1 w-1/2"
                    value={modelSelect}
                    onChange={(e) => setModelSelect(e.target.value)}
                  >
                    <option value="">（不选择）</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {(m.label || m.id) + (m.recommended ? " ·默认" : "")}
                      </option>
                    ))}
                  </select>
                  <input
                    className="border rounded px-2 py-1 w-1/2"
                    placeholder="手写模型名（优先）"
                    value={modelCustom}
                    onChange={(e) => setModelCustom(e.target.value)}
                  />
                </div>
              </div>

              {/* fallback default model */}
              <div className="flex items-center gap-2 min-w-[200px]">
                <span className="shrink-0">默认模型(兜底)</span>
                <input
                  className="border rounded px-2 py-1 w-full"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                />
              </div>

              {/* TTS settings */}
              <div className="space-y-1 min-w-[250px]">
                <div className="text-[11px] opacity-70">语音合成</div>
                <div className="flex items-center gap-2">
                  <select
                    className="border rounded px-2 py-1 w-2/3"
                    value={voiceType}
                    onChange={(e) => setVoiceType(e.target.value)}
                  >
                    {voices.map((v) => (
                      <option key={v.voice_type} value={v.voice_type}>
                        {v.voice_name || v.voice_type}
                      </option>
                    ))}
                  </select>
                  <label className="text-xs flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={autoSpeak}
                      onChange={(e) => setAutoSpeak(e.target.checked)}
                    />
                    自动朗读
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 右侧主聊天区：头部 / 消息 / 输入区 */}
      <div className="col-start-2 flex flex-col overflow-hidden h-full">
        {/* Header */}
        <div className="h-14 border-b border-slate-200 bg-white flex items-center px-4 gap-3 flex-shrink-0">
          <div className="font-semibold">角色</div>
          <select
            className="border rounded px-2 py-1"
            value={currentCharId ?? ""}
            onChange={(e) => handleBindCharacter(e.target.value)}
          >
            <option value="">（未绑定）</option>
            {chars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="ml-auto text-xs opacity-60 flex items-center gap-4">
            <span>
              SID: <span className="font-mono">{sid || "—"}</span>
            </span>
            <span>
              模型: <span className="font-mono">{modelCustom || modelSelect || defaultModel || "后端默认"}</span>
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={clsx("mb-3 flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={clsx(
                  "max-w-[75%] rounded-2xl px-3 py-2 whitespace-pre-wrap break-words",
                  m.role === "user" ? "bg-slate-900 text-white" : "bg-white border border-slate-200"
                )}
              >
                {m.content || ""}
                {m._streaming && (
                  <span className="inline-block w-2 h-4 align-baseline bg-slate-300 ml-1 animate-pulse" />
                )}
              </div>
            </div>
          ))}
          <div ref={listBottomRef} />
        </div>

        {/* Composer */}
        <div className="border-t border-slate-200 bg-white p-3 flex-shrink-0">
          {error && (
            <div className="mb-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {String(error)}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              rows={2}
              className="flex-1 border rounded-md px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
              placeholder="输入消息，Enter发送，Shift+Enter换行"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending || streaming}
            />
            <button
              onClick={recOn ? stopASR : startASR}
              className={clsx(
                "px-3 py-2 rounded-md border",
                recOn ? "bg-red-50 border-red-200 text-red-600" : "bg-white border-slate-200"
              )}
              title="语音输入"
            >
              {recOn ? "停止" : "🎤 语音"}
            </button>
            <button
              onClick={sendMessage}
              disabled={sending || streaming || !input.trim()}
              className={clsx(
                "px-4 py-2 rounded-md text-white",
                sending || streaming || !input.trim() ? "bg-slate-400" : "bg-slate-900 hover:bg-black"
              )}
            >
              发送
            </button>
          </div>
          <div className="text-xs opacity-70 mt-1">
            当前使用模型优先级：<code>手写</code> → <code>下拉</code> → <code>默认(兜底)</code>。兜底当前：
            <span className="font-mono"> {defaultModel || "（后端默认）"}</span>
          </div>
        </div>
      </div>

      {/* hidden audio for TTS */}
      <audio ref={audioRef} hidden />
    </div>
  );
}
