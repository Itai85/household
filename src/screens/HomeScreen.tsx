import { useApp } from '../store/AppContext';
import { money, humanise, monthlyAmount, annualAmount, effectiveMonthly, USAGE_CATEGORIES, CATEGORY_GROUPS, type ServiceCategory, type Service } from '../types';

interface Props {
  onNavigate: (page: string, params?: Record<string, string>) => void;
}

/* ── Category → group colour accent (left stripe) ── */
const GROUP_COLORS: Record<string, string> = {
  energy:    '#f59e0b',  // amber
  water:     '#3b82f6',  // blue
  telecom:   '#8b5cf6',  // violet
  insurance: '#10b981',  // emerald
  housing:   '#ec4899',  // pink
  transport: '#f97316',  // orange
  subs:      '#06b6d4',  // cyan
  finance:   '#6366f1',  // indigo
  other:     '#64748b',  // slate
};

function groupKeyForCategory(cat: ServiceCategory): string {
  for (const [key, { categories }] of Object.entries(CATEGORY_GROUPS)) {
    if ((categories as readonly string[]).includes(cat)) return key;
  }
  return 'other';
}

function ServiceRow({ svc, onNavigate }: { svc: Service; onNavigate: Props['onNavigate'] }) {
  const groupKey = groupKeyForCategory(svc.category);
  const color = GROUP_COLORS[groupKey] || GROUP_COLORS.other;
  const isMetered = USAGE_CATEGORIES.has(svc.category) && svc.billAvgMonthlyCents && svc.billAvgMonthlyCents > 0;

  return (
    <tr
      className="svc-row"
      onClick={() => onNavigate('service', { id: svc.id })}
    >
      <td className="svc-row__stripe" style={{ '--stripe': color } as React.CSSProperties} />
      <td className="svc-row__name">
        <span className="svc-row__nickname">{svc.nickname}</span>
        {svc.provider && <span className="svc-row__provider">{svc.provider}</span>}
      </td>
      <td className="svc-row__cat">
        <span className="svc-tag" style={{ '--tag-color': color } as React.CSSProperties}>
          {humanise(svc.category)}
        </span>
      </td>
      <td className="svc-row__amount">
        {isMetered ? (
          <>
            <span className="svc-row__money">~{money(svc.billAvgMonthlyCents!)}</span>
            <span className="svc-row__freq">/mo avg</span>
          </>
        ) : (
          <>
            <span className="svc-row__money">{money(svc.amountCents)}</span>
            <span className="svc-row__freq">/{svc.billingFrequency.toLowerCase().replace('_', ' ')}</span>
          </>
        )}
      </td>
      <td className="svc-row__arrow">›</td>
    </tr>
  );
}

export function HomeScreen({ onNavigate }: Props) {
  const { services, loading } = useApp();

  if (loading) return <div className="loading"><div className="spinner" /></div>;

  const totalMonthly = services.reduce((s, svc) => s + effectiveMonthly(svc), 0);
  const totalAnnual = annualAmount(totalMonthly, 'MONTHLY');

  // Group by category
  const byCategory = new Map<ServiceCategory, typeof services>();
  for (const svc of services) {
    const list = byCategory.get(svc.category) || [];
    list.push(svc);
    byCategory.set(svc.category, list);
  }

  // Sort services by group then name for clean grouping
  const sorted = [...services].sort((a, b) => {
    const ga = groupKeyForCategory(a.category);
    const gb = groupKeyForCategory(b.category);
    if (ga !== gb) return ga.localeCompare(gb);
    return a.nickname.localeCompare(b.nickname);
  });

  return (
    <div className="stack">
      {/* ── Upload action ── */}
      <div className="card import-card" onClick={() => onNavigate('import-doc')} style={{ cursor: 'pointer' }}>
        <div className="import-card__header">
          <span className="import-card__icon">📤</span>
          <div>
            <h3 style={{ margin: 0 }}>Upload Document</h3>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Upload a bill, contract, or letter — the service will be created or updated automatically
            </p>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: '1.5rem', opacity: 0.5 }}>→</span>
        </div>
      </div>

      {/* Summary strip */}
      {services.length > 0 && (
        <div className="summary-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="card summary-card">
            <span className="summary-label">Monthly</span>
            <span className="summary-value">{money(totalMonthly)}</span>
          </div>
          <div className="card summary-card">
            <span className="summary-label">Annual</span>
            <span className="summary-value">{money(totalAnnual)}</span>
          </div>
          <div className="card summary-card">
            <span className="summary-label">Services</span>
            <span className="summary-value">{services.length}</span>
          </div>
          <div
            className="card summary-card"
            onClick={() => onNavigate('dashboard')}
            style={{ cursor: 'pointer', borderColor: 'var(--accent)', transition: 'transform 0.1s' }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'none')}
          >
            <span className="summary-label">Dashboard</span>
            <span className="summary-value" style={{ fontSize: '1.4rem' }}>📊</span>
          </div>
        </div>
      )}

      {/* ── Service table ── */}
      {services.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Services</h2>
            <button className="btn btn--outline btn--small" onClick={() => onNavigate('add-service')}>+ Add Manually</button>
          </div>
          <div className="svc-table-wrap">
            <table className="svc-table">
              <thead>
                <tr>
                  <th className="svc-th svc-th--stripe" />
                  <th className="svc-th svc-th--name">Service</th>
                  <th className="svc-th svc-th--cat">Category</th>
                  <th className="svc-th svc-th--amount">Amount</th>
                  <th className="svc-th svc-th--arrow" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(svc => (
                  <ServiceRow key={svc.id} svc={svc} onNavigate={onNavigate} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Category breakdown (compact) */}
          <div className="cat-breakdown">
            {Object.entries(CATEGORY_GROUPS).map(([key, group]) => {
              const groupSvcs = group.categories.flatMap(c => byCategory.get(c) || []);
              if (groupSvcs.length === 0) return null;
              const groupMonthly = groupSvcs.reduce((s, svc) => s + effectiveMonthly(svc), 0);
              const color = GROUP_COLORS[key] || GROUP_COLORS.other;
              return (
                <div key={key} className="cat-chip" style={{ '--chip-color': color } as React.CSSProperties}>
                  <span className="cat-chip__icon">{group.icon}</span>
                  <span className="cat-chip__label">{group.label}</span>
                  <span className="cat-chip__amount">{money(groupMonthly)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {services.length === 0 && (
        <div className="empty">
          <p>No services yet. Upload a document to get started — the service will be created automatically.</p>
          <p className="muted" style={{ marginTop: '8px' }}>
            Or <button className="btn btn--outline btn--small" onClick={() => onNavigate('add-service')}>add a service manually</button>
          </p>
        </div>
      )}
    </div>
  );
}
