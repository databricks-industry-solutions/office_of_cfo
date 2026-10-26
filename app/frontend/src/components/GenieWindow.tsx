import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Plus, Send } from "lucide-react";
import { api, GenieAnswer, getDemoMonthOffset } from "../api";
import { bumpGenieChatEpoch, isCurrentGenieChatEpoch } from "../lib/genieChatEpoch";

/** Fire this from anywhere to open the Genie assistant: `openGenie()`.
 * Pass a `seed` to pre-fill the input with a suggested question (the user
 * reviews and hits send — we don't auto-ask). */
export function openGenie(seed?: string) {
  window.dispatchEvent(new CustomEvent("genie:open", { detail: { seed } }));
}

/** The Databricks Genie sparkle glyph (twin four-point stars). */
function GenieGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 1.75c.45 3.9 2.6 6.05 6.5 6.5-3.9.45-6.05 2.6-6.5 6.5-.45-3.9-2.6-6.05-6.5-6.5 3.9-.45 6.05-2.6 6.5-6.5Z"
        fill="currentColor"
      />
      <path
        d="M18.75 13.5c.22 1.9 1.35 3.03 3.25 3.25-1.9.22-3.03 1.35-3.25 3.25-.22-1.9-1.35-3.03-3.25-3.25 1.9-.22 3.03-1.35 3.25-3.25Z"
        fill="currentColor"
        opacity="0.75"
      />
    </svg>
  );
}

// A single turn in the transcript. Genie turns carry the optional SQL query and
// result table the Conversation API returns alongside the natural-language text.
type ChatTurn =
  | { role: "user"; text: string }
  | {
      role: "genie";
      text: string | null;
      query: string | null;
      table: GenieAnswer["table"];
      error?: string;
    };

// Genie answers come back as light Markdown; render the inline formatting it
// actually uses — **bold** and `inline code` — while preserving newlines via the
// pre-wrap parent. (Deliberately minimal: no block-level Markdown.)
function RichText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(<strong key={key++} className="font-semibold text-fg">{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      nodes.push(
        <code key={key++} className="font-mono text-[0.85em] bg-ink-800 ring-1 ring-line rounded px-1 py-0.5">
          {m[2]}
        </code>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function ResultTable({ table }: { table: NonNullable<GenieAnswer["table"]> }) {
  const rows = table.rows.slice(0, 50);
  return (
    <div className="mt-2 overflow-x-auto rounded-lg ring-1 ring-line">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-ink-800">
            {table.columns.map((c) => (
              <th key={c} className="px-2.5 py-1.5 text-left font-medium text-fg-muted whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line/60">
              {r.map((cell, j) => (
                <td key={j} className="px-2.5 py-1.5 text-fg-muted whitespace-nowrap tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > rows.length && (
        <div className="px-2.5 py-1.5 text-[10px] text-fg-subtle bg-ink-800/60">
          Showing first {rows.length} of {table.rows.length} rows.
        </div>
      )}
    </div>
  );
}

/**
 * On-demand Genie assistant, available on every screen as a collapsible
 * right-hand sidebar. A persistent Ask Genie tab sits on the right edge of the
 * viewport and opens the panel; the panel can also be toggled via the global
 * hotkey (⌘K / Ctrl+K), the "Ask Genie" links, or the `genie:open` event.
 *
 * Answers come from the Databricks Genie Conversation API (not an iframe). The
 * conversation id returned by the first question is threaded into every
 * follow-up, so Genie keeps the full context of the chat.
 */
export default function GenieWindow() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  // The live Genie conversation. Held in a ref so the async send always reads
  // the latest id (the first answer establishes it; follow-ups reuse it).
  const conversationId = useRef<string | null>(null);
  // Bumped on New chat so in-flight replies from the previous chat are dropped.
  const chatEpoch = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadedMeta = useRef(false);

  // Global hotkey (toggle) + Esc (close), and the programmatic open event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = (e: Event) => {
      setOpen(true);
      // A seeded open (from the variance commentary "Ask a follow-up" button)
      // pre-fills the input so the user can review before sending.
      const seed = (e as CustomEvent<{ seed?: string }>).detail?.seed;
      if (seed) {
        setDraft(seed);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("genie:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("genie:open", onOpen);
    };
  }, []);

  // Lazily load the suggestion chips + the full-space link the first time the
  // panel opens (best-effort; the panel works without them).
  useEffect(() => {
    if (!open || loadedMeta.current) return;
    loadedMeta.current = true;
    api.genieSuggestions().then((r) => setSuggestions(r.questions)).catch(() => {});
    api.genieEmbed().then((r) => setEmbedUrl(r.url)).catch(() => {});
  }, [open]);

  // Keep the transcript pinned to the latest turn, and focus the input on open.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(content: string) {
    const q = content.trim();
    if (!q || busy) return;
    const sendEpoch = chatEpoch.current;
    setDraft("");
    setTurns((t) => [...t, { role: "user", text: q }]);
    setBusy(true);
    try {
      const ans = conversationId.current
        ? await api.genieFollowUp(conversationId.current, q)
        : await api.genieAsk(q);
      // New chat (or another reset) happened while we were waiting — discard.
      if (!isCurrentGenieChatEpoch(sendEpoch, chatEpoch.current)) return;
      conversationId.current = ans.conversation_id;
      setTurns((t) => [
        ...t,
        { role: "genie", text: ans.text, query: ans.query, table: ans.table },
      ]);
    } catch (e: any) {
      if (!isCurrentGenieChatEpoch(sendEpoch, chatEpoch.current)) return;
      setTurns((t) => [
        ...t,
        { role: "genie", text: null, query: null, table: null, error: e?.message || "Genie is unavailable right now." },
      ]);
    } finally {
      // Only clear busy for this send; a newer chat may already be in flight.
      if (isCurrentGenieChatEpoch(sendEpoch, chatEpoch.current)) {
        setBusy(false);
      }
    }
  }

  function startNewChat() {
    chatEpoch.current = bumpGenieChatEpoch(chatEpoch.current);
    conversationId.current = null;
    setTurns([]);
    setDraft("");
    setBusy(false);
  }

  return (
    <>
      {/* Persistent launcher — a right-edge bookmark tab, vertically centered.
          Hidden while the panel is open (the panel takes its place). */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Ask Genie"
        aria-expanded={open}
        className={`fixed right-0 top-1/2 z-40 -translate-y-1/2 flex flex-col items-center gap-1.5
                    rounded-l-2xl px-1.5 py-3
                    bg-accent text-white ring-1 ring-accent/40 transition
                    hover:bg-accent-600 active:scale-[0.98]
                    ${open ? "opacity-0 pointer-events-none translate-x-2" : "opacity-100"}`}
      >
        <GenieGlyph className="w-4 h-4" />
        <span
          className="text-[11px] font-semibold tracking-wide leading-none"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          Ask Genie
        </span>
      </button>

      {/* Backdrop (click to collapse). */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] animate-[fadein_150ms_ease-out]"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Collapsible right sidebar. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Ask Genie"
        aria-hidden={!open}
        className={`fixed top-0 right-0 z-50 h-[100dvh] w-full sm:w-[420px] bg-ink-900 border-l border-line
                    shadow-depth flex flex-col transition-transform duration-200 ease-out
                    ${open ? "translate-x-0" : "hidden translate-x-full pointer-events-none"}`}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3 shrink-0">
          <button
            onClick={startNewChat}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium
                       text-fg ring-1 ring-line hover:bg-black/[0.04] transition"
          >
            <Plus className="w-3.5 h-3.5" />
            New chat
          </button>
          <div className="flex items-center gap-1 shrink-0">
            {embedUrl && getDemoMonthOffset() === 0 && (
              <a
                href={embedUrl}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 rounded-md hover:bg-black/[0.04] transition text-fg-muted"
                aria-label="Open the full Genie space in a new tab"
                title="Open in Databricks"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button
              onClick={() => setOpen(false)}
              aria-label="Collapse"
              className="p-1.5 rounded-md hover:bg-black/[0.04] transition text-fg-muted"
            >
              <ChevronRight className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {/* Transcript */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {turns.length === 0 && (
            <div className="px-1 py-2">
              <h2 className="text-sm text-fg leading-relaxed">
                Ask a plain-language question. Try one of the suggested prompts below or type your own question.
              </h2>
              {suggestions.length > 0 && (
                <div className="mt-4 flex flex-col gap-2">
                  {suggestions.slice(0, 5).map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left text-xs text-fg-muted bg-ink-800/60 hover:bg-ink-700/60
                                 ring-1 ring-line rounded-lg px-3 py-2 transition"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent text-white px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                  {turn.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] w-full">
                  {turn.error ? (
                    <p className="text-sm text-signal-bad whitespace-pre-wrap">{turn.error}</p>
                  ) : (
                    <>
                      {turn.text && (
                        <div className="text-sm text-fg whitespace-pre-wrap break-words leading-relaxed">
                          <RichText text={turn.text} />
                        </div>
                      )}
                      {turn.table && <ResultTable table={turn.table} />}
                      {turn.query && (
                        <details className="mt-2 group">
                          <summary className="text-[11px] text-fg-subtle hover:text-fg-muted cursor-pointer select-none">
                            View SQL
                          </summary>
                          <pre className="mt-1.5 text-[11px] font-mono text-fg-muted bg-ink-800 ring-1 ring-line rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap">
                            {turn.query}
                          </pre>
                        </details>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          )}

          {busy && (
            <div className="flex justify-start">
              <span className="genie-dots" aria-label="Genie is thinking">
                <i /><i /><i />
              </span>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-line p-3 shrink-0">
          <div className="flex items-end gap-2 rounded-xl ring-1 ring-line bg-ink-800/60 px-2.5 py-1.5 focus-within:ring-accent/40 transition">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={1}
              placeholder="Ask Genie…"
              className="flex-1 resize-none bg-transparent text-sm text-fg placeholder:text-fg-subtle
                         outline-none max-h-32 py-1"
            />
            <button
              onClick={() => send(draft)}
              disabled={!draft.trim() || busy}
              aria-label="Send"
              className="shrink-0 w-8 h-8 rounded-lg grid place-items-center bg-accent text-white
                         disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent-600 transition"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-fg-subtle text-center">
            Genie keeps context across this conversation.
          </p>
        </div>
      </aside>
    </>
  );
}
