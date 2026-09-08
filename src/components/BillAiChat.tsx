/**
 * BillAiChat — floating AI chat panel for asking questions about bills.
 *
 * Works with any service category. Shows:
 * - Welcome message
 * - Suggested questions (2 static + up to 3 dynamic from AI)
 * - Free-text input
 * - Conversation history
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { Service, Bill } from '../types';
import {
  askQuestion,
  generateSuggestions,
  comparePlan,
  buildUsageProfile,
  type ChatMessage,
} from '../platform/ai-chat';
import { money, USAGE_UNITS, USAGE_CATEGORIES } from '../types';

interface Props {
  service: Service;
  bills: Bill[];
  open: boolean;
  onClose: () => void;
}

let _msgId = 0;
const nextId = () => `msg_${++_msgId}_${Date.now()}`;

export function BillAiChat({ service, bills, open, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [compareInput, setCompareInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', text: text.trim(), timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    setStatus('');

    try {
      const { answer, costUSD } = await askQuestion(service, bills, text, messages, setStatus);
      const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', text: answer, timestamp: Date.now() };
      setMessages(prev => [...prev, assistantMsg]);
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

  const handleCompare = useCallback(async () => {
    if (!compareInput.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: nextId(), role: 'user',
      text: `🔄 Compare plan:\n${compareInput.trim()}`, timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);
    setCompareInput('');
    setShowCompare(false);
    setLoading(true);
    setStatus('');

    try {
      const { analysis, costUSD } = await comparePlan(service, bills, compareInput, setStatus);
      const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', text: analysis, timestamp: Date.now() };
      setMessages(prev => [...prev, assistantMsg]);
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
  }, [loading, compareInput, service, bills]);

  if (!open) return null;

  const unit = USAGE_UNITS[service.category] || '';
  const isUsage = USAGE_CATEGORIES.has(service.category);
  const profile = buildUsageProfile(service, bills);

  return (
    <div className="ai-chat-panel">
      {/* Header */}
      <div className="ai-chat-header">
        <div className="ai-chat-header__left">
          <span className="ai-chat-icon">✨</span>
          <span className="ai-chat-title">Ask AI</span>
        </div>
        <button className="ai-chat-close" onClick={onClose} title="Close">✕</button>
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
            <div className="ai-chat-bubble__text">{formatMessageText(msg.text)}</div>
          </div>
        ))}

        {/* Loading indicator */}
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

      {/* Bottom area — suggestions, compare button, input */}
      <div className="ai-chat-bottom">
        {/* Plan compare panel */}
        {showCompare && (
          <div className="ai-chat-compare">
            <div className="ai-chat-compare__header">
              <strong>📊 Compare new plan</strong>
              <button className="ai-chat-close" onClick={() => setShowCompare(false)} style={{ fontSize: '0.8rem' }}>✕</button>
            </div>
            <p className="muted" style={{ fontSize: '0.78rem', margin: '4px 0 8px' }}>
              Paste the plan details — rates, supply charge, discounts, plan name. The AI will calculate your actual cost on both plans.
            </p>
            <textarea
              className="input"
              value={compareInput}
              onChange={e => setCompareInput(e.target.value)}
              placeholder={isUsage
                ? `e.g. Plan: ValueSaver\nSupply: 90c/day\nPeak: 55c/kWh\nOff-peak: 20c/kWh\n10% pay-on-time discount`
                : `e.g. Plan: Basic 50\nMonthly: $59/month\nSpeed: 50/20 Mbps\nNo lock-in`
              }
              rows={4}
              style={{ fontSize: '0.82rem', resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />
            <button
              className="btn btn--primary btn--small"
              style={{ marginTop: '6px', width: '100%' }}
              onClick={handleCompare}
              disabled={!compareInput.trim() || loading}
            >
              ⚡ Compare against my usage
            </button>
          </div>
        )}

        {/* Suggestions — always visible (not just when no messages) */}
        {!showCompare && !loading && suggestions.length > 0 && (
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

/** Simple markdown-like formatting for AI responses */
function formatMessageText(text: string): (string | React.ReactElement)[] {
  // Split into lines and process
  const lines = text.split('\n');
  const elements: (string | React.ReactElement)[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) elements.push(<br key={`br-${i}`} />);

    // Bold **text**
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]!;
      if (part.startsWith('**') && part.endsWith('**')) {
        elements.push(<strong key={`${i}-${j}`} style={{ fontWeight: 600 }}>{part.slice(2, -2)}</strong>);
      } else {
        elements.push(part);
      }
    }
  }

  return elements;
}
