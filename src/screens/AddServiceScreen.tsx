import { useState, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../store/AppContext';
import { saveService as storageSave } from '../platform/storage';
import {
  CATEGORY_GROUPS, FREQUENCY_LABELS,
  type Service, type ServiceCategory, type BillingFrequency,
  today, humanise,
} from '../types';

interface Props {
  editId?: string;
  onDone: () => void;
}

/* ── Category → field-relevance mapping ── */

type CatGroup = 'energy' | 'water' | 'telecom' | 'insurance' | 'housing' | 'transport' | 'subs' | 'finance' | 'other';

const CAT_TO_GROUP: Record<ServiceCategory, CatGroup> = Object.fromEntries(
  Object.entries(CATEGORY_GROUPS).flatMap(([g, { categories }]) =>
    categories.map(c => [c, g as CatGroup]),
  ),
) as Record<ServiceCategory, CatGroup>;

/** Which optional fields are relevant per group */
const GROUP_FIELDS: Record<CatGroup, {
  showMeter?: boolean;
  showExitFee?: boolean;
  showPlanName?: boolean;
  showBenefitEnd?: boolean;
  showContractEnd?: boolean;
  accountLabel?: string;
  meterLabel?: string;
}> = {
  energy:    { showMeter: true, showExitFee: true, showContractEnd: true, accountLabel: 'Account Number', meterLabel: 'Meter ID (NMI/MIRN)' },
  water:     { showMeter: true, showExitFee: true, showContractEnd: true, accountLabel: 'Account Number', meterLabel: 'Meter ID' },
  telecom:   { showExitFee: true, showPlanName: true, showContractEnd: true, accountLabel: 'Account Number' },
  insurance: { showBenefitEnd: true, showPlanName: true, accountLabel: 'Policy Number' },
  housing:   { showContractEnd: true, accountLabel: 'Reference Number' },
  transport: { showBenefitEnd: true, accountLabel: 'Registration / Member No.' },
  subs:      { showPlanName: true, showContractEnd: true, accountLabel: 'Account ID' },
  finance:   { accountLabel: 'Account Number (BSB-Acct)' },
  other:     { showExitFee: true, showContractEnd: true, accountLabel: 'Account / Reference' },
};

/* ── Grouped dropdown options ── */
const GROUPED_OPTIONS = Object.entries(CATEGORY_GROUPS).map(([, { label, icon, categories }]) => ({
  label: `${icon} ${label}`,
  options: categories.map(c => ({ value: c, label: humanise(c) })),
}));

function emptyService(): Service {
  return {
    id: uuid(), nickname: '', category: 'ELECTRICITY' as ServiceCategory,
    provider: '', planName: '', status: 'ACTIVE',
    amountCents: 0, billingFrequency: 'MONTHLY' as BillingFrequency,
    startDate: '', benefitEndDate: '', contractEndDate: '',
    exitFeeCents: 0, accountNumber: '', meterIdentifier: '',
    notes: '', customFields: [], tariffHistory: [],
    createdAt: today(), updatedAt: today(),
  };
}

export function AddServiceScreen({ editId, onDone }: Props) {
  const app = useApp();
  const [svc, setSvc] = useState<Service>(emptyService());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dollars, setDollars] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editId) {
      const found = app.services.find(s => s.id === editId);
      if (found) {
        setSvc(found);
        setDollars((found.amountCents / 100).toFixed(2));
        // Auto-expand advanced if any advanced field has data
        if (found.planName || found.startDate || found.benefitEndDate || found.contractEndDate
          || found.exitFeeCents || found.accountNumber || found.meterIdentifier || found.notes) {
          setShowAdvanced(true);
        }
      }
    }
  }, [editId, app.services]);

  const set = <K extends keyof Service>(key: K, val: Service[K]) =>
    setSvc(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    if (!svc.nickname.trim() || saving) return;
    setSaving(true);
    const amountCents = Math.round(parseFloat(dollars || '0') * 100);
    try {
      // Save directly to storage (single fast upsert)
      await storageSave({ ...svc, amountCents, updatedAt: today() });
    } catch (err) {
      console.error('Save failed:', err);
      setSaving(false);
      return;
    }
    // Navigate back immediately — don't wait for full reload
    onDone();
    // Refresh service list in background
    app.reload().catch(() => {});
  };

  const group = CAT_TO_GROUP[svc.category] || 'other';
  const fields = GROUP_FIELDS[group] || GROUP_FIELDS.other;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{editId ? 'Edit Service' : 'Add Service'}</h2>
        <button className="btn" onClick={onDone}>← Back</button>
      </div>

      {/* ── Category dropdown (grouped) ── */}
      <div className="field">
        <label>Category</label>
        <select
          value={svc.category}
          onChange={e => set('category', e.target.value as ServiceCategory)}
          style={{ fontSize: '1rem', padding: '0.6em 0.8em' }}
        >
          {GROUPED_OPTIONS.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* ── Core fields ── */}
      <div className="form-grid">
        <div className="field">
          <label>Service Name *</label>
          <input value={svc.nickname} onChange={e => set('nickname', e.target.value)} placeholder="e.g. AGL Electricity" />
        </div>
        <div className="field">
          <label>Provider</label>
          <input value={svc.provider} onChange={e => set('provider', e.target.value)} placeholder="e.g. AGL" />
        </div>
        <div className="field">
          <label>Amount ($)</label>
          <input type="number" step="0.01" value={dollars} onChange={e => setDollars(e.target.value)} placeholder="0.00" />
        </div>
        <div className="field">
          <label>Billing Frequency</label>
          <select value={svc.billingFrequency} onChange={e => set('billingFrequency', e.target.value as BillingFrequency)}>
            {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Advanced fields (context-sensitive) ── */}
      <button className="btn btn--outline" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? '▾ Less details' : '▸ More details'}
      </button>

      {showAdvanced && (
        <div className="form-grid">
          {fields.showPlanName && (
            <div className="field">
              <label>Plan Name</label>
              <input value={svc.planName} onChange={e => set('planName', e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Start Date</label>
            <input type="date" value={svc.startDate} onChange={e => set('startDate', e.target.value)} />
          </div>
          {fields.showBenefitEnd && (
            <div className="field">
              <label>{group === 'insurance' ? 'Policy End Date' : 'Benefit End Date'}</label>
              <input type="date" value={svc.benefitEndDate} onChange={e => set('benefitEndDate', e.target.value)} />
            </div>
          )}
          {fields.showContractEnd && (
            <div className="field">
              <label>{group === 'housing' ? 'Lease End Date' : 'Contract End Date'}</label>
              <input type="date" value={svc.contractEndDate} onChange={e => set('contractEndDate', e.target.value)} />
            </div>
          )}
          {fields.showExitFee && (
            <div className="field">
              <label>Exit Fee ($)</label>
              <input type="number" step="0.01"
                value={svc.exitFeeCents ? (svc.exitFeeCents / 100).toFixed(2) : ''}
                onChange={e => set('exitFeeCents', Math.round(parseFloat(e.target.value || '0') * 100))}
              />
            </div>
          )}
          <div className="field">
            <label>{fields.accountLabel || 'Account Number'}</label>
            <input value={svc.accountNumber} onChange={e => set('accountNumber', e.target.value)} />
          </div>
          {fields.showMeter && (
            <div className="field">
              <label>{fields.meterLabel || 'Meter ID'}</label>
              <input value={svc.meterIdentifier} onChange={e => set('meterIdentifier', e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Status</label>
            <select value={svc.status} onChange={e => set('status', e.target.value as Service['status'])}>
              <option value="ACTIVE">Active</option>
              <option value="PENDING">Pending</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>
          <div className="field field--full">
            <label>Notes</label>
            <textarea value={svc.notes} onChange={e => set('notes', e.target.value)} rows={3} />
          </div>
        </div>
      )}

      <div className="row">
        <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : editId ? 'Save Changes' : 'Add Service'}
        </button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
