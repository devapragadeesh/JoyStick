import { useEffect, useMemo, useRef, useState } from "react";
import { useCodeGraph } from "./CodeMap.js";
import { useSelection } from "./selection.js";
import { useChat, useProviders } from "./useQa.js";
import { ProviderSettings } from "./ProviderSettings.js";

const LAST_PROVIDER_KEY = "joystick.qa.lastProviderId";

/**
 * Q&A chat (B.2).
 *
 * Selection is read from the same SelectionProvider the graph view writes
 * to — switching here after picking files in the graph shows them already
 * applied, not reset. `@`-mention resolves against the same graph node list
 * used everywhere else in the panel, not a second file listing.
 */
export function Chat({ sessionId }: { sessionId: string | null }) {
  const { selected, remove, add } = useSelection();
  const { graph } = useCodeGraph();
  const { providers } = useProviders();
  const { messages, sending, send } = useChat(sessionId);

  const [text, setText] = useState("");
  const [providerId, setProviderId] = useState<string>(() => localStorage.getItem(LAST_PROVIDER_KEY) ?? "");
  const [showSettings, setShowSettings] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // Pin the view to the newest message as the conversation grows — the input
  // row is a fixed footer (see .chat-messages' own scroll region in
  // styles.css), so without this the latest message would sit below the
  // fold rather than "just appearing" the way a chat is expected to.
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages.length]);

  const effectiveProviderId = providers.some((p) => p.id === providerId)
    ? providerId
    : (providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? "");

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null || !graph) return [];
    const q = mentionQuery.toLowerCase();
    return graph.nodes.filter((n) => n.filePath.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionQuery, graph]);

  const handleTextChange = (value: string) => {
    setText(value);
    const at = value.lastIndexOf("@");
    if (at === -1) {
      setMentionQuery(null);
      return;
    }
    const after = value.slice(at + 1);
    // Only treat trailing "@word" as a live mention — once whitespace follows
    // it, the mention is already resolved or abandoned.
    if (/\s/.test(after)) {
      setMentionQuery(null);
    } else {
      setMentionQuery(after);
    }
  };

  const pickMention = (filePath: string) => {
    const at = text.lastIndexOf("@");
    setText(text.slice(0, at));
    setMentionQuery(null);
    add(filePath);
    inputRef.current?.focus();
  };

  const handleSelectProvider = (id: string) => {
    setProviderId(id);
    localStorage.setItem(LAST_PROVIDER_KEY, id);
  };

  const handleSend = async () => {
    const question = text.trim();
    if (!question || !effectiveProviderId) return;
    setText("");
    await send(effectiveProviderId, question, selected);
  };

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <span className="codemap-title">Ask</span>
        <button className="qa-settings-toggle" onClick={() => setShowSettings((s) => !s)}>
          {showSettings ? "hide settings" : "providers…"}
        </button>
      </div>

      {showSettings && <ProviderSettings onClose={() => setShowSettings(false)} />}

      {!sessionId && <p className="muted codemap-status">Select a session first.</p>}

      {sessionId && (
        <>
          <div className="chat-messages" ref={messagesRef}>
            {messages.length === 0 && <p className="muted codemap-hint">Ask a question about this session's code.</p>}
            {messages.map((m) => (
              <div key={m.id} className={`chat-message chat-message-${m.role}`}>
                {m.role === "assistant" && m.providerLabel && (
                  <span className="chat-provider-tag">{m.providerLabel}</span>
                )}
                <p>{m.text}</p>
                {m.contextFiles.length > 0 && (
                  <p className="muted chat-context-files">context: {m.contextFiles.join(", ")}</p>
                )}
              </div>
            ))}
          </div>

          {selected.length > 0 && (
            <div className="qa-chips">
              {selected.map((f) => (
                <span key={f} className="codemap-chip">
                  {f.split("/").pop()}
                  <button onClick={() => remove(f)}>×</button>
                </span>
              ))}
            </div>
          )}

          <div className="chat-input-row">
            <select value={effectiveProviderId} onChange={(e) => handleSelectProvider(e.target.value)}>
              {providers.length === 0 && <option value="">no providers configured</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.kind})
                </option>
              ))}
            </select>
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              placeholder="Ask about the selected files… @ to mention one, or add a folder from the graph"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button onClick={handleSend} disabled={sending || !text.trim() || !effectiveProviderId}>
              {sending ? "asking…" : "send"}
            </button>
          </div>

          {mentionMatches.length > 0 && (
            <ul className="qa-mention-list">
              {mentionMatches.map((n) => (
                <li key={n.id}>
                  <button onClick={() => pickMention(n.filePath)}>{n.filePath}</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
