import React from 'react';
import { divergingPosition, divergingTicks, niceLimit, niceTicks, ordinal, pullBar, scalePosition } from './chartMath.js';

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
 * The shared frame for the row charts: a header that puts the scale above the
 * rows (so the units are read before the bars), gridlines through every row
 * at each tick, and value columns that sit next to the bars rather than at
 * the far edge of a wide card. `ticks` are { at: percent, label }.
 */
function AxisHead({ nameLabel = '', ticks, valueLabels = [] }) {
  return <div className="viz-grid viz-head" aria-hidden="true" style={{ '--values': valueLabels.length || 1 }}>
    <span className="viz-head-name">{nameLabel}</span>
    <span className="viz-ticks">{ticks.map((tick, index) => <i key={`${tick.at}-${index}`} className={index === 0 ? 'viz-tick-first' : index === ticks.length - 1 ? 'viz-tick-last' : ''} style={{ left: `${tick.at}%` }}>{tick.label}</i>)}</span>
    {valueLabels.length ? valueLabels.map((label) => <span key={label} className="viz-head-value">{label}</span>) : <span className="viz-head-value" />}
  </div>;
}

function Gridlines({ ticks, baseline = null }) {
  return <>
    {ticks.map((tick, index) => <i key={`${tick.at}-${index}`} className={`viz-gridline ${tick.at === baseline ? 'viz-baseline' : ''}`} style={{ left: `${tick.at}%` }} />)}
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
  const ticks = [{ at: 0, label: '0' }, { at: 25, label: '25' }, { at: 50, label: '50 neutral' }, { at: 75, label: '75' }, { at: 100, label: '100' }];
  return <figure className="viz pull-chart viz-axis-chart" ref={box}>
    <div className="pull-legend" aria-hidden="true">
      <span><i className="viz-key viz-key-neg" />Below 50: holds {subject} back</span>
      <span><i className="viz-key viz-key-pos" />Above 50: helps {subject}</span>
    </div>
    <AxisHead nameLabel="Reading" ticks={ticks} valueLabels={['Score']} />
    <ul className="viz-rows" aria-label={`Each reading's pull on the verdict for ${subject}, from 0 to 100 where 50 is neutral`}>
      {scored.map((row) => {
        const bar = pullBar(row.score);
        const side = bar.side === 'pos' ? `helps ${subject}` : bar.side === 'neg' ? `holds ${subject} back` : 'neutral';
        const weight = Number.isFinite(row.weight) ? `${Math.round(row.weight * 100)}% of the verdict's weight` : null;
        // Whole points, as the verdict's own score is printed: "53.2" beside "60" reads as false precision.
        const shown = Math.round(row.score);
        return <li key={row.key} className="viz-grid viz-row" style={{ '--values': 1 }} tabIndex={0} aria-label={`${row.name}: ${shown} of 100, ${side}${row.detail ? `, ${row.detail}` : ''}`}
          {...handlers(<TipBody value={`${shown} / 100`} label={`${row.name} ${side}`} lines={[row.detail, weight]} />)}>
          <span className="viz-name">{row.name}{row.detail ? <small>{row.detail}</small> : null}</span>
          <span className="viz-track">
            <Gridlines ticks={ticks} baseline={50} />
            {bar.side === 'flat'
              ? <b className="pull-dot" style={{ left: '50%' }} />
              : <b className={`viz-bar pull-bar pull-${bar.side}`} style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />}
          </span>
          <span className="viz-val">{shown}</span>
        </li>;
      })}
    </ul>
    <figcaption>Each reading is scored 0–100 and the centre line is 50, neutral. A bar's length is how far the reading sits from it.</figcaption>
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
export function DivergingBars({ rows, barLabel, dotLabel, barShort = null, dotShort = null, nameLabel = '', unit = '%', caption, formatValue = (value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}${unit}`, formatTick = (value) => `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}${unit}` }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.bar));
  if (!usable.length) return null;
  const limit = niceLimit(Math.max(...usable.flatMap((row) => [Math.abs(row.bar), Number.isFinite(row.dot) ? Math.abs(row.dot) : 0])));
  const ticks = divergingTicks(limit).map((tick) => ({ at: 50 + ((tick / limit) * 50), label: tick === 0 ? '0' : formatTick(tick) }));
  const hasDot = Boolean(dotLabel) && usable.some((row) => Number.isFinite(row.dot));
  const shortOf = (label) => label.replace(/^Last /, '').replace(/ (against|vs) .*$/, '');
  const valueLabels = hasDot ? [barShort ?? shortOf(barLabel), dotShort ?? shortOf(dotLabel)] : [barShort ?? shortOf(barLabel)];
  return <figure className="viz diverging-chart viz-axis-chart" ref={box}>
    <div className="diverging-legend">
      <span><i className="viz-key viz-key-pos" /><i className="viz-key viz-key-neg" />Bar: {barLabel}</span>
      {hasDot ? <span><i className="viz-key viz-key-dot" />Dot: {dotLabel}</span> : null}
    </div>
    <AxisHead nameLabel={nameLabel} ticks={ticks} valueLabels={valueLabels} />
    <ul className="viz-rows">
      {usable.map((row) => {
        const bar = divergingPosition(row.bar, limit);
        const dot = hasDot && Number.isFinite(row.dot) ? divergingPosition(row.dot, limit) : null;
        return <li key={row.key} className="viz-grid viz-row" style={{ '--values': valueLabels.length }} tabIndex={0}
          aria-label={`${row.name}: ${barLabel} ${formatValue(row.bar)}${dot ? `, ${dotLabel} ${formatValue(row.dot)}` : ''}${row.note ? `, ${row.note}` : ''}`}
          {...handlers(<TipBody value={formatValue(row.bar)} label={`${row.name}, ${barLabel.charAt(0).toLowerCase()}${barLabel.slice(1)}`} lines={[dot ? `${dotLabel}: ${formatValue(row.dot)}` : null, row.note]} />)}>
          <span className="viz-name">{row.name}{row.sub ? <small>{row.sub}</small> : null}</span>
          <span className="viz-track">
            <Gridlines ticks={ticks} baseline={50} />
            <b className={`viz-bar diverging-bar diverging-${bar.side}`} style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
            {dot ? <b className="diverging-dot" style={{ left: `${dot.at}%` }} /> : null}
          </span>
          <span className="viz-val">{formatValue(row.bar)}</span>
          {hasDot ? <span className="viz-val viz-val-2">{Number.isFinite(row.dot) ? formatValue(row.dot) : '—'}</span> : null}
        </li>;
      })}
    </ul>
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
export function MagnitudeBars({ rows, tone = 'neg', caption, label, maximum: fixedMaximum = null, reference = null, referenceLabel = null, formatTick = null, valueLabel = '' }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.value));
  if (!usable.length) return null;
  const maximum = fixedMaximum ?? niceLimit(Math.max(...usable.map((row) => Math.abs(row.value))) || 1);
  const ticks = niceTicks(maximum).map((value) => ({ at: (value / maximum) * 100, label: formatTick ? formatTick(value) : '' }));
  const referenceAt = Number.isFinite(reference) ? (reference / maximum) * 100 : null;
  return <figure className="viz magnitude-chart viz-axis-chart" ref={box} aria-label={label}>
    {formatTick ? <AxisHead ticks={ticks} valueLabels={[valueLabel]} /> : null}
    <ul className="viz-rows">
      {usable.map((row) => <li key={row.key} className="viz-grid viz-row" style={{ '--values': 1 }} tabIndex={0} aria-label={`${row.label}: ${row.display}${row.note ? `, ${row.note}` : ''}`}
        {...handlers(<TipBody value={row.display} label={row.label} lines={[row.note]} />)}>
        <span className="viz-name">{row.label}{row.sub ? <small>{row.sub}</small> : null}</span>
        <span className="viz-track">
          <Gridlines ticks={ticks} baseline={0} />
          {referenceAt !== null ? <i className="viz-reference" style={{ left: `${referenceAt}%` }} /> : null}
          <b className={`viz-bar magnitude-bar ${row.emphasis ? `magnitude-${tone}` : 'magnitude-context'}`} style={{ left: 0, width: `${Math.max(1.5, Math.min(100, (Math.abs(row.value) / maximum) * 100))}%` }} />
        </span>
        <span className="viz-val">{row.display}</span>
      </li>)}
    </ul>
    {referenceLabel ? <p className="magnitude-ref-label"><i className="paired-ref-key" />{referenceLabel}</p> : null}
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

/**
 * Where each row sits in its own history, 0-100, with the outer tenths
 * shaded as the extremes. Neither end is better: a crowded long and a crowded
 * short are both extremes, so the marks are one neutral colour.
 */
export function PercentileStrip({ rows, lowLabel, highLabel, caption }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.value));
  if (!usable.length) return null;
  const ticks = [{ at: 0, label: lowLabel ?? '0' }, { at: 25, label: '25th' }, { at: 50, label: '50th' }, { at: 75, label: '75th' }, { at: 100, label: highLabel ?? '100th' }];
  return <figure className="viz percentile-chart viz-axis-chart" ref={box}>
    <AxisHead ticks={ticks} valueLabels={['Pctl.']} />
    <ul className="viz-rows">
      {usable.map((row) => {
        const at = scalePosition(row.value, 0, 100);
        const extreme = row.value <= 10 || row.value >= 90;
        return <li key={row.key} className="viz-grid viz-row" style={{ '--values': 1 }} tabIndex={0} aria-label={`${row.name}: ${ordinal(row.value)} percentile of its own history${row.note ? `, ${row.note}` : ''}`}
          {...handlers(<TipBody value={`${ordinal(row.value)} percentile`} label={row.name} lines={[row.note, extreme ? 'An extreme: outside 90% of its own history' : null]} />)}>
          <span className="viz-name">{row.name}{row.sub ? <small>{row.sub}</small> : null}</span>
          <span className="viz-track percentile-track"><i className="percentile-zone percentile-zone-low" /><i className="percentile-zone percentile-zone-high" /><Gridlines ticks={ticks} baseline={50} /><b className={`percentile-dot ${extreme ? 'percentile-extreme' : ''}`} style={{ left: `${at}%` }} /></span>
          <span className="viz-val">{ordinal(row.value)}</span>
        </li>;
      })}
    </ul>
    {caption ? <figcaption>{caption}</figcaption> : null}
    {node}
  </figure>;
}

/**
 * Two measures per row on one shared axis from zero, with a reference line -
 * up and down capture against the benchmark's 100%. The two measures are two
 * series, so they take two identity colours and a legend.
 */
export function PairedBars({ rows, aLabel, bLabel, reference = 100, unit = '%', caption }) {
  const { box, handlers, node } = useTooltip();
  const usable = rows.filter((row) => Number.isFinite(row.a) || Number.isFinite(row.b));
  if (!usable.length) return null;
  const limit = niceLimit(Math.max(reference, ...usable.flatMap((row) => [row.a, row.b]).filter(Number.isFinite)));
  const width = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(100, (value / limit) * 100)) : 0);
  const show = (value) => (Number.isFinite(value) ? `${value}${unit}` : '—');
  const ticks = niceTicks(limit).map((value) => ({ at: (value / limit) * 100, label: `${value}${unit}` }));
  const referenceAt = (reference / limit) * 100;
  return <figure className="viz paired-chart viz-axis-chart" ref={box}>
    <div className="diverging-legend"><span><i className="viz-key viz-key-pos" />{aLabel}</span><span><i className="viz-key viz-key-opp" />{bLabel}</span><span><i className="paired-ref-key" />{reference}{unit}: moves one-for-one</span></div>
    <AxisHead ticks={ticks} valueLabels={[aLabel.replace(/ capture$/i, ''), bLabel.replace(/ capture$/i, '')]} />
    <ul className="viz-rows">
      {usable.map((row) => <li key={row.key} className="viz-grid viz-row" style={{ '--values': 2 }} tabIndex={0}
        aria-label={`${row.name}: ${aLabel} ${show(row.a)}, ${bLabel} ${show(row.b)}${row.note ? `, ${row.note}` : ''}`}
        {...handlers(<TipBody value={`${show(row.a)} up · ${show(row.b)} down`} label={row.name} lines={[row.note]} />)}>
        <span className="viz-name">{row.name}{row.sub ? <small>{row.sub}</small> : null}</span>
        <span className="viz-track paired-track">
          <Gridlines ticks={ticks} baseline={0} />
          <i className="viz-reference" style={{ left: `${referenceAt}%` }} />
          <b className="paired-bar paired-a" style={{ width: `${width(row.a)}%` }} />
          <b className="paired-bar paired-b" style={{ width: `${width(row.b)}%` }} />
        </span>
        <span className="viz-val">{show(row.a)}</span>
        <span className="viz-val viz-val-2">{show(row.b)}</span>
      </li>)}
    </ul>
    {caption ? <figcaption>{caption}</figcaption> : null}
    {node}
  </figure>;
}
