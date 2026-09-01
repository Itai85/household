import { useState, useRef, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../store/AppContext';
import { extractText, type OcrProgress } from '../platform/document-reader';
import { parseDocument } from '../platform/document-parser';
import { llmParse, type LlmParseResult, type TokenUsage } from '../platform/llm-parser';
import { getAiConfig } from '../platform/storage';
import { PROVIDERS } from '../platform/ai-providers';
import type { Document as Doc, DocumentType, DocInsight, Service, ServiceCategory, TariffEntry, BillingFrequency } from '../types';
import { DOC_TYPE_LABELS, FREQUENCY_LABELS, humanise, emptyUserEdits, today, USAGE_CATEGORIES, USAGE_UNITS, formatDate } from '../types';

interface Props {
  serviceId?: string;
  onDone: () => void;
}

type Phase = 'upload' | 'processing' | 'review' | 'saved';

/** A row the user sees in the review — editable tariff/contract/clause with a date */
interface ReviewRow {
  id: string;
  label: string;
  value: string;
  section: DocInsight['section'];
  effectiveDate: string;
  source?: string;
  enabled: boolean;      // user can uncheck rows they don't want
}

/** Per-file bill data extracted from each uploaded document */
interface PerFileBill {
  fileIdx: number;
  fileName: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  usageQty: string;
  usageUnit: string;
  usageDays: string;
  docDate: string;
}

/** Try to parse a date string into ISO YYYY-MM-DD */
function parseDateField(raw: string): string {
  if (!raw) return '';
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Try native parse "DD Mon YYYY" or "DD/MM/YYYY"
  const d = new Date(raw);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString().slice(0, 10);
  // AU format DD/MM/YYYY
  const parts = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (parts) {
    const yr = parts[3]!.length === 2 ? '20' + parts[3] : parts[3];
    return `${yr}-${parts[2]!.padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`;
  }
  return '';
}

export function ImportDocumentScreen({ serviceId: preSelectedServiceId, onDone }: Props) {
  const app = useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('upload');
  const [progress, setProgress] = useState<OcrProgress>({ percent: 0, status: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [currentFileIdx, setCurrentFileIdx] = useState(0);
  const [ocrTexts, setOcrTexts] = useState<string[]>([]);
  const [ocrText, setOcrText] = useState('');
  const [showRawText, setShowRawText] = useState(false);

  // ─── Detected & editable service info ────────────────────
  const [matchedServiceId, setMatchedServiceId] = useState(preSelectedServiceId || '');
  const [createNewService, setCreateNewService] = useState(false);
  const [providerName, setProviderName] = useState('');
  const [category, setCategory] = useState<ServiceCategory>('OTHER');
  const [nickname, setNickname] = useState('');

  // ─── Document metadata ───────────────────────────────────
  const [title, setTitle] = useState('');
  const [docTypes, setDocTypes] = useState<DocumentType[]>([]);
  const [docDate, setDocDate] = useState('');

  // ─── Editable rows (tariffs, contract terms, amounts, etc.) ─
  const [rows, setRows] = useState<ReviewRow[]>([]);

  // ─── Bill fields (single file) ─────────────────────────────
  const [billTotal, setBillTotal] = useState('');
  const [billPeriodStart, setBillPeriodStart] = useState('');
  const [billPeriodEnd, setBillPeriodEnd] = useState('');

  // ─── Per-file bills (multiple files) ──────────────────────
  const [perFileBills, setPerFileBills] = useState<PerFileBill[]>([]);

  // ─── New row form ─────────────────────────────────────────
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newSection, setNewSection] = useState<DocInsight['section']>('tariff');

  // ─── Parser mode indicator ─────────────────────────────────
  const [parserUsed, setParserUsed] = useState<'llm' | 'regex'>('regex');
  const [summary, setSummary] = useState('');

  // ─── Token usage tracking ──────────────────────────────────
  const [tokenUsage, setTokenUsage] = useState<TokenUsage[]>([]);

  // ─── Pasted text ──────────────────────────────────────────
  const [pastedText, setPastedText] = useState('');
  const [sourceMode, setSourceMode] = useState<'file' | 'text'>('file');

  // ─── Process uploaded file ────────────────────────────────

  const processFiles = useCallback(async (fileList: File[]) => {
    setFiles(fileList);
    setSourceMode('file');
    setPhase('processing');

    try {
      // Parse all files and merge results
      const allTexts: string[] = [];
      const allResults: ReturnType<typeof parseDocument>[] = [];
      let usedLlm = false;
      const allTokenUsage: TokenUsage[] = [];

      // First pass: extract text from all files
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i]!;
        setCurrentFileIdx(i);
        setProgress({ percent: Math.round((i / fileList.length) * 50), status: `Extracting text from ${f.name} (${i + 1}/${fileList.length})…` });

        const text = await extractText(f, p => {
          const base = (i / fileList.length) * 50;
          const fileShare = 50 / fileList.length;
          setProgress({ percent: Math.round(base + (p.percent / 100) * fileShare), status: p.status + ` (${i + 1}/${fileList.length})` });
        });
        allTexts.push(text);
      }

      // Quick regex pre-scan on first file to detect provider/category (free, instant)
      const regexResult = parseDocument(allTexts[0] || '');
      const knownProvider = regexResult.detectedProvider || undefined;
      const knownCategory = regexResult.detectedCategory || undefined;
      const knownDocTypes = regexResult.docTypes.length > 0 ? regexResult.docTypes : undefined;

      // Second pass: AI analysis with context
      const aiConfig = getAiConfig();
      const providerLabel = aiConfig ? (PROVIDERS[aiConfig.providerId]?.label || 'AI') : '';

      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i]!;
        const text = allTexts[i]!;
        setCurrentFileIdx(i);

        let result;
        if (aiConfig?.apiKey) {
          setProgress({ percent: Math.round(50 + (i / fileList.length) * 45), status: `Analysing ${f.name} with ${providerLabel}... (${i + 1}/${fileList.length})` });
          const llmResult = await llmParse(text, aiConfig, status => {
            setProgress(prev => ({ ...prev, status: status + ` (${i + 1}/${fileList.length})` }));
          }, {
            knownProvider,
            knownCategory,
            knownDocTypes,
          });
          if (llmResult) {
            result = llmResult;
            usedLlm = true;
            allTokenUsage.push(llmResult.tokenUsage);
          } else {
            result = parseDocument(text);
          }
        } else {
          result = parseDocument(text);
        }
        allResults.push(result);
      }

      setParserUsed(usedLlm ? 'llm' : 'regex');
      setTokenUsage(allTokenUsage);
      setOcrTexts(allTexts);
      setOcrText(allTexts.join('\n\n─── Next Document ───\n\n'));

      // Collect summaries from LLM results
      const summaries = allResults
        .filter((r): r is LlmParseResult => 'summary' in r && !!(r as LlmParseResult).summary)
        .map(r => r.summary);
      setSummary(summaries.join(' '));

      // Merge results — use first non-null provider/category, combine all insights
      const firstProvider = allResults.find(r => r.detectedProvider)?.detectedProvider || null;
      const firstCategory = allResults.find(r => r.detectedCategory)?.detectedCategory || null;
      const allDocTypes = [...new Set(allResults.flatMap(r => r.docTypes))];
      const firstDate = allResults.find(r => r.docDate)?.docDate || null;
      const firstTitle = allResults.find(r => r.suggestedTitle)?.suggestedTitle || 'Document';

      // Merge insights from all files with smart dedup:
      // - clause/date/contract/tariff/amount: one entry per label (latest wins)
      // - identifier/coverage: keep unique label+value pairs
      const mergedInsights: DocInsight[] = [];
      const labelOnlySections = new Set(['clause', 'date', 'contract', 'tariff', 'amount']);
      // Process results in order (oldest first) so latest overwrites
      const seenByLabel = new Map<string, number>(); // label → index in mergedInsights
      const seenByLabelValue = new Set<string>();
      for (const result of allResults) {
        for (const ins of result.insights) {
          if (labelOnlySections.has(ins.section)) {
            // For these sections, keep only one entry per label (latest wins)
            const existingIdx = seenByLabel.get(ins.label);
            if (existingIdx !== undefined) {
              mergedInsights[existingIdx] = ins; // overwrite with latest
            } else {
              seenByLabel.set(ins.label, mergedInsights.length);
              mergedInsights.push(ins);
            }
          } else {
            // For identifier/coverage, deduplicate by label+value
            const key = `${ins.label}::${ins.value}`;
            if (!seenByLabelValue.has(key)) {
              seenByLabelValue.add(key);
              if (!seenByLabel.has(ins.label)) seenByLabel.set(ins.label, mergedInsights.length);
              mergedInsights.push(ins);
            }
          }
        }
      }

      // Auto-fill detected fields
      setTitle(fileList.length > 1 ? `${firstProvider || 'Documents'} — ${fileList.length} files` : firstTitle);
      setDocTypes(allDocTypes);
      setDocDate(firstDate || today());
      setProviderName(firstProvider || '');
      setCategory(firstCategory || 'OTHER');
      setNickname(firstProvider
        ? `${firstProvider} ${humanise(firstCategory || 'OTHER')}`
        : '');

      // Auto-match: try provider name first, then category
      if (!preSelectedServiceId) {
        let match = null;
        if (firstProvider) {
          match = app.services.find(s =>
            s.provider.toLowerCase() === firstProvider.toLowerCase() ||
            s.nickname.toLowerCase().includes(firstProvider.toLowerCase())
          );
        }
        // Fallback: match by category if only one service in that category
        if (!match && firstCategory) {
          const catMatches = app.services.filter(s => s.category === firstCategory);
          if (catMatches.length === 1) match = catMatches[0];
        }
        if (match) {
          setMatchedServiceId(match.id);
          setCreateNewService(false);
        } else {
          setMatchedServiceId('');
          setCreateNewService(true);
        }
      } else {
        setMatchedServiceId(preSelectedServiceId);
        setCreateNewService(false);
      }

      // Build review rows from merged insights
      const effectiveDate = firstDate || today();
      const reviewRows: ReviewRow[] = mergedInsights.map(ins => ({
        id: uuid(),
        label: ins.label,
        value: ins.value,
        section: ins.section,
        effectiveDate,
        source: ins.source,
        enabled: true,
      }));
      setRows(reviewRows);

      // ─── Build per-file bill data ───────────────────────────
      const detectedCategory = firstCategory;
      const defaultUnit = detectedCategory ? USAGE_UNITS[detectedCategory] || '' : '';
      const bills: PerFileBill[] = [];
      for (let i = 0; i < allResults.length; i++) {
        const res = allResults[i]!;
        const ins = res.insights;
        const total = ins.find(x => x.label === 'Total amount')?.value.replace(/[$,]/g, '') || '';
        const ps = ins.find(x => x.label === 'Period start')?.value || '';
        const pe = ins.find(x => x.label === 'Period end')?.value || '';
        const usageKwh = ins.find(x => x.label === 'Usage (kWh)')?.value.replace(/[^\d.,]/g, '') || '';
        const usageMj = ins.find(x => x.label === 'Usage (MJ)')?.value.replace(/[^\d.,]/g, '') || '';
        const usageKl = ins.find(x => x.label === 'Usage (kL)')?.value.replace(/[^\d.,]/g, '') || '';
        const usageDays = ins.find(x => x.label === 'Usage days')?.value.replace(/[^\d]/g, '') || '';
        // Pick the right usage value based on detected category
        let usageQty = '';
        let usageUnit = defaultUnit;
        if (usageKwh) { usageQty = usageKwh; usageUnit = 'kWh'; }
        else if (usageMj) { usageQty = usageMj; usageUnit = 'MJ'; }
        else if (usageKl) { usageQty = usageKl; usageUnit = 'kL'; }

        if (total || usageQty) {
          bills.push({
            fileIdx: i,
            fileName: fileList[i]?.name || `File ${i + 1}`,
            periodStart: parseDateField(ps),
            periodEnd: parseDateField(pe),
            total,
            usageQty,
            usageUnit,
            usageDays,
            docDate: res.docDate || firstDate || today(),
          });
        }
      }
      // Sort by period start (oldest first)
      bills.sort((a, b) => (a.periodStart || a.docDate).localeCompare(b.periodStart || b.docDate));
      setPerFileBills(bills);

      // Pre-fill single-bill fields from the last (most recent) bill
      const lastBill = bills[bills.length - 1];
      if (lastBill) {
        setBillTotal(lastBill.total);
        setBillPeriodStart(lastBill.periodStart);
        setBillPeriodEnd(lastBill.periodEnd);
      } else {
        const totalIns = mergedInsights.find(i => i.label === 'Total amount');
        if (totalIns) setBillTotal(totalIns.value.replace(/[$,]/g, ''));
      }

      setPhase('review');
    } catch (err) {
      alert(`Error processing files: ${(err as Error).message}`);
      setPhase('upload');
    }
  }, [app.services, preSelectedServiceId]);

  /** Process pasted text (same pipeline as files, without file extraction) */
  const processText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setSourceMode('text');
    setPhase('processing');

    try {
      setProgress({ percent: 20, status: 'Quick scan…' });

      // Quick regex pre-scan for context
      const regexResult = parseDocument(text);
      const knownProvider = regexResult.detectedProvider || undefined;
      const knownCategory = regexResult.detectedCategory || undefined;
      const knownDocTypes = regexResult.docTypes.length > 0 ? regexResult.docTypes : undefined;

      // Try LLM parser with context, fall back to regex
      const aiConfig = getAiConfig();
      let result;
      let usedLlm = false;
      if (aiConfig?.apiKey) {
        const providerLabel = PROVIDERS[aiConfig.providerId]?.label || 'AI';
        setProgress({ percent: 40, status: `Analysing with ${providerLabel}…` });
        const llmResult = await llmParse(text, aiConfig, status => {
          setProgress(prev => ({ ...prev, status }));
        }, { knownProvider, knownCategory, knownDocTypes });
        if (llmResult) {
          result = llmResult;
          usedLlm = true;
          setTokenUsage([llmResult.tokenUsage]);
        } else {
          result = parseDocument(text);
        }
      } else {
        result = regexResult; // Already computed, no need to parse again
      }

      setParserUsed(usedLlm ? 'llm' : 'regex');
      setOcrTexts([text]);
      setOcrText(text);

      if ('summary' in result && (result as LlmParseResult).summary) {
        setSummary((result as LlmParseResult).summary);
      }

      setTitle(result.suggestedTitle || 'Pasted Text');
      setDocTypes(result.docTypes);
      setDocDate(result.docDate || today());
      setProviderName(result.detectedProvider || '');
      setCategory(result.detectedCategory || 'OTHER');
      setNickname(result.detectedProvider
        ? `${result.detectedProvider} ${humanise(result.detectedCategory || 'OTHER')}`
        : '');

      // Auto-match service
      if (!preSelectedServiceId) {
        let match = null;
        if (result.detectedProvider) {
          match = app.services.find(s =>
            s.provider.toLowerCase() === result.detectedProvider!.toLowerCase() ||
            s.nickname.toLowerCase().includes(result.detectedProvider!.toLowerCase())
          );
        }
        if (!match && result.detectedCategory) {
          const catMatches = app.services.filter(s => s.category === result.detectedCategory);
          if (catMatches.length === 1) match = catMatches[0];
        }
        if (match) {
          setMatchedServiceId(match.id);
          setCreateNewService(false);
        } else {
          setMatchedServiceId('');
          setCreateNewService(true);
        }
      }

      // Build review rows
      const effectiveDate = result.docDate || today();
      setRows(result.insights.map(ins => ({
        id: uuid(),
        label: ins.label,
        value: ins.value,
        section: ins.section,
        effectiveDate,
        source: ins.source,
        enabled: true,
      })));

      // Pre-fill bill fields
      const totalIns = result.insights.find(i => i.label === 'Total amount');
      if (totalIns) setBillTotal(totalIns.value.replace(/[$,]/g, ''));
      const ps = result.insights.find(i => i.label === 'Period start');
      if (ps) setBillPeriodStart(ps.value);
      const pe = result.insights.find(i => i.label === 'Period end');
      if (pe) setBillPeriodEnd(pe.value);

      setProgress({ percent: 100, status: 'Done' });
      setPhase('review');
    } catch (err) {
      alert(`Error processing text: ${(err as Error).message}`);
      setPhase('upload');
    }
  }, [app.services, preSelectedServiceId]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) processFiles(dropped);
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) processFiles(selected);
  }, [processFiles]);

  // ─── Row editing helpers ──────────────────────────────────

  const updateRow = (id: string, patch: Partial<ReviewRow>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  };

  const deleteRow = (id: string) => {
    setRows(prev => prev.filter(r => r.id !== id));
  };

  const addRow = () => {
    if (!newLabel.trim() || !newValue.trim()) return;
    setRows(prev => [...prev, {
      id: uuid(),
      label: newLabel.trim(),
      value: newValue.trim(),
      section: newSection,
      effectiveDate: docDate || today(),
      enabled: true,
    }]);
    setNewLabel('');
    setNewValue('');
  };

  // ─── Save ─────────────────────────────────────────────────

  const handleSave = async () => {
    if (files.length === 0 && sourceMode === 'file') return;

    const enabledRows = rows.filter(r => r.enabled);
    let targetServiceId = matchedServiceId;

    // Detect the best "amount" for this service from the extracted data
    // Priority: bill total > premium > plan price > category-specific amount labels
    const AMOUNT_LABELS = [
      'Total premium', 'Premium', 'Car premium',           // Insurance
      'Plan price', 'Subscription price',                   // Mobile/Internet/Streaming/Software
      'Rent amount',                                        // Rent
      'Repayment amount',                                   // Mortgage
      'Strata levy',                                        // Strata
      'Rates amount',                                       // Council rates
      'Registration cost', 'CTP premium',                   // Vehicle registration
      'Membership fee', 'Gym membership',                   // Roadside/Gym
      'Account fee',                                        // Bank fees
      'Transport pass',                                     // Public transport
    ];
    const amountRow = enabledRows.find(r => AMOUNT_LABELS.includes(r.label));
    const detectedAmountStr = billTotal
      || amountRow?.value.replace(/[$,\/a-zA-Z]/g, '').trim()
      || '';
    const detectedAmountCents = detectedAmountStr ? Math.round(parseFloat(detectedAmountStr) * 100) : 0;

    // Default billing frequency per category
    const isInsurance = ['HOME_INSURANCE', 'CAR_INSURANCE', 'HEALTH_INSURANCE', 'LIFE_INSURANCE',
      'CONTENTS_INSURANCE', 'PET_INSURANCE', 'TRAVEL_INSURANCE'].includes(category);
    const isEnergy = ['ELECTRICITY', 'GAS', 'WATER'].includes(category);
    const isAnnual = ['VEHICLE_REGISTRATION', 'ROADSIDE_ASSIST', 'COUNCIL_RATES'].includes(category);
    const isQuarterly = ['STRATA'].includes(category);
    const isWeekly = ['RENT'].includes(category);
    const defaultFrequency: BillingFrequency = isInsurance || isAnnual ? 'ANNUALLY'
      : isEnergy || isQuarterly ? 'QUARTERLY'
      : isWeekly ? 'WEEKLY'
      : 'MONTHLY';

    // Create new service if needed
    if (createNewService || !targetServiceId) {
      const newService: Service = {
        id: uuid(),
        nickname: nickname || providerName || 'New Service',
        category,
        provider: providerName,
        planName: '',
        status: 'ACTIVE',
        amountCents: detectedAmountCents,
        billingFrequency: defaultFrequency,
        startDate: '',
        benefitEndDate: '',
        contractEndDate: '',
        exitFeeCents: 0,
        accountNumber: enabledRows.find(r => r.label === 'Account number')?.value
          || enabledRows.find(r => r.label === 'Policy number')?.value || '',
        meterIdentifier: enabledRows.find(r => r.label === 'NMI')?.value
          || enabledRows.find(r => r.label === 'MIRN')?.value || '',
        notes: '',
        summary: summary || undefined,
        customFields: [],
        tariffHistory: [],
        createdAt: today(),
        updatedAt: today(),
      };
      targetServiceId = newService.id;
      await app.saveService(newService);
      await app.reload();
    }

    // Build tariff history entries from enabled tariff/contract/clause rows
    const tariffRows = enabledRows.filter(r =>
      ['tariff', 'contract', 'clause', 'identifier', 'amount', 'coverage'].includes(r.section) && r.section !== 'date'
    );

    // Save documents — either from files or from pasted text
    const docIds: string[] = [];
    const insights: DocInsight[] = enabledRows.map(r => ({
      label: r.label,
      value: r.value,
      source: r.source,
      section: r.section,
      importance: 'medium' as const,
    }));

    if (sourceMode === 'text') {
      // Text-only: save a single document with the pasted text
      const docId = uuid();
      docIds.push(docId);
      const doc: Doc = {
        id: docId,
        serviceId: targetServiceId,
        title: title || 'Pasted Text',
        docTypes,
        docDate: docDate || today(),
        ocrText: ocrText,
        fileName: 'pasted-text.txt',
        mimeType: 'text/plain',
        fileSize: ocrText.length,
        insights,
        userEdits: emptyUserEdits(),
        createdAt: today(),
      };
      await app.saveDoc(doc);
    } else {
      // File mode: save each file as a separate document
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const docId = uuid();
        docIds.push(docId);

        const doc: Doc = {
          id: docId,
          serviceId: targetServiceId,
          title: files.length > 1
            ? `${title || 'Document'} (${i + 1}/${files.length}) — ${f.name}`
            : title || 'Untitled Document',
          docTypes,
          docDate: docDate || today(),
          ocrText: ocrTexts[i] || '',
          fileName: f.name,
          mimeType: f.type,
          fileSize: f.size,
          insights: i === 0 ? insights : [],  // insights only on first doc to avoid duplication
          userEdits: emptyUserEdits(),
          createdAt: today(),
        };
        await app.saveDoc(doc);

        // Store original file
        const bytes = await f.arrayBuffer();
        await app.saveFile(docId, bytes, f.type, f.name);
      }
    }

    // Build tariff entries linked to first document
    const primaryDocId = docIds[0]!;
    const tariffEntries: TariffEntry[] = tariffRows.map(r => ({
      id: uuid(),
      label: r.label,
      value: r.value,
      section: r.section as TariffEntry['section'],
      effectiveDate: r.effectiveDate,
      source: 'parsed' as const,
      docId: primaryDocId,
    }));

    // Update service with new tariff entries
    const svc = app.services.find(s => s.id === targetServiceId)
      || (await app.reload(), app.services.find(s => s.id === targetServiceId));

    if (svc) {
      const existing = svc.tariffHistory || [];
      const uploadedDate = docDate || today();

      // Determine if this upload is historical (older than existing current entries)
      const currentEntries = existing.filter(e => !e.endDate);
      const isHistorical = currentEntries.length > 0 && currentEntries.some(e =>
        e.effectiveDate && uploadedDate < e.effectiveDate
      );

      let updated: TariffEntry[];
      let toAdd: TariffEntry[];

      if (isHistorical) {
        // ── Historical upload: don't touch current entries ──
        // Add new entries as historical with endDate set to the earliest current entry date
        updated = [...existing];
        toAdd = tariffEntries
          .filter(n => !existing.some(e =>
            e.label === n.label && e.value === n.value && e.effectiveDate === n.effectiveDate
          ))
          .map(n => {
            // Find the current entry for this label to set endDate
            const current = currentEntries.find(e => e.label === n.label);
            if (current && current.effectiveDate) {
              return { ...n, endDate: current.effectiveDate };
            }
            return n;
          });
      } else {
        // ── Current/newer upload: replace existing current entries ──
        updated = existing.map(e => {
          if (!e.endDate) {
            const replacement = tariffEntries.find(n => n.label === e.label);
            if (replacement && replacement.value !== e.value) {
              return { ...e, endDate: replacement.effectiveDate };
            }
          }
          return e;
        });
        toAdd = tariffEntries.filter(n =>
          !updated.some(e => e.label === n.label && e.value === n.value && e.effectiveDate === n.effectiveDate)
        );
      }

      const updatedSvc: Service = {
        ...svc,
        tariffHistory: [...updated, ...toAdd],
        updatedAt: today(),
        accountNumber: enabledRows.find(r => r.label === 'Account number')?.value || svc.accountNumber,
        meterIdentifier: enabledRows.find(r => r.label === 'NMI')?.value
          || enabledRows.find(r => r.label === 'MIRN')?.value || svc.meterIdentifier,
      };

      const exitFee = enabledRows.find(r => r.label === 'Exit fee');
      if (exitFee) {
        updatedSvc.exitFeeCents = Math.round(parseFloat(exitFee.value.replace(/[$,]/g, '')) * 100) || svc.exitFeeCents;
      }

      // Update amount: from bill total, premium, or any detected amount
      // Skip amount update if this is a historical upload
      if (!isHistorical && detectedAmountCents > 0 && detectedAmountCents !== svc.amountCents && svc.amountCents > 0) {
        const oldAmountLabel = 'Service cost';
        const oldMoney = '$' + (svc.amountCents / 100).toFixed(2);
        const newMoney = '$' + (detectedAmountCents / 100).toFixed(2);
        // End the old amount entry if it exists
        updatedSvc.tariffHistory = updatedSvc.tariffHistory.map(e =>
          e.label === oldAmountLabel && !e.endDate
            ? { ...e, endDate: docDate || today() }
            : e
        );
        // Add old amount entry if none existed (first time tracking)
        if (!updatedSvc.tariffHistory.some(e => e.label === oldAmountLabel)) {
          updatedSvc.tariffHistory.push({
            id: uuid(), label: oldAmountLabel, value: oldMoney,
            section: 'tariff', effectiveDate: svc.updatedAt || svc.createdAt,
            endDate: docDate || today(), source: 'parsed', docId: primaryDocId,
          });
        }
        // Add new amount entry
        updatedSvc.tariffHistory.push({
          id: uuid(), label: oldAmountLabel, value: newMoney,
          section: 'tariff', effectiveDate: docDate || today(),
          source: 'parsed', docId: primaryDocId,
        });
        updatedSvc.amountCents = detectedAmountCents;
      } else if (!isHistorical && detectedAmountCents > 0) {
        updatedSvc.amountCents = detectedAmountCents;
      }

      // Update policy number if found
      const policyNum = enabledRows.find(r => r.label === 'Policy number');
      if (policyNum) {
        updatedSvc.accountNumber = policyNum.value || svc.accountNumber;
      }

      // Save AI summary if available
      if (summary) {
        updatedSvc.summary = summary;
      }

      await app.saveService(updatedSvc);
    }

    // Create bill records — one per file if we have per-file data, otherwise single bill
    if (docTypes.includes('BILL')) {
      if (perFileBills.length > 0) {
        for (const fb of perFileBills) {
          if (!fb.total && !fb.usageQty) continue;
          await app.saveBill({
            id: uuid(),
            serviceId: targetServiceId,
            periodStart: fb.periodStart,
            periodEnd: fb.periodEnd,
            totalCents: fb.total ? Math.round(parseFloat(fb.total) * 100) : 0,
            usageQuantity: fb.usageQty ? parseFloat(fb.usageQty.replace(/,/g, '')) : null,
            usageUnit: fb.usageUnit || null,
            usageDays: fb.usageDays ? parseInt(fb.usageDays) : null,
            lineItems: [],
            notes: '',
            createdAt: today(),
          });
        }
      } else if (billTotal) {
        await app.saveBill({
          id: uuid(),
          serviceId: targetServiceId,
          periodStart: billPeriodStart,
          periodEnd: billPeriodEnd,
          totalCents: Math.round(parseFloat(billTotal) * 100),
          usageQuantity: null,
          usageUnit: null,
          usageDays: null,
          lineItems: [],
          notes: '',
          createdAt: today(),
        });
      }
    }

    setPhase('saved');
    await app.reload();
    setTimeout(onDone, 800);
  };

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  // ─── Upload phase ─────────────────────────────────────────

  if (phase === 'upload') {
    return (
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>📄 Import Document</h2>
          <button className="btn" onClick={onDone}>← Back</button>
        </div>
        <p className="muted">Upload any bill, contract, or letter. The system will detect the provider, service type, tariffs, dates, and more — then you can review and edit everything before saving.</p>
        <div
          className="dropzone"
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
        >
          <p style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📤</p>
          <p><strong>Drop files here</strong> or click to select</p>
          <p className="muted" style={{ marginTop: '0.5rem' }}>PDF, JPEG, PNG, WebP, HEIC — multiple files OK</p>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>

        {/* ─── Paste from email ──────────────────────────────── */}
        <div className="divider-text"><span>or paste text</span></div>
        <div className="card">
          <h3>📋 Paste from Email / Website</h3>
          <p className="muted" style={{ margin: '0 0 8px' }}>Copy the email content or document text and paste it here.</p>
          <textarea
            className="input paste-area"
            rows={6}
            placeholder="Paste bill, contract, or insurance details here…"
            value={pastedText}
            onChange={e => setPastedText(e.target.value)}
          />
          {pastedText.trim().length > 0 && (
            <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted">{pastedText.trim().split(/\s+/).length} words</span>
              <button className="btn btn--primary" onClick={() => processText(pastedText)}>
                🔍 Analyse Text
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Processing phase ─────────────────────────────────────

  if (phase === 'processing') {
    return (
      <div className="stack" style={{ alignItems: 'center', padding: '3rem' }}>
        <div className="spinner" />
        {files.length > 1 && (
          <p style={{ marginTop: '0.5rem', fontWeight: 600 }}>File {currentFileIdx + 1} of {files.length}</p>
        )}
        <p style={{ marginTop: '0.5rem' }}>{progress.status || 'Starting...'}</p>
        <div className="progress-bar" style={{ marginTop: '0.5rem' }}>
          <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
        </div>
        <p className="muted">{progress.percent}%</p>
      </div>
    );
  }

  // ─── Saved phase ──────────────────────────────────────────

  if (phase === 'saved') {
    return (
      <div className="stack" style={{ alignItems: 'center', padding: '3rem' }}>
        <p style={{ fontSize: '3rem' }}>✅</p>
        <p style={{ fontSize: '1.2rem', fontWeight: 600 }}>Saved!</p>
        <p className="muted">Returning…</p>
      </div>
    );
  }

  // ─── Review phase ─────────────────────────────────────────

  const sectionGroups = [
    { key: 'coverage',   icon: '🛡️', title: 'Coverage & Benefits' },
    { key: 'tariff',     icon: '📊', title: 'Tariffs & Rates' },
    { key: 'contract',   icon: '📋', title: 'Contract Terms' },
    { key: 'clause',     icon: '📌', title: 'Clauses' },
    { key: 'identifier', icon: '🔑', title: 'Identifiers' },
    { key: 'amount',     icon: '💰', title: 'Amounts' },
    { key: 'date',       icon: '📅', title: 'Dates' },
  ];

  const enabledCount = rows.filter(r => r.enabled).length;

  // Detect if this upload is historical (older docs for an existing service)
  const existingSvc = app.services.find(s => s.id === matchedServiceId);
  const existingCurrentEntries = existingSvc?.tariffHistory?.filter(e => !e.endDate) || [];
  const isHistoricalUpload = existingCurrentEntries.length > 0 && existingCurrentEntries.some(e =>
    e.effectiveDate && (docDate || today()) < e.effectiveDate
  );

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Review & Edit</h2>
        <button className="btn" onClick={onDone}>✕ Cancel</button>
      </div>

      {/* Stats */}
      <div className="stats-bar">
        {files.length > 1 && <span className="stat">📎 <strong>{files.length}</strong> files</span>}
        <span className="stat"><strong>{rows.length}</strong> fields detected</span>
        <span className="stat"><strong>{enabledCount}</strong> will be saved</span>
        {isHistoricalUpload && (
          <span className="stat" style={{ color: '#8b5cf6' }}>📜 Historical — won't overwrite current</span>
        )}
        <span className="stat" style={{ marginLeft: 'auto', color: parserUsed === 'llm' ? 'var(--ok)' : 'var(--muted)' }}>
          {parserUsed === 'llm' ? `🤖 ${tokenUsage[0]?.provider ? (PROVIDERS[tokenUsage[0].provider]?.icon || '') + ' ' + (PROVIDERS[tokenUsage[0].provider]?.label || 'AI') : 'AI'}` : '📐 Regex'}
        </span>
        {tokenUsage.length > 0 && (
          <span className="stat" style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
            💰 ${tokenUsage.reduce((s, t) => s + t.estimatedCostUSD, 0).toFixed(4)}
            {' · '}
            {((tokenUsage.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0)) / 1000).toFixed(1)}k tokens
            {' · '}
            {tokenUsage[0]?.model.split('-').slice(1, 3).join(' ')}
          </span>
        )}
      </div>

      {/* ─── AI Summary ──────────────────────────────────── */}
      {summary && (
        <div className="card card--summary">
          <h3>📝 Summary</h3>
          <p style={{ lineHeight: 1.6, margin: 0 }}>{summary}</p>
        </div>
      )}

      {/* ─── Service assignment (auto-resolved, expandable) ── */}
      {(() => {
        const autoResolved = !!(matchedServiceId || createNewService);
        const matchedSvc = app.services.find(s => s.id === matchedServiceId);
        const summaryText = matchedSvc
          ? `🔗 Updating: ${matchedSvc.nickname}`
          : createNewService
            ? `➕ New service: ${nickname || providerName || humanise(category)}`
            : '⚠️ Select a service';

        return (
          <details open={!autoResolved} className="card card--highlight">
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🏢 {summaryText}</span>
              <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.8rem' }}>▸ change</span>
            </summary>

            <div style={{ marginTop: '10px' }}>
              <div className="field" style={{ marginBottom: '8px' }}>
                <label>Assign to</label>
                <select
                  className="input"
                  value={createNewService ? '__new__' : matchedServiceId}
                  onChange={e => {
                    if (e.target.value === '__new__') {
                      setCreateNewService(true);
                      setMatchedServiceId('');
                    } else {
                      setCreateNewService(false);
                      setMatchedServiceId(e.target.value);
                    }
                  }}
                >
                  <option value="">Select existing service…</option>
                  {app.services.map(s => (
                    <option key={s.id} value={s.id}>{s.nickname} ({s.provider})</option>
                  ))}
                  <option value="__new__">➕ Create new service</option>
                </select>
              </div>

              {createNewService && (
                <div className="form-grid" style={{ marginTop: '8px' }}>
                  <div className="field">
                    <label>Provider</label>
                    <input className="input" value={providerName} onChange={e => setProviderName(e.target.value)} placeholder="e.g. Origin Energy" />
                  </div>
                  <div className="field">
                    <label>Nickname</label>
                    <input className="input" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="e.g. Origin Electricity" />
                  </div>
                  <div className="field">
                    <label>Category</label>
                    <select className="input" value={category} onChange={e => setCategory(e.target.value as ServiceCategory)}>
                      {(['ELECTRICITY','GAS','WATER','INTERNET','MOBILE','LANDLINE',
                        'HOME_INSURANCE','CAR_INSURANCE','HEALTH_INSURANCE','LIFE_INSURANCE',
                        'CONTENTS_INSURANCE','PET_INSURANCE','TRAVEL_INSURANCE',
                        'RENT','MORTGAGE','STRATA','COUNCIL_RATES',
                        'STREAMING','SOFTWARE','GYM','SUBSCRIPTION_BOX',
                        'VEHICLE_REGISTRATION','ROADSIDE_ASSIST','TOLL_ACCOUNT','PUBLIC_TRANSPORT',
                        'BANK_FEES','OTHER'] as ServiceCategory[]).map(c => (
                        <option key={c} value={c}>{humanise(c)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          </details>
        );
      })()}

      {/* ─── Document metadata (collapsed by default) ──── */}
      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>📄 {title || 'Document'}</span>
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {docTypes.map(t => DOC_TYPE_LABELS[t]?.icon).join('')} {docDate}
          </span>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.8rem' }}>▸ edit</span>
        </summary>
        <div style={{ marginTop: '10px' }}>
          <div className="form-grid">
            <div className="field">
              <label>Title</label>
              <input className="input" value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label>Date</label>
              <input className="input" type="date" value={docDate} onChange={e => setDocDate(e.target.value)} />
            </div>
          </div>
          <div className="field" style={{ marginTop: '8px' }}>
            <label>Type</label>
            <div className="chips">
              {(Object.entries(DOC_TYPE_LABELS) as [DocumentType, { label: string; icon: string }][]).map(([type, info]) => (
                <button
                  key={type}
                  className="chip"
                  aria-selected={docTypes.includes(type)}
                  onClick={() => setDocTypes(prev =>
                    prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
                  )}
                >
                  {info.icon} {info.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </details>

      {/* ─── Extracted rows by section (with change detection) ── */}
      {(() => {
        // Build lookup of existing tariff entries for comparison
        const existingSvc = app.services.find(s => s.id === matchedServiceId);
        const existingEntries = existingSvc?.tariffHistory || [];

        return sectionGroups.map(({ key, icon, title: secTitle }) => {
          const sectionRows = rows.filter(r => r.section === key);
          if (sectionRows.length === 0) return null;
          return (
            <div key={key} className="card">
              <h3>{icon} {secTitle}</h3>
              {sectionRows.map(row => {
                // Compare against existing data
                const existing = existingEntries.find(e => e.label === row.label && !e.endDate);
                const isChanged = existing && existing.value !== row.value;
                const isNew = !existing && existingSvc;
                const isSame = existing && existing.value === row.value;

                return (
                  <div key={row.id} className="review-row" style={{ opacity: row.enabled ? 1 : 0.4 }}>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={e => updateRow(row.id, { enabled: e.target.checked })}
                    />
                    <div className="review-row__content">
                      <div className="review-row__top">
                        <input
                          className="review-row__label"
                          value={row.label}
                          onChange={e => updateRow(row.id, { label: e.target.value })}
                        />
                        <input
                          className="review-row__value"
                          value={row.value}
                          onChange={e => updateRow(row.id, { value: e.target.value })}
                        />
                        {['tariff', 'contract', 'clause', 'coverage'].includes(row.section) && (
                          <input
                            className="review-row__date"
                            type="date"
                            value={row.effectiveDate}
                            onChange={e => updateRow(row.id, { effectiveDate: e.target.value })}
                            title="Effective date"
                          />
                        )}
                        <button className="btn-icon btn-icon--danger" onClick={() => deleteRow(row.id)} title="Remove">🗑️</button>
                      </div>
                      {/* Change indicator */}
                      {isChanged && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                          ⚡ Changed: <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>{existing.value}</span>
                          <span>→</span> <span style={{ fontWeight: 600 }}>{row.value}</span>
                        </span>
                      )}
                      {isNew && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--ok)', marginTop: 2 }}>✨ New</span>
                      )}
                      {isSame && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 2 }}>= Unchanged</span>
                      )}
                      {row.source && !isChanged && !isNew && !isSame && (
                        <span className="review-row__source">{row.source}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        });
      })()}

      {/* ─── Add custom row ──────────────────────────────── */}
      <div className="card">
        <h3>➕ Add Row</h3>
        <div className="add-row-form">
          <select className="input" value={newSection} onChange={e => setNewSection(e.target.value as DocInsight['section'])} style={{ maxWidth: '140px' }}>
            <option value="coverage">Coverage</option>
            <option value="tariff">Tariff</option>
            <option value="contract">Contract</option>
            <option value="clause">Clause</option>
            <option value="identifier">Identifier</option>
            <option value="amount">Amount</option>
            <option value="date">Date</option>
          </select>
          <input className="input" placeholder="Label" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
          <input className="input" placeholder="Value" value={newValue} onChange={e => setNewValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addRow(); }} />
          <button className="btn btn--small btn--primary" onClick={addRow}>Add</button>
        </div>
      </div>

      {/* ─── Bill details ────────────────────────────────── */}
      {docTypes.includes('BILL') && perFileBills.length > 1 ? (
        <div className="card">
          <h3>🧾 Bills ({perFileBills.length})</h3>
          <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.85rem' }}>
            Each file creates a separate bill record with its own period and usage data.
          </p>
          {perFileBills.map((fb, idx) => {
            const updateBill = (patch: Partial<PerFileBill>) =>
              setPerFileBills(prev => prev.map((b, i) => i === idx ? { ...b, ...patch } : b));
            return (
              <div key={idx} style={{
                padding: '12px', marginBottom: idx < perFileBills.length - 1 ? '8px' : 0,
                borderRadius: '8px', background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                    📄 {fb.fileName}
                  </span>
                  {fb.periodStart && fb.periodEnd && (
                    <span className="tag" style={{ fontSize: '0.75rem' }}>
                      {formatDate(fb.periodStart)} — {formatDate(fb.periodEnd)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
                  <div className="field">
                    <label style={{ fontSize: '0.75rem' }}>Period Start</label>
                    <input className="input" type="date" value={fb.periodStart}
                      onChange={e => updateBill({ periodStart: e.target.value })} style={{ fontSize: '0.85rem' }} />
                  </div>
                  <div className="field">
                    <label style={{ fontSize: '0.75rem' }}>Period End</label>
                    <input className="input" type="date" value={fb.periodEnd}
                      onChange={e => updateBill({ periodEnd: e.target.value })} style={{ fontSize: '0.85rem' }} />
                  </div>
                  <div className="field">
                    <label style={{ fontSize: '0.75rem' }}>Total ($)</label>
                    <input className="input" type="number" step="0.01" value={fb.total}
                      onChange={e => updateBill({ total: e.target.value })} style={{ fontSize: '0.85rem' }} />
                  </div>
                  {(fb.usageQty || USAGE_CATEGORIES.has(category)) && (
                    <>
                      <div className="field">
                        <label style={{ fontSize: '0.75rem' }}>Usage ({fb.usageUnit || 'units'})</label>
                        <input className="input" type="number" step="0.01" value={fb.usageQty}
                          onChange={e => updateBill({ usageQty: e.target.value })} style={{ fontSize: '0.85rem' }} />
                      </div>
                      <div className="field">
                        <label style={{ fontSize: '0.75rem' }}>Days</label>
                        <input className="input" type="number" value={fb.usageDays}
                          onChange={e => updateBill({ usageDays: e.target.value })} style={{ fontSize: '0.85rem' }} />
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : docTypes.includes('BILL') && (
        <div className="card">
          <h3>🧾 Bill</h3>
          <div className="form-grid">
            <div className="field">
              <label>Period Start</label>
              <input className="input" type="date" value={billPeriodStart} onChange={e => setBillPeriodStart(e.target.value)} />
            </div>
            <div className="field">
              <label>Period End</label>
              <input className="input" type="date" value={billPeriodEnd} onChange={e => setBillPeriodEnd(e.target.value)} />
            </div>
            <div className="field">
              <label>Total ($)</label>
              <input className="input" type="number" step="0.01" value={billTotal} onChange={e => setBillTotal(e.target.value)} />
            </div>
            {USAGE_CATEGORIES.has(category) && (
              <>
                <div className="field">
                  <label>Usage ({USAGE_UNITS[category] || 'units'})</label>
                  <input className="input" type="number" step="0.01"
                    value={perFileBills[0]?.usageQty || ''}
                    onChange={e => {
                      const unit = USAGE_UNITS[category] || '';
                      setPerFileBills([{
                        fileIdx: 0, fileName: files[0]?.name || 'Document',
                        periodStart: billPeriodStart, periodEnd: billPeriodEnd,
                        total: billTotal, usageQty: e.target.value, usageUnit: unit,
                        usageDays: perFileBills[0]?.usageDays || '', docDate: docDate || today(),
                      }]);
                    }} />
                </div>
                <div className="field">
                  <label>Days</label>
                  <input className="input" type="number"
                    value={perFileBills[0]?.usageDays || ''}
                    onChange={e => {
                      const unit = USAGE_UNITS[category] || '';
                      setPerFileBills([{
                        fileIdx: 0, fileName: files[0]?.name || 'Document',
                        periodStart: billPeriodStart, periodEnd: billPeriodEnd,
                        total: billTotal, usageQty: perFileBills[0]?.usageQty || '',
                        usageUnit: unit, usageDays: e.target.value, docDate: docDate || today(),
                      }]);
                    }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ─── Raw text toggle ─────────────────────────────── */}
      <details open={showRawText} onToggle={e => setShowRawText((e.target as HTMLDetailsElement).open)}>
        <summary className="btn btn--outline">📝 Raw OCR Text</summary>
        <pre className="raw-text">{ocrText}</pre>
      </details>

      {/* ─── Save bar ────────────────────────────────────── */}
      <div className="save-bar save-bar--sticky">
        <button className="btn" onClick={onDone}>Discard</button>
        <button
          className="btn btn--primary btn--lg"
          disabled={!matchedServiceId && !createNewService}
          onClick={handleSave}
        >
          ✅ Save ({enabledCount} fields{files.length > 1 ? ` + ${files.length} docs` : ''}{docTypes.includes('BILL') && perFileBills.length > 1 ? ` + ${perFileBills.length} bills` : docTypes.includes('BILL') && billTotal ? ' + bill' : ''})
        </button>
      </div>
    </div>
  );
}
