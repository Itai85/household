import { useState } from 'react';

interface Props {
  label: string;
  value: string;
  source?: string;
  isOverridden?: boolean;
  onSave: (newValue: string) => void;
  onDelete?: () => void;
  onRestore?: () => void;
}

export function EditableRow({ label, value, source, isOverridden, onSave, onDelete, onRestore }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [showSource, setShowSource] = useState(false);

  const confirmEdit = () => {
    if (draft.trim() && draft !== value) {
      onSave(draft.trim());
    }
    setEditing(false);
  };

  return (
    <div className="fact-row">
      <span className="fact-label">{label}</span>
      <div className="fact-value-area">
        {editing ? (
          <span className="fact-edit">
            <input
              className="fact-input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmEdit();
                if (e.key === 'Escape') setEditing(false);
              }}
              autoFocus
            />
            <button className="btn-icon" onClick={e => { e.stopPropagation(); confirmEdit(); }} title="Save">✓</button>
            <button className="btn-icon" onClick={e => { e.stopPropagation(); setEditing(false); }} title="Cancel">✕</button>
          </span>
        ) : (
          <span
            className={`fact-value ${isOverridden ? 'fact-value--edited' : ''}`}
            onClick={() => { setDraft(value); setEditing(true); }}
            title="Click to edit"
          >
            {value} {isOverridden && <span className="tag tag--accent">(edited)</span>}
          </span>
        )}
        <span className="fact-actions">
          {source && (
            <button className="btn-icon" onClick={e => { e.stopPropagation(); setShowSource(!showSource); }} title="Toggle source">📄</button>
          )}
          {isOverridden && onRestore && (
            <button className="btn-icon" onClick={e => { e.stopPropagation(); onRestore(); }} title="Restore original">↩️</button>
          )}
          {onDelete && (
            <button className="btn-icon btn-icon--danger" onClick={e => { e.stopPropagation(); onDelete(); }} title="Delete">🗑️</button>
          )}
        </span>
      </div>
      {showSource && source && (
        <div className="fact-source">Source: {source}</div>
      )}
    </div>
  );
}
