import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../store/AppContext';
import { EditableRow } from '../components/EditableRow';
import type { Document as Doc, DocumentType, DocInsight } from '../types';
import { DOC_TYPE_LABELS, formatDate, today } from '../types';

interface Props {
  serviceId: string;
  docId: string;
  onBack: () => void;
}

export function DocDetailScreen({ serviceId, docId, onBack }: Props) {
  const app = useApp();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [showRawText, setShowRawText] = useState(false);

  // Editable state
  const [title, setTitle] = useState('');
  const [docTypes, setDocTypes] = useState<DocumentType[]>([]);
  const [docDate, setDocDate] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [custom, setCustom] = useState<{ label: string; value: string }[]>([]);
  const [notes, setNotes] = useState('');

  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  const load = useCallback(async () => {
    const d = await app.getDoc(docId);
    if (!d) return;
    setDoc(d);
    setTitle(d.title);
    setDocTypes(d.docTypes || []);
    setDocDate(d.docDate);
    setOverrides(d.userEdits?.overrides || {});
    setHidden(d.userEdits?.hidden || []);
    setCustom(d.userEdits?.custom || []);
    setNotes(d.userEdits?.notes || '');
    setDirty(false);
  }, [docId, app]);

  useEffect(() => { load(); }, [load]);

  const handleViewFile = async () => {
    if (fileUrl) { setFileUrl(null); return; }
    const f = await app.loadFile(docId);
    if (!f) { alert('File not found'); return; }
    const blob = new Blob([f.bytes], { type: f.mimeType });
    setFileUrl(URL.createObjectURL(blob));
  };

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    if (!doc) return;
    await app.saveDoc({
      ...doc,
      title,
      docTypes,
      docDate,
      userEdits: { overrides, hidden, custom, notes },
    });

    // Propagate overrides to the service's tariffHistory so the
    // ServiceDetailScreen shows the edited values immediately.
    const svc = app.services.find(s => s.id === serviceId);
    if (svc && Object.keys(overrides).length > 0) {
      let changed = false;
      const updated = svc.tariffHistory.map(entry => {
        // Match by docId + label
        if (entry.docId === docId && overrides[entry.label] != null) {
          changed = true;
          return { ...entry, value: overrides[entry.label]! };
        }
        return entry;
      });
      if (changed) {
        await app.saveService({ ...svc, tariffHistory: updated, updatedAt: today() });
      }
    }

    setDirty(false);
    await load();
  };

  const handleDelete = async () => {
    if (confirm('Delete this document?')) {
      await app.deleteDoc(docId);
      onBack();
    }
  };

  const toggleType = (type: DocumentType) => {
    setDocTypes(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]);
    markDirty();
  };

  if (!doc) return <div className="loading"><div className="spinner" /></div>;

  const visibleInsights = (doc.insights || []).filter(i => !hidden.includes(i.label));

  const sectionGroups: { key: string; label: string; items: DocInsight[] }[] = [
    { key: 'tariff',     label: '📊 Tariffs',        items: visibleInsights.filter(i => i.section === 'tariff') },
    { key: 'contract',   label: '📋 Contract Terms',  items: visibleInsights.filter(i => i.section === 'contract') },
    { key: 'clause',     label: '📌 Clauses',         items: visibleInsights.filter(i => i.section === 'clause') },
    { key: 'identifier', label: '🔑 Identifiers',     items: visibleInsights.filter(i => i.section === 'identifier') },
    { key: 'amount',     label: '💰 Amounts',         items: visibleInsights.filter(i => i.section === 'amount') },
    { key: 'date',       label: '📅 Dates',           items: visibleInsights.filter(i => i.section === 'date') },
  ];

  const highlights = visibleInsights.filter(i => i.importance === 'high');

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn" onClick={onBack}>← Back</button>
        <button className="btn btn--danger" onClick={handleDelete}>Delete Document</button>
      </div>

      {/* Metadata */}
      <div className="card">
        <h3>Document Info</h3>
        <div className="form-grid">
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={e => { setTitle(e.target.value); markDirty(); }} />
          </div>
          <div className="field">
            <label>Date</label>
            <input type="date" value={docDate} onChange={e => { setDocDate(e.target.value); markDirty(); }} />
          </div>
        </div>
        <div className="field">
          <label>Type</label>
          <div className="chips">
            {(Object.entries(DOC_TYPE_LABELS) as [DocumentType, { label: string; icon: string }][]).map(([type, info]) => (
              <button key={type} className="chip" aria-selected={docTypes.includes(type)} onClick={() => toggleType(type)}>
                {info.icon} {info.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted">{doc.fileName} · {(doc.fileSize / 1024).toFixed(0)} KB · {formatDate(doc.createdAt)}</p>
        <button className="btn btn--outline" onClick={handleViewFile}>
          {fileUrl ? 'Hide original' : '📎 View original file'}
        </button>
      </div>

      {/* File viewer */}
      {fileUrl && (
        <div className="card">
          {doc.mimeType.startsWith('image/') ? (
            <img src={fileUrl} alt="Original document" style={{ maxWidth: '100%' }} />
          ) : (
            <iframe src={fileUrl} style={{ width: '100%', height: '80vh', border: 'none' }} title="Document" />
          )}
        </div>
      )}

      {/* Highlights */}
      {highlights.length > 0 && (
        <div className="card card--highlight">
          <h3>🔍 Key Findings</h3>
          {highlights.map((h, i) => (
            <div key={i} className="fact-row">
              <span className="fact-label">{h.label}</span>
              <span className={`fact-value ${overrides[h.label] ? 'fact-value--edited' : ''}`}>
                {overrides[h.label] || h.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Insight sections */}
      {sectionGroups.map(({ key, label, items }) => {
        if (items.length === 0) return null;
        return (
          <div key={key} className="card">
            <h3>{label}</h3>
            {items.map((ins, i) => (
              <EditableRow
                key={i}
                label={ins.label}
                value={overrides[ins.label] || ins.value}
                source={ins.source}
                isOverridden={!!overrides[ins.label]}
                onSave={v => { setOverrides(prev => ({ ...prev, [ins.label]: v })); markDirty(); }}
                onDelete={() => { setHidden(prev => [...prev, ins.label]); markDirty(); }}
                onRestore={overrides[ins.label] ? () => {
                  const { [ins.label]: _, ...rest } = overrides;
                  setOverrides(rest);
                  markDirty();
                } : undefined}
              />
            ))}
          </div>
        );
      })}

      {/* Custom fields */}
      <div className="card">
        <h3>➕ Custom Fields</h3>
        {custom.map((f, i) => (
          <EditableRow
            key={i}
            label={f.label}
            value={f.value}
            onSave={v => {
              const next = [...custom];
              next[i] = { ...f, value: v };
              setCustom(next);
              markDirty();
            }}
            onDelete={() => {
              setCustom(prev => prev.filter((_, j) => j !== i));
              markDirty();
            }}
          />
        ))}
        <div className="add-row-form">
          <input placeholder="Label" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="fact-input" />
          <input placeholder="Value" value={newValue} onChange={e => setNewValue(e.target.value)} className="fact-input"
            onKeyDown={e => { if (e.key === 'Enter') {
              if (newLabel.trim() && newValue.trim()) {
                setCustom(prev => [...prev, { label: newLabel.trim(), value: newValue.trim() }]);
                setNewLabel(''); setNewValue(''); markDirty();
              }
            }}} />
          <button className="btn btn--small btn--primary" onClick={() => {
            if (newLabel.trim() && newValue.trim()) {
              setCustom(prev => [...prev, { label: newLabel.trim(), value: newValue.trim() }]);
              setNewLabel(''); setNewValue(''); markDirty();
            }
          }}>Add</button>
        </div>
      </div>

      {/* Notes */}
      <div className="card">
        <h3>📝 Notes</h3>
        <textarea
          value={notes}
          onChange={e => { setNotes(e.target.value); markDirty(); }}
          rows={4}
          placeholder="Add notes about this document..."
        />
      </div>

      {/* Raw text */}
      <details open={showRawText} onToggle={e => setShowRawText((e.target as HTMLDetailsElement).open)}>
        <summary className="btn btn--outline">Full OCR Text</summary>
        <pre className="raw-text">{doc.ocrText}</pre>
      </details>

      {/* Save bar */}
      {dirty && (
        <div className="save-bar save-bar--sticky">
          <button className="btn" onClick={load}>Discard Changes</button>
          <button className="btn btn--primary" onClick={handleSave}>💾 Save Changes</button>
        </div>
      )}
    </div>
  );
}
