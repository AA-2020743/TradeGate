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
  deriveLightContrast,
  LIGHT_MIN_OPACITY,
  LIGHT_RAISED_SURFACE,
  LIGHT_TEXT_CONTRAST,
  lightPageDarkSurfaces,
  lightTextColor,
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

test('light-theme text below the bar is darkened, hue kept, until it reads on the raised light surface', () => {
  const surface = parseColor(LIGHT_RAISED_SURFACE);
  // A muted footnote grey, a section label, and the caution and positive accents.
  for (const token of ['#9ba19b', '#87928b', '#d8b45f', '#6fbf5e', '#2a8a43']) {
    const color = parseColor(token);
    const lifted = lightTextColor(color);
    assert.ok(contrastRatio(lifted, surface) >= LIGHT_TEXT_CONTRAST, `${token} -> ${formatColor(lifted)}`);
    assert.ok(contrastRatio(lifted, surface) < LIGHT_TEXT_CONTRAST + 0.5, `${token} was darkened further than the bar needs`);
    if (token !== '#9ba19b' && token !== '#87928b') assert.ok(Math.abs(hueOf(lifted) - hueOf(color)) < 0.05, `${token} changed hue`);
  }
  // Text that already reads is left exactly as written.
  assert.equal(formatColor(lightTextColor(parseColor('#37413a'))), '#37413a');
});

test('light overrides are scoped to the light theme, at the rule\'s own specificity, and skip dark surfaces', () => {
  const css = `.panel { background: #fbfbf8; }
.note { color: #9ba19b; }
.chip { background: #e2e6dc; color: #7f887f; }
.callout { background: #27322a; color: #a8b59f; }
.ok { color: #37413a; }
.field::placeholder { color: #a0a6a0; }
button:disabled { color: #b0b5b0; }
html[data-theme='dark'] .note { color: #cccccc; }
@media (max-width: 600px) { .note { color: #a5aba5; } }`;
  const out = deriveLightContrast(css);
  const lines = out.split('\n');
  // Every override names data-theme inside :where(), so it adds no specificity
  // and the dark derivation never reads it.
  assert.ok(lines.filter((line) => line.includes('{')).every((line) => line.includes(":where(html:not([data-theme='dark']))") || line.startsWith('@media')));
  assert.match(out, /\.note:not\(:where\(\.callout\) \*\) \{ color: #[0-9a-f]{6}; \}/);
  // A chip is judged against its own background, the darker of the two.
  const chip = out.match(/\.chip[^{]*\{ color: (#[0-9a-f]{6}); \}/)[1];
  assert.ok(contrastRatio(parseColor(chip), parseColor('#e2e6dc')) >= LIGHT_TEXT_CONTRAST);
  // Light text on a dark surface, readable text, and disabled controls are untouched.
  assert.doesNotMatch(out, /\.callout \{|\.callout:not|\.ok|disabled/);
  // A pseudo-element keeps its place at the end of the selector.
  assert.match(out, /\.field:not\(:where\(\.callout\) \*\)::placeholder \{/);
  // An override inside a media query stays inside it.
  assert.match(out, /@media \(max-width: 600px\) \{\n  :where\(html:not\(\[data-theme='dark'\]\)\) \.note/);
  assert.deepEqual(lightPageDarkSurfaces(parseRules(css)), ['.callout']);
});

test('a translucent fixed backdrop is not a dark surface; the dialog above it is light', () => {
  const css = `.backdrop { position: fixed; inset: 0; background: rgba(10, 17, 12, .68); }
.blurred { background: rgba(10, 17, 12, .9); backdrop-filter: blur(6px); }
.sidebar { background: #19201c; }`;
  assert.deepEqual(lightPageDarkSurfaces(parseRules(css)), ['.sidebar']);
});

test('the light overrides leave the derived dark theme exactly as it was', () => {
  const light = deriveLightContrast(stylesheet);
  assert.ok(light.length > 0);
  assert.equal(deriveDarkTheme(`${stylesheet}\n${light}`), deriveDarkTheme(stylesheet));
  // No override carries a comma inside its selector, which a comma-splitting
  // reader of the stylesheet would cut in two.
  for (const line of light.split('\n').filter((entry) => entry.includes('{') && !entry.startsWith('@'))) {
    assert.equal(line.slice(0, line.indexOf('{')).includes(','), false, line.slice(0, 120));
  }
});

test('text muted with opacity is floored in the light theme, and a colour is judged at its drawn opacity', () => {
  const css = `.muted { opacity: 0.55; }
.faint { opacity: 0.2; }
.disabled-look:disabled { opacity: 0.5; }
.grey-muted { color: #7f887f; opacity: 0.6; }`;
  const out = deriveLightContrast(css);
  assert.match(out, new RegExp(`\\.muted[^{]*\\{ opacity: ${LIGHT_MIN_OPACITY}; \\}`));
  // Decorative or transitional opacity and disabled controls are left alone.
  assert.doesNotMatch(out, /\.faint|disabled/);
  // #7f887f does not read on its own, nor at the floor: it is darkened as well as floored.
  const line = out.split('\n').find((entry) => entry.includes('.grey-muted'));
  assert.match(line, new RegExp(`opacity: ${LIGHT_MIN_OPACITY}`));
  const color = parseColor(line.match(/color: (#[0-9a-f]{6})/)[1]);
  const surface = parseColor(LIGHT_RAISED_SURFACE);
  const drawn = { r: color.r * LIGHT_MIN_OPACITY + surface.r * (1 - LIGHT_MIN_OPACITY), g: color.g * LIGHT_MIN_OPACITY + surface.g * (1 - LIGHT_MIN_OPACITY), b: color.b * LIGHT_MIN_OPACITY + surface.b * (1 - LIGHT_MIN_OPACITY), a: 1 };
  assert.ok(contrastRatio(drawn, surface) >= LIGHT_TEXT_CONTRAST);
});
