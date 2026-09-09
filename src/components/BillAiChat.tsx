/**
 * BillAiChat — floating AI chat panel for asking questions about bills.
 *
 * Improvements:
 * #3 — Structured compare form with fields for plan details
 * #4 — Chat history persisted to localStorage per serviceId
 * #5 — Clear chat button
 * #6 — Better loading states with descriptive messages
 * #7 — Rich markdown rendering (tables, lists, headings, bold, code)
 * #9 — Follow-up suggestions after each AI answer
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Service, Bill } from '../types';
import {
  askQuestion,
  generateSuggestions,
  comparePlan,
  buildUsageProfile,
  loadChatHistory,
  saveChatHistory,
  clearChatHistory,
  extractFollowUps,
  type ChatMessage,
} from '../platform/ai-chat';
import { money, USAGE_UNITS, USAGE_CATEGORIES } from '../types';

interface Props {
  service: Service;
  bills: Bill[];
  open: boolean;
  openCompare?: boolean;
  onClose: () => void;
}

let _msgId = 0;
const nextId = () => `msg_${++_msgId}_${Date.now()}`;

export function BillAiChat({ service, bills, open, openCompare, onClose }: Props) {
  // #4: Load persisted chat history
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatHistory(service.id));
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [showCompare, setShowCompare] = useState(openCompare || false);
  const [ratings, setRatings] = useState<Record<string, 'up' | 'down'>>({});
  const [copied, setCopied] = useState(false);
  // #3: Structured compare form state
  const [compareForm, setCompareForm] = useState({
    planName: '',
    provider: '',
    supplyCharge: '',
    peakRate: '',
    shoulderRate: '',
    offPeakRate: '',
    controlledLoad: '',
    monthlyPrice: '',
    discount: '',
    extras: '',
  });
  // #9: Follow-up suggestions from the last AI response
  const [followUps, setFollowUps] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isUsage = USAGE_CATEGORIES.has(service.category);

  // #4: Persist messages whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      saveChatHistory(service.id, messages);
    }
  }, [messages, service.id]);

  // #4: Reload history when service changes
  useEffect(() => {
    setMessages(loadChatHistory(service.id));
    setSuggestions([]);
    setFollowUps([]);
  }, [service.id]);

  // Load dynamic suggestions when opened
  useEffect(() => {
    if (!open || suggestions.length > 0) return;
    setSuggestionsLoading(true);
    generateSuggestions(service, bills, setStatus)
      .then(s => setSuggestions(s))
      .catch(() => setSuggestions(['Summarise my costs', 'Tips to save']))
      .finally(() => { setSuggestionsLoading(false); setStatus(''); });
  }, [open, service, bills, suggestions.length]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  // #9: Load follow-ups from last assistant message
  useEffect(() => {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.followUps && last.followUps.length > 0) {
      setFollowUps(last.followUps);
    }
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', text: text.trim(), timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    setStatus('');
    setFollowUps([]);

    try {
      const { answer, costUSD, followUps: newFollowUps } = await askQuestion(service, bills, text, messages, setStatus);
      const assistantMsg: ChatMessage = {
        id: nextId(), role: 'assistant', text: answer,
        timestamp: Date.now(), followUps: newFollowUps,
      };
      setMessages(prev => [...prev, assistantMsg]);
      setFollowUps(newFollowUps);
      setStatus(`~$${costUSD.toFixed(4)}`);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: nextId(), role: 'assistant',
        text: `❌ ${(err as Error).message}`, timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [loading, service, bills, messages]);

  // #3: Build compare text from structured form
  const buildCompareText = useCallback(() => {
    const parts: string[] = [];
    if (compareForm.provider) parts.push(`Provider: ${compareForm.provider}`);
    if (compareForm.planName) parts.push(`Plan: ${compareForm.planName}`);
    if (compareForm.supplyCharge) parts.push(`Supply charge: ${compareForm.supplyCharge}`);
    if (compareForm.peakRate) parts.push(`Peak rate: ${compareForm.peakRate}`);
    if (compareForm.shoulderRate) parts.push(`Shoulder rate: ${compareForm.shoulderRate}`);
    if (compareForm.offPeakRate) parts.push(`Off-peak rate: ${compareForm.offPeakRate}`);
    if (compareForm.controlledLoad) parts.push(`Controlled load: ${compareForm.controlledLoad}`);
    if (compareForm.monthlyPrice) parts.push(`Monthly price: ${compareForm.monthlyPrice}`);
    if (compareForm.discount) parts.push(`Discount: ${compareForm.discount}`);
    if (compareForm.extras) parts.push(`Notes: ${compareForm.extras}`);
    return parts.join('\n');
  }, [compareForm]);

  const handleCompare = useCallback(async () => {
    const text = buildCompareText();
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: nextId(), role: 'user',
      text: `🔄 Compare plan:\n${text}`, timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);
    setCompareForm({ planName: '', provider: '', supplyCharge: '', peakRate: '', shoulderRate: '', offPeakRate: '', controlledLoad: '', monthlyPrice: '', discount: '', extras: '' });
    setShowCompare(false);
    setLoading(true);
    setStatus('');
    setFollowUps([]);

    try {
      const { analysis, costUSD } = await comparePlan(service, bills, text, setStatus);
      const { cleanText, followUps: compFollowUps } = extractFollowUps(analysis);
      const assistantMsg: ChatMessage = {
        id: nextId(), role: 'assistant', text: cleanText,
        timestamp: Date.now(), followUps: compFollowUps,
      };
      setMessages(prev => [...prev, assistantMsg]);
      setFollowUps(compFollowUps);
      setStatus(`~$${costUSD.toFixed(4)}`);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: nextId(), role: 'assistant',
        text: `❌ ${(err as Error).message}`, timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [loading, buildCompareText, service, bills]);

  // #5: Clear chat
  const handleClear = useCallback(() => {
    clearChatHistory(service.id);
    setMessages([]);
    setFollowUps([]);
    setStatus('');
    setRatings({});
  }, [service.id]);

  // Export chat to clipboard
  const handleExport = useCallback(async () => {
    const lines = messages.map(m => {
      const role = m.role === 'user' ? '👤 You' : '✨ AI';
      return `${role}:\n${m.text}\n`;
    });
    const text = `Chat — ${service.nickname}\n${'═'.repeat(40)}\n\n${lines.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [messages, service.nickname]);

  // Rate an AI response
  const handleRate = useCallback((msgId: string, rating: 'up' | 'down') => {
    setRatings(prev => {
      const next = { ...prev };
      if (next[msgId] === rating) { delete next[msgId]; } // toggle off
      else { next[msgId] = rating; }
      return next;
    });
  }, []);

  // Check if compare form has at least one filled field
  const compareHasData = useMemo(() => {
    return Object.values(compareForm).some(v => v.trim() !== '');
  }, [compareForm]);

  if (!open) return null;

  const unit = USAGE_UNITS[service.category] || '';
  const profile = buildUsageProfile(service, bills);

  return (
    <div className="ai-chat-panel">
      {/* Header */}
      <div className="ai-chat-header">
        <div className="ai-chat-header__left">
          <span className="ai-chat-icon">✨</span>
          <span className="ai-chat-title">Ask AI</span>
        </div>
        <div className="ai-chat-header__right">
          {/* Export button */}
          {messages.length > 0 && (
            <button className="ai-chat-clear" onClick={handleExport} title={copied ? 'Copied!' : 'Copy chat'}>
              {copied ? '✅' : '📋'}
            </button>
          )}
          {/* #5: Clear button */}
          {messages.length > 0 && (
            <button className="ai-chat-clear" onClick={handleClear} title="Clear chat">🗑</button>
          )}
          <button className="ai-chat-close" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Messages area */}
      <div className="ai-chat-messages" ref={scrollRef}>
        {/* Welcome message */}
        {messages.length === 0 && (
          <div className="ai-chat-welcome">
            <div className="ai-chat-bubble ai-chat-bubble--assistant">
              <span className="ai-chat-avatar">✨</span>
              <div className="ai-chat-bubble__text">
                {bills.length > 0
                  ? `I have ${bills.length} bill${bills.length > 1 ? 's' : ''} for your ${service.nickname} service. Ask me anything — costs, usage patterns, rate changes, tips to save.`
                  : `No bills uploaded yet for ${service.nickname}. Upload some bills first so I can analyse them.`
                }
              </div>
            </div>

            {/* Usage profile summary */}
            {profile && isUsage && (
              <div className="ai-chat-profile">
                <div className="ai-chat-profile__row">
                  <span className="muted">Avg daily:</span>
                  <strong>{profile.avgDaily.toFixed(1)} {unit}/day</strong>
                </div>
                <div className="ai-chat-profile__row">
                  <span className="muted">Avg cost:</span>
                  <strong>{money(Math.round(profile.avgDailyCost))}/day</strong>
                </div>
                <div className="ai-chat-profile__row">
                  <span className="muted">Blended rate:</span>
                  <strong>{profile.blendedRate.toFixed(1)} c/{unit}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Conversation */}
        {messages.map(msg => (
          <div key={msg.id} className={`ai-chat-bubble ai-chat-bubble--${msg.role}`}>
            {msg.role === 'assistant' && <span className="ai-chat-avatar">✨</span>}
            <div className="ai-chat-bubble__text">
              <MarkdownContent text={msg.text} />
              {/* Thumbs up/down for AI responses */}
              {msg.role === 'assistant' && !msg.text.startsWith('❌') && (
                <div className="ai-chat-rating">
                  <button
                    className={`ai-chat-rate ${ratings[msg.id] === 'up' ? 'ai-chat-rate--active' : ''}`}
                    onClick={() => handleRate(msg.id, 'up')}
                    title="Good answer"
                  >👍</button>
                  <button
                    className={`ai-chat-rate ${ratings[msg.id] === 'down' ? 'ai-chat-rate--active' : ''}`}
                    onClick={() => handleRate(msg.id, 'down')}
                    title="Bad answer"
                  >👎</button>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Loading indicator — #6: Better status */}
        {loading && (
          <div className="ai-chat-bubble ai-chat-bubble--assistant">
            <span className="ai-chat-avatar">✨</span>
            <div className="ai-chat-bubble__text ai-chat-thinking">
              <span className="dot" /><span className="dot" /><span className="dot" />
              {status && <span className="ai-chat-status">{status}</span>}
            </div>
          </div>
        )}
      </div>

      {/* Bottom area — suggestions, compare, follow-ups, input */}
      <div className="ai-chat-bottom">
        {/* Plan compare panel — #3: Structured form */}
        {showCompare && (
          <div className="ai-chat-compare">
            <div className="ai-chat-compare__header">
              <strong>📊 Compare new plan</strong>
              <button className="ai-chat-close" onClick={() => setShowCompare(false)} style={{ fontSize: '0.8rem' }}>✕</button>
            </div>
            <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 0 8px' }}>
              Enter the new plan details. AI will calculate your actual cost on both plans.
            </p>

            <div className="ai-chat-compare__form">
              <div className="ai-chat-compare__row">
                <input className="input input--sm" placeholder="Provider" value={compareForm.provider}
                  onChange={e => setCompareForm(f => ({ ...f, provider: e.target.value }))} />
                <input className="input input--sm" placeholder="Plan name" value={compareForm.planName}
                  onChange={e => setCompareForm(f => ({ ...f, planName: e.target.value }))} />
              </div>
              {isUsage ? (
                <>
                  <div className="ai-chat-compare__row">
                    <input className="input input--sm" placeholder="Supply charge (c/day)" value={compareForm.supplyCharge}
                      onChange={e => setCompareForm(f => ({ ...f, supplyCharge: e.target.value }))} />
                    <input className="input input--sm" placeholder="Peak rate (c/kWh)" value={compareForm.peakRate}
                      onChange={e => setCompareForm(f => ({ ...f, peakRate: e.target.value }))} />
                  </div>
                  <div className="ai-chat-compare__row">
                    <input className="input input--sm" placeholder="Shoulder rate" value={compareForm.shoulderRate}
                      onChange={e => setCompareForm(f => ({ ...f, shoulderRate: e.target.value }))} />
                    <input className="input input--sm" placeholder="Off-peak rate" value={compareForm.offPeakRate}
                      onChange={e => setCompareForm(f => ({ ...f, offPeakRate: e.target.value }))} />
                  </div>
                  <input className="input input--sm" placeholder="Controlled load / other rate" value={compareForm.controlledLoad}
                    onChange={e => setCompareForm(f => ({ ...f, controlledLoad: e.target.value }))} style={{ width: '100%' }} />
                </>
              ) : (
                <input className="input input--sm" placeholder="Monthly price" value={compareForm.monthlyPrice}
                  onChange={e => setCompareForm(f => ({ ...f, monthlyPrice: e.target.value }))} style={{ width: '100%' }} />
              )}
              <input className="input input--sm" placeholder="Discount (e.g. 10% pay-on-time)" value={compareForm.discount}
                onChange={e => setCompareForm(f => ({ ...f, discount: e.target.value }))} style={{ width: '100%' }} />
              <input className="input input--sm" placeholder="Other details / notes" value={compareForm.extras}
                onChange={e => setCompareForm(f => ({ ...f, extras: e.target.value }))} style={{ width: '100%' }} />
            </div>

            <button
              className="btn btn--primary btn--small"
              style={{ marginTop: '6px', width: '100%' }}
              onClick={handleCompare}
              disabled={!compareHasData || loading}
            >
              ⚡ Compare against my usage
            </button>
          </div>
        )}

        {/* #9: Follow-up suggestions from AI */}
        {!showCompare && !loading && followUps.length > 0 && (
          <div className="ai-chat-suggestions ai-chat-followups">
            <span className="ai-chat-followup-label">Follow up:</span>
            {followUps.map((f, i) => (
              <button key={`fu-${i}`} className="ai-chat-suggestion ai-chat-suggestion--followup" onClick={() => sendMessage(f)}>
                {f}
              </button>
            ))}
          </div>
        )}

        {/* Suggestions — always visible */}
        {!showCompare && !loading && suggestions.length > 0 && followUps.length === 0 && (
          <div className="ai-chat-suggestions">
            {suggestionsLoading ? (
              <span className="muted" style={{ fontSize: '0.75rem' }}>Loading suggestions...</span>
            ) : (
              suggestions.map((s, i) => (
                <button key={i} className="ai-chat-suggestion" onClick={() => sendMessage(s)}>
                  {s}
                </button>
              ))
            )}
          </div>
        )}

        {/* Compare button */}
        {!showCompare && (
          <button
            className="ai-chat-compare-btn"
            onClick={() => setShowCompare(true)}
          >
            📊 Compare new plan against my usage
          </button>
        )}

        {/* Input */}
        <div className="ai-chat-input">
          <input
            ref={inputRef}
            className="input"
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendMessage(input); }}
            placeholder="Ask about your service..."
            disabled={loading}
            style={{ flex: 1, fontSize: '0.85rem' }}
          />
          <button
            className="ai-chat-send"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || loading}
          >
            ↑
          </button>
        </div>

        {/* Cost indicator */}
        {status && !loading && (
          <div className="ai-chat-cost">{status}</div>
        )}
      </div>
    </div>
  );
}

// ─── #7: Rich Markdown Rendering ──────────────────────────

/** Renders markdown text as React elements — supports tables, lists, headings, bold, code */
function MarkdownContent({ text }: { text: string }) {
  const elements = useMemo(() => parseMarkdown(text), [text]);
  return <>{elements}</>;
}

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Table — starts with | and next line is |---|
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s-:|]+\|/.test(lines[i + 1]!)) {
      const tableLines: string[] = [line];
      i++; // skip header
      i++; // skip separator
      while (i < lines.length && lines[i]!.startsWith('|')) {
        tableLines.push(lines[i]!);
        i++;
      }
      result.push(<MarkdownTable key={key++} headerLine={tableLines[0]!} bodyLines={tableLines.slice(1)} />);
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const content = headingMatch[2]!;
      const Tag = `h${Math.min(level + 1, 6)}` as keyof React.JSX.IntrinsicElements;
      result.push(<Tag key={key++} className="ai-md-heading">{inlineFormat(content)}</Tag>);
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*•]\s+/, ''));
        i++;
      }
      result.push(
        <ul key={key++} className="ai-md-list">
          {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      result.push(
        <ol key={key++} className="ai-md-list">
          {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
        </ol>
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      result.push(<hr key={key++} className="ai-md-hr" />);
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph
    result.push(<p key={key++} className="ai-md-p">{inlineFormat(line)}</p>);
    i++;
  }

  return result;
}

/** Render a markdown table */
function MarkdownTable({ headerLine, bodyLines }: { headerLine: string; bodyLines: string[] }) {
  const parseCells = (line: string) =>
    line.split('|').slice(1, -1).map(c => c.trim());

  const headers = parseCells(headerLine);
  const rows = bodyLines.map(parseCells);

  return (
    <div className="ai-md-table-wrap">
      <table className="ai-md-table">
        <thead>
          <tr>{headers.map((h, i) => <th key={i}>{inlineFormat(h)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{inlineFormat(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline formatting: **bold**, `code`, *italic* */
function inlineFormat(text: string): React.ReactNode[] {
  // Split on **bold**, `code`, and *italic*
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="ai-md-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
