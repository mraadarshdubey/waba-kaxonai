'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bot, RotateCcw, Send, Loader2, UserCircle2, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** assistant-only: the agent signalled a human handoff on this turn. */
  handoff?: boolean;
}

/**
 * How many messages the playground remembers. Matches the server's
 * MAX_TURNS in /api/ai/playground — anything beyond this would be
 * silently dropped there anyway, so the client trims to the same
 * bound and the "N/40" counter never lies.
 */
const MAX_MEMORY = 40;

const STORAGE_KEY = 'waba-kaxon.playground.transcript';

/** Last MAX_MEMORY turns from localStorage, [] on anything malformed. */
function loadStoredTurns(): Turn[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is Turn =>
          !!t &&
          typeof t === 'object' &&
          ((t as Turn).role === 'user' || (t as Turn).role === 'assistant') &&
          typeof (t as Turn).content === 'string',
      )
      .slice(-MAX_MEMORY);
  } catch {
    return [];
  }
}

export function AiPlayground({ onGoToSetup }: { onGoToSetup?: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the transcript once on mount (not in useState's initializer
  // — localStorage doesn't exist during SSR). This is what keeps a
  // model-comparison session alive across the Setup tab and reloads:
  // switch models, come back, and the conversation is still here.
  useEffect(() => {
    const stored = loadStoredTurns();
    if (stored.length > 0) setTurns(stored);
  }, []);

  // Mirror every change back, trimmed to the memory window. Storage
  // full/blocked (private mode) just means no persistence — never an
  // error the user sees.
  useEffect(() => {
    try {
      if (turns.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(turns.slice(-MAX_MEMORY)),
        );
      }
    } catch {
      /* best-effort */
    }
  }, [turns]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    // Trim as we go so the transcript, what's persisted, and what the
    // server sees all share the same 40-message window.
    const next: Turn[] = [
      ...turns,
      { role: 'user' as const, content: text },
    ].slice(-MAX_MEMORY);
    setTurns(next);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/ai/playground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only role+content — the server ignores anything else.
        body: JSON.stringify({
          messages: next.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'ai_not_configured') {
          toast.error('No agent configured yet — finish Setup first.');
        } else {
          toast.error(data.error ?? "Couldn't get a reply.");
        }
        // Roll the unsent user turn back so the transcript stays clean.
        setTurns(turns);
        setInput(text);
        return;
      }
      setTurns(
        [
          ...next,
          {
            role: 'assistant' as const,
            content:
              typeof data.reply === 'string' && data.reply.trim()
                ? data.reply
                : '',
            handoff: Boolean(data.handoff),
          },
        ].slice(-MAX_MEMORY),
      );
    } catch {
      toast.error("Couldn't reach the agent.");
      setTurns(turns);
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-[60vh] min-h-[420px] flex-col rounded-xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Playground</span>
          <span className="text-xs text-muted-foreground">
            — test replies as if you were a customer
          </span>
        </div>
        <div className="flex items-center gap-1">
          {turns.length > 0 && (
            <span
              className="text-xs tabular-nums text-muted-foreground"
              title={`The agent remembers the last ${MAX_MEMORY} messages of this test chat — it survives tab switches and reloads. At ${MAX_MEMORY} the oldest fall off.`}
            >
              {turns.length}/{MAX_MEMORY} in memory
            </span>
          )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTurns([])}
          disabled={turns.length === 0 || sending}
          className="text-muted-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
        </Button>
        </div>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Bot className="mb-2 h-8 w-8 text-muted-foreground/60" />
            <p>Send a message to see how your agent would reply.</p>
            <p className="mt-1 text-xs">
              It uses your knowledge base and behaves exactly like the
              auto-reply bot — including handoff.
            </p>
            {onGoToSetup && (
              <Button
                variant="link"
                size="sm"
                onClick={onGoToSetup}
                className="mt-1 h-auto p-0 text-xs"
              >
                Not set up yet? Go to Setup <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={i}
            className={cn(
              'flex gap-2',
              t.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            {t.role === 'assistant' && (
              <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
            )}
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm',
                t.role === 'user'
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {t.content && <p className="whitespace-pre-wrap">{t.content}</p>}
              {t.role === 'assistant' && t.handoff && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs text-amber-500',
                    t.content && 'mt-1.5 border-t border-border/50 pt-1.5',
                  )}
                >
                  <UserCircle2 className="h-3.5 w-3.5" />
                  Would hand off to a human here
                </p>
              )}
            </div>
            {t.role === 'user' && (
              <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-5 w-5 text-primary" />
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a customer message…"
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <Button
          size="sm"
          onClick={send}
          disabled={!input.trim() || sending}
          className="h-9 w-9 shrink-0 p-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
