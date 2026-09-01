import { useState, useEffect, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../store/AppContext';
import { parseDocument } from '../platform/document-parser';
import { extractText } from '../platform/document-reader';
import { llmParse, type LlmParseResult } from '../platform/llm-parser';
import { getApiKey } from '../platform/storage';
import type { Service, Bill, Document as Doc, TariffEntry } from '../types';
import { money, humanise, formatDate, monthlyAmount, FREQUENCY_LABELS, DOC_TYPE_LABELS, today, USAGE_CATEGORIES, USAGE_UNITS } from '../types';
import { forecastNextBill, type ForecastResult } from '../platform/forecast';

interface Props {
  serviceId: string;
  onNavigate: (page: string, params?: Record<string, string>) => void;
  onBack: () => void;
}

type Tab = 'overview' | 'bills' | 'documents';

interface PendingChange {
  id: string;
  type: 'deleteBill' | 'other';
  description: string;
  apply: () => Promise<void>;
}

export function ServiceDetailScreen({ serviceId, onNavigate, onBack }: Props) {
  const app = useApp();
  const [svc, setSvc] = useState<Service | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [tab, setTab] = useState<Tab>('overview');

  // Pending changes system
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [showConfirmBar, setShowConfirmBar] = useState(false);

  const [reparsing, setReparsing] = useState(false);
  const [reparseStatus, setReparseStatus] = useState('');
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [showForecast, setShowForecast] = useState(false);

  const load = useCallback(async () => {
    const s = app.services.find(s => s.id === serviceId);
    if (s) setSvc(s);
    setBills(await app.getBills(serviceId));
    setDocs(await app.getDocs(serviceId));
    setPendingChanges([]);
    setShowConfirmBar(false);
  }, [serviceId, app]);

  useEffect(() => { load(); }, [load]);

  /** Re-parse all documents with the current parser and rebuild tariff history */
  const handleReparse = async () => {
    if (!svc) return;
    setReparsing(true);
    setReparseStatus('Starting...');

    try {
      const allDocs = await app.getDocs(serviceId);
      const apiKey = getApiKey();
      const allEntries: TariffEntry[] = [];
      let summary = '';

      for (let i = 0; i < allDocs.length; i++) {
        const doc = allDocs[i]!;
        setReparseStatus(`Re-extracting ${doc.fileName || doc.title} (${i + 1}/${allDocs.length})...`);

        // Re-extract text from stored file (uses improved text extraction)
        let text = doc.ocrText || '';
        const storedFile = await app.loadFile(doc.id);
        if (storedFile) {
          try {
            const blob = new Blob([storedFile.bytes], { type: storedFile.mimeType });
            const file = new File([blob], storedFile.fileName || doc.fileName, { type: storedFile.mimeType });
            text = await extractText(file, p => {
              setReparseStatus(`${p.status} — ${doc.fileName} (${i + 1}/${allDocs.length})`);
            });
            // Update stored ocrText with improved extraction
            await app.saveDoc({ ...doc, ocrText: text });
          } catch (e) {
            console.warn('[Re-parse] Failed to re-extract text for', doc.fileName, e);
          }
        }

        if (!text) continue;

        let result;
        if (apiKey) {
          setReparseStatus(`Analysing ${doc.fileName || doc.title} with Claude (${i + 1}/${allDocs.length})...`);
          const llmResult = await llmParse(text, apiKey, status => {
            setReparseStatus(`${status} (${i + 1}/${allDocs.length})`);
          });
          if (llmResult) {
            result = llmResult;
            if ((llmResult as LlmParseResult).summary && !summary) {
              summary = (llmResult as LlmParseResult).summary;
            }
          } else {
            result = parseDocument(text);
          }
        } else {
          result = parseDocument(text);
        }

        // Build tariff entries from this doc's insights
        const effectiveDate = doc.docDate || today();
        for (const ins of result.insights) {
          if (['date'].includes(ins.section)) continue;
          // Deduplicate: skip if same label already exists (case-insensitive)
          if (allEntries.some(e => e.label.toLowerCase() === ins.label.toLowerCase())) continue;
          allEntries.push({
            id: uuid(),
            label: ins.label,
            value: ins.value,
            section: ins.section as TariffEntry['section'],
            effectiveDate,
            source: 'parsed',
            docId: doc.id,
          });
        }
      }

      // Update service with fresh tariff history
      setReparseStatus('Saving...');
      const updatedSvc: Service = {
        ...svc,
        tariffHistory: allEntries,
        summary: summary || svc.summary || '',
        updatedAt: today(),
      };

      // Update amount from the main cost field (premium, plan price, rent, etc.)
      const AMOUNT_LABELS = [
        'Total premium', 'Premium', 'Car premium',
        'Plan price', 'Subscription price',
        'Rent amount', 'Repayment amount',
        'Strata levy', 'Rates amount',
        'Registration cost', 'CTP premium',
        'Membership fee', 'Gym membership',
        'Account fee', 'Transport pass',
      ];
      const amountEntry = allEntries.find(e => AMOUNT_LABELS.includes(e.label));
      if (amountEntry) {
        const amount = Math.round(parseFloat(amountEntry.value.replace(/[$,\/a-zA-Z]/g, '').trim()) * 100);
        if (amount > 0) updatedSvc.amountCents = amount;
      }

      await app.saveService(updatedSvc);
      await app.reload();
      await load();
      setReparseStatus('Done!');
      setTimeout(() => setReparseStatus(''), 2000);
    } catch (err) {
      setReparseStatus(`Error: ${(err as Error).message}`);
    } finally {
      setReparsing(false);
    }
  };

  if (!svc) return <div className="loading"><div className="spinner" /></div>;

  // ─── Add a pending change ────────────────────────────────

  const addPending = (change: Omit<PendingChange, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setPendingChanges(prev => [...prev, { ...change, id }]);
    setShowConfirmBar(true);
  };

  const removePending = (id: string) => {
    setPendingChanges(prev => {
      const next = prev.filter(c => c.id !== id);
      if (next.length === 0) setShowConfirmBar(false);
      return next;
    });
  };

  const applyAllPending = async () => {
    for (const change of pendingChanges) {
      await change.apply();
    }
    await load();
  };

  const discardAllPending = () => {
    setPendingChanges([]);
    setShowConfirmBar(false);
  };

  // ─── Handlers ──────────────────────────────────────────────

  const handleDeleteBill = (billId: string, periodStart: string) => {
    addPending({
      type: 'deleteBill',
      description: `Delete bill from ${formatDate(periodStart)}`,
      apply: async () => {
        await app.deleteBill(billId);
      },
    });
  };

  const handleDeleteService = async () => {
    if (confirm('Delete this service and all its bills and documents?')) {
      await app.deleteService(serviceId);
      onBack();
    }
  };

  // ─── Tariff history (sorted newest first) ─────────────────
  const tariffHistory = (svc.tariffHistory || [])
    .sort((a, b) => (b.effectiveDate || '').localeCompare(a.effectiveDate || ''));

  const daysUntil = (date: string) => {
    if (!date) return null;
    return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
  };

  /** Render a tariff/contract/clause section with timeline */
  const renderTariffSection = (section: string, icon: string, title: string) => {
    const entries = tariffHistory.filter(t => t.section === section);
    // Group by label — current (no endDate) first, then ended
    const currentEntries = entries.filter(e => !e.endDate);
    const endedEntries = entries.filter(e => e.endDate);

    if (currentEntries.length === 0 && endedEntries.length === 0) {
      // Don't show empty coverage section for non-insurance services
      if (section === 'coverage') return null;
      return (
        <div className="card">
          <h3>{icon} {title}</h3>
          <p className="muted">No data yet. Upload a document to extract {title.toLowerCase()}.</p>
        </div>
      );
    }

    return (
      <div className="card">
        <h3>{icon} {title}</h3>
        {/* Current rates */}
        {currentEntries.map(entry => {
          // Color-code coverage values
          const lv = entry.value.toLowerCase();
          const coverageColor = section === 'coverage'
            ? /^(?:included|covered)$/i.test(lv) ? 'var(--color-ok, #4caf50)'
              : /^(?:restricted)$/i.test(lv) ? 'var(--color-warn, #ff9800)'
              : /(?:not\s*(?:included|covered)|excluded)$/i.test(lv) ? 'var(--color-bad, #f44336)'
              : undefined
            : undefined;

          // Check if there's a historical (ended) entry with same label → means it changed
          const previousEntry = endedEntries.find(e => e.label === entry.label);

          return (
            <div key={entry.id} className="tariff-entry">
              <div className="tariff-entry__header">
                <span className="tariff-entry__label">{entry.label}</span>
                <span className="tariff-entry__value" style={coverageColor ? { color: coverageColor } : undefined}>{entry.value}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="tariff-entry__date">
                  Since {formatDate(entry.effectiveDate)}
                </span>
                {previousEntry && (
                  <span style={{ fontSize: '0.72rem', color: 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    ⚡ was <span style={{ textDecoration: 'line-through' }}>{previousEntry.value}</span>
                    <span className="muted">({formatDate(previousEntry.effectiveDate)} – {formatDate(previousEntry.endDate!)})</span>
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {/* Historical (ended) rates */}
        {endedEntries.length > 0 && (
          <details style={{ marginTop: '8px' }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
              📜 History ({endedEntries.length} previous)
            </summary>
            <div className="tariff-timeline" style={{ marginTop: '6px' }}>
              {endedEntries.map(entry => (
                <div key={entry.id} className="tariff-entry tariff-entry--ended">
                  <div className="tariff-entry__header">
                    <span className="tariff-entry__label">{entry.label}</span>
                    <span className="tariff-entry__value">{entry.value}</span>
                  </div>
                  <span className="tariff-entry__date">
                    {formatDate(entry.effectiveDate)} → {formatDate(entry.endDate!)}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="stack">
      {/* Header */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn" onClick={onBack}>← Back</button>
        <div className="row">
          <button className="btn btn--outline" onClick={() => onNavigate('edit-service', { id: serviceId })}>Edit</button>
          <button className="btn btn--danger" onClick={handleDeleteService}>Delete</button>
        </div>
      </div>

      <div className="service-header">
        <h2>{svc.nickname}</h2>
        <div className="row">
          <span className="tag">{humanise(svc.category)}</span>
          <span className="tag tag--status">{svc.status}</span>
        </div>
        <div className="service-header__cost">
          {USAGE_CATEGORIES.has(svc.category) && svc.billAvgMonthlyCents && svc.billAvgMonthlyCents > 0 ? (
            <>
              <span className="money big">~{money(svc.billAvgMonthlyCents)}</span>
              <span className="muted">/ mo avg</span>
              {svc.billCount && <span className="muted">({svc.billCount} bills)</span>}
            </>
          ) : (
            <>
              <span className="money big">{money(svc.amountCents)}</span>
              <span className="muted">/ {FREQUENCY_LABELS[svc.billingFrequency]?.toLowerCase()}</span>
              <span className="muted">({money(monthlyAmount(svc.amountCents, svc.billingFrequency))}/mo)</span>
            </>
          )}
        </div>
        {svc.provider && <span className="muted">{svc.provider}{svc.planName ? ` — ${svc.planName}` : ''}</span>}
      </div>

      {/* Key dates */}
      {(svc.startDate || svc.benefitEndDate || svc.contractEndDate) && (
        <div className="card">
          <h3>Key Dates</h3>
          <div className="dates-grid">
            {svc.startDate && <div className="fact-row"><span className="fact-label">Start</span><span className="fact-value">{formatDate(svc.startDate)}</span></div>}
            {svc.benefitEndDate && (
              <div className="fact-row">
                <span className="fact-label">Benefit ends</span>
                <span className={`fact-value ${(daysUntil(svc.benefitEndDate) ?? 999) <= 30 ? 'text-warn' : ''}`}>
                  {formatDate(svc.benefitEndDate)}
                  {daysUntil(svc.benefitEndDate) !== null && ` (${daysUntil(svc.benefitEndDate)} days)`}
                </span>
              </div>
            )}
            {svc.contractEndDate && (
              <div className="fact-row">
                <span className="fact-label">Contract ends</span>
                <span className={`fact-value ${(daysUntil(svc.contractEndDate) ?? 999) <= 30 ? 'text-danger' : ''}`}>
                  {formatDate(svc.contractEndDate)}
                  {daysUntil(svc.contractEndDate) !== null && ` (${daysUntil(svc.contractEndDate)} days)`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {(['overview', 'bills', 'documents'] as Tab[]).map(t => (
          <button key={t} className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : t === 'bills' ? `Bills (${bills.length})` : `Documents (${docs.length})`}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="stack">
          {/* Prominent upload button on overview */}
          <div className="row" style={{ gap: '8px' }}>
            <button
              className="btn btn--primary btn--lg"
              style={{ flex: 1, fontSize: '1.1rem', padding: '14px' }}
              onClick={() => onNavigate('import-doc', { serviceId })}
            >
              📄 Upload &amp; Parse Document
            </button>
            {docs.length > 0 && (
              <button
                className="btn btn--outline"
                style={{ padding: '14px', whiteSpace: 'nowrap' }}
                onClick={handleReparse}
                disabled={reparsing}
                title="Re-analyse all uploaded documents with the latest parser"
              >
                {reparsing ? '⏳' : '🔄'} Re-parse
              </button>
            )}
          </div>
          {reparseStatus && (
            <p className="muted" style={{ textAlign: 'center', margin: '-4px 0' }}>{reparseStatus}</p>
          )}

          {/* ── AI Summary ──────────────────────────────────── */}
          {svc.summary && (
            <div className="card card--summary">
              <h3>📝 Summary</h3>
              <p style={{ lineHeight: 1.6, margin: 0 }}>{svc.summary}</p>
            </div>
          )}

          {/* ── Next Bill Forecast ──────────────────────────── */}
          <div className="card" style={{ border: showForecast && forecast ? '1px solid var(--accent)' : undefined }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>🔮 Next Bill Forecast</h3>
              <button
                className="btn btn--primary btn--small"
                onClick={() => {
                  const result = forecastNextBill(svc, bills);
                  setForecast(result);
                  setShowForecast(true);
                }}
              >
                {showForecast ? '🔄 Recalculate' : '📊 Calculate'}
              </button>
            </div>

            {showForecast && !forecast && (
              <p className="muted" style={{ marginTop: '12px' }}>
                Not enough data to forecast. Upload bills with usage data and tariff rates first.
              </p>
            )}

            {showForecast && forecast && (() => {
              const conf = forecast.confidence;
              const confIcon = conf === 'high' ? '🟢' : conf === 'medium' ? '🟡' : '🔴';
              const confLabel = conf === 'high' ? 'High confidence' : conf === 'medium' ? 'Medium confidence' : 'Low confidence';

              return (
                <div style={{ marginTop: '16px' }}>
                  {/* Big number */}
                  <div style={{ textAlign: 'center', padding: '16px 0' }}>
                    <div style={{ fontSize: '2.2rem', fontWeight: 700, color: 'var(--accent)' }}>
                      {money(forecast.estimatedCents)}
                    </div>
                    {forecast.estimatedUsage != null && (
                      <div style={{ fontSize: '1rem', color: 'var(--text)', marginTop: '4px' }}>
                        ~{forecast.estimatedUsage.toLocaleString()} {forecast.usageUnit} over {forecast.estimatedDays} days
                      </div>
                    )}
                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: '4px' }}>
                      {formatDate(forecast.periodStart)} — {formatDate(forecast.periodEnd)}
                    </div>
                    <div style={{ fontSize: '0.8rem', marginTop: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <span>{confIcon}</span>
                      <span className="muted">{confLabel}</span>
                    </div>
                  </div>

                  {/* Comparison to last bill */}
                  {forecast.vsLastBill && (
                    <div style={{
                      textAlign: 'center', padding: '10px', borderRadius: '8px',
                      background: forecast.vsLastBill.diffCents > 0
                        ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                      marginBottom: '12px',
                    }}>
                      <span style={{
                        fontWeight: 600,
                        color: forecast.vsLastBill.diffCents > 0 ? '#ef4444' : '#22c55e',
                      }}>
                        {forecast.vsLastBill.diffCents > 0 ? '📈' : '📉'}{' '}
                        {forecast.vsLastBill.diffCents > 0 ? '+' : ''}
                        {money(forecast.vsLastBill.diffCents)}
                        {' '}({forecast.vsLastBill.diffPct > 0 ? '+' : ''}{forecast.vsLastBill.diffPct.toFixed(1)}%)
                      </span>
                      <span className="muted"> vs last bill ({money(forecast.vsLastBill.lastCents)})</span>
                    </div>
                  )}

                  {/* Breakdown */}
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px' }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: '0.9rem', color: 'var(--muted)' }}>Breakdown</h4>
                    {forecast.breakdown.map((line, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '6px 0', borderBottom: i < forecast.breakdown.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined,
                      }}>
                        <div>
                          <span style={{ fontWeight: 500 }}>{line.label}</span>
                          <span className="muted" style={{ display: 'block', fontSize: '0.78rem' }}>{line.detail}</span>
                        </div>
                        <span style={{
                          fontWeight: 600, whiteSpace: 'nowrap',
                          color: line.amountCents < 0 ? '#22c55e' : 'var(--text)',
                        }}>
                          {line.amountCents < 0 ? '-' : ''}{money(Math.abs(line.amountCents))}
                        </span>
                      </div>
                    ))}
                    {/* Total line */}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 0 0', borderTop: '2px solid rgba(255,255,255,0.1)', marginTop: '4px',
                    }}>
                      <span style={{ fontWeight: 700 }}>Estimated Total</span>
                      <span style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--accent)' }}>
                        {money(forecast.estimatedCents)}
                      </span>
                    </div>
                  </div>

                  {/* Method explanation */}
                  <p className="muted" style={{ fontSize: '0.78rem', marginTop: '10px', textAlign: 'center' }}>
                    {forecast.method}
                  </p>
                </div>
              );
            })()}
          </div>

          {/* ── Coverage & Benefits (insurance) ────────────── */}
          {renderTariffSection('coverage', '🛡️', 'Coverage & Benefits')}

          {/* ── Tariff History ─────────────────────────────── */}
          {renderTariffSection('tariff', '📊', 'Tariffs & Rates')}
          {renderTariffSection('contract', '📋', 'Contract Terms')}
          {renderTariffSection('clause', '📌', 'Important Clauses')}

          {/* Account identifiers */}
          {(svc.accountNumber || svc.meterIdentifier || (tariffHistory.filter(t => t.section === 'identifier').length > 0)) && (
            <div className="card">
              <h3>🔑 Identifiers</h3>
              {svc.accountNumber && (
                <div className="fact-row"><span className="fact-label">Account #</span><span className="fact-value">{svc.accountNumber}</span></div>
              )}
              {svc.meterIdentifier && (
                <div className="fact-row"><span className="fact-label">Meter ID</span><span className="fact-value">{svc.meterIdentifier}</span></div>
              )}
              {tariffHistory.filter(t => t.section === 'identifier' && t.label !== 'Account number' && t.label !== 'NMI' && t.label !== 'MIRN').map(t => (
                <div key={t.id} className="fact-row">
                  <span className="fact-label">{t.label}</span>
                  <span className="fact-value">{t.value}</span>
                </div>
              ))}
            </div>
          )}

          {svc.notes && (
            <div className="card">
              <h3>Notes</h3>
              <p>{svc.notes}</p>
            </div>
          )}
        </div>
      )}

      {tab === 'bills' && (() => {
        const isUsageSvc = svc ? USAGE_CATEGORIES.has(svc.category) : false;
        const unit = svc ? USAGE_UNITS[svc.category] || '' : '';
        const sortedBills = [...bills].sort((a, b) => (a.periodStart || '').localeCompare(b.periodStart || ''));
        const usageBills = sortedBills.filter(b => b.usageQuantity && b.usageQuantity > 0);
        const maxUsage = usageBills.length > 0 ? Math.max(...usageBills.map(b => b.usageQuantity!)) : 0;
        const maxCost = sortedBills.length > 0 ? Math.max(...sortedBills.map(b => b.totalCents)) : 0;

        return (
          <div className="stack">
            <button className="btn btn--primary" onClick={() => onNavigate('add-bill', { serviceId })}>+ Add Bill</button>

            {/* ─── Usage chart (for electricity/gas/water) ─── */}
            {isUsageSvc && usageBills.length >= 2 && (
              <div className="card">
                <h3>📈 Usage History ({unit})</h3>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '140px', marginTop: '12px' }}>
                  {usageBills.map(b => {
                    const pct = maxUsage > 0 ? (b.usageQuantity! / maxUsage) * 100 : 0;
                    const periodLabel = b.periodStart
                      ? new Date(b.periodStart).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
                      : '?';
                    return (
                      <div key={b.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600, marginBottom: '4px' }}>
                          {b.usageQuantity!.toLocaleString()}
                        </span>
                        <div style={{
                          width: '100%', maxWidth: '48px',
                          height: `${Math.max(pct, 4)}%`,
                          background: 'linear-gradient(180deg, #3b82f6, #1d4ed8)',
                          borderRadius: '4px 4px 0 0',
                          transition: 'height 0.3s',
                        }} />
                        <span style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: '4px', whiteSpace: 'nowrap' }}>
                          {periodLabel}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {/* Daily average */}
                {usageBills.length > 0 && (() => {
                  const totalQty = usageBills.reduce((s, b) => s + (b.usageQuantity || 0), 0);
                  const totalDays = usageBills.reduce((s, b) => s + (b.usageDays || 0), 0);
                  const avg = totalDays > 0 ? (totalQty / totalDays).toFixed(1) : null;
                  return avg ? (
                    <p className="muted" style={{ textAlign: 'center', marginTop: '8px', fontSize: '0.85rem' }}>
                      Average: <strong>{avg} {unit}/day</strong>
                    </p>
                  ) : null;
                })()}
              </div>
            )}

            {/* ─── Cost chart ─── */}
            {sortedBills.length >= 2 && (
              <div className="card">
                <h3>💰 Cost History</h3>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '120px', marginTop: '12px' }}>
                  {sortedBills.map(b => {
                    const pct = maxCost > 0 ? (b.totalCents / maxCost) * 100 : 0;
                    const periodLabel = b.periodStart
                      ? new Date(b.periodStart).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
                      : '?';
                    return (
                      <div key={b.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600, marginBottom: '4px' }}>
                          {money(b.totalCents, true)}
                        </span>
                        <div style={{
                          width: '100%', maxWidth: '48px',
                          height: `${Math.max(pct, 4)}%`,
                          background: 'linear-gradient(180deg, #f59e0b, #d97706)',
                          borderRadius: '4px 4px 0 0',
                          transition: 'height 0.3s',
                        }} />
                        <span style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: '4px', whiteSpace: 'nowrap' }}>
                          {periodLabel}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ─── Bill list ─── */}
            {bills.length === 0 ? (
              <div className="empty"><p>No bills yet. Import a document or add a bill manually.</p></div>
            ) : (
              sortedBills.reverse().map(b => (
                <div key={b.id} className="card bill-card">
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{formatDate(b.periodStart)} — {formatDate(b.periodEnd)}</span>
                      {b.usageDays && <span className="muted" style={{ marginLeft: '8px' }}>({b.usageDays} days)</span>}
                    </div>
                    <span className="money" style={{ fontSize: '1.1rem' }}>{money(b.totalCents)}</span>
                  </div>
                  {b.usageQuantity != null && b.usageQuantity > 0 && (
                    <div style={{ display: 'flex', gap: '16px', marginTop: '4px' }}>
                      <span style={{ color: '#3b82f6', fontWeight: 600 }}>
                        ⚡ {b.usageQuantity.toLocaleString()} {b.usageUnit || unit || 'units'}
                      </span>
                      {b.usageDays && b.usageDays > 0 && (
                        <span className="muted">
                          ({(b.usageQuantity / b.usageDays).toFixed(1)} {b.usageUnit || unit}/day)
                        </span>
                      )}
                    </div>
                  )}
                  <button
                    className="btn btn--small btn--danger"
                    style={{ marginTop: '6px', alignSelf: 'flex-start' }}
                    onClick={() => handleDeleteBill(b.id, b.periodStart)}
                  >Delete</button>
                </div>
              ))
            )}
          </div>
        );
      })()}

      {tab === 'documents' && (
        <div className="stack">
          <button className="btn btn--primary" onClick={() => onNavigate('import-doc', { serviceId })}>📄 Import Document</button>
          {docs.length === 0 ? (
            <div className="empty"><p>No documents yet. Import a bill, contract, or other document.</p></div>
          ) : (
            docs.map(d => (
              <div
                key={d.id}
                className="card doc-card"
                onClick={() => onNavigate('doc-detail', { serviceId, docId: d.id })}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    {d.docTypes?.map(t => DOC_TYPE_LABELS[t]?.icon || '📄').join('')}
                    {' '}{d.title}
                  </span>
                  <span className="muted">{formatDate(d.docDate)}</span>
                </div>
                <span className="muted">{d.docTypes?.map(t => DOC_TYPE_LABELS[t]?.label).join(', ')}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* ─── Confirm Bar (sticky) ──────────────────────────── */}
      {showConfirmBar && pendingChanges.length > 0 && (
        <div className="confirm-bar">
          <div className="confirm-bar__changes">
            <strong>{pendingChanges.length} pending change{pendingChanges.length > 1 ? 's' : ''}:</strong>
            <ul className="confirm-bar__list">
              {pendingChanges.map(c => (
                <li key={c.id}>
                  {c.description}
                  <button className="btn-icon" onClick={() => removePending(c.id)} title="Undo">✕</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="confirm-bar__actions">
            <button className="btn" onClick={discardAllPending}>Discard All</button>
            <button className="btn btn--primary" onClick={applyAllPending}>
              ✅ Apply {pendingChanges.length} Change{pendingChanges.length > 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
