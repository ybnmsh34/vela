/**
 * The half of the harness that runs **inside the window**.
 *
 * Everything here is a JavaScript source string evaluated in the page through
 * `Runtime.evaluate`. It is kept in one place, separate from the CLI, so that
 * what the harness asks the running app is readable without reading the driver.
 *
 * ## What the element query is, and what it is not
 *
 * `resolve()` below is a *pragmatic* role/name matcher, not an implementation of
 * the ARIA accessible-name computation. It reads `aria-labelledby`,
 * `aria-label`, an associated `<label>`, `alt`, `title`, `placeholder`, a
 * button's `value`, and finally visible text — which covers what this
 * application's controls actually use — and it derives an implicit role from
 * the tag for a fixed list of elements. It does **not** implement
 * name-from-content suppression, `aria-owns`, or the full role taxonomy. Where a
 * verdict turns on an accessibility claim rather than on "a user could click
 * this", read the attributes directly with `eval` and say what you read.
 *
 * A candidate is reported as `visible` when it has at least one client rectangle
 * with a non-zero area, `visibility` is neither `hidden` nor `collapse`, and
 * computed `opacity` is greater than zero. That is not the same as "a human can
 * see it": an element under an opaque overlay passes this test. Neither
 * `--via message` nor `--via os` relies on it — both are verified by what the
 * window reports being hit, which is the real answer to "was it clickable".
 *
 * `Object.freeze` is applied to built-in prototypes by Tauri's `freezePrototype`,
 * so nothing here extends a built-in prototype; the API is one own property on
 * `window`.
 */

/**
 * Installs `window.__velaHarness`. Idempotent, and re-evaluated on every CLI
 * invocation because each invocation is a fresh CDP connection to a window that
 * kept running — so the resolved-node list is carried across re-evaluations
 * rather than reset, and the pointer listener is added once per document rather
 * than once per connection.
 */
export const BOOTSTRAP = String.raw`(() => {
  const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  const IMPLICIT_ROLES = {
    BUTTON: 'button', A: 'link', TEXTAREA: 'textbox', SELECT: 'combobox',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    DIALOG: 'dialog', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    FORM: 'form', IMG: 'img', SUMMARY: 'button', LABEL: 'label', P: 'paragraph',
  };
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    text: 'textbox', password: 'textbox',
  };
  const NON_CONTENT = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'BASE']);

  const roleOf = (el) => {
    const explicit = el.getAttribute ? el.getAttribute('role') : null;
    if (collapse(explicit)) return collapse(explicit).split(' ')[0];
    if (el.tagName === 'INPUT') return INPUT_ROLES[(el.type || 'text').toLowerCase()] || 'textbox';
    if (el.tagName === 'A' && !el.hasAttribute('href')) return 'generic';
    return IMPLICIT_ROLES[el.tagName] || 'generic';
  };

  const nameOf = (el) => {
    const labelledBy = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => collapse(node.textContent));
      if (collapse(parts.join(' '))) return collapse(parts.join(' '));
    }
    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (collapse(ariaLabel)) return collapse(ariaLabel);
    if (el.labels && el.labels.length > 0) {
      const fromLabels = collapse(Array.from(el.labels).map((l) => l.textContent).join(' '));
      if (fromLabels) return fromLabels;
    }
    for (const attribute of ['alt', 'title', 'placeholder']) {
      const value = el.getAttribute ? el.getAttribute(attribute) : null;
      if (collapse(value)) return collapse(value);
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].indexOf((el.type || '').toLowerCase()) !== -1) {
      if (collapse(el.value)) return collapse(el.value);
    }
    return collapse(el.textContent);
  };

  const isVisible = (el) => {
    let area = 0;
    for (const rect of el.getClientRects()) area += rect.width * rect.height;
    if (area <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number.parseFloat(style.opacity || '1') <= 0) return false;
    return true;
  };

  const selectorPathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const describe = (el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      tag: el.tagName,
      role: roleOf(el),
      name: nameOf(el).slice(0, 200),
      text: collapse(el.textContent).slice(0, 200),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className.slice(0, 160) : null,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      visible: isVisible(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      selectorPath: selectorPathOf(el),
    };
  };

  /**
   * query: { selector?, role?, name?, text?, exact?, includeHidden? }
   * Filters are ANDed; name/text match case-insensitively by substring unless
   * "exact". Returns live elements, innermost-first when matching by text.
   */
  const findElements = (query) => {
    const q = query || {};
    let list = Array.from(document.querySelectorAll(q.selector || '*'));
    if (!q.selector) list = list.filter((el) => !NON_CONTENT.has(el.tagName));
    const matches = (haystack, needle) => {
      if (needle === undefined || needle === null) return true;
      const a = collapse(haystack).toLowerCase();
      const b = collapse(needle).toLowerCase();
      return q.exact ? a === b : a.indexOf(b) !== -1;
    };
    let hits = list.filter((el) => {
      if (q.role && roleOf(el) !== q.role) return false;
      if (!matches(nameOf(el), q.name)) return false;
      if (!matches(el.textContent, q.text)) return false;
      return true;
    });
    if (!q.includeHidden) hits = hits.filter(isVisible);
    /* Matching by text or name without a selector also matches every ancestor
       that contains the text. Keep only the innermost hits: an element whose
       descendant is also a hit is a container, not the control. */
    if ((q.text !== undefined || q.name !== undefined) && !q.selector) {
      hits = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
    }
    return hits;
  };

  const store = (window.__velaHarness && window.__velaHarness.__store) || { nodes: [] };

  const api = {
    version: 4,

    /** Runs a query, remembers the live nodes, returns their descriptions. */
    resolve(query) {
      store.nodes = findElements(query);
      return { count: store.nodes.length, matches: store.nodes.map(describe) };
    },

    describeStored(index) {
      const el = store.nodes[index];
      return el ? describe(el, index) : null;
    },

    /** Viewport-relative click point, plus what an OS click would need. */
    pointFor(index) {
      const el = store.nodes[index];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const viewportX = rect.left + rect.width / 2;
      const viewportY = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(viewportX, viewportY);
      return {
        viewport: { x: viewportX, y: viewportY },
        screenCss: { x: window.screenX + viewportX, y: window.screenY + viewportY },
        devicePixelRatio: window.devicePixelRatio,
        screenOrigin: { x: window.screenX, y: window.screenY },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        /* coversTarget asks whether the pixel belongs to the queried element,
           so the test is identity-or-descendant. An ancestor clause here read
           as "covered" for every container the point fell through to, up to and
           including BODY, which is to say for everything. */
        topmostAtPoint: hit ? { tag: hit.tagName, coversTarget: el === hit || el.contains(hit) } : null,
      };
    },

    focusStored(index) {
      const el = store.nodes[index];
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (typeof el.focus === 'function') el.focus();
      return document.activeElement === el;
    },

    /** A stable fingerprint of what the window is showing, for before/after. */
    digest(selector) {
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) return null;
      const text = collapse(root.innerText || root.textContent);
      let hash = 5381;
      for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
      return {
        selector: selector || 'body',
        chars: text.length,
        hash: hash.toString(16),
        elements: root.querySelectorAll('*').length,
        activeElement: document.activeElement
          ? { tag: document.activeElement.tagName, name: nameOf(document.activeElement).slice(0, 120) }
          : null,
        dialogOpen: Boolean(document.querySelector('[role="dialog"],[role="alertdialog"],dialog[open]')),
      };
    },

    visibleText(selector, limit) {
      const root = selector ? document.querySelector(selector) : document.body;
      if (!root) return null;
      const lines = (root.innerText || root.textContent || '')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter((line) => line.length > 0);
      return limit ? lines.slice(0, limit) : lines;
    },

    /** What the renderer actually put in the root, and whether React is live. */
    mountReport() {
      const root = document.getElementById('root');
      const bodyText = collapse(document.body ? document.body.innerText : '');
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        rootPresent: Boolean(root),
        rootChildElements: root ? root.children.length : 0,
        rootDescendants: root ? root.querySelectorAll('*').length : 0,
        bodyTextChars: bodyText.length,
        bodyTextHead: bodyText.slice(0, 400),
        reactContainerKeyOnRoot: root
          ? Object.keys(root).filter((key) => key.indexOf('__reactContainer') === 0 || key.indexOf('_reactRootContainer') === 0)
          : [],
        hasTauriInternals: typeof window.__TAURI_INTERNALS__ === 'object' && window.__TAURI_INTERNALS__ !== null,
        scriptSources: Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src')),
        landmarks: Array.from(document.querySelectorAll('header,main,nav,footer,[role]'))
          .slice(0, 40)
          .map((el) => ({ tag: el.tagName, role: roleOf(el), name: nameOf(el).slice(0, 80) })),
      };
    },

    /**
     * Records the next pointer press the document sees, in the capture phase at
     * the window, so nothing in the app can intercept it first. This is how an
     * OS-level click proves it landed: the *window* reports what the engine hit,
     * rather than the harness asserting where it aimed.
     */
    armPointerRecorder() {
      window.__velaHarnessPointer = null;
      /* The live node, kept beside the serialisable record. This is what
         decides on-target; see pointerHit. Never returned by value. */
      window.__velaHarnessPointerNode = null;
      if (!window.__velaHarnessRecorderInstalled) {
        window.addEventListener('mousedown', (event) => {
          const target = event.target;
          window.__velaHarnessPointerNode = target;
          window.__velaHarnessPointer = {
            isTrusted: event.isTrusted,
            clientX: event.clientX,
            clientY: event.clientY,
            screenX: event.screenX,
            screenY: event.screenY,
            buttons: event.buttons,
            target: target && target.tagName
              ? { tag: target.tagName, role: roleOf(target), name: nameOf(target).slice(0, 120) }
              : null,
            at: Date.now(),
          };
        }, true);
        window.__velaHarnessRecorderInstalled = true;
      }
      return true;
    },

    /**
     * What the recorder saw, and whether it was on the element we aimed at.
     *
     * **The answer comes from the node the event was dispatched at**, captured
     * at mousedown, and not from a fresh elementFromPoint. Two failures made
     * that necessary, and both reported a click that never happened:
     *
     * - An ancestor clause (hit.contains(el)) made on-target nearly
     *   unfalsifiable, because document.body contains everything. A button
     *   with pointer-events: none — the exact shape of an unwired control —
     *   passed while its handler never ran.
     * - Re-hit-testing *after* the settle delay reads the DOM as it is now, not
     *   as it was when the button went down. An overlay that removes itself on
     *   mousedown is gone by the time the question is asked, so the point
     *   resolves to the button that was never clicked.
     *
     * Identity-or-descendant only: a click on a child span of the queried
     * button is on target; a click on its parent, or on anything covering it,
     * is not.
     */
    pointerHit(index) {
      const record = window.__velaHarnessPointer || null;
      if (!record) return { landed: false, onTarget: null, record: null };
      const el = store.nodes[index];
      const node = window.__velaHarnessPointerNode || null;
      let onTarget = null;
      if (el) onTarget = Boolean(node && (node === el || el.contains(node)));
      return {
        landed: true,
        onTarget,
        record,
        decidedFrom: 'the event target captured at mousedown',
        eventTarget: node
          ? { tag: node.tagName, isQueriedElement: node === el, isInsideQueried: Boolean(el && el.contains(node)) }
          : null,
      };
    },
  };

  Object.defineProperty(api, '__store', { value: store, enumerable: false });
  window.__velaHarness = api;
  return api.version;
})()`;

/** JSON-encodes a value for safe interpolation into an evaluated expression. */
export function literal(value) {
  return JSON.stringify(value === undefined ? null : value);
}
