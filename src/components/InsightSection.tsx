import { useState } from 'react';
import type { DocInsight, CustomField } from '../types';
import { EditableRow } from './EditableRow';

interface Props {
  icon: string;
  title: string;
  sectionKey: 'tariff' | 'contract' | 'clause';
  insights: (DocInsight & { docId: string; isOverridden: boolean; displayValue: string })[];
  manualRows: (CustomField & { fieldIndex: number })[];
  onOverride: (docId: string, label: string, newValue: string) => void;
  onRemoveOverride: (docId: string, label: string) => void;
  onHide: (docId: string, label: string) => void;
  onAddManual: (field: CustomField) => void;
  onEditManual: (index: number, field: CustomField) => void;
  onRemoveManual: (index: number) => void;
}

export function InsightSection({
  icon, title, sectionKey, insights, manualRows,
  onOverride, onRemoveOverride, onHide,
  onAddManual, onEditManual, onRemoveManual,
}: Props) {
  const [addingRow, setAddingRow] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  const handleAdd = () => {
    if (newLabel.trim() && newValue.trim()) {
      onAddManual({ label: newLabel.trim(), value: newValue.trim(), section: sectionKey });
      setNewLabel('');
      setNewValue('');
      setAddingRow(false);
    }
  };

  return (
    <div className="card insight-card">
      <h3>{icon} {title}</h3>

      {insights.length === 0 && manualRows.length === 0 && !addingRow && (
        <p className="muted">No data yet. Import a document or add manually.</p>
      )}

      {insights.map((ins, i) => (
        <EditableRow
          key={`doc-${i}`}
          label={ins.label}
          value={ins.displayValue}
          source={ins.source}
          isOverridden={ins.isOverridden}
          onSave={v => onOverride(ins.docId, ins.label, v)}
          onDelete={() => onHide(ins.docId, ins.label)}
          onRestore={ins.isOverridden ? () => onRemoveOverride(ins.docId, ins.label) : undefined}
        />
      ))}

      {manualRows.map((row) => (
        <EditableRow
          key={`manual-${row.fieldIndex}`}
          label={row.label}
          value={row.value}
          onSave={v => onEditManual(row.fieldIndex, { ...row, value: v })}
          onDelete={() => onRemoveManual(row.fieldIndex)}
        />
      ))}

      {addingRow && (
        <div className="add-row-form">
          <input
            placeholder="Label"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            className="fact-input"
            autoFocus
          />
          <input
            placeholder="Value"
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            className="fact-input"
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          />
          <button className="btn btn--small btn--primary" onClick={handleAdd}>Add</button>
          <button className="btn btn--small" onClick={() => setAddingRow(false)}>Cancel</button>
        </div>
      )}

      <button
        className="btn btn--small btn--outline add-row-btn"
        onClick={() => setAddingRow(true)}
      >
        + Add row
      </button>
    </div>
  );
}
