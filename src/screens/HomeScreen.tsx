import { useApp } from '../store/AppContext';
import { money, humanise, monthlyAmount, annualAmount, effectiveMonthly, USAGE_CATEGORIES, CATEGORY_GROUPS, type ServiceCategory } from '../types';

interface Props {
  onNavigate: (page: string, params?: Record<string, string>) => void;
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

  return (
    <div className="stack">
      {/* ── Single prominent action: upload document ── */}
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

      {/* Summary cards */}
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

      {/* Category breakdown */}
      {services.length > 0 && (
        <div className="card">
          <h3>By Category</h3>
          {Object.values(CATEGORY_GROUPS).map(group => {
            const groupSvcs = group.categories.flatMap(c => byCategory.get(c) || []);
            if (groupSvcs.length === 0) return null;
            const groupMonthly = groupSvcs.reduce((s, svc) => s + effectiveMonthly(svc), 0);
            return (
              <div key={group.label} className="category-row">
                <span>{group.icon} {group.label}</span>
                <span className="muted">{groupSvcs.length} service{groupSvcs.length > 1 ? 's' : ''}</span>
                <span className="money">{money(groupMonthly)}/mo</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Service list */}
      {services.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Services</h2>
            <button className="btn btn--outline btn--small" onClick={() => onNavigate('add-service')}>+ Add Manually</button>
          </div>
          <div className="service-grid">
            {services.map(svc => (
              <div
                key={svc.id}
                className="card service-card"
                onClick={() => onNavigate('service', { id: svc.id })}
              >
                <div className="service-card__header">
                  <span className="service-card__name">{svc.nickname}</span>
                  <span className="tag">{humanise(svc.category)}</span>
                </div>
                <div className="service-card__details">
                  {svc.provider && <span className="muted">{svc.provider}</span>}
                  {USAGE_CATEGORIES.has(svc.category) && svc.billAvgMonthlyCents && svc.billAvgMonthlyCents > 0 ? (
                    <>
                      <span className="money">~{money(svc.billAvgMonthlyCents)}</span>
                      <span className="muted">/ mo avg</span>
                      {svc.billCount && <span className="muted" style={{ fontSize: '0.75rem' }}>({svc.billCount} bills)</span>}
                    </>
                  ) : (
                    <>
                      <span className="money">{money(svc.amountCents)}</span>
                      <span className="muted">/ {svc.billingFrequency.toLowerCase().replace('_', ' ')}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
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
