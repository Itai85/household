import { useApp } from '../store/AppContext';
import { hasAiConfig, getNotificationPrefs, setNotificationPrefs } from '../platform/storage';
import { money, humanise, monthlyAmount, annualAmount, effectiveMonthly, daysUntil, formatDate, USAGE_CATEGORIES, CATEGORY_GROUPS, type ServiceCategory, type Service } from '../types';

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
  const aiConfigured = hasAiConfig();

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
      {/* ── AI banner: shown until provider is configured ── */}
      {!aiConfigured && (
        <div className="ai-banner" onClick={() => onNavigate('settings')}>
          <span className="ai-banner__icon">✨</span>
          <div className="ai-banner__body">
            <div className="ai-banner__title">Connect AI to unlock smart document parsing</div>
            <div className="ai-banner__desc">
              Upload a bill or contract and AI extracts provider, amount, dates, and category automatically.
            </div>
            <span className="ai-banner__link">Set up AI provider →</span>
          </div>
        </div>
      )}

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

      {/* ── Empty state: welcome guide ── */}
      {services.length === 0 && (
        <div className="welcome-guide">
          <div className="welcome-guide__header">
            <div className="welcome-guide__title">Get started in 3 steps</div>
          </div>
          <div className="welcome-guide__steps">
            <div
              className={`welcome-step ${aiConfigured ? 'welcome-step--done' : 'welcome-step--active'}`}
              onClick={() => !aiConfigured && onNavigate('settings')}
              style={{ cursor: aiConfigured ? 'default' : 'pointer' }}
            >
              <span className="welcome-step__num">{aiConfigured ? '✓' : '1'}</span>
              <div className="welcome-step__body">
                <div className="welcome-step__label">Connect AI provider</div>
                <div className="welcome-step__desc">{aiConfigured ? 'Connected' : 'Anthropic, OpenAI, or Google — bring your API key'}</div>
              </div>
            </div>
            <div className="welcome-step__arrow">→</div>
            <div
              className="welcome-step welcome-step--pending"
              onClick={() => onNavigate('import-doc')}
              style={{ cursor: 'pointer' }}
            >
              <span className="welcome-step__num">2</span>
              <div className="welcome-step__body">
                <div className="welcome-step__label">Upload a document</div>
                <div className="welcome-step__desc">Bill, contract, or letter — AI parses it</div>
              </div>
            </div>
            <div className="welcome-step__arrow">→</div>
            <div className="welcome-step welcome-step--pending">
              <span className="welcome-step__num">3</span>
              <div className="welcome-step__body">
                <div className="welcome-step__label">Review and save</div>
                <div className="welcome-step__desc">Edit any field, then save the service</div>
              </div>
            </div>
          </div>
          <div className="welcome-guide__alt">
            Or <button className="btn btn--outline btn--small" onClick={() => onNavigate('add-service')}>add a service manually</button>
          </div>
        </div>
      )}

      {/* ── Expiry alerts ── */}
      {services.length > 0 && <ExpiryAlerts services={services} onNavigate={onNavigate} />}

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
    </div>
  );
}

/* ── Expiry Alerts Component ── */

interface ExpiryItem {
  serviceId: string;
  nickname: string;
  provider: string;
  type: 'contract' | 'benefit' | 'reminder';
  label: string;
  date: string;
  days: number;
}

function ExpiryAlerts({ services, onNavigate }: { services: Service[]; onNavigate: Props['onNavigate'] }) {
  const [, forceUpdate] = useState(0);
  const notifPrefs = getNotificationPrefs();
  const threshold = notifPrefs.daysBefore || 60;

  const items: ExpiryItem[] = [];
  for (const svc of services) {
    const freq = svc.reminderFrequency || 'BEFORE_EXPIRY';
    if (freq === 'NONE') continue;

    if (freq !== 'BEFORE_EXPIRY') {
      items.push({
        serviceId: svc.id, nickname: svc.nickname, provider: svc.provider,
        type: 'reminder',
        label: freq === 'WEEKLY' ? 'Weekly reminder' : freq === 'MONTHLY' ? 'Monthly reminder' : 'Quarterly reminder',
        date: '', days: 0,
      });
      continue;
    }

    if (svc.contractEndDate) {
      const d = daysUntil(svc.contractEndDate);
      if (d !== null && d >= -7 && d <= threshold) {
        items.push({ serviceId: svc.id, nickname: svc.nickname, provider: svc.provider, type: 'contract', label: 'Contract', date: svc.contractEndDate, days: d });
      }
    }
    if (svc.benefitEndDate) {
      const d = daysUntil(svc.benefitEndDate);
      if (d !== null && d >= -7 && d <= threshold) {
        items.push({ serviceId: svc.id, nickname: svc.nickname, provider: svc.provider, type: 'benefit', label: 'Benefit', date: svc.benefitEndDate, days: d });
      }
    }
  }

  if (items.length === 0) return null;

  items.sort((a, b) => {
    if (a.type === 'reminder' && b.type !== 'reminder') return 1;
    if (a.type !== 'reminder' && b.type === 'reminder') return -1;
    return a.days - b.days;
  });

  const dismissed = new Set(notifPrefs.dismissed || []);
  const visible = items.filter(it => !dismissed.has(`${it.serviceId}-${it.type}`));
  if (visible.length === 0) return null;

  const dismiss = (item: ExpiryItem) => {
    const prefs = getNotificationPrefs();
    prefs.dismissed = [...(prefs.dismissed || []), `${item.serviceId}-${item.type}`];
    setNotificationPrefs(prefs);
    forceUpdate(n => n + 1);
  };

  return (
    <div className="expiry-alerts">
      <div className="expiry-alerts__header">
        <span className="expiry-alerts__icon">🔔</span>
        <span className="expiry-alerts__title">Upcoming Expirations</span>
        <span className="expiry-alerts__count">{visible.length}</span>
      </div>
      <div className="expiry-alerts__list">
        {visible.map(item => {
          const isReminder = item.type === 'reminder';
          const urgent = !isReminder && item.days <= 7;
          const expired = !isReminder && item.days < 0;
          const severity = isReminder ? 'info' : expired ? 'expired' : urgent ? 'urgent' : item.days <= 30 ? 'warning' : 'info';
          return (
            <div
              key={`${item.serviceId}-${item.type}`}
              className={`expiry-alert expiry-alert--${severity}`}
              onClick={() => onNavigate('service', { id: item.serviceId })}
            >
              <div className="expiry-alert__main">
                <span className="expiry-alert__badge">
                  {isReminder ? '🔔' : expired ? '⛔' : urgent ? '🔴' : item.days <= 30 ? '🟡' : '🔵'}
                </span>
                <div className="expiry-alert__info">
                  <span className="expiry-alert__name">{item.nickname}</span>
                  {item.provider && <span className="expiry-alert__provider">{item.provider}</span>}
                </div>
                <div className="expiry-alert__detail">
                  <span className="expiry-alert__type">{item.label}</span>
                  {item.date && <span className="expiry-alert__date">{formatDate(item.date)}</span>}
                </div>
                <div className="expiry-alert__days">
                  {isReminder
                    ? <span className="expiry-alert__days-text">{item.label}</span>
                    : expired
                    ? <span className="expiry-alert__days-text expiry-alert__days-text--expired">Expired {Math.abs(item.days)}d ago</span>
                    : item.days === 0
                    ? <span className="expiry-alert__days-text expiry-alert__days-text--today">Today!</span>
                    : <span className={`expiry-alert__days-text ${urgent ? 'expiry-alert__days-text--urgent' : ''}`}>{item.days} days</span>
                  }
                </div>
              </div>
              <button
                className="expiry-alert__dismiss"
                title="Dismiss"
                onClick={e => { e.stopPropagation(); dismiss(item); }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
