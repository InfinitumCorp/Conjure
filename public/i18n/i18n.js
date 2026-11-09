// @infinitum/i18n runtime. One plain ES module, no dependencies, so it runs the
// same in Vite/React apps, static HTML pages, Workers-served pages and Chrome
// extensions. Standalone repos vendor this file unchanged (see README).
//
// Catalogs are generated at build time and committed with each app, so nothing
// here fetches from the network: the UI works offline and in Russia without a VPN.

/** Every language an Infinitum app ships. English is the source and the fallback. */
export const LOCALES = [
  { code: "en", name: "English", dir: "ltr" },
  { code: "ru", name: "Русский", dir: "ltr" },
  { code: "uk", name: "Українська", dir: "ltr" },
  { code: "es", name: "Español", dir: "ltr" },
  { code: "fr", name: "Français", dir: "ltr" },
  { code: "de", name: "Deutsch", dir: "ltr" },
  { code: "pt", name: "Português", dir: "ltr" },
  { code: "zh", name: "中文", dir: "ltr" },
  { code: "ar", name: "العربية", dir: "rtl" },
];

export const DEFAULT_STORAGE_KEY = "infinitum.lang";
const RTL = new Set(["ar", "fa", "he", "ur"]);

/** "pt-BR" -> "pt", "zh_Hans_CN" -> "zh". */
export function baseLanguage(tag) {
  return String(tag || "").trim().toLowerCase().replace("_", "-").split("-")[0];
}

export function directionOf(code) {
  return RTL.has(baseLanguage(code)) ? "rtl" : "ltr";
}

function readStorage(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function writeStorage(key, value) {
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch { /* private mode, blocked storage: the choice just isn't remembered */ }
}

/**
 * Pick the UI language: a remembered manual choice, then `?lang=`, then the
 * browser's preferred languages, then the fallback.
 */
export function detectLocale(options = {}) {
  const supported = options.supported ?? LOCALES.map((l) => l.code);
  const fallback = options.fallback ?? "en";
  const key = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const pick = (tag) => {
    const base = baseLanguage(tag);
    return supported.includes(base) ? base : null;
  };
  const stored = pick(readStorage(key));
  if (stored) return stored;
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? "").get("lang");
    if (pick(q)) return pick(q);
  } catch { /* no location */ }
  const nav = globalThis.navigator;
  const prefs = options.languages ?? (nav ? (nav.languages?.length ? nav.languages : [nav.language]) : []);
  for (const tag of prefs) {
    const hit = pick(tag);
    if (hit) return hit;
  }
  return fallback;
}

/** Replace `{name}` placeholders. Unknown placeholders are left as they are. */
export function format(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * Create a translator.
 *   const i18n = createI18n({ catalogs });   // catalogs = { en: {...}, ru: {...} }
 *   i18n.t("nav.inbox"); i18n.setLocale("ar"); i18n.apply(document);
 */
export function createI18n(options) {
  const catalogs = options.catalogs || {};
  const fallback = options.fallback ?? "en";
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const supported = options.supported ?? LOCALES.map((l) => l.code).filter((c) => c === fallback || catalogs[c]);
  const listeners = new Set();
  let locale = options.locale && supported.includes(baseLanguage(options.locale))
    ? baseLanguage(options.locale)
    : detectLocale({ supported, fallback, storageKey });

  const t = (key, vars) => {
    const hit = catalogs[locale]?.[key] ?? catalogs[fallback]?.[key];
    return format(hit ?? key, vars);
  };

  // Keys with {0}-style placeholders also match rendered text ("3 / 5 active agents").
  const patternCache = new Map();
  const patternsFor = (code) => {
    if (!patternCache.has(code)) {
      const list = [];
      for (const [key, value] of Object.entries(catalogs[code] ?? {})) {
        if (!/\{\d+\}/.test(key)) continue;
        const src = key.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\d+)\\?\}/g, "(?<p$1>.+?)").replace(/\{(\d+)\}/g, "(?<p$1>.+?)");
        try { list.push([new RegExp(`^${src}$`, "s"), value]); } catch { /* skip odd keys */ }
      }
      patternCache.set(code, list);
    }
    return patternCache.get(code);
  };
  /** Translation of an exact English UI string in the current language, or null. */
  const lookup = (text) => {
    if (locale === fallback) return null;
    const exact = catalogs[locale]?.[text];
    if (exact != null) return exact;
    for (const [re, value] of patternsFor(locale)) {
      const m = re.exec(text);
      if (m) return value.replace(/\{(\d+)\}/g, (s, n) => m.groups?.[`p${n}`] ?? s);
    }
    return null;
  };

  const i18n = {
    get locale() { return locale; },
    get dir() { return directionOf(locale); },
    supported,
    locales: LOCALES.filter((l) => supported.includes(l.code)),
    t,
    lookup,
    has: (key) => Boolean(catalogs[locale]?.[key] ?? catalogs[fallback]?.[key]),
    /** Switch language and remember the choice. `null` forgets it and follows the browser again. */
    setLocale(code) {
      let next;
      if (code == null) {
        writeStorage(storageKey, null);
        next = detectLocale({ supported, fallback, storageKey });
      } else {
        next = baseLanguage(code);
        if (!supported.includes(next)) return;
        writeStorage(storageKey, next);
      }
      if (next === locale) return;
      locale = next;
      if (options.autoApply !== false && globalThis.document) i18n.apply(globalThis.document);
      for (const fn of listeners) fn(locale);
    },
    /** Subscribe to language changes; returns an unsubscribe function. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * Translate static markup:
     *   <h1 data-i18n="home.title">Fallback</h1>
     *   <input data-i18n-attr="placeholder:search.hint,aria-label:search.label">
     *   <p data-i18n-html="legal.note">  (only for catalog strings you control)
     * and set <html lang dir>.
     */
    apply(root) {
      const doc = root?.ownerDocument ?? root;
      const html = doc?.documentElement;
      if (html) { html.lang = locale; html.dir = directionOf(locale); }
      if (!root?.querySelectorAll) return;
      for (const el of root.querySelectorAll("[data-i18n]")) {
        const key = el.getAttribute("data-i18n");
        if (i18n.has(key)) el.textContent = t(key);
      }
      for (const el of root.querySelectorAll("[data-i18n-html]")) {
        const key = el.getAttribute("data-i18n-html");
        if (i18n.has(key)) el.innerHTML = t(key);
      }
      for (const el of root.querySelectorAll("[data-i18n-attr]")) {
        for (const pair of el.getAttribute("data-i18n-attr").split(",")) {
          const [attr, key] = pair.split(":").map((s) => s.trim());
          if (attr && key && i18n.has(key)) el.setAttribute(attr, t(key));
        }
      }
    },
  };
  if (options.autoApply !== false && globalThis.document?.documentElement) {
    globalThis.document.documentElement.lang = locale;
    globalThis.document.documentElement.dir = directionOf(locale);
  }
  return i18n;
}

const UI_ATTRS = ["placeholder", "title", "aria-label", "alt", "label", "aria-description"];
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "NOSCRIPT", "KBD", "SAMP", "svg"]);

/**
 * Translate rendered markup in place, using catalogs keyed by the English text
 * (extracted at build time by scripts/extract.ts). Watches the subtree, so text
 * that views render later is translated too, and re-translates on language change.
 * Anything inside `translate="no"`, contenteditable, code or form values is left
 * alone: mark user content (mail bodies, chat, AI output) with translate="no".
 */
export function translateDom(i18n, root = globalThis.document?.body) {
  if (!root) return { stop() {} };
  const doc = root.ownerDocument ?? root;
  const sourceText = new WeakMap();   // Text -> English source
  const shownText = new WeakMap();    // Text -> value we last wrote
  const sourceAttr = new WeakMap();   // Element -> { attr: English }
  const skipped = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName) || e.getAttribute("translate") === "no" || e.isContentEditable) return true;
    }
    return false;
  };
  const split = (s) => /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const doText = (node) => {
    const cur = node.nodeValue;
    if (shownText.get(node) !== cur) sourceText.set(node, cur);
    const src = sourceText.get(node);
    const [, lead, core, trail] = split(src);
    if (!core || !/\p{L}/u.test(core) || skipped(node.parentElement)) return;
    const tr = i18n.lookup(core.replace(/\s+/g, " "));
    const next = tr == null ? src : lead + tr + trail;
    shownText.set(node, next);
    if (next !== cur) node.nodeValue = next;
  };
  // A <textarea>'s or <code>'s contents are skipped, but its own placeholder/title
  // are still UI; only translate="no" and contenteditable opt the element out.
  const attrsSkipped = (el) => el.getAttribute("translate") === "no" || el.isContentEditable || skipped(el.parentElement);
  const doAttrs = (el) => {
    if (attrsSkipped(el)) return;
    let src = sourceAttr.get(el);
    for (const a of UI_ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      if (!src) { src = {}; sourceAttr.set(el, src); }
      const known = src[a];
      if (known == null || (cur !== known.shown)) src[a] = { en: cur, shown: cur };
      const tr = i18n.lookup(src[a].en.trim());
      const next = tr ?? src[a].en;
      src[a].shown = next;
      if (next !== cur) el.setAttribute(a, next);
    }
  };
  const walk = (node) => {
    if (node.nodeType === 3) { doText(node); return; }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.nodeType === 1) { doAttrs(node); if (skipped(node)) return; }
    const tw = doc.createTreeWalker(node, 5 /* ELEMENT | TEXT */, {
      acceptNode: (n) => {
        if (n.nodeType !== 1) return 1;
        if (SKIP_TAGS.has(n.tagName)) { doAttrs(n); return 2; }
        return n.getAttribute("translate") === "no" || n.isContentEditable ? 2 : 1;
      },
    });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) doText(n); else doAttrs(n);
    }
  };
  let titleSource = doc.title;
  let titleShown = doc.title;
  const doTitle = () => {
    if (doc.title !== titleShown) titleSource = doc.title;
    titleShown = i18n.lookup(titleSource) ?? titleSource;
    if (doc.title !== titleShown) doc.title = titleShown;
  };
  const run = () => { doTitle(); walk(root); };
  run();
  const Observer = globalThis.MutationObserver;
  const mo = Observer ? new Observer((records) => {
    for (const r of records) {
      if (r.type === "characterData") doText(r.target);
      else if (r.type === "attributes") doAttrs(r.target);
      else for (const n of r.addedNodes) walk(n);
    }
  }) : null;
  mo?.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: UI_ATTRS });
  const off = i18n.subscribe(run);
  return { stop() { mo?.disconnect(); off(); }, refresh: run };
}

/**
 * One call for most apps: detect the language, translate the page, and (when
 * `switcher` is an element or selector) mount the language menu into it.
 */
export function startI18n(options) {
  const i18n = createI18n(options);
  const doc = globalThis.document;
  if (doc) {
    const go = () => {
      i18n.dom = translateDom(i18n, options.root ?? doc.body);
      const host = typeof options.switcher === "string" ? doc.querySelector(options.switcher) : options.switcher;
      // No menu until there is a second language to choose.
      if (host && i18n.locales.length > 1) host.append(languageSwitcher(i18n, { label: i18n.lookup("Language") ?? "Language" }));
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go, { once: true }); else go();
  }
  return i18n;
}

/**
 * A plain <select> language switcher. It inherits the app's font and colors and
 * is styled by the `.lang-switch` rules in i18n.css (white/black, hairline border).
 */
export function languageSwitcher(i18n, options = {}) {
  const doc = options.document ?? globalThis.document;
  const select = doc.createElement("select");
  select.className = options.className ?? "lang-switch";
  select.setAttribute("aria-label", options.label ?? "Language");
  for (const l of i18n.locales) {
    const opt = doc.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    opt.lang = l.code;
    if (l.code === i18n.locale) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", () => i18n.setLocale(select.value));
  i18n.subscribe((code) => { select.value = code; });
  return select;
}
