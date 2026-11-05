import React from 'react';
import { divergingPosition, divergingTicks, niceLimit, pullBar, scalePosition } from './chartMath.js';

/**
 * The app's charts, in plain HTML positioned by percentage so they reflow at
 * any width. Colours come from the --viz-* tokens in styles.css (a validated
 * blue/red diverging pair, re-stepped for the dark theme), never from the
 * text: values and labels stay in the text colours, and a coloured mark beside
 * them carries the meaning.
 *
 * Every chart is interactive - each row is a hover and keyboard-focus target
 * with a tooltip - and none of them gates a value behind it: each one either
 * prints its values or sits beside a table carrying them.
 */

/** One tooltip per chart, positioned against the chart's own box. */
function useTooltip() {
  const [tip, setTip] = React.useState(null);
  const box = React.useRef(null);
  const place = (event, content) => {
    const frame = box.current?.getBoundingClientRect();
    const row = event.currentTarget.getBoundingClientRect();
    if (!frame) return;
    const x = Number.isFinite(event.clientX) && event.clientX ? event.clientX - frame.left : row.left - frame.left + (row.width / 2);
    setTip({ content, x: Math.max(8, Math.min(x, frame.width - 8)), y: row.top - frame.top, flip: x > frame.width * 0.6 });
  };
  const handlers = (content) => ({
    onPointerEnter: (event) => place(event, content),
    onPointerMove: (event) => place(event, content),
    onPointerLeave: () => setTip(null),
    onFocus: (event) => place(event, content),
    onBlur: () => setTip(null),
  });
  const node = tip ? <div className={`viz-tooltip ${tip.flip ? 'viz-tooltip-flip' : ''}`} role="presentation" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{tip.content}</div> : null;
  return { box, handlers, node };
}

function TipBody({ value, label, lines = [] }) {
  return <>
    <strong>{value}</strong>
    <span>{label}</span>
    {lines.filter(Boolean).map((line) => <small key={line}>{line}</small>)}
  </>;
}

/**
 * A verdict's readings as bars pulling from the neutral line: right helps the
 * asset, left holds it back, length is the distance from neutral. Sorted from
 * the strongest help to the strongest drag, so the chart reads top-down as
 * the argument does.
 */
export function PullChart({ rows, subject }) {
  const { box, handlers, node } = useTooltip();
  const scored = rows.filter((row) => Number.isFinite(row.score)).sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  return <figure className="viz pull-chart" ref={box}>
    <div className="pull-legend" aria-hidden="true">
      <span><i className="viz-key viz-key-neg" />Holding {subject} back</span>
      <span>Helping {subject}<i className="viz-key viz-key-pos" /></span>
    </div>
    <ul className="pull-rows" aria-label={`Each reading's pull on the verdict for ${subject}, from 0 to 100 where 50 is neutral`}>
      {scored.map((row) => {
        const bar = pullBar(row.score);
        const side = bar.side === 'pos' ? `helps ${subject}` : bar.side === 'neg' ? `holds ${subject} back` : 'neutral';
        const weight = Number.isFinite(row.weight) ? `${Math.round(row.weight * 100)}% of the verdict's weight` : null;
        return <li key={row.key} className="pull-row" tabIndex={0} aria-label={`${row.name}: ${row.score} of 100, ${side}${row.detail ? `, ${row.detail}` : ''}`}
          {...handlers(<TipBody value={`${row.score} / 100`} label={`${row.name} ${side}`} lines={[row.detail, weight]} />)}>
          <span className="pull-name">{row.name}{row.detail ? <small>{row.detail}</small> : null}</span>
          <span className="pull-track">
            <i className="pull-neutral" />
            {bar.side === 'flat'
              ? <b className="pull-dot" style={{ left: '50%' }} />
              : <b className={`pull-bar pull-${bar.side}`} style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />}
          </span>
          <span className="pull-value">{row.score}</span>
        </li>;
      })}
    </ul>
    <figcaption>Each reading is scored 0–100. The centre line is 50, neutral; a bar's length is how far the reading sits from it.</figcaption>
    {node}
  </figure>;
}

/**
 * Where one reading sits between two named ends - "Cheap" to "Expensive" -
 * with a marker on a track. Coloured as a diverging scale when one end is
 * better for an investor than the other, and in one neutral tone when neither
 * is (a sentiment reading is not good or bad in itself).
 */
export function ScaleMarker({ scale, compact = false }) {
  const at = scalePosition(scale?.value, scale?.min ?? 0, scale?.max ?? 100);
  if (at === null) return null;
  const polarity = scale.polarity ?? 'none';
  // A row-sized version: the track alone, named for assistive technology and
  // on hover, for lists whose rows already print the value.
  if (compact) {
    return <div className={`scale-marker scale-compact scale-${polarity}`} role="img" aria-label={`${scale.label}, on a scale from ${scale.left} to ${scale.right}`} title={`${scale.label} (${scale.left} to ${scale.right})`}>
      <div className="scale-track"><b className="scale-dot" style={{ left: `${at}%` }} /></div>
    </div>;
  }
  return <div className={`scale-marker scale-${polarity}`}>
    <div className="scale-track" aria-hidden="true">
      <b className="scale-dot" style={{ left: `${at}%` }} />
    </div>
    <div className="scale-ends">
      <span>{scale.left}</span>
      <span className="scale-value" aria-label={`${scale.label}, on a scale from ${scale.left} to ${scale.right}`}>{scale.label}</span>
      <span>{scale.right}</span>
    </div>
  </div>;
}

/**
 * Signed values on one shared axis: a bar for the main measure and a dot for
 * a second measure in the same unit (sector performance against the index
 * over 60 and 20 sessions). One axis, so the two can be compared directly.
 */
export function DivergingBars({ rows, barLabel, dotLabel, unit = '%', caption, formatValue = (value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}${unit}` }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.bar));
  if (!usable.length) return null;
  const limit = niceLimit(Math.max(...usable.flatMap((row) => [Math.abs(row.bar), Number.isFinite(row.dot) ? Math.abs(row.dot) : 0])));
  const ticks = divergingTicks(limit);
  return <figure className="viz diverging-chart" ref={box}>
    <div className="diverging-legend">
      <span><i className="viz-key viz-key-pos" /><i className="viz-key viz-key-neg" />{barLabel}</span>
      {dotLabel ? <span><i className="viz-key viz-key-dot" />{dotLabel}</span> : null}
    </div>
    <ul className="diverging-rows">
      {usable.map((row) => {
        const bar = divergingPosition(row.bar, limit);
        const dot = Number.isFinite(row.dot) ? divergingPosition(row.dot, limit) : null;
        return <li key={row.key} className="diverging-row" tabIndex={0}
          aria-label={`${row.name}: ${barLabel} ${formatValue(row.bar)}${dot ? `, ${dotLabel} ${formatValue(row.dot)}` : ''}${row.note ? `, ${row.note}` : ''}`}
          {...handlers(<TipBody value={formatValue(row.bar)} label={`${row.name}, ${barLabel.charAt(0).toLowerCase()}${barLabel.slice(1)}`} lines={[dot ? `${dotLabel}: ${formatValue(row.dot)}` : null, row.note]} />)}>
          <span className="diverging-name">{row.name}{row.sub ? <small>{row.sub}</small> : null}</span>
          <span className="diverging-track">
            <i className="diverging-zero" />
            <b className={`diverging-bar diverging-${bar.side}`} style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
            {dot ? <b className="diverging-dot" style={{ left: `${dot.at}%` }} /> : null}
          </span>
          <span className="diverging-value">{formatValue(row.bar)}</span>
        </li>;
      })}
    </ul>
    <div className="diverging-axis" aria-hidden="true">
      <span />
      <span className="diverging-ticks">{ticks.map((tick) => <i key={tick} style={{ left: `${50 + ((tick / limit) * 50)}%` }}>{tick === 0 ? '0' : formatValue(tick)}</i>)}</span>
      <span />
    </div>
    {caption ? <figcaption>{caption}</figcaption> : null}
    {node}
  </figure>;
}

/**
 * Magnitudes from one baseline, one bar per row, the value printed at the
 * bar's end. Rows marked `emphasis` take the accent colour and the rest stay
 * a context grey, for charts where one bar is the point and the others are
 * there to judge it by ("today's fall against the typical and the worst").
 */
export function MagnitudeBars({ rows, tone = 'neg', caption, label }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.value));
  if (!usable.length) return null;
  const maximum = Math.max(...usable.map((row) => Math.abs(row.value))) || 1;
  return <figure className="viz magnitude-chart" ref={box} aria-label={label}>
    <ul className="magnitude-rows">
      {usable.map((row) => <li key={row.key} className="magnitude-row" tabIndex={0} aria-label={`${row.label}: ${row.display}${row.note ? `, ${row.note}` : ''}`}
        {...handlers(<TipBody value={row.display} label={row.label} lines={[row.note]} />)}>
        <span className="magnitude-name">{row.label}{row.sub ? <small>{row.sub}</small> : null}</span>
        <span className="magnitude-track">
          <b className={`magnitude-bar ${row.emphasis ? `magnitude-${tone}` : 'magnitude-context'}`} style={{ width: `${Math.max(1.5, (Math.abs(row.value) / maximum) * 100)}%` }} />
        </span>
        <span className="magnitude-value">{row.display}</span>
      </li>)}
    </ul>
    {caption ? <figcaption>{caption}</figcaption> : null}
    {node}
  </figure>;
}

/**
 * Price bands around today's price, one row per horizon, on one shared price
 * axis so a wider band reads as wider. The line through every row is today.
 */
export function RangeChart({ rows, center, centerLabel, format = (value) => value.toFixed(2), caption }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.lower) && Number.isFinite(row.upper));
  if (!usable.length || !Number.isFinite(center)) return null;
  const low = Math.min(center, ...usable.map((row) => row.lower));
  const high = Math.max(center, ...usable.map((row) => row.upper));
  const pad = (high - low) * 0.06 || Math.abs(center) * 0.01 || 1;
  const at = (value) => ((value - (low - pad)) / ((high + pad) - (low - pad))) * 100;
  return <figure className="viz range-chart" ref={box}>
    <ul className="range-rows">
      {usable.map((row) => <li key={row.key} className="range-row" tabIndex={0} aria-label={`${row.label}: ${format(row.lower)} to ${format(row.upper)}${row.note ? `, ${row.note}` : ''}`}
        {...handlers(<TipBody value={`${format(row.lower)} – ${format(row.upper)}`} label={row.label} lines={[row.sub, row.note]} />)}>
        <span className="range-name">{row.label}<small>{row.sub ? `${row.sub} · ` : ''}{format(row.lower)} – {format(row.upper)}</small></span>
        <span className="range-track">
          <i className="range-center" style={{ left: `${at(center)}%` }} />
          <b className="range-band" style={{ left: `${at(row.lower)}%`, width: `${at(row.upper) - at(row.lower)}%` }} />
        </span>
      </li>)}
    </ul>
    <p className="range-center-label"><i className="range-key" />{centerLabel ?? 'Today'}: {format(center)}</p>
    {caption ? <figcaption>{caption}</figcaption> : null}
    {node}
  </figure>;
}

/**
 * A handful of readings over time on a 0-100 scale, joined by a line, with
 * the latest emphasised and labelled. Each point is a hover and focus target.
 */
export function PointsLine({ points, low = 'Fear', high = 'Greed', label }) {
  const { box, handlers, node } = useTooltip();
  const usable = points.filter((point) => Number.isFinite(point.value));
  if (usable.length < 2) return null;
  const width = 320;
  const height = 130;
  const left = 34;
  const right = 18;
  const top = 12;
  const bottom = 26;
  const x = (index) => left + ((width - left - right) * index) / (usable.length - 1);
  const y = (value) => top + ((height - top - bottom) * (100 - Math.max(0, Math.min(100, value)))) / 100;
  const path = usable.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const last = usable.at(-1);
  return <figure className="viz points-line" ref={box}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? usable.map((point) => `${point.label} ${Math.round(point.value)}`).join(', ')}>
      {[0, 50, 100].map((tick) => <line key={tick} className={tick === 50 ? 'points-mid' : 'points-grid'} x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />)}
      <text className="points-axis" x={left - 6} y={y(100) + 4} textAnchor="end">{high}</text>
      <text className="points-axis" x={left - 6} y={y(50) + 4} textAnchor="end">50</text>
      <text className="points-axis" x={left - 6} y={y(0) + 4} textAnchor="end">{low}</text>
      <path className="points-path" d={path} />
      {usable.map((point, index) => <g key={point.key} tabIndex={0} className="points-hit" aria-label={`${point.label}: ${Math.round(point.value)} of 100`}
        {...handlers(<TipBody value={`${Math.round(point.value)} / 100`} label={point.label} lines={[point.note]} />)}>
        <circle cx={x(index)} cy={y(point.value)} r="12" className="points-target" />
        <circle cx={x(index)} cy={y(point.value)} r={point === last ? 5.5 : 4} className={point === last ? 'points-dot points-last' : 'points-dot'} />
        <text className="points-axis" x={x(index)} y={height - 8} textAnchor="middle">{point.short ?? point.label}</text>
      </g>)}
      <text className="points-value" x={x(usable.length - 1) - 10} y={y(last.value) - 10} textAnchor="end">{Math.round(last.value)}</text>
    </svg>
    {node}
  </figure>;
}
