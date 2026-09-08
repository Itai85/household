import { useApp } from '../store/AppContext';
import { money, humanise, monthlyAmount, annualAmount, effectiveMonthly, USAGE_CATEGORIES, CATEGORY_GROUPS, type ServiceCategory, type Service } from '../types';

interface Props {
  onNavigate: (page: string, params?: Record<string, string>) => void;
}

/* ── Category → group colour accent (left stripe) ── */
const GROUP_COLORS: Record<string, string> = {
  energy:    '#eab308',  // yellow
  water:     '#38bdf8',  // sky
  telecom:   '#a78bfa',  // violet-light
  insurance: '#34d399',  // emerald
  housing:   '#f472b6',  // pink
  transport: '#fb923c',  // orange
  subs:      '#22d3ee',  // cyan
  finance:   '#818cf8',  // indigo-light
  other:     '#94a3b8',  // slate
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
      {/* ── Hero strip: KPIs + actions ── */}
      {services.length > 0 && (
        <div className="hero-strip">
          <div className="hero-strip__kpis">
            <div className="kpi kpi--primary">
              <span className="kpi__value">{money(totalMonthly)}</span>
              <span className="kpi__label">per month</span>
            </div>
            <div className="kpi__divider" />
            <div className="kpi">
              <span className="kpi__value">{money(totalAnnual)}</span>
              <span className="kpi__label">per year</span>
            </div>
            <div className="kpi__divider" />
            <div className="kpi">
              <span className="kpi__value">{services.length}</span>
              <span className="kpi__label">services</span>
            </div>
          </div>
          <div className="hero-strip__actions">
            <button className="hero-btn hero-btn--upload" onClick={() => onNavigate('import-doc')}>
              <span className="hero-btn__icon">📤</span>
              <span>Upload</span>
            </button>
            <button className="hero-btn hero-btn--dash" onClick={() => onNavigate('dashboard')}>
              <span className="hero-btn__icon">📊</span>
              <span>Dashboard</span>
            </button>
          </div>
        </div>
      )}

      {services.length === 0 && (
        <div className="upload-bar" onClick={() => onNavigate('import-doc')}>
          <span className="upload-bar__icon">📤</span>
          <div className="upload-bar__text">
            <div className="upload-bar__title">Upload Document</div>
            <div className="upload-bar__desc">Bill, contract, or letter — auto-detected</div>
          </div>
          <span className="upload-bar__arrow">→</span>
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
