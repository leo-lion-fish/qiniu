// --- START OF FILE App.jsx ---

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * App.jsx — 会话管理（重命名/删除）+ 多轮会话 + 角色绑定 + 模型优先级 + 流式SSE + TTS + 浏览器ASR
 *
 * 后端接口（FastAPI）：
 *   GET    /characters
 *   GET    /sessions                      -> [{ session_id, character_id?, character_name?, title?, created_at, last_active_at }]
 *   GET    /sessions/{sid}/messages
 *   POST   /sessions/{sid}/bind-character -> { character_id }
 *   POST   /chat                          -> { session_id, message, model? }
 *   POST   /chat/stream                   -> SSE（data:{"content"} | "[DONE]")
 *   PATCH  /sessions/{sid}                -> { title }
 *   DELETE /sessions/{sid}                -> { deleted: 1 }
 *   GET    /models
 *   GET    /voice/list
 *   POST   /voice/tts
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
// 简单时间格式化（左侧显示“最后活跃时间”）
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

  // --- New states for retry logic ---
  const [isSessionLocked, setIsSessionLocked] = useState(false); // Whether the session is currently locked by another client
  const [retryTimeoutId, setRetryTimeoutId] = useState(null); // Timeout ID for scheduled retries
  const [retryAttempt, setRetryAttempt] = useState(0); // Current retry count for the *this* client's message
  const MAX_RETRY_ATTEMPTS = 5;
  const BASE_RETRY_DELAY_MS = 1000; // 1 second for the first retry

  /* ---------- TTS ---------- */
  const [voices, setVoices] = useState([]); // from /voice/list
  const [voiceType, setVoiceType] = useLocalStorage(
    "cfg.voiceType",
    "qiniu_zh_female_tmjxxy"
  );
  const [autoSpeak, setAutoSpeak] = useLocalStorage("cfg.autoSpeak", true);
  const audioRef = useRef(null);
  // const [isPlayingAudio, setIsPlayingAudio] = useState(false); // REMOVED

  /* ---------- ASR (Web Speech API) ---------- */
  const [recOn, setRecOn] = useState(false);
  const recognitionRef = useRef(null);

  /* ---------- Refs ---------- */
  const listBottomRef = useRef(null);
  const inputRef = useRef(null);
  // const currentAbortController = useRef(null); // REMOVED
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
        const r = await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(sid)}/messages`
        );
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async bindCharacter(sid, character_id) {
        const r = await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(sid)}/bind-character`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ character_id }),
          }
        );
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async renameSession(sid, title) {
        const r = await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(sid)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          }
        );
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async deleteSession(sid) {
        const r = await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(sid)}`,
          { method: "DELETE" }
        );
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async chat(body) {
        const r = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // --- Custom error handling for 409 ---
        if (r.status === 409) {
          const errBody = await r.json();
          // Include status to allow calling function to distinguish
          throw new Error(JSON.stringify({ status: 409, detail: errBody.detail }));
        }
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async *chatStream(body) { // Removed signal parameter
        const r = await fetch(`${baseUrl}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          // Removed signal: signal,
        });
        // --- Custom error handling for 409 ---
        if (r.status === 409) {
          const errBody = await r.json();
          // Include status to allow calling function to distinguish
          throw new Error(JSON.stringify({ status: 409, detail: errBody.detail }));
        }
        if (!r.ok) throw new Error(await r.text());

        const reader = r.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            // 手写分行：避免正则字面量引起的 oxc 误判
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              const s = line.trim();
              if (!s.startsWith("data:")) continue;
              const payload = s.slice(5).trim();
              if (payload === "[DONE]") return;
              try {
                const obj = JSON.parse(payload);
                if (obj.content) yield obj.content;
                if (obj.error) throw new Error(obj.error);
              } catch {
                // ignore malformed chunk
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
        } catch {}

        // voice list
        try {
          const vs = await api.getVoiceList();
          setVoices(vs || []);
          if (!voiceType) {
            const v =
              (vs || []).find((x) =>
                String(x.voice_type || "").startsWith("qiniu_zh_female")
              ) || vs?.[0];
            if (v?.voice_type) setVoiceType(v.voice_type);
          }
        } catch {}

        // ensure sid
        if (!sid) {
          const first =
            sRes.status === "fulfilled" ? sRes.value?.[0]?.session_id : null;
          setSid(first || uuidv4());
        }
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Load messages on sid change / Reset retry state ---------- */
  useEffect(() => {
    if (!sid) return;
    (async () => {
      try {
        setError("");
        // Reset retry states when session changes
        setIsSessionLocked(false);
        setRetryAttempt(0);
        if (retryTimeoutId) clearTimeout(retryTimeoutId);
        setRetryTimeoutId(null);

        const msgs = await api.getMessages(sid);
        setMessages(msgs || []);
      } catch (e) {
        console.error(e);
        setError(String(e));
      }
    })();
  }, [sid, api]);

  /* ---------- 同步：当前会话的角色到下拉框（找不到当前会话时“不覆盖”） ---------- */
  useEffect(() => {
    if (!sid) return;
    const cur = sessions.find((s) => s.session_id === sid);
    if (!cur) {
      // 列表里还没有这个会话（比如刚新建），保持现状，不覆盖用户刚刚的选择
      return;
    }
    if (cur.character_id != null) {
      setCurrentCharId(cur.character_id);
    } else if (cur.character_name) {
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
    setError(""); // Clear error when creating new session
    // Reset retry states
    setIsSessionLocked(false);
    setRetryAttempt(0);
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    setRetryTimeoutId(null);
  }

  async function handleBindCharacter(val) {
    if (!sid) return;
    if (val === "" || val === null) {
      setCurrentCharId(null);
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === sid
            ? { ...s, character_id: null, character_name: undefined }
            : s
        )
      );
      return;
    }
    const idNum = Number(val);
    if (Number.isNaN(idNum)) return;
    try {
      await api.bindCharacter(sid, idNum);
      setCurrentCharId(idNum);
      const newName = chars.find((c) => c.id === idNum)?.name;
      setSessions((prev) => {
        const exists = prev.some((s) => s.session_id === sid);
        if (exists) {
          return prev.map((s) =>
            s.session_id === sid
              ? {
                  ...s,
                  character_id: idNum,
                  character_name: newName ?? s.character_name,
                }
              : s
          );
        }
        // 会话列表还没有当前 sid（刚新建），插入一条最小信息；时间用 now 兜底
        const now = new Date().toISOString();
        return [
          ...prev,
          {
            session_id: sid,
            character_id: idNum,
            character_name: newName,
            title: "",
            created_at: now,
            last_active_at: now,
          },
        ];
      });
    } catch (e) {
      setError("绑定角色失败：" + String(e));
    }
  }

  async function speakIfNeeded(text) {
    if (!autoSpeak || !text) return;
    if (!audioRef.current) return;

    try {
      // audioRef.current.onended = () => setIsPlayingAudio(false); // REMOVED
      // audioRef.current.onplay = () => setIsPlayingAudio(true); // REMOVED
      // audioRef.current.onpause = () => setIsPlayingAudio(false); // REMOVED

      const { audio } = await api.tts(voiceType, text, "mp3", 1.0);
      audioRef.current.src = audio;
      await audioRef.current.play().catch((err) => {
        console.warn("TTS 播放失败 (可能需要用户交互)：", err);
        // setIsPlayingAudio(false); // REMOVED
      });
    } catch (e) {
      console.warn("TTS 播放请求失败：", e);
      // setIsPlayingAudio(false); // REMOVED
    }
  }

  // function stopSpeaking() { // REMOVED
  //   if (audioRef.current && isPlayingAudio) {
  //     audioRef.current.pause();
  //     audioRef.current.currentTime = 0;
  //     setIsPlayingAudio(false);
  //   }
  // }

  // function stopGenerating() { // REMOVED
  //   if (currentAbortController.current) {
  //     currentAbortController.current.abort();
  //     currentAbortController.current = null;
  //     setStreaming(false);
  //     setError("生成已停止。");
  //   }
  // }


  // Refactored sendMessage to handle retries gracefully
  async function sendMessage(originalInputText = null, isRetry = false) {
    const textToSend = originalInputText !== null ? originalInputText : input.trim();
    if (!textToSend || sending || streaming) return;

    // Clear any previous abort controller if it somehow wasn't cleared (safety) // REMOVED
    // if (currentAbortController.current) {
    //   currentAbortController.current.abort();
    //   currentAbortController.current = null;
    // }

    // On the very first attempt for a new user message, reset all retry-related states
    if (!isRetry) {
      setError("");
      setRetryAttempt(0);
      setIsSessionLocked(false);
      // Clear any previous retry timeouts
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
      setRetryTimeoutId(null);

      // Optimistically add user message only on the *first* send attempt
      const newUser = {
          role: "user",
          content: textToSend,
          created_at: new Date().toISOString(),
          _optimistic: true // Mark as optimistic, to be removed on success or final failure
      };
      setMessages((prev) => [...prev, newUser]);
      setInput(""); // Clear input field only on initial send
    }

    setSending(true); // Disable input and button while processing (including initial wait/retry setup)

    const candidate = (modelCustom || "").trim();
    const selected = (modelSelect || "").trim();
    const fallback = (defaultModel || "").trim();
    const finalModel = candidate || selected || fallback || undefined;

    // Track the optimistic user message index for later updates/removal
    let currentUserMessageIndex = -1;
    setMessages(prev => {
        const lastUserMsg = prev.findLast(m => m.role === 'user' && m.content === textToSend && m._optimistic);
        if (lastUserMsg) {
            currentUserMessageIndex = prev.indexOf(lastUserMsg);
        }
        return prev;
    });

    // Create a new AbortController for *this* send attempt // REMOVED
    // const abortController = new AbortController();
    // currentAbortController.current = abortController; // Store it in ref

    try {
      const body = { session_id: sid, message: textToSend };
      if (finalModel) body.model = finalModel;

      let acc = "";
      let gotChunk = false;
      let assistantMessageIndex = -1; // Index for the assistant's reply (placeholder or full)

      // Use the api.chatStream generator directly.
      // Pass the signal from the abortController. // Removed signal parameter
      const chatStreamGenerator = api.chatStream(body);

      try {
        for await (const chunk of chatStreamGenerator) {
          // If this is the first chunk, add the assistant placeholder
          if (!gotChunk) {
            setMessages(prev => {
                const copy = [...prev];
                // Ensure assistantMessageIndex is for a new message
                copy.push({
                    role: "assistant",
                    content: "", // Start with empty content
                    created_at: new Date().toISOString(),
                    _streaming: true,
                });
                assistantMessageIndex = copy.length - 1;
                return copy;
            });
            setStreaming(true); // Start streaming flag once we get first chunk
          }

          gotChunk = true;
          acc += chunk;
          setMessages((prev) => {
            const copy = [...prev];
            // Update the content of the streaming assistant message
            if (assistantMessageIndex !== -1 && copy[assistantMessageIndex]) {
              copy[assistantMessageIndex] = { ...copy[assistantMessageIndex], content: acc };
            }
            return copy;
          });
        }
      } catch (streamError) {
          // Pass stream errors to outer catch block for 409 or other API errors.
          // The outer catch block will distinguish 409, AbortError, etc.
          throw streamError;
      }

      // Mark streaming complete and remove optimistic/streaming flags
      setMessages((prev) =>
        prev.map((m, index) => {
            if (index === assistantMessageIndex) {
                return { ...m, _streaming: false };
            }
            if (index === currentUserMessageIndex) {
                const { _optimistic, ...rest } = m; // Remove optimistic flag
                return rest;
            }
            return m;
        })
      );

      await speakIfNeeded(acc);

      // On successful send (after all retries, if any), reset retry state and clear ALL related error messages
      setIsSessionLocked(false);
      setRetryAttempt(0);
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
      setRetryTimeoutId(null);
      setError(""); // Crucial: Clear error message on success!

    } catch (e) {
      console.error("发送消息失败:", e);
      let errorDetail = String(e);
      let parsedError = null;
      let is409Error = false;
      // let isAbortError = false; // REMOVED

      // Check for AbortError first, as it's a specific type of user-triggered error // REMOVED
      // if (e.name === 'AbortError') {
      //     isAbortError = true;
      //     errorDetail = "生成已停止。"; // Use a more specific message for user abort
      // } else {
          // Try to parse the error message if it looks like JSON from our API helper
          const rawErrorMessage = errorDetail.startsWith('Error: ') ? errorDetail.substring(7) : errorDetail;
          if (rawErrorMessage.startsWith('{') && rawErrorMessage.endsWith('}')) {
            try {
                parsedError = JSON.parse(rawErrorMessage);
                if (parsedError && parsedError.status === 409 && parsedError.detail) {
                    errorDetail = parsedError.detail;
                    is409Error = true;
                }
            } catch (parseError) {
                console.warn("Error parsing error message:", parseError);
            }
          }
      // } // REMOVED


      if (is409Error) {
        const nextRetryAttempt = retryAttempt + 1;
        setRetryAttempt(nextRetryAttempt);
        setIsSessionLocked(true); // Indicate session is locked, and we're waiting/retrying

        if (nextRetryAttempt <= MAX_RETRY_ATTEMPTS) {
          const delay = BASE_RETRY_DELAY_MS * (2 ** (nextRetryAttempt - 1));
          setError(`会话忙，将在 ${delay / 1000} 秒后自动重试... (第 ${nextRetryAttempt}/${MAX_RETRY_ATTEMPTS} 次)`);
          const timeout = setTimeout(() => sendMessage(textToSend, true), delay);
          setRetryTimeoutId(timeout);
        } else {
          // Max retries reached
          setError(`会话长时间忙碌，已停止重试。错误: ${errorDetail}。请稍后手动重试。`);
          // Remove the optimistic user message if max retries reached and failed
          setMessages((prev) => {
              let copy = [...prev];
              if (currentUserMessageIndex !== -1 && copy[currentUserMessageIndex] && copy[currentUserMessageIndex]._optimistic) {
                  copy.splice(currentUserMessageIndex, 1);
              }
              // Remove assistant placeholder if it was added for any reason (though with new logic, they shouldn't exist for 409)
              if (assistantMessageIndex !== -1 && copy[assistantMessageIndex] && copy[assistantMessageIndex]._streaming) {
                  copy.splice(assistantMessageIndex, 1); // remove if it was added for some reason
              }
              return copy;
          });
          setIsSessionLocked(false); // No longer actively retrying for this message
        }
      } else {
        // Handle other types of errors (e.g., network, LLM upstream, or general API parsing error)
        setError("发送失败：" + errorDetail);
        // Remove optimistic messages in case of other errors
        setMessages((prev) => {
            let copy = [...prev];
            if (currentUserMessageIndex !== -1 && copy[currentUserMessageIndex] && copy[currentUserMessageIndex]._optimistic) {
                copy.splice(currentUserMessageIndex, 1);
            }
            if (assistantMessageIndex !== -1 && copy[assistantMessageIndex] && copy[assistantMessageIndex]._streaming) {
                copy.splice(assistantMessageIndex, 1);
            }
            return copy;
        });
        setIsSessionLocked(false); // Not locked, just failed
      }
    } finally {
      // Always clear the AbortController ref. // REMOVED
      // currentAbortController.current = null; // REMOVED

      // ALWAYS reset sending/streaming flags if no longer explicitly locked and retrying
      // This ensures UI is responsive after any error or success.
      if (!isSessionLocked || retryAttempt >= MAX_RETRY_ATTEMPTS || !is409Error) { // Added !is409Error to ensure clearing if not 409
        setSending(false);
        setStreaming(false);
        inputRef.current?.focus();
      }

      // Always try to refresh sessions, as it's just fetching data.
      try {
        setSessions(await api.getSessions());
      } catch (err) {
        console.error("Failed to refresh sessions:", err); // Log this, but don't stop the main flow
      }
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const messageText = input.trim();
      sendMessage(messageText);
    }
  }

  // --- 重命名 / 删除 ---
  async function handleRenameSession(e, s) {
    e.stopPropagation();
    const t = prompt("会话标题", s.title || s.character_name || "");
    if (t == null) return;
    try {
      await api.renameSession(s.session_id, String(t).trim());
      const list = await api.getSessions();
      setSessions(list || []);
    } catch (err) {
      setError("重命名失败：" + String(err));
    }
  }

  async function handleDeleteSession(e, s) {
    e.stopPropagation();
    if (!confirm("确定删除该会话及其全部消息？此操作不可撤销。")) return;
    try {
      await api.deleteSession(s.session_id);
      const list = await api.getSessions();
      setSessions(list || []);
      if (s.session_id === sid) {
        const first = list?.[0]?.session_id;
        if (first) setSid(first);
        else {
          const newSid = uuidv4();
          setSid(newSid);
          setMessages([]);
          setCurrentCharId(null);
        }
        setError(""); // Clear error when deleting active session
        // Reset retry states
        setIsSessionLocked(false);
        setRetryAttempt(0);
        if (retryTimeoutId) clearTimeout(retryTimeoutId);
        setRetryTimeoutId(null);
      }
    } catch (err) {
      setError("删除失败：" + String(err));
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
      setInput(txt);
    };
    rec.onerror = (e) => {
      setError("ASR 错误：" + e.error);
      setRecOn(false);
    };
    rec.onend = () => {
      setRecOn(false);
      if (finalTxt.trim()) sendMessage(finalTxt.trim()); // Use finalTxt for ASR input
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
  // isDisabled now considers the session being locked and retrying
  const isDisabled = sending || streaming || (isSessionLocked && retryAttempt < MAX_RETRY_ATTEMPTS);
  // const showStopButton = streaming || isPlayingAudio; // REMOVED

  return (
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
            sessions.map((s) => {
              const active = sid === s.session_id;
              return (
                <button
                  key={s.session_id}
                  onClick={() => setSid(s.session_id)}
                  className={clsx(
                    "w-full text-left px-3 py-2 rounded-md mb-2 border group",
                    active
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white hover:bg-slate-50 border-slate-200"
                  )}
                  title={`SID: ${s.session_id}\n最后活跃：${fmtTime(
                    s.last_active_at || s.created_at
                  )}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium truncate">
                      {s.title?.trim() || s.character_name || "未绑定角色"}
                    </div>
                    {active && (
                      <div className="ml-2 shrink-0 flex gap-1">
                        <button
                          className={clsx(
                            "px-1.5 py-0.5 text-xs rounded border",
                            active
                              ? "border-slate-300 bg-white/10 hover:bg-white/20"
                              : "border-slate-300 hover:bg-slate-50"
                          )}
                          title="重命名会话"
                          onClick={(e) => handleRenameSession(e, s)}
                        >
                          ✏️
                        </button>
                        <button
                          className={clsx(
                            "px-1.5 py-0.5 text-xs rounded border text-red-600",
                            active
                              ? "border-red-300 bg-white/10 hover:bg-red-50/20"
                              : "border-red-300 hover:bg-red-50"
                          )}
                          title="删除会话"
                          onClick={(e) => handleDeleteSession(e, s)}
                        >
                          🗑️
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="text-xs opacity-70 truncate">
                    {fmtTime(s.last_active_at || s.created_at) || "—"}
                  </div>
                </button>
              );
            })
          ) : (
            <div className="text-sm text-slate-500 p-3">
              暂无会话，点“新建”创建一个。
            </div>
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
                <div className="text-[11px] opacity-70">
                  推荐模型（选其一，右侧手写优先生效）
                </div>
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
                <div className="text:[11px] opacity-70">语音合成</div>
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
              模型:{" "}
              <span className="font-mono">
                {modelCustom || modelSelect || defaultModel || "后端默认"}
              </span>
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={clsx(
                "mb-3 flex",
                m.role === "user" ? "justify-end" : "justify-start"
              )}
            >
              <div
                className={clsx(
                  "max-w-[75%] rounded-2xl px-3 py-2 whitespace-pre-wrap break-words",
                  m.role === "user"
                    ? "bg-slate-900 text-white"
                    : "bg-white border border-slate-200"
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
              disabled={isDisabled}
            />
            <button
              onClick={recOn ? stopASR : startASR}
              className={clsx(
                "px-3 py-2 rounded-md border",
                recOn
                  ? "bg-red-50 border-red-200 text-red-600"
                  : "bg-white border-slate-200"
              )}
              title="语音输入"
              disabled={isDisabled}
            >
              {recOn ? "停止" : "🎤 语音"}
            </button>

            {/* REMOVED: Stop button for generation or speaking */}
            {/* {showStopButton && (
              <button
                onClick={streaming ? stopGenerating : stopSpeaking}
                className={clsx(
                  "px-3 py-2 rounded-md border",
                  streaming
                    ? "bg-orange-100 border-orange-300 text-orange-700"
                    : "bg-blue-100 border-blue-300 text-blue-700"
                )}
                title={streaming ? "停止生成" : "停止朗读"}
              >
                {streaming ? "⏹️ 停止生成" : "🔇 停止朗读"}
              </button>
            )} */}

            <button
              onClick={() => sendMessage()}
              disabled={isDisabled || !input.trim()}
              className={clsx(
                "px-4 py-2 rounded-md text-white",
                isDisabled || !input.trim()
                  ? "bg-slate-400"
                  : "bg-slate-900 hover:bg-black"
              )}
            >
              发送
            </button>
          </div>
          <div className="text-xs opacity-70 mt-1">
            当前使用模型优先级：<code>手写</code> → <code>下拉</code> →{" "}
            <code>默认(兜底)</code>。兜底当前：
            <span className="font-mono"> {defaultModel || "（后端默认）"}</span>
          </div>
        </div>
      </div>

      {/* hidden audio for TTS */}
      <audio ref={audioRef} hidden />
    </div>
  );
}
// --- END OF FILE App.jsx ---