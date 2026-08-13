/**
 * The assertions of the GATE M Part 1 (Phase C) UI matrix, and the DOM readers
 * they are built on.
 *
 * They live in their own module because two callers need the *same* predicate:
 * `drive-matrix.mjs`, which applies each one where it must hold, and
 * `controls.mjs`, which applies the identical function where it must NOT — an
 * assertion that cannot fail is worthless, and the only way to show it can is
 * to run it against a case that should break it.
 *
 * Nothing here knows a provider name. Every expectation is keyed by profile,
 * which is a description of a *deficiency* (see mock-provider/src/profiles.ts),
 * and the UI is read only through what a user could see: rendered text, the
 * presence or absence of controls, aria state.
 */

/**
 * What each profile's endpoint really is, transcribed from
 * `tests/harness/mock-provider/src/profiles.ts`. This is the *ground truth* the
 * UI's claims are checked against — never the other way round.
 */
export const EXPECTED = {
  frontier: {
    modelId: 'mock-frontier',
    contextWindow: 200_000,
    windowTexts: ['200,000'],
    vision: true,
    nativeTools: true,
    reasoning: true,
    usageReported: true,
    // Whether this endpoint delivers prose into the answer channel at all.
    // `hostile` never closes its thinking block, so its text is salvaged rather
    // than answered — which is a correct outcome, and not one the *reading
    // surface* can be judged on. See the reading-surface step in
    // `drive-matrix.mjs`.
    answerChannelIsClean: true,
  },
  'mid-local': {
    modelId: 'mock-mid-local',
    contextWindow: 32_768,
    // `formatTokens` writes an exact multiple of 1024 in binary units, so
    // 32768 renders as "32K". Both spellings are the endpoint's real number.
    windowTexts: ['32K', '32,768'],
    vision: false,
    nativeTools: true,
    reasoning: true,
    usageReported: true,
    answerChannelIsClean: true,
  },
  'small-local': {
    modelId: 'mock-small-local',
    contextWindow: 8_192,
    windowTexts: ['8K', '8,192'],
    vision: false,
    nativeTools: false,
    reasoning: false,
    usageReported: false,
    answerChannelIsClean: true,
  },
  hostile: {
    modelId: 'mock-hostile',
    contextWindow: 4_096,
    windowTexts: ['4K', '4,096'],
    vision: false,
    nativeTools: false,
    reasoning: true,
    usageReported: false,
    answerChannelIsClean: false,
  },
};

/** Reasoning markup in any spelling the guard recognises. */
export const REASONING_MARKUP = ['<think>', '</think>', '<thinking>', '</thinking>'];

/* -------------------------------------------------------------------------- */
/* DOM readers — everything a user could see, and nothing else                */
/* -------------------------------------------------------------------------- */

/**
 * Every affordance that offers to attach an **image**.
 *
 * Deliberately looks for *existence*, not for `disabled`: the rule is that a
 * model without vision gets no image control at all, because a disabled button
 * is a promise the endpoint cannot keep. Three independent routes are checked,
 * because a control can be reachable by any one of them — the accessible name,
 * the test id, and the file picker's own `accept` list. A picker that renders no
 * visible button but accepts `image/png` is still an offer.
 *
 * Text-file attachment is deliberately NOT counted. Inlining a `.md` into a
 * prompt is something every model can do, so gating it on vision would forbid a
 * plain text file on a local model that handles it perfectly well. See
 * `src/features/attachments/attachment-rules.ts`.
 */
export function imageAffordances(page) {
  return page.evaluate(() => {
    const found = [];
    for (const node of document.querySelectorAll('button, [role="button"], a')) {
      const name = `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`;
      if (/image|photo|picture|screenshot/iu.test(name) || node.getAttribute('data-testid') === 'attach-image') {
        found.push({ via: 'control', tag: node.tagName.toLowerCase(), testid: node.getAttribute('data-testid'), label: name.replace(/\s+/gu, ' ').trim().slice(0, 60), disabled: node.disabled === true });
      }
    }
    for (const input of document.querySelectorAll('input[type="file"]')) {
      if ((input.getAttribute('accept') ?? '').includes('image/')) {
        found.push({ via: 'accept', tag: 'input[type=file]', testid: input.getAttribute('data-testid'), label: input.getAttribute('accept').slice(0, 60), disabled: input.disabled === true });
      }
    }
    return found;
  });
}

/** Every attach control of any kind, image or not. Reported, never asserted on. */
export function attachAffordances(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, input[type="file"]')]
      .filter((node) => /attach|file|image/iu.test(`${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('data-testid') ?? ''} ${node.textContent ?? ''}`))
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        testid: node.getAttribute('data-testid'),
        label: (node.getAttribute('aria-label') ?? node.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60),
        accept: node.getAttribute('accept'),
      })),
  );
}

/** The whole visible transcript, as text. */
export function transcriptText(page) {
  return page.evaluate(() => {
    const turns = [...document.querySelectorAll('article[data-role]')];
    return turns.map((turn) => turn.innerText).join('\n');
  });
}

/**
 * The last model turn, split into the channels a user perceives as separate.
 *
 * `answer` is what is left of the turn once the subordinate channels are taken
 * out — reasoning (`<section>` from ThinkingBlock), tool calls (`<section>`
 * from ToolCallList), the degradation list, the error block and the footer.
 * That subtraction is the point: it is the text the user reads *as the answer*,
 * which is where reasoning markup must never appear.
 */
export function lastAssistantTurn(page) {
  return page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    if (turn === undefined) return null;

    const clone = turn.cloneNode(true);
    for (const node of clone.querySelectorAll('section, footer, [data-kind], ul[aria-label]')) {
      node.remove();
    }
    const thinking = turn.querySelector('section [id$="-reasoning"]');
    const toggle = turn.querySelector('section h3 button');
    const tools = [...turn.querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-label') === 'Tool calls',
    );
    const notes = turn.querySelector('ul[aria-label]');
    const error = turn.querySelector('[data-kind]');

    return {
      answer: (clone.innerText ?? '').trim(),
      whole: turn.innerText,
      reasoning:
        thinking === null
          ? null
          : {
              text: thinking.textContent ?? '',
              hiddenAttribute: thinking.hasAttribute('hidden'),
              summary: toggle?.textContent?.trim() ?? '',
              expanded: toggle?.getAttribute('aria-expanded') === 'true',
            },
      tools:
        tools === undefined
          ? null
          : {
              text: tools.innerText,
              cards: [...tools.querySelectorAll('[data-status]')].map((card) =>
                card.getAttribute('data-status'),
              ),
            },
      degradations: notes === null ? [] : [...notes.querySelectorAll('li')].map((li) => li.innerText),
      error: error === null ? null : { kind: error.getAttribute('data-kind'), text: error.innerText },
    };
  });
}

/**
 * THE READING SURFACE, as the engine actually set it.
 *
 * Every other reader here asks what the DOM *says*. This one asks what the
 * engine *did* — computed font sizes, weights, margins, white-space, and
 * whether anything overflows its column — because the defect it exists for is
 * invisible in the DOM. Six headings with six correct tags and one shared font
 * size is a perfectly well-formed document that cannot be read as one, and no
 * amount of `innerText` will say so.
 *
 * It is also the reason this step exists at all: no screenshot in the Phase C
 * evidence set rendered a heading, a list, a block quote or a table. The
 * evidence base could not see the main thing users look at.
 *
 * Read from the *answer channel* only — the prose container that holds the
 * headings — so the thinking block and tool cards cannot flatter the numbers.
 */
export function readingSurface(page) {
  return page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    if (turn === undefined) return null;

    const px = (value) => Math.round(Number.parseFloat(value) * 100) / 100;
    const firstHeading = turn.querySelector('[data-level]');
    // The prose container is whatever holds the headings. Found structurally
    // rather than by class name, because the class name is a build hash.
    const prose = firstHeading?.parentElement ?? turn.querySelector('p')?.parentElement ?? null;
    if (prose === null) return { headings: [], paragraphs: [], counts: {}, prose: null };

    const headings = [...prose.querySelectorAll('[data-level]')].map((node) => {
      const style = getComputedStyle(node);
      return {
        level: Number(node.getAttribute('data-level')),
        tag: node.tagName.toLowerCase(),
        text: (node.textContent ?? '').trim().slice(0, 60),
        fontSizePx: px(style.fontSize),
        fontWeight: style.fontWeight,
        lineHeightPx: px(style.lineHeight),
        marginTopPx: px(style.marginTop),
        textTransform: style.textTransform,
        color: style.color,
      };
    });

    const paragraphs = [...prose.querySelectorAll(':scope > p')].map((node) => {
      const style = getComputedStyle(node);
      return {
        text: (node.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120),
        // The whole defect, in one measured value. `pre-wrap` here means the
        // model's source line endings are the reader's line endings.
        whiteSpace: style.whiteSpace,
        fontSizePx: px(style.fontSize),
        lineHeightPx: px(style.lineHeight),
        // A soft wrap that survived into the DOM as a literal newline.
        carriesSourceNewline: (node.textContent ?? '').includes('\n'),
        hardBreaks: node.querySelectorAll('br').length,
        renderedLines:
          px(style.lineHeight) > 0 ? Math.round(node.getBoundingClientRect().height / px(style.lineHeight)) : null,
      };
    });

    const bodyStyle = getComputedStyle(prose);
    return {
      headings,
      paragraphs,
      prose: {
        fontSizePx: px(bodyStyle.fontSize),
        lineHeightPx: px(bodyStyle.lineHeight),
        clientWidthPx: prose.clientWidth,
        scrollWidthPx: prose.scrollWidth,
      },
      counts: {
        headings: headings.length,
        paragraphs: prose.querySelectorAll('p').length,
        listItems: prose.querySelectorAll('li').length,
        nestedLists: prose.querySelectorAll('ul ul, ol ol, ul ol, ol ul').length,
        quotes: prose.querySelectorAll('blockquote').length,
        codeBlocks: prose.querySelectorAll('pre').length,
        // Filtered rather than `:not(pre code)`: a complex selector inside
        // `:not()` is a newer feature than this reader needs to depend on, and
        // a `SyntaxError` here would take the whole step down.
        inlineCode: [...prose.querySelectorAll('code')].filter((node) => node.closest('pre') === null)
          .length,
        tables: prose.querySelectorAll('table').length,
        links: prose.querySelectorAll('a[href]').length,
        rules: prose.querySelectorAll('hr').length,
      },
    };
  });
}

/** The context meter's own words. */
export function contextMeterText(page) {
  return page.locator('[data-testid="context-meter"]').innerText();
}

/** The capability chip beside the model name. */
export function limitsChipText(page) {
  return page.getByRole('button', { name: /limit|Capabilities unknown/u }).first().innerText();
}

/* -------------------------------------------------------------------------- */
/* assertions — each one returns {pass, detail}                               */
/* -------------------------------------------------------------------------- */

const ok = (pass, detail) => ({ pass, detail });

/** A1. No reasoning markup anywhere a user can read. */
export function noReasoningMarkup(text) {
  const found = REASONING_MARKUP.filter((tag) => text.includes(tag));
  return ok(found.length === 0, found.length === 0 ? 'no reasoning tags in visible text' : `leaked: ${found.join(' ')}`);
}

/** A2. The answer channel is non-empty — an unterminated block must not swallow it. */
export function answerNotSwallowed(turn) {
  const visible = (turn?.answer ?? '').replace(/\s+/gu, ' ').trim();
  const reasoning = (turn?.reasoning?.text ?? '').replace(/\s+/gu, ' ').trim();
  // Either the answer channel carried text, or the reasoning channel is open
  // AND on screen with an explanation. What is forbidden is text that exists in
  // neither place.
  const shown = visible.length > 0 || (reasoning.length > 0 && turn?.reasoning?.hiddenAttribute === false);
  return ok(shown, `answer=${visible.length} chars, reasoning=${reasoning.length} chars, reasoningVisible=${String(turn?.reasoning?.hiddenAttribute === false)}`);
}

/** A3. A model with no vision offers no image affordance — absent, not disabled. */
export function visionAffordanceMatchesCapability(affordances, expectVision) {
  const describe = affordances.map((a) => `${a.tag}#${a.testid ?? ''}"${a.label}"`).join(', ');
  if (expectVision) {
    return ok(affordances.length > 0, `${String(affordances.length)} image affordance(s) present: ${describe}`);
  }
  return ok(affordances.length === 0, affordances.length === 0 ? 'no image affordance in the DOM by name, test id or accept list' : `present anyway: ${describe}`);
}

/**
 * A4. The window shown is the endpoint's own number — and nobody else's.
 *
 * Two halves, because either alone is weak. The first accepts any accurate
 * spelling of this endpoint's figure (`formatTokens` writes exact multiples of
 * 1024 in binary units, so 32768 is "32K"). The second fails if *another*
 * profile's window is on screen, which is what a stale capability report from a
 * previous model would look like.
 */
export function contextWindowIsTheEndpoints(meterText, expectedTexts, otherProfileTexts) {
  const said = meterText.replace(/\s+/gu, ' ').trim();
  const mine = expectedTexts.some((text) => meterText.includes(text));
  const foreign = otherProfileTexts.filter((text) => meterText.includes(text));
  return ok(mine && foreign.length === 0, `meter says: ${said}${foreign.length > 0 ? ` — and carries another endpoint's figure: ${foreign.join(', ')}` : ''}`);
}

/** Every window figure that belongs to a *different* profile. */
export function foreignWindowTexts(profile) {
  return Object.entries(EXPECTED)
    .filter(([name]) => name !== profile)
    .flatMap(([, entry]) => entry.windowTexts)
    // "4K" is a substring of nothing here, but "8K" would match inside "8K"
    // only; keep the list literal and let the caller see what matched.
    .filter((text) => !EXPECTED[profile].windowTexts.includes(text));
}

/** A5. The meter warns before the turn is sent. */
export function contextOverflowWarns(meterText) {
  const warns = /larger than the window|close to the limit/iu.test(meterText);
  return ok(warns, meterText.replace(/\s+/gu, ' ').trim().slice(0, 200));
}

/**
 * A6. A malformed tool call is on screen, and on screen as *refused*.
 *
 * The status vocabulary is the renderer's, not the wire's: a call the host
 * reported as `malformed` becomes `unreadable` ("Could not be read") or
 * `notCommitted` ("Not sent") — the second for a call rescued out of a thinking
 * block the model never closed, which parsed fine and was refused anyway. Both
 * are correct; what is forbidden is a malformed call that leaves no trace, and
 * a malformed call presented as if it had run.
 */
export function malformedToolCallVisible(turn) {
  const cards = turn?.tools?.cards ?? [];
  const text = (turn?.tools?.text ?? '').replace(/\s+/gu, ' ');
  const refused = cards.filter((status) => status === 'unreadable' || status === 'notCommitted');
  const saysSo = /could not be read|not sent|did not run|was not run/iu.test(text);
  return ok(refused.length > 0 && saysSo, `cards=[${cards.join(',')}] saysItWasRefused=${String(saysSo)} text=${text.slice(0, 200)}`);
}

/**
 * A7. Prompt emulation is disclosed rather than passed off as native support.
 *
 * The disclosure is matched on meaning, not on the word "emulated": the UI
 * deliberately spells it out ("This model has no built-in tool calling, so the
 * tools were described in the prompt"). What fails this is a turn that used
 * emulation and said nothing at all.
 */
export function emulationDisclosed(turn) {
  const haystack = `${turn?.tools?.text ?? ''} ${(turn?.degradations ?? []).join(' ')}`.replace(/\s+/gu, ' ');
  const disclosed = /emulat|described in the prompt|no built-in tool calling/iu.test(haystack);
  return ok(disclosed, haystack.trim().slice(0, 220) || '(nothing said)');
}

/** A8. Zero console errors and zero uncaught exceptions. */
export function consoleIsClean(entries) {
  const bad = entries.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
  return ok(bad.length === 0, bad.length === 0 ? 'clean' : bad.map((entry) => `${entry.type}: ${entry.text}`).join(' | '));
}

/**
 * A9. Nothing in the browser talked to the model endpoint.
 *
 * The point is not that it was blocked — CORS would have blocked it — but that
 * it was never attempted, because all provider HTTP originates in the core.
 */
export function noBrowserSideModelRequest(requests, endpointOrigin) {
  const offenders = requests.filter((url) => url.startsWith(endpointOrigin));
  return ok(offenders.length === 0, offenders.length === 0 ? `none of ${String(requests.length)} requests went to ${endpointOrigin}` : offenders.join(', '));
}

/** A10. "No credential" is a working state, not an error state. */
export function noCredentialIsClean(providerView, pageText) {
  const complaint = /missing (api )?key|credential (is )?required|not authenticated|add a key/iu.test(pageText);
  const pass =
    providerView.usable === true &&
    providerView.credentialCheck === 'satisfiedWithoutCredential' &&
    providerView.credentialPresent === false &&
    !complaint;
  return ok(pass, `usable=${String(providerView.usable)} check=${providerView.credentialCheck} complaintOnScreen=${String(complaint)}`);
}

/** A11. An unprobed model claims nothing and offers no capability-gated control. */
export function unprobedOffersNothing(chipText, imageAffordanceCount) {
  const pass = /Capabilities unknown/u.test(chipText) && imageAffordanceCount === 0;
  return ok(pass, `chip="${chipText.trim()}" imageAffordances=${String(imageAffordanceCount)}`);
}

/** A12. The turn ended in a state the user can read, not a spinner. */
export function turnSettled(turn) {
  const waiting = /Waiting for the first token/u.test(turn?.whole ?? '');
  return ok(!waiting, waiting ? 'still says "Waiting for the first token…"' : 'settled');
}

/** A13. A failed turn says so, in Vela's words. */
export function errorStateVisible(turn) {
  const error = turn?.error;
  return ok(error !== null && (error?.text ?? '').trim().length > 0, error === null ? '(no error block)' : error.text.replace(/\s+/gu, ' ').slice(0, 200));
}

/**
 * A15. The turn was painted as it arrived, not in one lump at the end.
 *
 * Two conditions, because either alone is satisfiable by a renderer that only
 * ever draws finished answers: React mounts the turn, swaps in the "waiting"
 * line and then replaces the whole thing, which is three growth steps inside a
 * few milliseconds. What a streaming renderer produces instead is many steps
 * spread across the life of the stream.
 *
 * `frames` is a list of `{t, whole}` samples taken by a MutationObserver, one
 * per change in the rendered length of the turn.
 */
export function paintedIncrementally(frames) {
  const growing = frames.filter((frame, index) => index === 0 || frame.whole > frames[index - 1].whole);
  const span = growing.length < 2 ? 0 : growing.at(-1).t - growing[0].t;
  const pass = growing.length >= 6 && span >= 300;
  return ok(pass, `${String(frames.length)} paints, ${String(growing.length)} growing, spread over ${String(Math.round(span))} ms`);
}

/**
 * A16. The rendered answer has a type hierarchy a reader can use.
 *
 * Three conditions, and each one catches a different way of not having one:
 *
 * - **enough distinct sizes.** All six levels at one size is the defect as
 *   found. Four distinct steps across the levels present is the floor.
 * - **monotonic.** Sizes must never *grow* as the level deepens; an `h4` bigger
 *   than the `h2` above it is worse than a flat document, because it says
 *   something false about the structure.
 * - **headings outrank body text.** The largest heading must be larger than the
 *   paragraph text around it. A "scale" entirely below body size is not one.
 *
 * The measurements are the engine's own computed values, so this is a claim
 * about what was painted and not about what the stylesheet intended.
 */
export function headingHierarchyIsVisible(reading) {
  const headings = reading?.headings ?? [];
  if (headings.length < 2) {
    return ok(false, `only ${String(headings.length)} heading(s) reached the answer channel`);
  }
  const byLevel = new Map();
  for (const heading of headings) {
    if (!byLevel.has(heading.level)) byLevel.set(heading.level, heading.fontSizePx);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const sizes = levels.map((level) => byLevel.get(level));
  const distinct = new Set(sizes).size;
  const monotonic = sizes.every((size, index) => index === 0 || size <= sizes[index - 1]);
  const body = reading?.prose?.fontSizePx ?? 0;
  const outranksBody = sizes[0] > body;

  const shape = levels.map((level, index) => `h${String(level)}=${String(sizes[index])}px`).join(' ');
  return ok(
    distinct >= 4 && monotonic && outranksBody,
    `${shape} | body=${String(body)}px | distinct=${String(distinct)} monotonic=${String(monotonic)} outranksBody=${String(outranksBody)}`,
  );
}

/**
 * A17. Wrapped prose is reflowed to the reader's column, not the model's.
 *
 * Models hard-wrap at seventy-odd columns. If those line endings survive to the
 * screen, every paragraph in every answer is set ragged at a width nobody
 * chose. Two independent readings, because either alone can be satisfied by
 * accident: the engine's computed `white-space` must not preserve newlines, and
 * no paragraph may still be carrying a literal newline in its text.
 *
 * A `<br>` is explicitly allowed — that is an author's hard break surviving on
 * purpose, and destroying it would be the same defect pointed the other way.
 */
export function proseReflows(reading) {
  const paragraphs = reading?.paragraphs ?? [];
  if (paragraphs.length === 0) return ok(false, 'no paragraph in the answer channel to judge');

  const preserving = paragraphs.filter((paragraph) => /^pre/u.test(paragraph.whiteSpace));
  const carrying = paragraphs.filter((paragraph) => paragraph.carriesSourceNewline);
  return ok(
    preserving.length === 0 && carrying.length === 0,
    `${String(paragraphs.length)} paragraphs; white-space=${[...new Set(paragraphs.map((p) => p.whiteSpace))].join('/')}; ${String(carrying.length)} still carry a source newline`,
  );
}

/**
 * A18. Nothing in the answer makes the reading column scroll sideways.
 *
 * The commonest way a reading surface breaks its own layout is a wide table or
 * a long unbroken token. Both are allowed to scroll — inside their own
 * container. What is forbidden is the column itself widening, which moves every
 * paragraph on screen.
 */
export function readingSurfaceFitsItsColumn(reading) {
  const prose = reading?.prose;
  if (prose === undefined || prose === null) return ok(false, 'no prose container found');
  // One pixel of slack: sub-pixel layout rounds against you on some engines.
  const fits = prose.scrollWidthPx <= prose.clientWidthPx + 1;
  return ok(fits, `column ${String(prose.clientWidthPx)}px wide, content ${String(prose.scrollWidthPx)}px`);
}

/** A14. Usage claimed only where the endpoint reported it. */
export function usageOnlyWhenReported(turnWholeText, expectReported) {
  const claims = /tokens$|\d+ in ·|\d+ out/mu.test(turnWholeText);
  return ok(claims === expectReported, `usage line present=${String(claims)} expected=${String(expectReported)}`);
}
