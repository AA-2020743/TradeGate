/**
 * Dark-theme counterparts for every light-theme colour that lacks one.
 *
 * The stylesheet is written light-first with literal colours, and the dark
 * theme is a set of `html[data-theme='dark']` overrides beside them. Every
 * panel added without its overrides rendered light-theme colours on the dark
 * background: near-black labels on a near-black panel, near-white cells
 * holding near-white text, accent greens and reds tuned for a pale page. A
 * contrast sweep of the dark theme found 77 such selectors on the unpublished
 * states alone.
 *
 * Rather than chase them by hand, this derives the missing overrides from the
 * light rules at build time, so a new panel is readable in dark mode the day
 * it is written. Hand-written dark rules always win: a selector and property
 * group that already has one is left alone. What is derived:
 *
 *   text      - lightness mirrored, then raised until it reads at 5.5:1 on
 *               the lightest common dark surface; hue kept, saturation capped
 *               so accents do not turn neon.
 *   surfaces  - a light background becomes a dark one of the same hue, so a
 *               tinted chip stays tinted.
 *   lines     - light borders become dark hairlines.
 *   graphics  - SVG fills and strokes are raised to 3:1, the non-text bar.
 *   dimming   - text muted with opacity (0.45-0.65 here) is floored at
 *               DARK_MIN_OPACITY: on a dark panel an already-muted or
 *               coloured label at 0.55 fell to 2-3:1. Opacities of 0.3 or
 *               less are decorative or transitional and disabled controls
 *               are exempt, so both are left alone.
 */

export const DARK_SURFACE = '#1a221d';
// Raised pills and selected rows sit on this; text tuned for it passes on
// the base panel too.
export const DARK_RAISED_SURFACE = '#27332b';
const DARK_SELECTOR = "html[data-theme='dark']";
export const DARK_MIN_OPACITY = 0.8;

// --- colour maths ---------------------------------------------------------

export function parseColor(token) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(token);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((digit) => digit + digit).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    const value = (offset) => parseInt(digits.slice(offset, offset + 2), 16);
    return { r: value(0), g: value(2), b: value(4), a: digits.length === 8 ? value(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(token);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part));
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const color = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
    return Object.values(color).every(Number.isFinite) ? color : null;
  }
  return null;
}

export function formatColor({ r, g, b, a = 1 }) {
  const channel = (value) => Math.round(Math.min(255, Math.max(0, value)));
  if (a < 1) return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.round(a * 1000) / 1000})`;
  return `#${[r, g, b].map((value) => channel(value).toString(16).padStart(2, '0')).join('')}`;
}

function toHsl({ r, g, b }) {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? (green - blue) / delta + (green < blue ? 6 : 0) : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return { h: hue / 6, s: saturation, l: lightness };
}

function fromHsl({ h, s, l }, a = 1) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255, a };
}

function luminance({ r, g, b }) {
  const linear = (value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function over(top, bottom) {
  const a = top.a ?? 1;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

function raiseUntil(hsl, alpha, target, surface) {
  let candidate = { ...hsl };
  for (let step = 0; step < 100 && contrastRatio(over(fromHsl(candidate, alpha), surface), surface) < target; step += 1) {
    candidate = { ...candidate, l: Math.min(1, candidate.l + 0.01) };
  }
  return candidate;
}

// 4.5:1 is the bar; the headroom keeps text muted to DARK_MIN_OPACITY above it.
export const DARK_TEXT_CONTRAST = 5.5;

/** A light-theme text colour, re-made to read on the dark surfaces. */
export function darkTextColor(color, { target = DARK_TEXT_CONTRAST } = {}) {
  const surface = parseColor(DARK_RAISED_SURFACE);
  if (contrastRatio(over(color, surface), surface) >= target) return color;
  const hsl = toHsl(color);
  const mirrored = { h: hsl.h, s: Math.min(hsl.s, 0.6), l: Math.max(1 - hsl.l, hsl.l) };
  return fromHsl(raiseUntil(mirrored, color.a ?? 1, target, surface), color.a ?? 1);
}

function chromaOf(hsl) {
  return hsl.s * (1 - Math.abs(2 * hsl.l - 1));
}

// Carries a colour's chroma, not its HSL saturation, to a new lightness: near
// white, saturation is inflated (#fbfbf8 is "100% saturated"), and keeping it
// turned a barely-warm white into an olive panel.
function atLightness(hsl, lightness, maxSaturation) {
  const chroma = chromaOf(hsl);
  const room = 1 - Math.abs(2 * lightness - 1);
  return { h: hsl.h, s: room > 0 ? Math.min(maxSaturation, chroma / room) : 0, l: lightness };
}

/** A light surface becomes a dark one of the same hue; dark or translucent ones are kept. */
export function darkSurfaceColor(color) {
  const hsl = toHsl(color);
  if ((color.a ?? 1) < 0.5 || hsl.l <= 0.6) return color;
  const lightness = 0.1 + (1 - hsl.l) * 0.45;
  // A near-neutral light surface (the page's off-whites) takes the dark
  // panel's own faint green, so it sits with the panels around it instead of
  // carrying its barely-warm tint into a brown cell.
  if (chromaOf(hsl) < 0.04) return fromHsl({ ...toHsl(parseColor(DARK_SURFACE)), l: lightness }, color.a ?? 1);
  return fromHsl(atLightness(hsl, lightness, 0.35), color.a ?? 1);
}

/** Light hairlines become dark ones; accent-coloured borders are treated as graphics. */
export function darkLineColor(color) {
  const hsl = toHsl(color);
  if ((color.a ?? 1) < 0.5) return color;
  if (hsl.l > 0.72) return fromHsl(atLightness(hsl, 0.17 + (1 - hsl.l) * 0.5, 0.2), color.a ?? 1);
  return darkGraphicColor(color);
}

/**
 * A background on a rule that holds text or padding is a surface; a light
 * grey one is a track or divider and darkens too. A coloured background on a
 * bare element is a data mark - a bar fill, a status dot - and darkening it
 * like a panel made it vanish, so it is only held to the 3:1 graphic bar.
 */
export function darkBackgroundColor(color, { surface }) {
  if (surface) return darkSurfaceColor(color);
  if (chromaOf(toHsl(color)) < 0.08) return darkSurfaceColor(color);
  return (color.a ?? 1) < 0.5 ? color : darkGraphicColor(color);
}

export function darkGraphicColor(color) {
  return darkTextColor(color, { target: 3 });
}

// --- stylesheet parsing ---------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flat rules with their enclosing at-rule (only `@media` nests here).
 * `@keyframes` and other at-rules are skipped: their colours animate between
 * states the rules already define.
 */
export function parseRules(css) {
  const source = stripComments(css);
  const rules = [];
  let index = 0;
  const readBlock = (context) => {
    while (index < source.length) {
      const open = source.indexOf('{', index);
      const close = source.indexOf('}', index);
      if (close !== -1 && (open === -1 || close < open)) {
        index = close + 1;
        return;
      }
      if (open === -1) {
        index = source.length;
        return;
      }
      const prelude = source.slice(index, open).trim();
      index = open + 1;
      if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
        readBlock(prelude);
      } else if (prelude.startsWith('@')) {
        let depth = 1;
        while (index < source.length && depth > 0) {
          if (source[index] === '{') depth += 1;
          else if (source[index] === '}') depth -= 1;
          index += 1;
        }
      } else {
        const end = source.indexOf('}', index);
        const body = source.slice(index, end === -1 ? source.length : end);
        index = end === -1 ? source.length : end + 1;
        const declarations = body.split(';').map((part) => part.trim()).filter(Boolean).flatMap((part) => {
          const colon = part.indexOf(':');
          return colon > 0 ? [{ property: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim() }] : [];
        });
        const selectors = prelude.split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')).filter(Boolean);
        if (selectors.length) rules.push({ context, selectors, declarations });
      }
    }
  };
  // Top-level: a stray '}' would end the block early, so loop until consumed.
  while (index < source.length) readBlock(null);
  return rules;
}

function groupOf(property) {
  if (property === 'color') return 'color';
  if (property === 'background' || property === 'background-color' || property === 'background-image') return 'background';
  if (property.startsWith('border') && !property.includes('radius') && !property.includes('width') && !property.includes('style') && !property.includes('collapse') && !property.includes('spacing')) return 'border';
  if (property === 'outline' || property === 'outline-color') return 'border';
  if (property === 'fill') return 'fill';
  if (property === 'stroke') return 'stroke';
  if (property === 'opacity') return 'opacity';
  return null;
}

const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;
const MAPPERS = { color: darkTextColor, background: darkBackgroundColor, border: darkLineColor, fill: darkGraphicColor, stroke: darkGraphicColor };
const SKIPPED_SELECTORS = new Set([':root', 'html', 'body', '*']);

function darkSelectorFor(selector) {
  if (selector.startsWith('html')) return `${DARK_SELECTOR}${selector.slice(4)}`;
  if (selector.startsWith(':root')) return `${DARK_SELECTOR}${selector.slice(5)}`;
  return `${DARK_SELECTOR} ${selector}`;
}

/** The overrides the light rules are missing, as CSS. */
export function deriveDarkTheme(css) {
  const rules = parseRules(css);
  const covered = new Set();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (!selector.startsWith(DARK_SELECTOR)) continue;
      const light = selector.slice(DARK_SELECTOR.length).trim();
      for (const declaration of rule.declarations) {
        const group = groupOf(declaration.property);
        if (group) covered.add(`${rule.context ?? ''}|${light}|${group}`);
        // A hand-written rule outside any media query covers every context.
        if (group && rule.context === null) covered.add(`*|${light}|${group}`);
      }
    }
  }
  const byContext = new Map();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (selector.includes('data-theme') || SKIPPED_SELECTORS.has(selector)) continue;
      const surface = rule.declarations.some((declaration) => declaration.property === 'color' || declaration.property.startsWith('padding'));
      const declarations = rule.declarations.flatMap((declaration) => {
        const group = groupOf(declaration.property);
        if (!group || covered.has(`${rule.context ?? ''}|${selector}|${group}`) || covered.has(`*|${selector}|${group}`)) return [];
        if (group === 'opacity') {
          const opacity = Number(declaration.value);
          return Number.isFinite(opacity) && opacity > 0.3 && opacity < DARK_MIN_OPACITY && !selector.includes(':disabled') ? [`opacity: ${DARK_MIN_OPACITY}`] : [];
        }
        let changed = false;
        const value = declaration.value.replace(COLOR_TOKEN, (token) => {
          const color = parseColor(token);
          if (!color) return token;
          const mapped = formatColor(MAPPERS[group](color, { surface }));
          if (mapped !== formatColor(color)) changed = true;
          return mapped;
        });
        return changed ? [`${declaration.property}: ${value}`] : [];
      });
      if (!declarations.length) continue;
      const list = byContext.get(rule.context) ?? [];
      list.push(`${darkSelectorFor(selector)} { ${declarations.join('; ')}; }`);
      byContext.set(rule.context, list);
    }
  }
  const blocks = [];
  for (const [context, lines] of byContext) {
    blocks.push(context ? `${context} {\n${lines.map((line) => `  ${line}`).join('\n')}\n}` : lines.join('\n'));
  }
  return blocks.length ? `/* Derived dark-theme overrides (src/darkTheme.js) */\n${blocks.join('\n')}\n` : '';
}

// --- light theme: the same bar for the light page -------------------------
//
// The light rules were written by eye, and a sweep found 141 text colours
// under 4.5:1 on the light panels - footnotes at 2.5:1, section labels and
// pills near 3:1. Editing them in place would also move every dark colour
// derived from them above, so this adds light-only overrides instead: each
// text colour below the bar, darkened with its hue kept until it reads on
// the darker light surfaces. Three things keep it from doing harm:
//
//   - every override is wrapped in :where(), so it carries exactly the
//     specificity of the rule it came from and wins only over that rule (by
//     coming later), never over a more specific rule written on purpose;
//   - its selector names data-theme, so the dark derivation skips it and the
//     dark theme is byte-for-byte what it was;
//   - text inside a surface that is dark on the light page (the sidebar, the
//     dark callout panels) is excluded, since that text is light on purpose.

// The darker of the light page's raised surfaces - pills and tinted chips.
export const LIGHT_RAISED_SURFACE = '#eef0ea';
export const LIGHT_TEXT_CONTRAST = 4.6;
// Body text muted with opacity 0.55-0.6 fell to 3.6-4.4:1 on the light
// panels. The floor matches the dark theme's: at 0.8 body text reads at about
// 8:1, which leaves room for a coloured figure inside a muted row, where the
// colour and the opacity come from different rules.
export const LIGHT_MIN_OPACITY = DARK_MIN_OPACITY;
const LIGHT_SELECTOR = ":where(html:not([data-theme='dark']))";

function lowerUntil(hsl, alpha, target, surface) {
  let candidate = { ...hsl };
  for (let step = 0; step < 100 && contrastRatio(over(fromHsl(candidate, alpha), surface), surface) < target; step += 1) {
    candidate = { ...candidate, l: Math.max(0, candidate.l - 0.01) };
  }
  return candidate;
}

/** A light-theme text colour, darkened with its hue kept until it reads at the bar on `surface`. */
export function lightTextColor(color, { surface = parseColor(LIGHT_RAISED_SURFACE), target = LIGHT_TEXT_CONTRAST } = {}) {
  if (contrastRatio(over(color, surface), surface) >= target) return color;
  return fromHsl(lowerUntil(toHsl(color), color.a ?? 1, target, surface), color.a ?? 1);
}

function firstColor(value) {
  const token = value.match(COLOR_TOKEN)?.[0];
  return token ? parseColor(token) : null;
}

function isThemeNeutral(selector) {
  return !selector.includes('data-theme') && !SKIPPED_SELECTORS.has(selector) && !selector.startsWith('html') && !selector.startsWith(':root');
}

/** Selectors painted dark on the light page: their text is light on purpose. */
export function lightPageDarkSurfaces(rules) {
  const surfaces = new Set();
  for (const rule of rules) {
    const background = rule.declarations.find((declaration) => declaration.property === 'background' || declaration.property === 'background-color');
    const color = background ? firstColor(background.value) : null;
    if (!color || (color.a ?? 1) < 0.6 || luminance(color) >= 0.2) continue;
    // A translucent fixed layer is a backdrop under a dialog, not a surface
    // text sits on: the dialog above it is a light panel of its own.
    const fixed = rule.declarations.some((declaration) => declaration.property === 'position' && declaration.value === 'fixed');
    if (rule.declarations.some((declaration) => declaration.property === 'backdrop-filter') || (fixed && (color.a ?? 1) < 1)) continue;
    for (const selector of rule.selectors) if (isThemeNeutral(selector) && !selector.includes('::')) surfaces.add(selector);
  }
  return [...surfaces];
}

/** Light-only overrides lifting every text colour below the bar, as CSS. */
export function deriveLightContrast(css) {
  const rules = parseRules(css);
  const darkSurfaces = lightPageDarkSurfaces(rules);
  // One :not per surface rather than a list: a comma inside the selector
  // would be split by any comma-splitting reader of this stylesheet, the dark
  // derivation's included. :where() keeps each one at zero specificity.
  const guard = darkSurfaces.map((surface) => `:not(:where(${surface}) *)`).join('');
  const byContext = new Map();
  for (const rule of rules) {
    const background = rule.declarations.find((declaration) => declaration.property === 'background' || declaration.property === 'background-color');
    const own = background ? firstColor(background.value) : null;
    // Text on its own dark background is light on purpose.
    if (own && (own.a ?? 1) >= 0.6 && luminance(own) < 0.2) continue;
    // Read against the rule's own light background when it has one, else
    // against the darker of the page's raised surfaces.
    const surface = own && (own.a ?? 1) >= 0.6 && luminance(own) < luminance(parseColor(LIGHT_RAISED_SURFACE)) ? own : parseColor(LIGHT_RAISED_SURFACE);
    // Opacity between the decorative (0.3 or less) and the floor is raised to
    // the floor, as the dark derivation does; a colour in the same rule is
    // judged at the opacity it will actually be drawn with.
    const opacityDeclaration = rule.declarations.find((declaration) => declaration.property === 'opacity');
    const opacity = opacityDeclaration ? Number(opacityDeclaration.value) : 1;
    const floored = Number.isFinite(opacity) && opacity > 0.3 && opacity < LIGHT_MIN_OPACITY;
    const drawnAt = Number.isFinite(opacity) ? Math.max(opacity, floored ? LIGHT_MIN_OPACITY : opacity) : 1;
    const declarations = rule.declarations.flatMap((declaration) => {
      if (declaration.property === 'opacity') return floored ? [`opacity: ${LIGHT_MIN_OPACITY}`] : [];
      if (declaration.property !== 'color') return [];
      const color = parseColor(declaration.value);
      if (!color) return [];
      const drawn = { ...color, a: (color.a ?? 1) * drawnAt };
      const lifted = lightTextColor(drawn, { surface });
      if (formatColor(lifted) === formatColor(drawn)) return [];
      return [`color: ${formatColor({ ...lifted, a: color.a ?? 1 })}`];
    });
    if (!declarations.length) continue;
    for (const selector of rule.selectors) {
      // Disabled controls are exempt from the contrast bar.
      if (!isThemeNeutral(selector) || selector.includes(':disabled')) continue;
      const pseudo = selector.indexOf('::');
      const scoped = pseudo === -1 ? `${selector}${guard}` : `${selector.slice(0, pseudo)}${guard}${selector.slice(pseudo)}`;
      const list = byContext.get(rule.context) ?? [];
      list.push(`${LIGHT_SELECTOR} ${scoped} { ${declarations.join('; ')}; }`);
      byContext.set(rule.context, list);
    }
  }
  const blocks = [];
  for (const [context, lines] of byContext) {
    blocks.push(context ? `${context} {\n${lines.map((line) => `  ${line}`).join('\n')}\n}` : lines.join('\n'));
  }
  return blocks.length ? `/* Derived light-theme contrast (src/darkTheme.js) */\n${blocks.join('\n')}\n` : '';
}

/** Vite plugin: appends the derived overrides to the stylesheet at build and dev time. */
export function darkThemePlugin({ match = /\/src\/styles\.css$/ } = {}) {
  return {
    name: 'tradegate-dark-theme',
    enforce: 'pre',
    transform(code, id) {
      if (!match.test(id.split('?')[0])) return null;
      return { code: `${code}\n${deriveDarkTheme(code)}\n${deriveLightContrast(code)}`, map: null };
    },
  };
}
