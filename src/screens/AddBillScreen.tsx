import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../store/AppContext';
import { today, USAGE_CATEGORIES, USAGE_UNITS } from '../types';

interface Props {
  serviceId: string;
  onDone: () => void;
}

export function AddBillScreen({ serviceId, onDone }: Props) {
  const app = useApp();
  const svc = app.services.find(s => s.id === serviceId);
  const isUsageSvc = svc ? USAGE_CATEGORIES.has(svc.category) : false;
  const usageUnit = svc ? USAGE_UNITS[svc.category] || '' : '';

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [totalDollars, setTotalDollars] = useState('');
  const [usageQty, setUsageQty] = useState('');
  const [usageDays, setUsageDays] = useState('');
  const [notes, setNotes] = useState('');

  const handleSave = async () => {
    if (!totalDollars) return;
    await app.saveBill({
      id: uuid(),
      serviceId,
      periodStart,
      periodEnd,
      totalCents: Math.round(parseFloat(totalDollars) * 100),
      usageQuantity: usageQty ? parseFloat(usageQty) : null,
      usageUnit: usageUnit || null,
      usageDays: usageDays ? parseInt(usageDays) : null,
      lineItems: [],
      notes,
      createdAt: today(),
    });
    onDone();
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Add Bill</h2>
        <button className="btn" onClick={onDone}>← Back</button>
      </div>

      <div className="form-grid">
        <div className="field">
          <label>Period Start</label>
          <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
        </div>
        <div className="field">
          <label>Period End</label>
          <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
        </div>
        <div className="field">
          <label>Total ($) *</label>
          <input type="number" step="0.01" value={totalDollars} onChange={e => setTotalDollars(e.target.value)} placeholder="0.00" />
        </div>
        {isUsageSvc && (
          <>
            <div className="field">
              <label>Usage ({usageUnit || 'units'})</label>
              <input type="number" step="0.01" value={usageQty} onChange={e => setUsageQty(e.target.value)} placeholder={`e.g. 450 ${usageUnit}`} />
            </div>
            <div className="field">
              <label>Days</label>
              <input type="number" value={usageDays} onChange={e => setUsageDays(e.target.value)} />
            </div>
          </>
        )}
        <div className="field field--full">
          <label>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} />
        </div>
      </div>

      <div className="row">
        <button className="btn btn--primary" onClick={handleSave}>Save Bill</button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
