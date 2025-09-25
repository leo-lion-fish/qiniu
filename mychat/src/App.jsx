import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Minimal Frontend for your FastAPI backend
 * Features:
 * - Session list / create new (front-end generates UUID)
 * - Character list & bind to session
 * - Chat (history load + SSE streaming via /chat/stream, fallback /chat)
 * - Model selector: curated dropdown from /models + custom text (custom takes priority)
 * - Basic error & loading states; settings (backend URL, fallback default model)
 *
 * Assumptions:
 * - Backend at same host or set in the left-bottom settings (BASE_URL).
 * - Endpoints:
 *   GET  /characters
 *   POST /sessions/{sid}/bind-character
 *   GET  /sessions
 *   GET  /sessions/{sid}/messages
 *   POST /chat
 *   POST /chat/stream
 *   GET  /models   -> { default: "deepseek-v3", models: [{id,label?,recommended?}, ...] }
 */

const BASE_URL_DEFAULT =
  typeof window !== "undefined" ? `${window.location.origin.replace(/\/+$/, "")}` : "http://127.0.0.1:8000";

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clsx(...args) {
  return args.filter(Boolean).join(" ");
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

export default function App() {
  // settings
  const [baseUrl, setBaseUrl] = useLocalStorage("cfg.baseUrl", BASE_URL_DEFAULT);
  const [defaultModel, setDefaultModel] = useLocalStorage("cfg.defaultModel", "deepseek-v3");

  // sessions
  const [sessions, setSessions] = useState([]);
  const [sid, setSid] = useLocalStorage("chat.sid", "");

  // characters
  const [chars, setChars] = useState([]);
  const [bindCharId, setBindCharId] = useLocalStorage("chat.bindCharId", null);

  // curated models & user choice
  const [models, setModels] = useState([]);                        // [{id,label?,recommended?}]
  const [modelSelect, setModelSelect] = useLocalStorage("cfg.modelSelect", "");
  const [modelCustom, setModelCustom] = useLocalStorage("cfg.modelCustom", "");

  // chat
  const [messages, setMessages] = useState([]); // [{role, content, created_at?}]
  const [input, setInput] = useLocalStorage("chat.input", "");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");

  const listBottomRef = useRef(null);
  const inputRef = useRef(null);

  const api = useMemo(
    () => ({
      async getCharacters() {
        const res = await fetch(`${baseUrl}/characters`);
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      },
      async getSessions() {
        const res = await fetch(`${baseUrl}/sessions`);
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      },
      async getMessages(sid) {
        const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sid)}/messages`);
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      },
      async bindCharacter(sid, character_id) {
        const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sid)}/bind-character`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ character_id }),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      },
      async chat(body) {
        const res = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      },
      async *chatStream(body) {
        const res = await fetch(`${baseUrl}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split(/\r?\n/);
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
                // ignore malformed chunks
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    }),
    [baseUrl]
  );

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const [c, s] = await Promise.allSettled([api.getCharacters(), api.getSessions()]);
        if (c.status === "fulfilled") setChars(c.value || []);
        if (s.status === "fulfilled") setSessions(s.value || []);

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
          // ignore; can still type custom
        }

        // ensure a sid
        if (!sid) {
          const first = s.status === "fulfilled" ? s.value?.[0]?.session_id : undefined;
          setSid(first || uuidv4());
        }
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // when sid changes: load messages; best-effort auto-bind preferred char on empty history
  useEffect(() => {
    if (!sid) return;
    (async () => {
      try {
        setError("");
        const msgs = await api.getMessages(sid);
        setMessages(msgs || []);
        if (bindCharId && (!msgs || msgs.length === 0)) {
          try {
            await api.bindCharacter(sid, bindCharId);
          } catch {}
        }
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
  }, [sid, bindCharId, api]);

  // autoscroll
  useEffect(() => {
    listBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  async function handleCreateSession() {
    const newSid = uuidv4();
    setSid(newSid);
    setMessages([]);
  }

  async function handleBindCharacter(id) {
    if (!sid) return;
    try {
      await api.bindCharacter(sid, id);
      setBindCharId(id);
      // optional UX: small toast could be added
    } catch (e) {
      setError("绑定角色失败：" + String(e));
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending || streaming) return;
    setError("");

    // model resolution: custom > dropdown > fallback input > backend default
    const candidate = (modelCustom || "").trim();
    const selected = (modelSelect || "").trim();
    const fallback = (defaultModel || "").trim();
    const finalModel = candidate || selected || fallback || undefined;

    // optimistic append user msg
    const newUser = { role: "user", content: text, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, newUser]);
    setInput("");

    // streaming path
    setStreaming(true);
    let acc = "";
    setMessages(prev => [...prev, { role: "assistant", content: "", created_at: new Date().toISOString(), _streaming: true }]);

    try {
      const body = { session_id: sid, message: text };
      if (finalModel) body.model = finalModel;

      let gotChunk = false;
      for await (const chunk of api.chatStream(body)) {
        gotChunk = true;
        acc += chunk;
        setMessages(prev => {
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
        setMessages(prev => {
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
        setMessages(prev => prev.map(m => (m._streaming ? { ...m, _streaming: false } : m)));
      }
    } catch (e) {
      console.error(e);
      setError("发送失败：" + String(e));
      setMessages(prev => prev.filter(m => !m._streaming));
    } finally {
      setStreaming(false);
      setSending(false);
      inputRef.current?.focus();
      try {
        setSessions(await api.getSessions());
      } catch {}
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="h-screen w-screen bg-slate-50 text-slate-900 flex">
      {/* Sidebar: sessions + settings */}
      <aside className="w-80 border-r border-slate-200 bg-white flex flex-col">
        <div className="p-3 border-b border-slate-200 flex items-center gap-2">
          <span className="font-semibold">会话</span>
          <button
            onClick={handleCreateSession}
            className="ml-auto px-2 py-1 rounded-md text-sm bg-slate-900 text-white hover:bg-black"
          >
            新建
          </button>
        </div>

        <div className="p-2 overflow-y-auto flex-1">
          {sessions?.length ? (
            sessions.map(s => (
              <button
                key={s.session_id}
                onClick={() => setSid(s.session_id)}
                className={clsx(
                  "w-full text-left px-3 py-2 rounded-md mb-2 border",
                  sid === s.session_id
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white hover:bg-slate-50 border-slate-200"
                )}
              >
                <div className="text-sm font-medium truncate">
                  {s.character_name || "未绑定角色"}
                </div>
                <div className="text-xs opacity-70 truncate">{s.session_id}</div>
              </button>
            ))
          ) : (
            <div className="text-sm text-slate-500 p-3">暂无会话，点“新建”创建一个。</div>
          )}
        </div>

        {/* Settings */}
        <div className="p-3 border-t border-slate-200 text-xs space-y-3">
          <div className="flex items-center gap-2">
            <span className="shrink-0">后端地址</span>
            <input
              className="border rounded px-2 py-1 w-full"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
            />
          </div>

          {/* Curated models + custom box */}
          <div className="space-y-1">
            <div className="text-[11px] opacity-70">推荐模型（选其一，右侧手写优先生效）</div>
            <div className="flex items-center gap-2">
              <select
                className="border rounded px-2 py-1 w-1/2"
                value={modelSelect}
                onChange={e => setModelSelect(e.target.value)}
              >
                <option value="">（不选择）</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {(m.label || m.id) + (m.recommended ? " ·默认" : "")}
                  </option>
                ))}
              </select>
              <input
                className="border rounded px-2 py-1 w-1/2"
                placeholder="手写模型名（优先）"
                value={modelCustom}
                onChange={e => setModelCustom(e.target.value)}
              />
            </div>
          </div>

          {/* Fallback default model (backend default if omitted) */}
          <div className="flex items-center gap-2">
            <span className="shrink-0">默认模型(兜底)</span>
            <input
              className="border rounded px-2 py-1 w-full"
              value={defaultModel}
              onChange={e => setDefaultModel(e.target.value)}
            />
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col">
        {/* Header: character bind + SID */}
        <div className="h-14 border-b border-slate-200 bg-white flex items-center px-4 gap-3">
          <div className="font-semibold">角色</div>
          <select
            className="border rounded px-2 py-1"
            value={bindCharId || ""}
            onChange={e => handleBindCharacter(Number(e.target.value))}
          >
            <option value="">（未绑定）</option>
            {chars.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="ml-auto text-xs opacity-60">
            SID: <span className="font-mono">{sid || "—"}</span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.map((m, i) => (
            <div key={i} className={clsx("mb-3 flex", m.role === "user" ? "justify-end" : "justify-start")}>
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
        <div className="border-t border-slate-200 bg-white p-3">
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
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending || streaming}
            />
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
      </main>
    </div>
  );
}
