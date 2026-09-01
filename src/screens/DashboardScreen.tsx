import { useState, useMemo } from 'react';
import { useApp } from '../store/AppContext';
import {
  money, humanise, monthlyAmount, CATEGORY_GROUPS,
  type ServiceCategory, type Service,
} from '../types';

interface Props {
  onBack: () => void;
  onNavigate: (page: string, params?: Record<string, string>) => void;
}

type ViewPeriod = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';

const PERIOD_LABELS: Record<ViewPeriod, string> = {
  WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', ANNUALLY: 'Annually',
};

const PERIOD_MULTIPLIER: Record<ViewPeriod, number> = {
  WEEKLY: 12 / 52, MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12,
};

/* ── Palette for category groups ── */
const GROUP_COLORS: Record<string, string> = {
  energy:    '#f59e0b',
  water:     '#3b82f6',
  telecom:   '#8b5cf6',
  insurance: '#06b6d4',
  housing:   '#ef4444',
  transport: '#f97316',
  subs:      '#ec4899',
  finance:   '#10b981',
  other:     '#6b7280',
};

function getGroupKey(cat: ServiceCategory): string {
  for (const [key, { categories }] of Object.entries(CATEGORY_GROUPS)) {
    if ((categories as ServiceCategory[]).includes(cat)) return key;
  }
  return 'other';
}

interface GroupData {
  key: string;
  label: string;
  icon: string;
  color: string;
  services: Service[];
  monthlyCents: number;
  periodCents: number;
}

export function DashboardScreen({ onBack, onNavigate }: Props) {
  const { services } = useApp();
  const [period, setPeriod] = useState<ViewPeriod>('MONTHLY');
  const [sortBy, setSortBy] = useState<'cost' | 'name' | 'category'>('cost');
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);

  const multiplier = PERIOD_MULTIPLIER[period];

  // Filtered services
  const filtered = useMemo(() => services.filter(s => !excludedIds.has(s.id)), [services, excludedIds]);
  const excludedCount = excludedIds.size;

  const toggleExclude = (id: string) => {
    setExcludedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const excludeByGroup = (groupKey: string) => {
    const cats = CATEGORY_GROUPS[groupKey]?.categories as ServiceCategory[] | undefined;
    if (!cats) return;
    setExcludedIds(prev => {
      const next = new Set(prev);
      const groupSvcs = services.filter(s => cats.includes(s.category));
      const allExcluded = groupSvcs.every(s => next.has(s.id));
      groupSvcs.forEach(s => allExcluded ? next.delete(s.id) : next.add(s.id));
      return next;
    });
  };

  const clearFilters = () => setExcludedIds(new Set());

  // Group data (from filtered)
  const groups = useMemo<GroupData[]>(() => {
    return Object.entries(CATEGORY_GROUPS)
      .map(([key, { label, icon, categories }]) => {
        const svcs = filtered.filter(s => (categories as ServiceCategory[]).includes(s.category));
        const monthlyCents = svcs.reduce((sum, s) => sum + monthlyAmount(s.amountCents, s.billingFrequency), 0);
        return {
          key, label, icon,
          color: GROUP_COLORS[key] || '#6b7280',
          services: svcs,
          monthlyCents,
          periodCents: Math.round(monthlyCents * multiplier),
        };
      })
      .filter(g => g.services.length > 0);
  }, [filtered, multiplier]);

  const totalPeriod = groups.reduce((s, g) => s + g.periodCents, 0);
  const totalMonthly = groups.reduce((s, g) => s + g.monthlyCents, 0);

  // Sorted services for table (from filtered)
  const sortedServices = useMemo(() => {
    const list = [...filtered];
    switch (sortBy) {
      case 'cost':
        return list.sort((a, b) => monthlyAmount(b.amountCents, b.billingFrequency) - monthlyAmount(a.amountCents, a.billingFrequency));
      case 'name':
        return list.sort((a, b) => a.nickname.localeCompare(b.nickname));
      case 'category':
        return list.sort((a, b) => a.category.localeCompare(b.category));
    }
  }, [filtered, sortBy]);

  if (services.length === 0) {
    return (
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>📊 Dashboard</h2>
          <button className="btn" onClick={onBack}>← Back</button>
        </div>
        <div className="empty">
          <p>No services yet. Add some services to see your spending dashboard.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Header */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>📊 Dashboard</h2>
        <button className="btn" onClick={onBack}>← Back</button>
      </div>

      {/* Period filter */}
      <div className="chips" style={{ justifyContent: 'center' }}>
        {(Object.entries(PERIOD_LABELS) as [ViewPeriod, string][]).map(([key, label]) => (
          <button
            key={key}
            className="chip"
            aria-selected={period === key}
            onClick={() => setPeriod(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Filter panel ── */}
      <div className="card" style={{ padding: '0.75rem 1rem' }}>
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
          onClick={() => setFilterOpen(!filterOpen)}
        >
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            🔍 Filter Services
            {excludedCount > 0 && (
              <span style={{
                marginLeft: 8,
                background: 'var(--accent)',
                color: '#fff',
                borderRadius: 10,
                padding: '2px 8px',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}>
                {excludedCount} hidden
              </span>
            )}
          </span>
          <span style={{ color: 'var(--muted)' }}>{filterOpen ? '▾' : '▸'}</span>
        </div>

        {filterOpen && (
          <div style={{ marginTop: '0.75rem' }}>
            {/* Quick group toggles */}
            <div style={{ marginBottom: '0.75rem' }}>
              <span className="muted" style={{ fontSize: '0.75rem', display: 'block', marginBottom: '0.4rem' }}>
                Toggle by category:
              </span>
              <div className="chips">
                {Object.entries(CATEGORY_GROUPS).map(([key, { label, icon, categories }]) => {
                  const groupSvcs = services.filter(s => (categories as ServiceCategory[]).includes(s.category));
                  if (groupSvcs.length === 0) return null;
                  const allExcluded = groupSvcs.every(s => excludedIds.has(s.id));
                  const someExcluded = groupSvcs.some(s => excludedIds.has(s.id));
                  return (
                    <button
                      key={key}
                      className="chip"
                      aria-selected={!allExcluded && !someExcluded}
                      onClick={() => excludeByGroup(key)}
                      style={{
                        borderColor: allExcluded ? 'var(--danger)' : someExcluded ? 'var(--warn)' : undefined,
                        opacity: allExcluded ? 0.5 : 1,
                        textDecoration: allExcluded ? 'line-through' : undefined,
                      }}
                    >
                      {icon} {label} ({groupSvcs.length})
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Individual service toggles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.4rem' }}>
              {services.map(svc => {
                const excluded = excludedIds.has(svc.id);
                const color = GROUP_COLORS[getGroupKey(svc.category)] || '#6b7280';
                const mo = monthlyAmount(svc.amountCents, svc.billingFrequency);
                return (
                  <label
                    key={svc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '0.4rem 0.6rem',
                      borderRadius: 'var(--radius-sm)',
                      background: excluded ? 'transparent' : 'var(--surface-2)',
                      border: `1px solid ${excluded ? 'var(--line)' : color + '44'}`,
                      cursor: 'pointer',
                      opacity: excluded ? 0.5 : 1,
                      transition: 'all 0.15s',
                      fontSize: '0.82rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!excluded}
                      onChange={() => toggleExclude(svc.id)}
                      style={{ accentColor: color, width: 16, height: 16, flexShrink: 0 }}
                    />
                    <span style={{ width: 6, height: 6, borderRadius: 2, background: color, flexShrink: 0 }} />
                    <span style={{
                      flex: 1,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      textDecoration: excluded ? 'line-through' : undefined,
                    }}>
                      {svc.nickname}
                    </span>
                    <span className="muted" style={{ fontSize: '0.75rem', flexShrink: 0 }}>
                      {money(Math.round(mo * multiplier))}
                    </span>
                  </label>
                );
              })}
            </div>

            {/* Clear button */}
            {excludedCount > 0 && (
              <div style={{ marginTop: '0.6rem', textAlign: 'center' }}>
                <button className="btn btn--small btn--outline" onClick={clearFilters}>
                  ✕ Clear filters — show all {services.length} services
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="summary-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="card summary-card">
          <span className="summary-label">{PERIOD_LABELS[period]}</span>
          <span className="summary-value">{money(totalPeriod)}</span>
        </div>
        <div className="card summary-card">
          <span className="summary-label">Annual</span>
          <span className="summary-value">{money(totalMonthly * 12)}</span>
        </div>
        <div className="card summary-card">
          <span className="summary-label">Daily avg</span>
          <span className="summary-value">{money(Math.round(totalMonthly * 12 / 365))}</span>
        </div>
        <div className="card summary-card">
          <span className="summary-label">Services</span>
          <span className="summary-value">
            {filtered.length}
            {excludedCount > 0 && <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}> / {services.length}</span>}
          </span>
        </div>
      </div>

      {/* Donut + Legend */}
      <div className="card" style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <DonutChart groups={groups} total={totalPeriod} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <h3 style={{ marginBottom: '0.75rem' }}>By Category</h3>
          {groups.map(g => {
            const pct = totalPeriod > 0 ? (g.periodCents / totalPeriod * 100) : 0;
            return (
              <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: g.color, flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{g.icon} {g.label}</span>
                <span className="muted">{g.services.length}</span>
                <span style={{ fontWeight: 600, minWidth: 90, textAlign: 'right' }}>{money(g.periodCents)}</span>
                <span className="muted" style={{ minWidth: 45, textAlign: 'right' }}>{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bar chart */}
      <div className="card">
        <h3>Spending Breakdown</h3>
        <BarChart groups={groups} maxCents={Math.max(...groups.map(g => g.periodCents), 1)} />
      </div>

      {/* Stacked bar */}
      <div className="card">
        <h3>Cost Distribution</h3>
        <StackedBar groups={groups} total={totalPeriod} />
      </div>

      {/* All services table */}
      {sortedServices.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0 }}>All Services</h3>
            <div className="chips">
              <button className="chip" aria-selected={sortBy === 'cost'} onClick={() => setSortBy('cost')} style={{ fontSize: '0.75rem' }}>💰 Cost</button>
              <button className="chip" aria-selected={sortBy === 'name'} onClick={() => setSortBy('name')} style={{ fontSize: '0.75rem' }}>🔤 Name</button>
              <button className="chip" aria-selected={sortBy === 'category'} onClick={() => setSortBy('category')} style={{ fontSize: '0.75rem' }}>📁 Category</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--line)', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem 0.5rem', color: 'var(--muted)', fontWeight: 500 }}>Service</th>
                  <th style={{ padding: '0.5rem 0.5rem', color: 'var(--muted)', fontWeight: 500 }}>Category</th>
                  <th style={{ padding: '0.5rem 0.5rem', color: 'var(--muted)', fontWeight: 500, textAlign: 'right' }}>{PERIOD_LABELS[period]}</th>
                  <th style={{ padding: '0.5rem 0.5rem', color: 'var(--muted)', fontWeight: 500, textAlign: 'right' }}>% of Total</th>
                  <th style={{ padding: '0.5rem 0.5rem', width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {sortedServices.map(svc => {
                  const mo = monthlyAmount(svc.amountCents, svc.billingFrequency);
                  const periodVal = Math.round(mo * multiplier);
                  const pct = totalPeriod > 0 ? (periodVal / totalPeriod * 100) : 0;
                  const groupKey = getGroupKey(svc.category);
                  const color = GROUP_COLORS[groupKey] || '#6b7280';
                  return (
                    <tr
                      key={svc.id}
                      style={{ borderBottom: '1px solid var(--line)', transition: 'background 0.1s' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td
                        style={{ padding: '0.6rem 0.5rem', fontWeight: 500, cursor: 'pointer' }}
                        onClick={() => onNavigate('service', { id: svc.id })}
                      >
                        {svc.nickname}
                        {svc.provider && <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>{svc.provider}</span>}
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                          {humanise(svc.category)}
                        </span>
                      </td>
                      <td style={{ padding: '0.6rem 0.5rem', textAlign: 'right', fontWeight: 600 }}>{money(periodVal)}</td>
                      <td style={{ padding: '0.6rem 0.5rem', textAlign: 'right', color: 'var(--muted)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                          <div style={{ width: 50, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
                          </div>
                          {pct.toFixed(1)}%
                        </div>
                      </td>
                      <td style={{ padding: '0.6rem 0.25rem', textAlign: 'center' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleExclude(svc.id); }}
                          title="Hide from dashboard"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: '0.8rem', opacity: 0.4, padding: '2px 4px',
                            transition: 'opacity 0.15s',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={e => (e.currentTarget.style.opacity = '0.4')}
                        >
                          👁‍🗨
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Chart Components (pure SVG, no deps)
   ═══════════════════════════════════════════════════════════ */

function DonutChart({ groups, total }: { groups: GroupData[]; total: number }) {
  const size = 180;
  const cx = size / 2, cy = size / 2;
  const radius = 70, strokeWidth = 28;

  let cumulativeAngle = -90; // start at top
  const arcs = groups.map(g => {
    const pct = total > 0 ? g.periodCents / total : 0;
    const angle = pct * 360;
    const startAngle = cumulativeAngle;
    cumulativeAngle += angle;
    return { ...g, pct, startAngle, angle };
  });

  function polarToCartesian(cxp: number, cyp: number, r: number, angleDeg: number) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cxp + r * Math.cos(rad), y: cyp + r * Math.sin(rad) };
  }

  function describeArc(startAngle: number, endAngle: number) {
    const start = polarToCartesian(cx, cy, radius, endAngle);
    const end = polarToCartesian(cx, cy, radius, startAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`;
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      {/* Background circle */}
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={strokeWidth} />
      {arcs.map((arc, i) => (
        arc.angle > 0.5 && (
          <path
            key={i}
            d={describeArc(arc.startAngle, arc.startAngle + arc.angle - 0.5)}
            fill="none"
            stroke={arc.color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        )
      ))}
      {/* Center text */}
      <text x={cx} y={cy - 8} textAnchor="middle" fill="var(--muted)" fontSize="11">Total</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fill="var(--text)" fontSize="18" fontWeight="700">
        {money(total, true)}
      </text>
    </svg>
  );
}

function BarChart({ groups, maxCents }: { groups: GroupData[]; maxCents: number }) {
  const barHeight = 32;
  const gap = 8;
  const labelWidth = 100;
  const valueWidth = 90;
  const chartWidth = 400;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: gap, marginTop: '0.75rem' }}>
      {groups.map(g => {
        const pct = maxCents > 0 ? (g.periodCents / maxCents * 100) : 0;
        return (
          <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: labelWidth, fontSize: '0.82rem', flexShrink: 0, textAlign: 'right' }}>
              {g.icon} {g.label}
            </span>
            <div style={{ flex: 1, maxWidth: chartWidth, height: barHeight, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
              <div
                style={{
                  width: `${Math.max(pct, 1)}%`,
                  height: '100%',
                  background: `linear-gradient(90deg, ${g.color}cc, ${g.color})`,
                  borderRadius: 4,
                  transition: 'width 0.4s ease',
                }}
              />
              {g.services.length > 1 && (
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: '0.7rem', color: '#fff', fontWeight: 600, textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                  {g.services.length} services
                </span>
              )}
            </div>
            <span style={{ width: valueWidth, fontSize: '0.85rem', fontWeight: 600, textAlign: 'right' }}>
              {money(g.periodCents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StackedBar({ groups, total }: { groups: GroupData[]; total: number }) {
  if (total === 0) return null;
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div style={{ display: 'flex', height: 36, borderRadius: 6, overflow: 'hidden' }}>
        {groups.map(g => {
          const pct = g.periodCents / total * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={g.key}
              style={{
                width: `${pct}%`,
                background: g.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'width 0.4s ease',
                position: 'relative',
              }}
              title={`${g.label}: ${money(g.periodCents)} (${pct.toFixed(1)}%)`}
            >
              {pct > 8 && (
                <span style={{ fontSize: '0.7rem', color: '#fff', fontWeight: 600, textShadow: '0 1px 2px rgba(0,0,0,0.4)' }}>
                  {pct.toFixed(0)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
      {/* Mini legend */}
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.5rem', justifyContent: 'center' }}>
        {groups.map(g => (
          <span key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: 'var(--muted)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color }} />
            {g.label}
          </span>
        ))}
      </div>
    </div>
  );
}
