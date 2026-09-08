import { useState, useEffect, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../store/AppContext';
import { parseDocument } from '../platform/document-parser';
import { extractText } from '../platform/document-reader';
import { llmParse, type LlmParseResult } from '../platform/llm-parser';
import { getEffectiveAiConfig } from '../platform/storage';
import type { Service, Bill, Document as Doc, TariffEntry } from '../types';
import { money, humanise, formatDate, monthlyAmount, FREQUENCY_LABELS, DOC_TYPE_LABELS, today, USAGE_CATEGORIES, USAGE_UNITS } from '../types';
import { forecastNextBill, type ForecastResult } from '../platform/forecast';

interface Props {
  serviceId: string;
  onNavigate: (page: string, params?: Record<string, string>) => void;
  onBack: () => void;
}

type Tab = 'overview' | 'bills' | 'rates' | 'contract' | 'coverage' | 'documents';

interface PendingChange {
  id: string;
  type: 'deleteBill' | 'other';
  description: string;
  apply: () => Promise<void>;
}

const INSURANCE_CATEGORIES = new Set([
  'HOME_INSURANCE', 'CAR_INSURANCE', 'HEALTH_INSURANCE', 'LIFE_INSURANCE',
  'CONTENTS_INSURANCE', 'PET_INSURANCE', 'TRAVEL_INSURANCE',
]);

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

  // Bill comparison
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);

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
      const aiConfig = getEffectiveAiConfig();
      const allEntries: TariffEntry[] = [];
      let summary = '';

      for (let i = 0; i < allDocs.length; i++) {
        const doc = allDocs[i]!;
        setReparseStatus(`Re-extracting ${doc.fileName || doc.title} (${i + 1}/${allDocs.length})...`);

        let text = doc.ocrText || '';
        const storedFile = await app.loadFile(doc.id);
        if (storedFile) {
          try {
            const blob = new Blob([storedFile.bytes], { type: storedFile.mimeType });
            const file = new File([blob], storedFile.fileName || doc.fileName, { type: storedFile.mimeType });
            text = await extractText(file, p => {
              setReparseStatus(`${p.status} — ${doc.fileName} (${i + 1}/${allDocs.length})`);
            });
            await app.saveDoc({ ...doc, ocrText: text });
          } catch (e) {
            console.warn('[Re-parse] Failed to re-extract text for', doc.fileName, e);
          }
        }

        if (!text) continue;

        let result;
        if (aiConfig) {
          setReparseStatus(`Analysing ${doc.fileName || doc.title} with AI (${i + 1}/${allDocs.length})...`);
          const llmResult = await llmParse(text, aiConfig, status => {
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

        const effectiveDate = doc.docDate || today();
        for (const ins of result.insights) {
          if (['date'].includes(ins.section)) continue;
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

      setReparseStatus('Saving...');
      const updatedSvc: Service = {
        ...svc,
        tariffHistory: allEntries,
        summary: summary || svc.summary || '',
        updatedAt: today(),
      };

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

  // ─── Pending changes helpers ─────────────────────────────

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

  const handleDeleteBill = (billId: string, periodStart: string) => {
    addPending({
      type: 'deleteBill',
      description: `Delete bill from ${formatDate(periodStart)}`,
      apply: async () => { await app.deleteBill(billId); },
    });
  };

  const handleDeleteService = async () => {
    if (confirm('Delete this service and all its bills and documents?')) {
      await app.deleteService(serviceId);
      onBack();
    }
  };

  // ─── Derived data ────────────────────────────────────────

  const tariffHistory = (svc.tariffHistory || [])
    .sort((a, b) => (b.effectiveDate || '').localeCompare(a.effectiveDate || ''));

  const isInsurance = INSURANCE_CATEGORIES.has(svc.category);
  const isUsageSvc = USAGE_CATEGORIES.has(svc.category);

  // Section helpers
  const entriesFor = (section: string) => tariffHistory.filter(t => t.section === section);
  const currentEntries = (section: string) => entriesFor(section).filter(e => !e.endDate);
  const endedEntries = (section: string) => entriesFor(section).filter(e => e.endDate);
  const hasEntries = (section: string) => entriesFor(section).length > 0;

  const daysUntil = (date: string) => {
    if (!date) return null;
    return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
  };

  // Build available tabs
  const availableTabs: { id: Tab; label: string; icon: string; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: '📋' },
    { id: 'bills', label: 'Bills', icon: '🧾', count: bills.length },
    { id: 'rates', label: 'Rates & Plan', icon: '📊' },
    { id: 'contract', label: 'Contract', icon: '📝' },
  ];
  if (isInsurance && hasEntries('coverage')) {
    availableTabs.splice(3, 0, { id: 'coverage', label: 'Coverage', icon: '🛡️' });
  }
  availableTabs.push({ id: 'documents', label: 'Documents', icon: '📄', count: docs.length });

  // ─── Render helpers ─────────────────────────────────────

  /** Render a tariff entry with optional change history */
  const renderEntry = (entry: TariffEntry, ended: TariffEntry[]) => {
    const lv = entry.value.toLowerCase();
    const coverageColor = entry.section === 'coverage'
      ? /^(?:included|covered)$/i.test(lv) ? 'var(--ok)'
        : /^(?:restricted)$/i.test(lv) ? 'var(--warn)'
        : /(?:not\s*(?:included|covered)|excluded)$/i.test(lv) ? 'var(--bad, #f44336)'
        : undefined
      : undefined;

    const previousEntry = ended.find(e => e.label === entry.label);

    return (
      <div key={entry.id} className="tariff-entry">
        <div className="tariff-entry__header">
          <span className="tariff-entry__label">{entry.label}</span>
          <span className="tariff-entry__value" style={coverageColor ? { color: coverageColor } : undefined}>{entry.value}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="tariff-entry__date">Since {formatDate(entry.effectiveDate)}</span>
          {previousEntry && (
            <span style={{ fontSize: '0.72rem', color: 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              ⚡ was <span style={{ textDecoration: 'line-through' }}>{previousEntry.value}</span>
              <span className="muted">({formatDate(previousEntry.effectiveDate)} – {formatDate(previousEntry.endDate!)})</span>
            </span>
          )}
        </div>
      </div>
    );
  };

  /** Render a section of tariff entries with collapsible history */
  const renderSection = (section: string, icon: string, title: string, opts?: { emptyMessage?: string; hideEmpty?: boolean }) => {
    const current = currentEntries(section);
    const ended = endedEntries(section);

    if (current.length === 0 && ended.length === 0) {
      if (opts?.hideEmpty) return null;
      return (
        <div className="detail-section">
          <h4 className="detail-section__title">{icon} {title}</h4>
          <p className="muted" style={{ fontSize: '0.85rem' }}>{opts?.emptyMessage || 'No data yet. Upload a document to extract this info.'}</p>
        </div>
      );
    }

    return (
      <div className="detail-section">
        <h4 className="detail-section__title">{icon} {title}</h4>
        {current.map(entry => renderEntry(entry, ended))}
        {ended.length > 0 && (
          <details style={{ marginTop: '8px' }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
              📜 History ({ended.length} previous)
            </summary>
            <div className="tariff-timeline" style={{ marginTop: '6px' }}>
              {ended.map(entry => (
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

  /** Render key dates with warnings */
  const renderKeyDates = () => {
    const dates: { label: string; value: string; warn?: boolean; danger?: boolean }[] = [];
    if (svc.startDate) dates.push({ label: 'Start date', value: formatDate(svc.startDate) });
    if (svc.benefitEndDate) {
      const d = daysUntil(svc.benefitEndDate);
      dates.push({
        label: 'Benefit ends',
        value: `${formatDate(svc.benefitEndDate)}${d !== null ? ` (${d} days)` : ''}`,
        warn: d !== null && d <= 60,
        danger: d !== null && d <= 14,
      });
    }
    if (svc.contractEndDate) {
      const d = daysUntil(svc.contractEndDate);
      dates.push({
        label: 'Contract ends',
        value: `${formatDate(svc.contractEndDate)}${d !== null ? ` (${d} days)` : ''}`,
        warn: d !== null && d <= 60,
        danger: d !== null && d <= 14,
      });
    }
    // Pull contract dates from tariff history too
    const contractDates = currentEntries('contract').filter(e =>
      /end date|expiry|renewal|notice period/i.test(e.label)
    );
    for (const e of contractDates) {
      if (!dates.some(d => d.label === e.label)) {
        dates.push({ label: e.label, value: e.value });
      }
    }

    if (dates.length === 0) return null;

    return (
      <div className="detail-section">
        <h4 className="detail-section__title">📅 Key Dates</h4>
        <div className="dates-grid">
          {dates.map(d => (
            <div key={d.label} className="fact-row">
              <span className="fact-label">{d.label}</span>
              <span className={`fact-value ${d.danger ? 'text-danger' : d.warn ? 'text-warn' : ''}`}>{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  /** Render identifiers */
  const renderIdentifiers = () => {
    const items: { label: string; value: string }[] = [];
    if (svc.accountNumber) items.push({ label: 'Account #', value: svc.accountNumber });
    if (svc.meterIdentifier) items.push({ label: 'Meter ID', value: svc.meterIdentifier });
    for (const t of currentEntries('identifier')) {
      if (t.label !== 'Account number' && t.label !== 'NMI' && t.label !== 'MIRN') {
        items.push({ label: t.label, value: t.value });
      }
    }
    if (items.length === 0) return null;
    return (
      <div className="detail-section">
        <h4 className="detail-section__title">🔑 Identifiers</h4>
        {items.map(i => (
          <div key={i.label} className="fact-row">
            <span className="fact-label">{i.label}</span>
            <span className="fact-value">{i.value}</span>
          </div>
        ))}
      </div>
    );
  };

  // ─── Exit / disconnection info (shown in both Overview warnings and Contract tab) ───
  const exitInfo: { label: string; value: string; warn?: boolean }[] = [];
  if (svc.exitFeeCents > 0) exitInfo.push({ label: 'Exit fee', value: money(svc.exitFeeCents), warn: true });
  const exitEntries = currentEntries('clause').filter(e =>
    /exit|cancel|disconnect|termination|early|break|switching|notice period/i.test(e.label)
  );
  for (const e of exitEntries) {
    exitInfo.push({ label: e.label, value: e.value, warn: /fee|penalty|charge/i.test(e.value) });
  }

  // Auto-renewal / important clauses
  const importantClauses = currentEntries('clause').filter(e =>
    /auto.?renew|price.?change|price.?variation|lock.?in|grandfather|hardship/i.test(e.label)
  );

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

      {/* Service header */}
      <div className="service-header">
        <h2>{svc.nickname}</h2>
        <div className="row">
          <span className="tag">{humanise(svc.category)}</span>
          <span className="tag tag--status">{svc.status}</span>
        </div>
        <div className="service-header__cost">
          {isUsageSvc && svc.billAvgMonthlyCents && svc.billAvgMonthlyCents > 0 ? (
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

      {/* Urgent warnings banner */}
      {(exitInfo.some(e => e.warn) || (svc.contractEndDate && (daysUntil(svc.contractEndDate) ?? 999) <= 30) || (svc.benefitEndDate && (daysUntil(svc.benefitEndDate) ?? 999) <= 30)) && (
        <div className="card" style={{ border: '1px solid var(--warn)', background: 'color-mix(in srgb, var(--warn) 6%, var(--surface))' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <span style={{ fontSize: '1.3rem' }}>⚠️</span>
            <div>
              {svc.contractEndDate && (daysUntil(svc.contractEndDate) ?? 999) <= 30 && (
                <div style={{ fontWeight: 600, color: 'var(--warn)', marginBottom: '4px' }}>
                  Contract ends in {daysUntil(svc.contractEndDate)} days ({formatDate(svc.contractEndDate)})
                </div>
              )}
              {svc.benefitEndDate && (daysUntil(svc.benefitEndDate) ?? 999) <= 30 && (
                <div style={{ fontWeight: 600, color: 'var(--warn)', marginBottom: '4px' }}>
                  Benefit ends in {daysUntil(svc.benefitEndDate)} days ({formatDate(svc.benefitEndDate)})
                </div>
              )}
              {exitInfo.filter(e => e.warn).map(e => (
                <div key={e.label} style={{ fontSize: '0.85rem', color: 'var(--text)', marginBottom: '2px' }}>
                  {e.label}: <strong>{e.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs" style={{ overflowX: 'auto' }}>
        {availableTabs.map(t => (
          <button key={t.id} className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            <span className="tab__icon">{t.icon}</span>
            <span>{t.label}</span>
            {t.count !== undefined && t.count > 0 && <span className="tab__badge">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════
          TAB: Overview
          ═══════════════════════════════════════════════════════ */}
      {tab === 'overview' && (
        <div className="stack">
          {/* Upload + Re-parse */}
          <div className="row" style={{ gap: '8px' }}>
            <button
              className="btn btn--primary btn--lg"
              style={{ flex: 1, fontSize: '1.1rem', padding: '14px' }}
              onClick={() => onNavigate('import-doc', { serviceId })}
            >
              📄 Upload & Parse Document
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

          {/* AI Summary */}
          {svc.summary && (
            <div className="card card--summary">
              <h3>📝 Summary</h3>
              <p style={{ lineHeight: 1.6, margin: 0 }}>{svc.summary}</p>
            </div>
          )}

          {/* Key Dates */}
          {renderKeyDates()}

          {/* Quick glance: top rates + cost */}
          {hasEntries('tariff') && (
            <div className="detail-section">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 className="detail-section__title" style={{ margin: 0 }}>📊 Current Rates</h4>
                <button className="btn btn--small btn--outline" onClick={() => setTab('rates')}>View all →</button>
              </div>
              {currentEntries('tariff').slice(0, 5).map(entry => renderEntry(entry, endedEntries('tariff')))}
              {currentEntries('tariff').length > 5 && (
                <p className="muted" style={{ fontSize: '0.82rem', marginTop: '6px', cursor: 'pointer' }} onClick={() => setTab('rates')}>
                  + {currentEntries('tariff').length - 5} more rates...
                </p>
              )}
            </div>
          )}

          {/* Exit / disconnection quick view */}
          {exitInfo.length > 0 && (
            <div className="detail-section">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 className="detail-section__title" style={{ margin: 0 }}>🚪 Exit & Disconnection</h4>
                <button className="btn btn--small btn--outline" onClick={() => setTab('contract')}>Details →</button>
              </div>
              {exitInfo.map(e => (
                <div key={e.label} className="fact-row">
                  <span className="fact-label">{e.label}</span>
                  <span className={`fact-value ${e.warn ? 'text-warn' : ''}`}>{e.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Important clauses quick view */}
          {importantClauses.length > 0 && (
            <div className="detail-section">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 className="detail-section__title" style={{ margin: 0 }}>⚡ Important</h4>
                <button className="btn btn--small btn--outline" onClick={() => setTab('contract')}>Details →</button>
              </div>
              {importantClauses.map(e => (
                <div key={e.id} className="fact-row">
                  <span className="fact-label">{e.label}</span>
                  <span className="fact-value">{e.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Identifiers */}
          {renderIdentifiers()}

          {/* Forecast */}
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

                  <p className="muted" style={{ fontSize: '0.78rem', marginTop: '10px', textAlign: 'center' }}>
                    {forecast.method}
                  </p>
                </div>
              );
            })()}
          </div>

          {svc.notes && (
            <div className="card">
              <h3>Notes</h3>
              <p>{svc.notes}</p>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          TAB: Bills
          ═══════════════════════════════════════════════════════ */}
      {tab === 'bills' && (() => {
        const unit = USAGE_UNITS[svc.category] || '';
        const sortedBills = [...bills].sort((a, b) =>
          (a.periodStart || a.createdAt || '').localeCompare(b.periodStart || b.createdAt || ''));
        const usageBills = sortedBills.filter(b => b.usageQuantity && b.usageQuantity > 0);
        const maxCost = sortedBills.length > 0 ? Math.max(...sortedBills.map(b => b.totalCents)) : 0;
        const maxUsage = usageBills.length > 0 ? Math.max(...usageBills.map(b => b.usageQuantity!)) : 0;

        // Build unique labels for each bill
        const billLabels = new Map<string, string>();
        const shortLabels = new Map<string, string>();
        const nameCounts = new Map<string, number>();
        for (const b of sortedBills) {
          const sourceFile = b.notes || '';
          const cleanName = sourceFile ? sourceFile.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') : '';
          const base = (b.periodStart || b.periodEnd)
            ? `${formatDate(b.periodStart)} — ${formatDate(b.periodEnd)}`
            : cleanName || 'Bill';
          nameCounts.set(base, (nameCounts.get(base) || 0) + 1);
        }
        const nameIdx = new Map<string, number>();
        for (const b of sortedBills) {
          const sourceFile = b.notes || '';
          const cleanName = sourceFile ? sourceFile.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') : '';
          const hasDates = b.periodStart || b.periodEnd;
          const base = hasDates
            ? `${formatDate(b.periodStart)} — ${formatDate(b.periodEnd)}`
            : cleanName || 'Bill';
          const count = nameCounts.get(base) || 1;
          if (count > 1) {
            const idx = (nameIdx.get(base) || 0) + 1;
            nameIdx.set(base, idx);
            billLabels.set(b.id, `${base} (#${idx})`);
          } else {
            billLabels.set(b.id, base);
          }
          // Short label for chart x-axis
          const d = b.periodStart || b.createdAt;
          if (d) {
            const dt = new Date(d);
            shortLabels.set(b.id, dt.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }));
          } else {
            shortLabels.set(b.id, `#${(nameIdx.get(base) || 1)}`);
          }
        }

        // Comparison bills
        const cmpA = compareIds ? sortedBills.find(b => b.id === compareIds[0]) : null;
        const cmpB = compareIds ? sortedBills.find(b => b.id === compareIds[1]) : null;

        // Y-axis grid values for cost chart
        const costStep = maxCost > 0 ? Math.pow(10, Math.floor(Math.log10(maxCost / 100))) * Math.ceil((maxCost / 100) / Math.pow(10, Math.floor(Math.log10(maxCost / 100))) / 4) : 0;
        const costGridLines = costStep > 0 ? Array.from({ length: 5 }, (_, i) => (i + 1) * costStep) .filter(v => v <= maxCost / 100 * 1.15) : [];

        // Change helper
        const pctChange = (a: number, b2: number) => a > 0 ? ((b2 - a) / a * 100) : null;

        return (
          <div className="stack">
            <button className="btn btn--primary" onClick={() => onNavigate('add-bill', { serviceId })}>+ Add Bill</button>

            {/* ═══════ COST BAR CHART ═══════ */}
            {sortedBills.length >= 2 && (
              <div className="card" style={{ padding: '16px 12px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                  <h3 style={{ margin: 0 }}>Payment History</h3>
                  <span className="muted" style={{ fontSize: '0.75rem' }}>
                    avg {money(Math.round(sortedBills.reduce((s, b) => s + b.totalCents, 0) / sortedBills.length))}
                  </span>
                </div>
                {/* Chart area */}
                <div style={{ position: 'relative', height: '200px', marginTop: '8px', display: 'flex' }}>
                  {/* Y-axis labels */}
                  <div style={{ width: '42px', flexShrink: 0, position: 'relative', height: '100%' }}>
                    {costGridLines.map(v => (
                      <span key={v} style={{
                        position: 'absolute', right: '4px',
                        bottom: `${(v / (maxCost / 100) * 100) * 0.85}%`,
                        transform: 'translateY(50%)',
                        fontSize: '0.65rem', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums',
                      }}>${v}</span>
                    ))}
                  </div>
                  {/* Bars + grid */}
                  <div style={{ flex: 1, position: 'relative', borderLeft: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                    {/* Grid lines */}
                    {costGridLines.map(v => (
                      <div key={v} style={{
                        position: 'absolute', left: 0, right: 0,
                        bottom: `${(v / (maxCost / 100)) * 85}%`,
                        borderTop: '1px dashed var(--border)', opacity: 0.5,
                      }} />
                    ))}
                    {/* Bars */}
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '100%', padding: '0 8px' }}>
                      {sortedBills.map((b, i) => {
                        const pct = maxCost > 0 ? (b.totalCents / maxCost) * 85 : 0;
                        const prevPct = i > 0 ? pctChange(sortedBills[i - 1]!.totalCents, b.totalCents) : null;
                        const isSelected = compareIds?.includes(b.id);
                        return (
                          <div key={b.id} style={{
                            flex: 1, display: 'flex', flexDirection: 'column',
                            alignItems: 'center', minWidth: 0, height: '100%', justifyContent: 'flex-end',
                          }}>
                            {/* Value on top */}
                            <span style={{
                              fontSize: '0.68rem', fontWeight: 600, color: 'var(--text)',
                              marginBottom: '2px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                            }}>{money(b.totalCents, true)}</span>
                            {/* Trend badge */}
                            {prevPct !== null && (
                              <span style={{
                                fontSize: '0.58rem', fontWeight: 700, marginBottom: '1px',
                                color: prevPct > 0 ? '#dc2626' : prevPct < 0 ? '#16a34a' : 'var(--muted)',
                              }}>
                                {prevPct > 0 ? '▲' : prevPct < 0 ? '▼' : '='}{Math.abs(prevPct).toFixed(0)}%
                              </span>
                            )}
                            {/* Bar */}
                            <div
                              onClick={() => {
                                if (!compareIds) {
                                  const other = sortedBills[i > 0 ? i - 1 : 1] || b;
                                  setCompareIds([other.id, b.id]);
                                } else if (compareIds.includes(b.id)) {
                                  setCompareIds(null);
                                } else {
                                  setCompareIds([compareIds[0], b.id]);
                                }
                              }}
                              style={{
                                width: '100%', maxWidth: '54px', cursor: 'pointer',
                                height: `${Math.max(pct, 3)}%`,
                                background: isSelected ? '#2563eb' : '#0ea5e9',
                                borderRadius: '3px 3px 0 0',
                                transition: 'height 0.4s ease, background 0.2s',
                                opacity: (compareIds && !isSelected) ? 0.35 : 1,
                                boxShadow: isSelected ? '0 0 0 2px #fff, 0 0 0 4px #2563eb' : 'none',
                              }}
                              title={billLabels.get(b.id)}
                            />
                            {/* X label */}
                            <span style={{
                              fontSize: '0.62rem', color: 'var(--muted)', marginTop: '4px',
                              whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                            }}>{shortLabels.get(b.id)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <p className="muted" style={{ textAlign: 'center', fontSize: '0.7rem', marginTop: '6px' }}>
                  Tap a bar to compare periods
                </p>
              </div>
            )}

            {/* ═══════ USAGE BAR CHART ═══════ */}
            {isUsageSvc && usageBills.length >= 2 && (
              <div className="card" style={{ padding: '16px 12px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                  <h3 style={{ margin: 0 }}>Daily {unit} Usage</h3>
                  {(() => {
                    const totalQty = usageBills.reduce((s, b) => s + (b.usageQuantity || 0), 0);
                    const totalDays = usageBills.reduce((s, b) => s + (b.usageDays || 0), 0);
                    const avg = totalDays > 0 ? (totalQty / totalDays).toFixed(1) : null;
                    return avg ? <span className="muted" style={{ fontSize: '0.75rem' }}>avg {avg} {unit}/day</span> : null;
                  })()}
                </div>
                <div style={{ position: 'relative', height: '160px', marginTop: '8px', display: 'flex' }}>
                  <div style={{ width: '42px', flexShrink: 0 }} />
                  <div style={{ flex: 1, position: 'relative', borderLeft: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '100%', padding: '0 8px' }}>
                      {usageBills.map(b => {
                        const pct = maxUsage > 0 ? (b.usageQuantity! / maxUsage) * 85 : 0;
                        const daily = b.usageDays && b.usageDays > 0 ? (b.usageQuantity! / b.usageDays).toFixed(1) : null;
                        return (
                          <div key={b.id} style={{
                            flex: 1, display: 'flex', flexDirection: 'column',
                            alignItems: 'center', minWidth: 0, height: '100%', justifyContent: 'flex-end',
                          }}>
                            <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text)', marginBottom: '2px', fontVariantNumeric: 'tabular-nums' }}>
                              {daily || b.usageQuantity!.toLocaleString()}
                            </span>
                            <div style={{
                              width: '100%', maxWidth: '54px',
                              height: `${Math.max(pct, 3)}%`,
                              background: '#3b82f6',
                              borderRadius: '3px 3px 0 0',
                              transition: 'height 0.4s ease',
                            }} />
                            <span style={{ fontSize: '0.62rem', color: 'var(--muted)', marginTop: '4px', whiteSpace: 'nowrap' }}>
                              {shortLabels.get(b.id)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ═══════ COMPARISON PANEL ═══════ */}
            {sortedBills.length >= 2 && (
              <div className="card" style={{
                border: compareIds ? '2px solid #2563eb' : '1px solid var(--border)',
                padding: '16px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h3 style={{ margin: 0 }}>⚖️ Compare Bills</h3>
                  {compareIds && <button className="btn btn--small" onClick={() => setCompareIds(null)} style={{ fontSize: '0.78rem' }}>✕ Clear</button>}
                </div>
                {/* Dropdowns to pick bills */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: '4px' }}>Period A (older)</label>
                    <select
                      className="input"
                      style={{ fontSize: '0.82rem', width: '100%' }}
                      value={compareIds?.[0] || ''}
                      onChange={e => {
                        const id = e.target.value;
                        if (!id) { setCompareIds(null); return; }
                        setCompareIds([id, compareIds?.[1] || sortedBills[sortedBills.length - 1]?.id || id]);
                      }}
                    >
                      <option value="">Select…</option>
                      {sortedBills.map(b => (
                        <option key={b.id} value={b.id}>{billLabels.get(b.id)} — {money(b.totalCents)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: '0.72rem', color: 'var(--muted)', display: 'block', marginBottom: '4px' }}>Period B (newer)</label>
                    <select
                      className="input"
                      style={{ fontSize: '0.82rem', width: '100%' }}
                      value={compareIds?.[1] || ''}
                      onChange={e => {
                        const id = e.target.value;
                        if (!id) { setCompareIds(null); return; }
                        setCompareIds([compareIds?.[0] || sortedBills[0]?.id || id, id]);
                      }}
                    >
                      <option value="">Select…</option>
                      {sortedBills.map(b => (
                        <option key={b.id} value={b.id}>{billLabels.get(b.id)} — {money(b.totalCents)}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Comparison data */}
                {cmpA && cmpB && cmpA.id !== cmpB.id ? (
                  <div style={{ overflowX: 'auto' }}>
                    {/* Side-by-side cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                      {[cmpA, cmpB].map((bill, ci) => {
                        const label = ci === 0 ? 'A' : 'B';
                        const color = ci === 0 ? '#64748b' : '#2563eb';
                        return (
                          <div key={bill.id} style={{
                            padding: '12px', borderRadius: '8px',
                            border: `2px solid ${color}`, background: `${color}11`,
                          }}>
                            <div style={{ fontSize: '0.7rem', fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                              {label} — {shortLabels.get(bill.id)}
                            </div>
                            <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                              {money(bill.totalCents)}
                            </div>
                            {bill.usageQuantity != null && bill.usageQuantity > 0 && (
                              <div style={{ fontSize: '0.82rem', color: '#3b82f6', fontWeight: 600, marginTop: '4px' }}>
                                ⚡ {bill.usageQuantity.toLocaleString()} {bill.usageUnit || unit}
                              </div>
                            )}
                            {bill.usageDays && <div className="muted" style={{ fontSize: '0.78rem', marginTop: '2px' }}>{bill.usageDays} days</div>}
                          </div>
                        );
                      })}
                    </div>

                    {/* Detail comparison rows */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                      {[
                        {
                          icon: '💰', label: 'Total',
                          valA: money(cmpA.totalCents), valB: money(cmpB.totalCents),
                          change: pctChange(cmpA.totalCents, cmpB.totalCents),
                          diffLabel: money(cmpB.totalCents - cmpA.totalCents),
                          invert: false,
                        },
                        ...(cmpA.usageQuantity || cmpB.usageQuantity ? [{
                          icon: '⚡', label: `Usage (${unit || 'units'})`,
                          valA: cmpA.usageQuantity ? cmpA.usageQuantity.toLocaleString() : '—',
                          valB: cmpB.usageQuantity ? cmpB.usageQuantity.toLocaleString() : '—',
                          change: cmpA.usageQuantity && cmpB.usageQuantity ? pctChange(cmpA.usageQuantity, cmpB.usageQuantity) : null,
                          diffLabel: cmpA.usageQuantity && cmpB.usageQuantity ? `${(cmpB.usageQuantity - cmpA.usageQuantity) > 0 ? '+' : ''}${(cmpB.usageQuantity - cmpA.usageQuantity).toLocaleString()}` : '',
                          invert: false,
                        }] : []),
                        ...(cmpA.usageDays || cmpB.usageDays ? [{
                          icon: '📅', label: 'Days',
                          valA: cmpA.usageDays?.toString() || '—',
                          valB: cmpB.usageDays?.toString() || '—',
                          change: cmpA.usageDays && cmpB.usageDays ? pctChange(cmpA.usageDays, cmpB.usageDays) : null,
                          diffLabel: cmpA.usageDays && cmpB.usageDays ? `${(cmpB.usageDays - cmpA.usageDays) > 0 ? '+' : ''}${cmpB.usageDays - cmpA.usageDays}` : '',
                          invert: false,
                        }] : []),
                        ...(cmpA.usageDays && cmpB.usageDays && cmpA.totalCents && cmpB.totalCents ? [{
                          icon: '💵', label: 'Daily Cost',
                          valA: money(Math.round(cmpA.totalCents / cmpA.usageDays)),
                          valB: money(Math.round(cmpB.totalCents / cmpB.usageDays)),
                          change: pctChange(cmpA.totalCents / cmpA.usageDays, cmpB.totalCents / cmpB.usageDays),
                          diffLabel: money(Math.round(cmpB.totalCents / cmpB.usageDays - cmpA.totalCents / cmpA.usageDays)),
                          invert: false,
                        }] : []),
                        ...(isUsageSvc && cmpA.usageQuantity && cmpA.usageDays && cmpB.usageQuantity && cmpB.usageDays ? [{
                          icon: '⚡', label: `Daily ${unit}`,
                          valA: `${(cmpA.usageQuantity / cmpA.usageDays).toFixed(1)}`,
                          valB: `${(cmpB.usageQuantity / cmpB.usageDays).toFixed(1)}`,
                          change: pctChange(cmpA.usageQuantity / cmpA.usageDays, cmpB.usageQuantity / cmpB.usageDays),
                          diffLabel: `${((cmpB.usageQuantity / cmpB.usageDays) - (cmpA.usageQuantity / cmpA.usageDays)) > 0 ? '+' : ''}${((cmpB.usageQuantity / cmpB.usageDays) - (cmpA.usageQuantity / cmpA.usageDays)).toFixed(1)}`,
                          invert: false,
                        }] : []),
                        ...(isUsageSvc && cmpA.usageQuantity && cmpA.totalCents && cmpB.usageQuantity && cmpB.totalCents ? [{
                          icon: '📊', label: `Cost per ${unit}`,
                          valA: money(Math.round(cmpA.totalCents / cmpA.usageQuantity)),
                          valB: money(Math.round(cmpB.totalCents / cmpB.usageQuantity)),
                          change: pctChange(cmpA.totalCents / cmpA.usageQuantity, cmpB.totalCents / cmpB.usageQuantity),
                          diffLabel: money(Math.round(cmpB.totalCents / cmpB.usageQuantity - cmpA.totalCents / cmpA.usageQuantity)),
                          invert: false,
                        }] : []),
                      ].map((row, ri) => (
                        <div key={ri} style={{
                          display: 'grid', gridTemplateColumns: '1fr auto 1fr auto',
                          alignItems: 'center', gap: '8px',
                          padding: '10px 0',
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{row.valA}</div>
                          <div style={{
                            fontSize: '0.72rem', fontWeight: 600, color: 'var(--muted)',
                            textAlign: 'center', minWidth: '80px',
                          }}>{row.icon} {row.label}</div>
                          <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{row.valB}</div>
                          <div style={{
                            minWidth: '65px', textAlign: 'right',
                            fontSize: '0.78rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                            color: row.change === null ? 'var(--muted)'
                              : row.change > 0 ? '#dc2626' : row.change < 0 ? '#16a34a' : 'var(--muted)',
                          }}>
                            {row.change !== null ? (
                              <>{row.change > 0 ? '▲' : row.change < 0 ? '▼' : '='}{Math.abs(row.change).toFixed(1)}%</>
                            ) : '—'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : !compareIds ? (
                  <p className="muted" style={{ textAlign: 'center', fontSize: '0.82rem', margin: '8px 0 0' }}>
                    Select two periods above or tap a chart bar
                  </p>
                ) : null}
              </div>
            )}

            {/* ═══════ BILL LIST ═══════ */}
            {bills.length === 0 ? (
              <div className="empty"><p>No bills yet. Import a document or add a bill manually.</p></div>
            ) : (
              sortedBills.reverse().map((b, idx) => {
                const label = billLabels.get(b.id) || `Bill #${idx + 1}`;
                const sourceFile = b.notes || '';
                const hasDates = b.periodStart || b.periodEnd;
                const isSelected = compareIds?.includes(b.id);
                return (
                <div key={b.id} className="card bill-card" style={{
                  borderLeft: isSelected ? '4px solid #2563eb' : undefined,
                }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{label}</span>
                      {b.usageDays && <span className="muted" style={{ marginLeft: '8px' }}>({b.usageDays} days)</span>}
                    </div>
                    <span className="money" style={{ fontSize: '1.1rem' }}>{money(b.totalCents)}</span>
                  </div>
                  {sourceFile && hasDates && (
                    <div className="muted" style={{ fontSize: '0.78rem', marginTop: '2px' }}>📄 {sourceFile}</div>
                  )}
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
                  <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                    <button
                      className="btn btn--small btn--danger"
                      onClick={() => handleDeleteBill(b.id, b.periodStart)}
                    >Delete</button>
                  </div>
                </div>
                );
              })
            )}
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════
          TAB: Rates & Plan
          ═══════════════════════════════════════════════════════ */}
      {tab === 'rates' && (
        <div className="stack">
          <button className="btn btn--primary" onClick={() => onNavigate('import-doc', { serviceId })}>
            📄 Upload document to update rates
          </button>

          {/* Amount section — totals, balances, usage */}
          {renderSection('amount', '💰', 'Amounts & Totals', { hideEmpty: true })}

          {/* Tariff rates */}
          {renderSection('tariff', '📊', 'Tariffs & Rates', {
            emptyMessage: 'No rate data yet. Upload a bill or contract to extract tariffs.',
          })}

          {/* Coverage in rates tab for insurance */}
          {isInsurance && renderSection('coverage', '🛡️', 'Coverage & Benefits', { hideEmpty: true })}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          TAB: Contract
          ═══════════════════════════════════════════════════════ */}
      {tab === 'contract' && (
        <div className="stack">
          <button className="btn btn--primary" onClick={() => onNavigate('import-doc', { serviceId })}>
            📄 Upload contract document
          </button>

          {/* Key dates (also in overview) */}
          {renderKeyDates()}

          {/* Exit & Disconnection — prominently displayed */}
          {exitInfo.length > 0 ? (
            <div className="detail-section" style={{ border: '1px solid var(--warn)', background: 'color-mix(in srgb, var(--warn) 4%, var(--surface))', padding: '16px', borderRadius: 'var(--radius)' }}>
              <h4 className="detail-section__title" style={{ margin: '0 0 10px' }}>🚪 Exit & Disconnection</h4>
              {exitInfo.map(e => (
                <div key={e.label} className="fact-row">
                  <span className="fact-label">{e.label}</span>
                  <span className={`fact-value ${e.warn ? 'text-warn' : ''}`}>{e.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="detail-section">
              <h4 className="detail-section__title">🚪 Exit & Disconnection</h4>
              <p className="muted" style={{ fontSize: '0.85rem' }}>No exit or disconnection terms found. Upload a contract to extract this info.</p>
            </div>
          )}

          {/* Contract terms */}
          {renderSection('contract', '📋', 'Contract Terms', {
            emptyMessage: 'No contract terms found. Upload a contract document.',
          })}

          {/* Important clauses */}
          {renderSection('clause', '📌', 'Important Clauses', {
            emptyMessage: 'No special clauses found. Upload a contract or PDS to extract clauses like auto-renewal, price changes, etc.',
          })}

          {/* Identifiers (also useful here) */}
          {renderIdentifiers()}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          TAB: Coverage (insurance only)
          ═══════════════════════════════════════════════════════ */}
      {tab === 'coverage' && (
        <div className="stack">
          <button className="btn btn--primary" onClick={() => onNavigate('import-doc', { serviceId })}>
            📄 Upload policy document
          </button>
          {renderSection('coverage', '🛡️', 'Coverage & Benefits', {
            emptyMessage: 'No coverage data yet. Upload a PDS or policy certificate.',
          })}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          TAB: Documents
          ═══════════════════════════════════════════════════════ */}
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
