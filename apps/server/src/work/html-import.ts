import ts from 'typescript';

export interface HtmlCompileOptions {
  fallbackTitle?: string;
  extraCss?: string;
  /**
   * Resolves a raw asset URL encountered in HTML `<img src>` or CSS `url(...)`.
   * - For `'img'`: return a work-public path like `'imported/hero.png'` (emitted with `import.meta.env.BASE_URL`),
   *   a safe `data:image/...` URI, or `null` to render an offline SVG placeholder.
   * - For `'css'`: return a `src/`-relative path like `'./imported/bg.png'`, a safe `data:image/...` URI,
   *   or `null` to strip the external/missing URL safely.
   */
  resolveAssetUrl?: (rawUrl: string, kind: 'img' | 'css') => string | null;
}

export interface CompiledHtmlWork {
  title: string;
  appTsx: string;
  styleCss: string;
  elementCount: number;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const SKIP_SUBTREE_TAGS = new Set([
  'script', 'noscript', 'style', 'template', 'iframe', 'frame',
  'frameset', 'object', 'embed', 'applet', 'head', 'title',
]);

const DROP_STANDALONE_TAGS = new Set([
  'html', 'body', 'base', 'link', 'meta', 'param', 'source', 'track',
]);

const ALLOWED_HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote',
  'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist',
  'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'i', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'menu', 'meter',
  'nav', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp',
  'rt', 'ruby', 's', 'samp', 'section', 'select', 'small', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
  'var', 'video', 'wbr',
  // SVG tags
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'text', 'tspan',
  'use', 'symbol', 'marker', 'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix',
]);

const SVG_TAG_CASE: Record<string, string> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
  fegaussianblur: 'feGaussianBlur',
  feoffset: 'feOffset',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
};

const AUTO_CLOSE_SAME_TAG = new Set(['p', 'li', 'dt', 'dd', 'option', 'tr', 'td', 'th']);
const BLOCK_CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

const ATTR_MAP: Record<string, string> = {
  class: 'className',
  classname: 'className',
  for: 'htmlFor',
  htmlfor: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  novalidate: 'noValidate',
  formaction: 'formAction',
  formenctype: 'formEncType',
  formmethod: 'formMethod',
  formnovalidate: 'formNoValidate',
  formtarget: 'formTarget',
  enctype: 'encType',
  crossorigin: 'crossOrigin',
  referrerpolicy: 'referrerPolicy',
  srcset: 'srcSet',
  imagesrcset: 'imageSrcSet',
  imagesizes: 'imageSizes',
  fetchpriority: 'fetchPriority',
  playsinline: 'playsInline',
  contenteditable: 'contentEditable',
  spellcheck: 'spellCheck',
  inputmode: 'inputMode',
  enterkeyhint: 'enterKeyHint',
  accesskey: 'accessKey',
   charset: 'charSet',
  datetime: 'dateTime',
  usemap: 'useMap',
  // SVG attributes
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'letter-spacing': 'letterSpacing',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'alignment-baseline': 'alignmentBaseline',
  'baseline-shift': 'baselineShift',
  'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering',
  'color-interpolation-filters': 'colorInterpolationFilters',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  patternunits: 'patternUnits',
  patterntransform: 'patternTransform',
  clippathunits: 'clipPathUnits',
  maskunits: 'maskUnits',
  filterunits: 'filterUnits',
  stddeviation: 'stdDeviation',
  'xlink:href': 'href',
};

const BOOLEAN_ATTRS = new Set([
  'disabled', 'hidden', 'required', 'multiple', 'muted', 'loop', 'controls',
  'open', 'reversed', 'readOnly', 'autoFocus', 'noValidate', 'playsInline',
]);

interface HtmlElementNode {
  kind: 'element';
  tag: string;
  attrs: Map<string, string>;
  children: HtmlNode[];
}

interface HtmlTextNode {
  kind: 'text';
  text: string;
}

type HtmlNode = HtmlElementNode | HtmlTextNode;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  bull: '•',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
  times: '×',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? full;
  });
}

function escapeJsxTextContent(raw: string): string {
  const decoded = decodeHtmlEntities(raw);
  return decoded
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
}

function safeDataImageUri(url: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(url) && url.length <= 260_000 && !url.includes('\0');
}

export function buildPlaceholderSvgDataUri(label?: string): string {
  const clean = (label ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, 32) || 'Imported Image';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#e3ebf2"/><stop offset="100%" stop-color="#cfdbe6"/></linearGradient></defs><rect width="640" height="400" rx="16" fill="url(#g)"/><circle cx="320" cy="176" r="38" fill="#9fb3c6" opacity="0.55"/><text x="320" y="256" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#425466">${clean}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function parseAttributes(rawAttrs: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([^\s=/>"'`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawAttrs)) !== null) {
    const name = match[1].trim();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.set(name.toLowerCase(), decodeHtmlEntities(value));
  }
  return attrs;
}

function cssPropToJsxKey(prop: string): string | null {
  const trimmed = prop.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('--')) {
    return /^--[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
  }
  const lower = trimmed.toLowerCase();
  if (!/^-?[a-z][a-z0-9-]*$/.test(lower)) return null;
  const normalized = lower.startsWith('-ms-') ? `ms-${lower.slice(4)}` : lower;
  return normalized.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function sanitizeCssUrlTokens(value: string, resolveAssetUrl?: HtmlCompileOptions['resolveAssetUrl']): string {
  return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_full, dq?: string, sq?: string, bare?: string) => {
    const raw = (dq ?? sq ?? bare ?? '').trim();
    if (!raw || raw.startsWith('#')) return raw ? `url("${raw}")` : 'none';
    if (safeDataImageUri(raw)) return `url("${raw}")`;
    const resolved = resolveAssetUrl?.(raw, 'css') ?? null;
    if (resolved) return `url("${resolved.replaceAll('"', '')}")`;
    return 'none';
  });
}

function parseInlineStyle(rawStyle: string, resolveAssetUrl?: HtmlCompileOptions['resolveAssetUrl']): Record<string, string> | null {
  const entries: Record<string, string> = {};
  // Split on semicolons outside parentheses and quotes
  const declarations: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < rawStyle.length; i += 1) {
    const ch = rawStyle[i];
    if (quote) {
      current += ch;
      if (ch === quote && rawStyle[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    if (ch === ';' && depth === 0) {
      if (current.trim()) declarations.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) declarations.push(current.trim());

  for (const decl of declarations) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    const key = cssPropToJsxKey(decl.slice(0, colon));
    if (!key) continue;
    let val = decl.slice(colon + 1).trim().replace(/\s*!important\s*$/i, '').trim();
    val = sanitizeCssUrlTokens(val, resolveAssetUrl);
    if (!val || val === 'none' && /url\(/i.test(decl)) {
      if (!val) continue;
    }
    entries[key] = val;
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

export function sanitizeImportedCss(rawCss: string, resolveAssetUrl?: HtmlCompileOptions['resolveAssetUrl']): string {
  let cleaned = rawCss
    .replace(/^\uFEFF/, '')
    .replace(/<!--|-->/g, '')
    // Strip all @import statements so CheckBuild's candidateSpecifier never encounters external/disallowed imports
    .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, '');

  cleaned = sanitizeCssUrlTokens(cleaned, resolveAssetUrl);
  return cleaned.trim();
}

function parseHtmlFragment(html: string): HtmlNode[] {
  const rootChildren: HtmlNode[] = [];
  const stack: HtmlElementNode[] = [];
  const currentChildren = () => (stack.length > 0 ? stack[stack.length - 1].children : rootChildren);

  const tokenRegex = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\?[\s\S]*?\?>|<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>|<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s=/>"'`]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

  let lastIndex = 0;
  let skipUntilCloseTag: string | null = null;
  let match: RegExpExecArray | null;

  const pushText = (raw: string) => {
    if (!raw || skipUntilCloseTag) return;
    currentChildren().push({ kind: 'text', text: raw });
  };

  while ((match = tokenRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      pushText(html.slice(lastIndex, match.index));
    }
    lastIndex = tokenRegex.lastIndex;

    const closeTagRaw = match[1];
    const openTagRaw = match[2];
    const rawAttrs = match[3] ?? '';
    const explicitSelfClose = match[4] === '/';

    if (skipUntilCloseTag) {
      if (closeTagRaw && closeTagRaw.toLowerCase() === skipUntilCloseTag) {
        skipUntilCloseTag = null;
      }
      continue;
    }

    if (!closeTagRaw && !openTagRaw) {
      // Comment / DOCTYPE / CDATA / processing instruction
      continue;
    }

    if (closeTagRaw) {
      const closeTag = closeTagRaw.toLowerCase();
      if (VOID_TAGS.has(closeTag) || DROP_STANDALONE_TAGS.has(closeTag)) continue;
      let foundIndex = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === closeTag) {
          foundIndex = i;
          break;
        }
      }
      if (foundIndex >= 0) {
        stack.length = foundIndex;
      }
      continue;
    }

    const rawLower = openTagRaw.toLowerCase();
    if (SKIP_SUBTREE_TAGS.has(rawLower)) {
      if (!explicitSelfClose && !VOID_TAGS.has(rawLower)) {
        skipUntilCloseTag = rawLower;
      }
      continue;
    }

    if (DROP_STANDALONE_TAGS.has(rawLower)) {
      continue;
    }

    const normalizedTag = ALLOWED_HTML_TAGS.has(rawLower) ? rawLower : 'div';

    // HTML5 implicit auto-closing
    if (stack.length > 0) {
      const top = stack[stack.length - 1].tag;
      if (AUTO_CLOSE_SAME_TAG.has(normalizedTag) && top === normalizedTag) {
        stack.pop();
      } else if (BLOCK_CLOSES_P.has(normalizedTag) && top === 'p') {
        stack.pop();
      }
    }

    const element: HtmlElementNode = {
      kind: 'element',
      tag: normalizedTag,
      attrs: parseAttributes(rawAttrs),
      children: [],
    };
    currentChildren().push(element);

    if (!explicitSelfClose && !VOID_TAGS.has(normalizedTag)) {
      stack.push(element);
    }
  }

  if (lastIndex < html.length) {
    pushText(html.slice(lastIndex));
  }

  return rootChildren;
}

function serializeAttributes(
  node: HtmlElementNode,
  inSvg: boolean,
  options: HtmlCompileOptions,
): string {
  const parts: string[] = [];
  const tag = node.tag;
  let hasTypeAttr = false;

  for (const [rawKey, rawVal] of node.attrs.entries()) {
    if (rawKey.startsWith('on')) continue; // strip inline JS event strings
    if (rawKey === 'xmlns:xlink' || rawKey === 'xml:space' || rawKey === 'xml:lang') continue;
    if (rawKey === 'selected' && tag === 'option') continue;

    if (rawKey === 'style') {
      const styleObj = parseInlineStyle(rawVal, options.resolveAssetUrl);
      if (styleObj) {
        parts.push(`style={${JSON.stringify(styleObj)}}`);
      }
      continue;
    }

    if (tag === 'img' && rawKey === 'src') {
      const trimmed = rawVal.trim();
      if (safeDataImageUri(trimmed)) {
        parts.push(`src=${JSON.stringify(trimmed)}`);
      } else {
        const resolved = options.resolveAssetUrl?.(trimmed, 'img') ?? null;
        if (resolved && safeDataImageUri(resolved)) {
          parts.push(`src=${JSON.stringify(resolved)}`);
        } else if (resolved) {
          const cleanRel = resolved.replace(/^\/+/, '');
          parts.push(`src={\`\${import.meta.env.BASE_URL}${cleanRel.replace(/[`$\\]/g, '')}\`}`);
        } else {
          parts.push(`src=${JSON.stringify(buildPlaceholderSvgDataUri(node.attrs.get('alt')))}`);
        }
      }
      continue;
    }

    if (rawKey === 'srcset' || rawKey === 'imagesrcset') {
      // Drop external srcSet so browser checks never fetch unlocalized responsive candidates
      continue;
    }

    if (tag === 'a' && rawKey === 'href') {
      const trimmed = rawVal.trim();
      if (/^javascript:/i.test(trimmed)) {
        parts.push('href="#action"');
      } else if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
        parts.push('href="#external-link"');
        parts.push(`title=${JSON.stringify(node.attrs.get('title') || trimmed.slice(0, 120))}`);
      } else {
        parts.push(`href=${JSON.stringify(trimmed || '#')}`);
      }
      continue;
    }

    if (tag === 'a' && rawKey === 'title' && /^https?:\/\//i.test(node.attrs.get('href') ?? '')) {
      continue;
    }

    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && rawKey === 'value') {
      parts.push(`defaultValue=${JSON.stringify(rawVal)}`);
      continue;
    }

    if (tag === 'input' && rawKey === 'checked') {
      parts.push('defaultChecked');
      continue;
    }

    let jsxKey: string | undefined = ATTR_MAP[rawKey];
    if (!jsxKey) {
      if (/^(?:data|aria)-[a-z0-9_.-]+$/.test(rawKey)) {
        jsxKey = rawKey;
      } else if (inSvg && /^[a-z][a-z0-9-]*$/.test(rawKey)) {
        jsxKey = rawKey.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
      } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawKey)) {
        jsxKey = rawKey;
      }
    }
    if (!jsxKey) continue;

    if (jsxKey === 'type') hasTypeAttr = true;

    if (BOOLEAN_ATTRS.has(jsxKey)) {
      if (rawVal.toLowerCase() !== 'false') {
        parts.push(jsxKey);
      }
      continue;
    }

    parts.push(`${jsxKey}=${JSON.stringify(rawVal)}`);
  }

  if (tag === 'button' && !hasTypeAttr) {
    parts.unshift('type="button"');
  }
  if (tag === 'form') {
    parts.push('onSubmit={event => event.preventDefault()}');
  }
  if (tag === 'img' && !node.attrs.has('src')) {
    parts.push(`src=${JSON.stringify(buildPlaceholderSvgDataUri(node.attrs.get('alt')))}`);
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function serializeNodes(
  nodes: HtmlNode[],
  indentLevel: number,
  inSvg: boolean,
  inPre: boolean,
  options: HtmlCompileOptions,
  counter: { elements: number },
): string[] {
  const lines: string[] = [];
  const pad = '  '.repeat(indentLevel);

  for (const node of nodes) {
    if (node.kind === 'text') {
      if (inPre) {
        if (node.text) {
          lines.push(`${pad}{${JSON.stringify(decodeHtmlEntities(node.text))}}`);
        }
      } else {
        const collapsed = node.text.replace(/\s+/g, ' ');
        if (!collapsed.trim()) continue;
        lines.push(`${pad}${escapeJsxTextContent(collapsed.trim())}`);
      }
      continue;
    }

    counter.elements += 1;
    const nextInSvg = inSvg || node.tag === 'svg';
    const nextInPre = inPre || node.tag === 'pre' || node.tag === 'code';
    const jsxTag = nextInSvg ? (SVG_TAG_CASE[node.tag] ?? node.tag) : node.tag;
    const attrStr = serializeAttributes(node, nextInSvg, options);

    if (node.tag === 'textarea') {
      const textContent = node.children
        .filter((child): child is HtmlTextNode => child.kind === 'text')
        .map(child => decodeHtmlEntities(child.text))
        .join('');
      const extraDefault = textContent && !node.attrs.has('value') ? ` defaultValue=${JSON.stringify(textContent)}` : '';
      lines.push(`${pad}<textarea${attrStr}${extraDefault} />`);
      continue;
    }

    if (VOID_TAGS.has(node.tag) || node.children.length === 0 && nextInSvg) {
      lines.push(`${pad}<${jsxTag}${attrStr} />`);
      continue;
    }

    const childLines = serializeNodes(node.children, indentLevel + 1, nextInSvg, nextInPre, options, counter);
    if (childLines.length === 0) {
      lines.push(`${pad}<${jsxTag}${attrStr}></${jsxTag}>`);
    } else if (childLines.length === 1 && !childLines[0].trimStart().startsWith('<') && childLines[0].length < 88) {
      lines.push(`${pad}<${jsxTag}${attrStr}>${childLines[0].trim()}</${jsxTag}>`);
    } else {
      lines.push(`${pad}<${jsxTag}${attrStr}>`);
      lines.push(...childLines);
      lines.push(`${pad}</${jsxTag}>`);
    }
  }

  return lines;
}

export function compileHtmlToReactWork(rawHtml: string, options: HtmlCompileOptions = {}): CompiledHtmlWork {
  const normalized = rawHtml.replace(/^\uFEFF/, '');

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(normalized);
  const extractedTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const title = (extractedTitle || options.fallbackTitle || '导入网页作品').slice(0, 60);

  const styleBlocks: string[] = [];
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleRegex.exec(normalized)) !== null) {
    if (styleMatch[1].trim()) styleBlocks.push(styleMatch[1]);
  }
  if (options.extraCss?.trim()) {
    styleBlocks.push(options.extraCss);
  }

  const bodyMatch = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(normalized);
  const bodyAttrs = bodyMatch ? parseAttributes(bodyMatch[1]) : new Map<string, string>();
  const bodyContent = bodyMatch ? bodyMatch[2] : normalized;

  const parsedNodes = parseHtmlFragment(bodyContent);
  const counter = { elements: 0 };

  // Unwrap single top-level <main> if present so we never nest <main> inside <main>
  let rootClass = ['forma-imported-page', bodyAttrs.get('class')].filter(Boolean).join(' ').trim();
  let contentNodes = parsedNodes;
  const nonEmptyTop = parsedNodes.filter(n => n.kind === 'element' || n.text.trim().length > 0);
  if (nonEmptyTop.length === 1 && nonEmptyTop[0].kind === 'element' && nonEmptyTop[0].tag === 'main') {
    const topMain = nonEmptyTop[0];
    rootClass = ['forma-imported-page', bodyAttrs.get('class'), topMain.attrs.get('class')].filter(Boolean).join(' ').trim();
    contentNodes = topMain.children;
  }

  let bodyJsxLines = serializeNodes(contentNodes, 3, false, false, options, counter);
  if (bodyJsxLines.length === 0) {
    bodyJsxLines = [
      `      <section className="forma-imported-fallback">`,
      `        <h1>${escapeJsxTextContent(title)}</h1>`,
      `        <p>网页已拉入 Forma 空间工作台，可开启选取修改文案排版或拖入 3D 模型。</p>`,
      `      </section>`,
    ];
    counter.elements = 3;
  }

  const buildAppTsx = (lines: string[]) => `export default function App() {
  return (
    <main data-spatial-page className=${JSON.stringify(rootClass || 'forma-imported-page')}>
${lines.join('\n')}
    </main>
  );
}
`;

  let appTsx = buildAppTsx(bodyJsxLines);
  const checkAst = ts.createSourceFile('src/App.tsx', appTsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (checkAst as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    // Guaranteed valid fallback preserving all extracted text paragraphs if exotic markup ever confused JSX
    const plainParagraphs = decodeHtmlEntities(bodyContent.replace(/<[^>]+>/g, '\n'))
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 40);
    const safeLines = [
      `      <section className="forma-imported-fallback">`,
      `        <h1>${escapeJsxTextContent(title)}</h1>`,
      ...plainParagraphs.map(line => `        <p>${escapeJsxTextContent(line)}</p>`),
      `      </section>`,
    ];
    appTsx = buildAppTsx(safeLines);
  }

  const sanitizedUserCss = sanitizeImportedCss(styleBlocks.join('\n\n'), options.resolveAssetUrl);
  const baseCss = `:root {
  font-family: "Inter", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
.forma-imported-page { min-height: 100vh; }
.forma-imported-page img { max-width: 100%; height: auto; }
`;

  return {
    title,
    appTsx,
    styleCss: sanitizedUserCss ? `${baseCss}\n${sanitizedUserCss}\n` : baseCss,
    elementCount: counter.elements,
  };
}
