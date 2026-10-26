import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "lucide-react";
import { PageDef, PageId } from "../nav";
import { useIndustry } from "../lib/industry";

/** ⌘/ command palette to jump between the current persona's pages. */
export default function CommandPalette({
  open, onClose, pages, onSelect,
}: {
  open: boolean;
  onClose: () => void;
  pages: PageDef[];
  onSelect: (p: PageId) => void;
}) {
  const { overlay } = useIndustry();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const labelFor = (p: PageDef) => overlay.navLabels[p.id] ?? p.label;

  const filtered = useMemo(
    () => pages.filter((p) => labelFor(p).toLowerCase().includes(q.trim().toLowerCase())),
    [pages, q, overlay]);

  useEffect(() => { setActive(0); }, [q]);

  if (!open) return null;

  const choose = (p?: PageDef) => {
    if (!p) return;
    onSelect(p.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start pt-32 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-xl mx-auto rounded-xl bg-ink-800 ring-1 ring-line shadow-depth overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <Command className="w-4 h-4 text-fg-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(filtered[active]); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
            placeholder="Jump to a screen..."
            className="bg-transparent flex-1 outline-none text-sm text-fg placeholder:text-fg-subtle"
          />
          <span className="text-[10px] text-fg-subtle font-mono">esc</span>
        </div>
        <div className="py-2 max-h-80 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-fg-subtle">No matching screens.</div>
          )}
          {filtered.map((p, i) => (
            <button
              key={p.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(p)}
              className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition ${
                i === active ? "bg-black/[0.04] text-fg" : "text-fg-muted hover:bg-black/[0.04]"
              }`}
            >
              <span>{labelFor(p)}</span>
              <span className="ml-auto text-[10px] text-fg-subtle font-mono">#{p.id}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
