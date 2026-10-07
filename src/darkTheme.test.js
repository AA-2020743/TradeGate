import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DARK_MIN_OPACITY,
  DARK_RAISED_SURFACE,
  DARK_SURFACE,
  contrastRatio,
  darkBackgroundColor,
  darkSurfaceColor,
  darkTextColor,
  deriveDarkTheme,
  formatColor,
  parseColor,
  parseRules,
} from './darkTheme.js';

const base = parseColor(DARK_SURFACE);
const raised = parseColor(DARK_RAISED_SURFACE);
const stylesheet = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function hueOf({ r, g, b }) {
  return Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
}

test('colours parse from hex and rgb forms and format back', () => {
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('#1a221d'), { r: 26, g: 34, b: 29, a: 1 });
  assert.deepEqual(parseColor('rgba(42, 139, 68, 0.1)'), { r: 42, g: 139, b: 68, a: 0.1 });
  assert.deepEqual(parseColor('rgb(42 139 68 / 50%)'), { r: 42, g: 139, b: 68, a: 0.5 });
  assert.equal(parseColor('currentColor'), null);
  assert.equal(formatColor(parseColor('#2a8b44')), '#2a8b44');
  assert.equal(formatColor({ r: 1, g: 2, b: 3, a: 0.25 }), 'rgba(1, 2, 3, 0.25)');
});

test('light-theme text colours become readable on both dark surfaces, keeping their hue', () => {
  // The light theme's own palette: near-black body text, muted greys, and the
  // positive, negative, caution and link accents.
  for (const token of ['#19201c', '#37413a', '#5d665f', '#7f867f', '#9ba19b', '#2a8a43', '#a35342', '#9a782f', '#52734c', '#8760bd']) {
    const light = parseColor(token);
    const dark = darkTextColor(light);
    assert.ok(contrastRatio(dark, raised) >= 5.5, `${token} -> ${formatColor(dark)} on the raised surface`);
    assert.ok(contrastRatio(dark, base) >= 5.5, `${token} -> ${formatColor(dark)} on the base panel`);
    if (Math.max(light.r, light.g, light.b) - Math.min(light.r, light.g, light.b) > 40) {
      const drift = Math.abs(hueOf(dark) - hueOf(light));
      assert.ok(Math.min(drift, 2 * Math.PI - drift) < 0.15, `${token} keeps its hue (drift ${drift.toFixed(3)})`);
    }
  }
  // A colour that already reads on dark is left alone.
  assert.deepEqual(darkTextColor(parseColor('#dce5dc')), parseColor('#dce5dc'));
});

test('a near-white surface becomes a near-neutral dark one, and a tinted chip keeps its tint', () => {
  const panel = darkSurfaceColor(parseColor('#fbfbf8'));
  assert.ok(contrastRatio(panel, base) < 1.3, `${formatColor(panel)} sits close to the dark panel`);
  assert.ok(Math.max(panel.r, panel.g, panel.b) - Math.min(panel.r, panel.g, panel.b) < 8, `${formatColor(panel)} is not tinted olive`);
  const chip = darkSurfaceColor(parseColor('#e7f3df'));
  assert.ok(chip.g > chip.r && chip.g > chip.b, `${formatColor(chip)} stays green`);
  assert.ok(contrastRatio(darkTextColor(parseColor('#41643c')), chip) >= 4.5);
  // Dark and translucent surfaces are kept.
  assert.deepEqual(darkSurfaceColor(parseColor('#19201c')), parseColor('#19201c'));
  assert.deepEqual(darkSurfaceColor(parseColor('rgba(42, 139, 68, 0.1)')), parseColor('rgba(42, 139, 68, 0.1)'));
});

test('a coloured data mark is kept visible rather than darkened like a panel', () => {
  const violet = parseColor('#c0a8e8');
  assert.deepEqual(darkBackgroundColor(violet, { surface: false }), violet, 'a pale accent mark already clears 3:1');
  assert.ok(contrastRatio(darkBackgroundColor(violet, { surface: true }), base) < 2, 'the same colour as a text surface does darken');
  const track = darkBackgroundColor(parseColor('#eef0ea'), { surface: false });
  assert.ok(contrastRatio(track, base) < 1.5, 'a grey track darkens even without text');
});

test('hand-written dark rules win, media queries are respected, keyframes are skipped', () => {
  const css = `
    .a { color: #19201c; background: #fbfbf8; border: 1px solid #e9ebe4; }
    .b { color: #7f867f; }
    html[data-theme='dark'] .b { color: #dce5dc; }
    @media (max-width: 600px) { .c { color: #37413a; } }
    @keyframes pulse { from { color: #19201c; } to { color: #000; } }
    .d { opacity: 0.55; }
    .d:disabled { opacity: 0.35; }
    .e { opacity: 0.2; }
    .f, .g { color: #2a8a43; }
    .h { border-radius: 4px; color: inherit; }
  `;
  const derived = deriveDarkTheme(css);
  assert.match(derived, /html\[data-theme='dark'\] \.a \{ color: #[0-9a-f]{6}; background: #[0-9a-f]{6}; border: 1px solid #[0-9a-f]{6}; \}/);
  assert.doesNotMatch(derived, /\] \.b \{/, 'a selector with a hand-written dark colour is left alone');
  assert.match(derived, /@media \(max-width: 600px\) \{\n {2}html\[data-theme='dark'\] \.c \{ color: /);
  assert.doesNotMatch(derived, /pulse|#000/);
  assert.match(derived, new RegExp(`\\] \\.d \\{ opacity: ${DARK_MIN_OPACITY}; \\}`));
  assert.doesNotMatch(derived, /:disabled|\.e \{/);
  assert.match(derived, /\] \.f \{ color: /);
  assert.match(derived, /\] \.g \{ color: /);
  assert.doesNotMatch(derived, /\.h \{/);
});

test('the real stylesheet parses completely and every derived text colour clears the bar', () => {
  const rules = parseRules(stylesheet);
  assert.ok(rules.length > 1000, `${rules.length} rules parsed`);
  const derived = deriveDarkTheme(stylesheet);
  const derivedRules = parseRules(derived);
  assert.ok(derivedRules.length > 50);
  for (const rule of derivedRules) {
    for (const declaration of rule.declarations.filter((entry) => entry.property === 'color')) {
      const color = parseColor(declaration.value);
      assert.ok(contrastRatio(color, base) >= 4.5, `${rule.selectors[0]} ${declaration.value}`);
    }
  }
});

// The badge sits on the asset's own bright colour, set inline.
const INTENTIONAL_DARK_TEXT = new Set([".asset-badge"]);

test('hand-written dark text colours read at 4.5:1 on their own background or the dark panel', () => {
  const failures = [];
  for (const rule of parseRules(stylesheet)) {
    const darkSelectors = rule.selectors.filter((selector) => selector.startsWith("html[data-theme='dark']"));
    if (!darkSelectors.length) continue;
    const background = rule.declarations.find((entry) => entry.property === 'background' || entry.property === 'background-color');
    const surface = (background && parseColor(background.value)) || base;
    for (const declaration of rule.declarations.filter((entry) => entry.property === 'color')) {
      const color = parseColor(declaration.value);
      if (!color) continue;
      const selectors = darkSelectors.map((selector) => selector.replace("html[data-theme='dark'] ", ''));
      if (selectors.every((selector) => INTENTIONAL_DARK_TEXT.has(selector))) continue;
      const ratio = contrastRatio(color, surface.a < 1 ? base : surface);
      if (ratio < 4.5) failures.push(`${selectors.join(', ')}: ${declaration.value} at ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, []);
});
