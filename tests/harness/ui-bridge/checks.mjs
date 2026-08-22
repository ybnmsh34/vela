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
    // THE ANSWER CHANNEL, NAMED.
    //
    // This used to be "whatever element holds the first `[data-level]`", which
    // was true right up until the thinking block started rendering markdown
    // too. From that commit on, a model that wrote a heading in its *reasoning*
    // would have redirected this whole reader at the subordinate channel and
    // reported the aside's type scale as the answer's — a gate measuring the
    // wrong document and saying nothing. `data-scale` is on the container for
    // exactly this: the answer says which one it is.
    const prose =
      turn.querySelector('[data-scale="answer"]') ??
      turn.querySelector('[data-level]')?.parentElement ??
      turn.querySelector('p')?.parentElement ??
      null;
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
    // Emphasis, measured beside the structure it must not outrank. The defect
    // is a *comparison* — `<strong>` at the user agent's 700 against a heading
    // at 600 — so a reading of either number alone says nothing.
    const strong = [...prose.querySelectorAll('strong')]
      .filter((node) => node.closest('[data-level]') === null)
      .map((node) => ({
        text: (node.textContent ?? '').trim().slice(0, 40),
        fontWeight: getComputedStyle(node).fontWeight,
        fontSizePx: px(getComputedStyle(node).fontSize),
      }));

    return {
      headings,
      paragraphs,
      strong,
      prose: {
        fontSizePx: px(bodyStyle.fontSize),
        lineHeightPx: px(bodyStyle.lineHeight),
        clientWidthPx: prose.clientWidth,
        scrollWidthPx: prose.scrollWidth,
        // The family the stylesheet ASKED FOR. Corrected by the GATE M
        // executor, which found this field labelled "what the engine actually
        // resolved" and reporting `Inter` on a container with no Inter
        // installed — a characters-per-line figure attributed to a face that
        // never loaded. `getComputedStyle().fontFamily` returns the declared
        // stack; it says nothing about what was found.
        fontFamily: bodyStyle.fontFamily.split(',')[0].replaceAll(/["']/gu, ''),
        // Whether that family RESOLVED, measured the way the desktop `visual`
        // critic settled the same question: render a string at 64px in the
        // requested family and in a family that certainly does not exist, and
        // compare advances. `document.fonts.check()` is not used — it returns
        // a false positive here, which is how the A1 finding nearly went the
        // other way. A `false` does not fail anything; it is the disclosure
        // that makes `charsPerLine` interpretable, because the same column
        // measures ~61 characters in this container's fallback and ~70 in
        // Segoe UI.
        firstFamilyResolves: (() => {
          const advance = (family) => {
            const context = document.createElement('canvas').getContext('2d');
            context.font = `64px ${family}`;
            return context.measureText('Handgloves 12345').width;
          };
          const asked = bodyStyle.fontFamily.split(',')[0].trim();
          const requested = advance(asked);
          const absent = advance("'ZzQqNoSuchFontXx'");
          return {
            asked,
            requestedAdvancePx: Math.round(requested * 100) / 100,
            absentControlAdvancePx: Math.round(absent * 100) / 100,
            resolves: Math.abs(requested - absent) > 0.5,
          };
        })(),
        // The measurement the whole reading-measure decision rests on.
        //
        // Not "characters ÷ line boxes": the last line of every paragraph is
        // partial, so that under-reports by half a line per paragraph — about
        // 8% on a document like this one, which is enough to move the number
        // out of the band it is being judged against. Instead the engine is
        // asked for the line boxes themselves. A `Range` over a paragraph's
        // contents returns one rect per rendered line, so the summed rect width
        // is the *inked* width of the text and dividing by its character count
        // gives the average advance directly — a property of the face and the
        // words, with no partial-line bias in it at all.
        charsPerLine: (() => {
          let inkedPx = 0;
          let characters = 0;
          for (const node of prose.querySelectorAll(':scope > p')) {
            const text = (node.textContent ?? '').length;
            if (text === 0) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) inkedPx += rect.width;
            characters += text;
            range.detach();
          }
          if (characters === 0 || inkedPx === 0) return null;
          return Math.round((prose.clientWidth / (inkedPx / characters)) * 10) / 10;
        })(),
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

/**
 * THE OTHER READING SURFACE — the thinking block.
 *
 * It is a reading surface and nothing here ever treated it as one. It rendered
 * `<p>{text}</p>` with `white-space: pre-wrap`, so a reasoning-heavy endpoint
 * printed literal `**Deconstruct the requirements:**`, literal `*   ` bullets
 * and literal fences at the user — and this matrix could not see it, because
 * every profile's reasoning narration was plain prose with no markdown in it to
 * render wrongly. `#thinkmd` puts markdown in the channel; this reads what came
 * out the other end.
 *
 * The block is collapsed by default now, so the caller must open it first.
 */
export function reasoningSurface(page) {
  return page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    const body = turn?.querySelector('section [id$="-reasoning"]') ?? null;
    if (body === null) return null;

    const prose = body.querySelector('[data-scale]');
    const style = prose === null ? null : getComputedStyle(prose);
    const answer = turn?.querySelector('[data-scale="answer"]') ?? null;
    return {
      scale: prose?.getAttribute('data-scale') ?? null,
      text: body.textContent ?? '',
      whiteSpace: style === null ? null : style.whiteSpace,
      fontSizePx: style === null ? null : Math.round(Number.parseFloat(style.fontSize) * 100) / 100,
      answerFontSizePx:
        answer === null
          ? null
          : Math.round(Number.parseFloat(getComputedStyle(answer).fontSize) * 100) / 100,
      // The biggest thing the aside sets. An `h1` the model wrote inside its own
      // reasoning must not out-shout the answer it is reasoning about.
      largestPx: Math.max(
        0,
        ...[...body.querySelectorAll('*')].map((node) =>
          Number.parseFloat(getComputedStyle(node).fontSize),
        ),
      ),
      counts: {
        strong: body.querySelectorAll('strong').length,
        listItems: body.querySelectorAll('li').length,
        inlineCode: [...body.querySelectorAll('code')].filter((node) => node.closest('pre') === null)
          .length,
        codeBlocks: body.querySelectorAll('pre').length,
        headings: body.querySelectorAll('[data-level]').length,
      },
    };
  });
}

/**
 * THE VERTICAL RULER, and the sidebar's share of the window.
 *
 * Three findings share one reader because they are one question: what does the
 * app do with the width it is given? The transcript's text and the composer's
 * box sat on two different rulers (688px over 736px); the sidebar was a
 * constant, so at 1000px it took half the window; and the reading column set
 * prose at ~95–105 characters. All three are properties of the assembled
 * layout at a *particular* window size, which is why they can only be read from
 * a browser and why this is called at more than one viewport.
 */
export function layoutRuler(page) {
  return page.evaluate(() => {
    const box = (node) => {
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const left = Number.parseFloat(style.paddingLeft);
      const right = Number.parseFloat(style.paddingRight);
      return {
        left: Math.round((rect.left + left) * 10) / 10,
        right: Math.round((rect.right - right) * 10) / 10,
        width: Math.round((rect.width - left - right) * 10) / 10,
      };
    };

    const scroller = document.querySelector('section[aria-label="Conversation"] > div');
    // The transcript's *text* edge: the column's content box, which is what a
    // reader's eye actually lines up against.
    const column = scroller?.firstElementChild ?? null;
    const field = document.querySelector('#vela-composer')?.closest('div') ?? null;
    const form = document.querySelector('#vela-composer')?.closest('form') ?? null;
    const sidebar = document.querySelector('nav[aria-label="Primary"]');

    // What each of the two boxes loses to the scrollbar, measured rather than
    // read off a declaration: border box less content box. They have to be the
    // same number or the column and the field are being centred in two
    // different widths, which is precisely how the ruler broke at 0f83c71.
    const reserved = (node) => (node === null ? null : node.offsetWidth - node.clientWidth);

    return {
      viewportWidth: window.innerWidth,
      reserve: { scroller: reserved(scroller), composer: reserved(form) },
      transcript: box(column),
      composer: field === null ? null : (() => {
        const rect = field.getBoundingClientRect();
        return {
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
        };
      })(),
      sidebarWidth:
        sidebar === null ? null : Math.round(sidebar.getBoundingClientRect().width * 10) / 10,
      scrollerMask: scroller === null ? null : getComputedStyle(scroller).maskImage,
      scrollerEdges:
        scroller === null
          ? null
          : {
              atTop: scroller.getAttribute('data-at-top'),
              atBottom: scroller.getAttribute('data-at-bottom'),
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

/**
 * The text the core emitted, reassembled from its own event log.
 *
 * `server.mjs` records every `chat:event` verbatim, so this is the ground truth
 * for what the renderer was given — as opposed to what it drew. Deltas from
 * every turn in the run are concatenated, which is all the caller needs: the
 * question being asked of it is whether a phrase is present, not where.
 */
export function emittedTextFor(events) {
  let text = '';
  for (const entry of events) {
    const event = entry?.payload?.event;
    if (event?.type === 'textDelta' && typeof event.text === 'string') text += event.text;
  }
  return text;
}

/**
 * A12b. Everything the core produced for this turn reached the reader.
 *
 * The other assertions on a settled turn ask whether *something* is on screen.
 * None of them asks whether it is the whole thing, and that gap had a cost: for
 * four gate runs the recorded transcript began mid-word — `small-local` showed
 * `"rise what this endpoint can do.."` where the core had emitted `"Mock
 * small-local reply to: Summarise what this endpoint can do.."` — and every
 * assertion passed, because an answer missing its first ninety-five characters
 * is still non-empty, still settled, still free of reasoning markup, and still
 * painted incrementally. The screenshot showed it plainly. Nothing was looking.
 *
 * ## Why the mock's opening words rather than a string comparison
 *
 * The rendered text is deliberately *not* the emitted text: markdown is turned
 * into elements, the reasoning channel is separated out, hostile's control
 * tokens are stripped on purpose, and hard wraps are reflowed. Comparing the
 * two would fail on correct behaviour. What no correct behaviour may do is drop
 * the answer's opening, so this asserts on the one deterministic phrase every
 * profile's answer starts with — `Mock <profile> reply to:` — which is exactly
 * the run that went missing.
 *
 * `emitted` is passed in from the core's own event log rather than assumed, so
 * a run where the endpoint genuinely never said it is reported as inconclusive
 * instead of quietly passing.
 */
export function nothingWasDroppedBeforeTheReader(turn, emitted) {
  const opening = /Mock [a-z-]+ reply to:/u.exec(emitted ?? '');
  if (opening === null) {
    return ok(false, 'the core emitted no recognisable answer opening — cannot judge (harness fault, not the app)');
  }
  const visible = (turn?.whole ?? '').replace(/\s+/gu, ' ');
  const pass = visible.includes(opening[0]);
  return ok(
    pass,
    pass
      ? `the answer's opening reached the screen: "${opening[0]}"`
      : `the core emitted "${opening[0]}" and it is NOT on screen — the turn was rendered without its opening`,
  );
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

/* ---- the reading surface, second pass ------------------------------------ *
 * Everything below was added because a human, on a real machine, saw six things
 * this matrix could not. Each one is now measured from the engine's own
 * computed values, so the next run reports them whether or not anybody looks.  */

/* ---- the staged attachment, read at both boundaries ---------------------- *
 * The eighth instance of this project's defect class was an attachment feature
 * whose every part worked and which was joined to nothing: `attachments` was
 * staged, listed and convertible to content parts, and `useSelectedModel()
 * .attachments` had no reader, so pressing Send discarded the user's picture
 * without a word. Every component test passed, because every one asked a
 * component about its own state.
 *
 * So this asks the only question that matters, twice, at the two places the
 * bytes have to arrive: what the renderer handed the host, and what the core
 * put on the wire. A payload that leaves the browser and dies in the Rust layer
 * is the same defect one storey down.                                         */

/** The last `chat_send` the renderer sent, and the user message it carried. */
function lastSentUserMessage(invokes) {
  const sends = (invokes ?? []).filter((entry) => entry.command === 'chat_send');
  const last = sends[sends.length - 1];
  const messages = last?.payload?.messages ?? [];
  return [...messages].reverse().find((message) => message.role === 'user') ?? null;
}

/** The last chat completion the endpoint was actually asked to serve. */
function lastEndpointCompletion(endpointRequests) {
  const completions = (endpointRequests ?? []).filter((request) =>
    request.path.includes('/chat/completions'),
  );
  return completions[completions.length - 1] ?? null;
}

/**
 * A25. A staged image reaches the wire — both halves of the journey.
 *
 * The base64 is passed in by the caller, who wrote the bytes. It is never
 * computed here from the same file object the app read, because then the check
 * and the code under test would agree by sharing an encoder rather than by the
 * bytes being right.
 */
export function stagedImageReachedTheWire(invokes, endpointRequests, base64) {
  const message = lastSentUserMessage(invokes);
  const parts = message?.parts ?? [];
  const inPayload = parts.some(
    (part) => part.kind === 'image' && part.mimeType === 'image/png' && part.data === base64,
  );
  const completion = lastEndpointCompletion(endpointRequests);
  const onTheWire = (completion?.body ?? '').includes(base64);
  return ok(
    inPayload && onTheWire,
    `renderer->host parts=${JSON.stringify(parts.map((part) => part.kind))} carriesImage=${String(inPayload)} | core->endpoint body ${String((completion?.body ?? '').length)} bytes, carriesImage=${String(onTheWire)}`,
  );
}

/**
 * A26. A staged text file reaches the wire, and arrives *named*.
 *
 * A model handed bare file contents cannot tell them from the question, which
 * is why the name is part of the assertion rather than a nicety.
 */
export function stagedTextReachedTheWire(invokes, endpointRequests, fileName, bodyText) {
  const message = lastSentUserMessage(invokes);
  const parts = message?.parts ?? [];
  const textParts = parts.filter((part) => part.kind === 'text').map((part) => part.text ?? '');
  const inPayload = textParts.some(
    (text) => text.includes(fileName) && text.includes(bodyText),
  );
  const completion = lastEndpointCompletion(endpointRequests);
  const body = completion?.body ?? '';
  const onTheWire = body.includes(fileName) && body.includes(bodyText);
  return ok(
    inPayload && onTheWire,
    `renderer->host textParts=${JSON.stringify(textParts.map((text) => text.slice(0, 48)))} | core->endpoint carriesName=${String(body.includes(fileName))} carriesBody=${String(body.includes(bodyText))}`,
  );
}

/**
 * A27. The endpoint really was asked to look at an image.
 *
 * Separate from A25 on purpose: A25 proves the *bytes* survived, this proves
 * they arrived in the shape an OpenAI-compatible endpoint reads as an image
 * rather than as a wall of base64 pasted into the prompt text.
 */
export function endpointSawAnImagePart(endpointRequests) {
  const completion = lastEndpointCompletion(endpointRequests);
  if (completion === null) return ok(false, 'the endpoint served no chat completion to read');
  let parsed = null;
  try {
    parsed = JSON.parse(completion.body);
  } catch {
    return ok(false, 'the endpoint received a body that is not JSON');
  }
  const parts = (parsed.messages ?? []).flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const images = parts.filter((part) => part.type === 'image_url');
  return ok(
    images.length > 0 && typeof images[0]?.image_url?.url === 'string',
    `content parts=${JSON.stringify(parts.map((part) => part.type))} url starts "${String(images[0]?.image_url?.url ?? '').slice(0, 24)}"`,
  );
}

/**
 * A19. The thinking block renders markdown rather than printing it.
 *
 * The largest single item in the CONV-1 visual FAIL, and engine-independent: it
 * reproduced identically on Linux. `<Markdown>` existed, was tested, and was
 * used by the answer channel two lines away in the same component — and the
 * reasoning channel never reached it.
 */
export function reasoningRendersAsMarkdown(reasoning) {
  if (reasoning === null) return ok(false, 'no thinking block to read');
  // Widened by the GATE M executor, in both halves.
  //
  // The syntax half: a bare backtick, not just a fence. A block that renders
  // bold and bullets and still leaves `llama-server` wrapped in backticks is
  // exactly the half-wired outcome this project keeps producing, and the old
  // literal list — `**`, `*   `, ``` — could not see it, because an inline span
  // is one backtick and never three.
  //
  // The structure half: four constructs, not two. `strong` and `li` are
  // produced by two branches of the parser; requiring `code` and `pre` as well
  // means the assertion is about the reasoning channel reaching the *renderer*
  // rather than about two branches of it happening to work.
  const literals = ['**', '*   ', '```', '`'].filter((literal) =>
    reasoning.text.includes(literal),
  );
  const built =
    reasoning.counts.strong > 0 &&
    reasoning.counts.listItems > 0 &&
    reasoning.counts.inlineCode > 0 &&
    reasoning.counts.codeBlocks > 0;
  const preserving = /^pre/u.test(reasoning.whiteSpace ?? '');
  return ok(
    literals.length === 0 && built && !preserving,
    `leaked=[${literals.join(' ')}] strong=${String(reasoning.counts.strong)} items=${String(reasoning.counts.listItems)} inlineCode=${String(reasoning.counts.inlineCode)} fences=${String(reasoning.counts.codeBlocks)} white-space=${String(reasoning.whiteSpace)}`,
  );
}

/**
 * A19b. A settled thought is closed, unless closing it would hide the turn.
 *
 * The block used to open itself while streaming, which on a real reasoning
 * endpoint meant it was the first thing on screen every turn and — on a short
 * prompt — the only thing for about ten seconds. It is a peek now.
 *
 * The exception is not an exception to be sorry about: when the stream ended
 * mid-thought the reasoning channel is the only text the turn produced, and
 * collapsing it would hide the whole answer. The block says so in its own
 * summary, so that is what this reads rather than a profile name — the rule is
 * about the state, not about which endpoint happened to produce it.
 */
export function settledThoughtIsClosed(turn) {
  const reasoning = turn?.reasoning ?? null;
  if (reasoning === null) return ok(false, 'no thinking block to judge');
  const unterminated = /never closed/iu.test(reasoning.summary);
  return ok(
    reasoning.expanded === unterminated,
    `summary="${reasoning.summary}" expanded=${String(reasoning.expanded)} (unterminated=${String(unterminated)})`,
  );
}

/**
 * A20. The aside stays subordinate to the answer it is about.
 *
 * The question routing reasoning through the answer's renderer creates: the
 * display sizes belong to the answer, so a model that writes `# Plan` inside
 * its own reasoning must not get a 24px heading over the reply.
 */
export function asideStaysSubordinate(reasoning) {
  if (reasoning === null) return ok(false, 'no thinking block to read');
  const answer = reasoning.answerFontSizePx ?? 0;
  return ok(
    reasoning.scale === 'aside' && answer > 0 && reasoning.largestPx <= answer,
    `scale=${String(reasoning.scale)} largest in aside=${String(reasoning.largestPx)}px, answer body=${String(answer)}px`,
  );
}

/**
 * A21. Structure outranks emphasis.
 *
 * `<strong>` is unclassed by design, so without a rule it inherits the user
 * agent's 700 — one step above every heading at 600. A phrase somebody bolded
 * in passing then read as more structural than the section containing it. Two
 * halves: no heading lighter than a bold run, and no heading smaller than the
 * prose it heads.
 */
export function headingsOutrankEmphasis(reading) {
  const headings = reading?.headings ?? [];
  const strong = reading?.strong ?? [];
  if (headings.length === 0) return ok(false, 'no heading in the answer channel to judge');
  if (strong.length === 0) return ok(false, 'no bold run in the answer channel to compare against');

  const boldest = Math.max(...strong.map((run) => Number(run.fontWeight)));
  const body = reading?.prose?.fontSizePx ?? 0;
  const outweighed = headings
    .filter((heading) => Number(heading.fontWeight) < boldest)
    .map((heading) => `h${String(heading.level)}@${heading.fontWeight}`);
  const undersized = headings
    .filter((heading) => heading.fontSizePx < body)
    .map((heading) => `h${String(heading.level)}@${String(heading.fontSizePx)}px`);

  return ok(
    outweighed.length === 0 && undersized.length === 0,
    `strong=${String(boldest)} body=${String(body)}px | outweighed=[${outweighed.join(' ')}] undersized=[${undersized.join(' ')}]`,
  );
}

/**
 * A22. The reading column sets a comfortable number of characters per line.
 *
 * 46rem put prose at ~95–105 characters on the operator's Windows machine;
 * comfortable sustained reading is 65–75.
 *
 * The band accepted here is 55–78, wider than the target, and the reason is
 * printed alongside every reading: **Vela does not bundle a typeface yet** — an
 * A1 platform finding — so the same column measures differently depending on
 * what the host resolved the stack to. This container has no Inter installed
 * and falls back to a wider face, where 30rem measures ~61; the same column on
 * Segoe UI measures ~70. A band tight enough to encode one engine's face would
 * fail honestly on the other.
 *
 * It is still falsifiable on the engine that runs it, which is the property
 * that matters: the pre-fix 46rem column measures ~88 here and ~100 there, and
 * both are outside it. When the face ships, tighten this to 65–75 and delete
 * this paragraph.
 */
export function readingMeasureIsComfortable(reading) {
  const measured = reading?.prose?.charsPerLine ?? null;
  if (measured === null) return ok(false, 'no multi-line paragraph in the answer to measure');
  const asked = reading?.prose?.fontFamily ?? 'unknown';
  const resolution = reading?.prose?.firstFamilyResolves ?? null;
  // The face is named as *requested* and the resolution is stated beside it,
  // so nobody can read this line as evidence that the requested face shipped.
  const face =
    resolution === null
      ? `${asked} (resolution unknown)`
      : `${asked} ${resolution.resolves ? '(resolved)' : '(NOT resolved — a fallback face was used)'}`;
  return ok(
    measured >= 55 && measured <= 78,
    `${String(measured)} characters per line at ${String(reading?.prose?.clientWidthPx)}px, set in ${face}`,
  );
}

/**
 * A23. The transcript and the composer stand on one vertical ruler.
 *
 * They were 688px of text over a 736px box — near enough to read as a
 * misalignment rather than as a decision, which is the worst width to be off by.
 *
 * **Left edge, right edge and width — never the centre.** Two concentric boxes
 * of different widths share a centre line, so a centre comparison passes on the
 * exact defect this exists to catch: at 880px the wave's own gate printed
 * `column 456.0 vs field 456.0` while the text was overhanging the composer by
 * 12px on each side.
 */
export function oneVerticalRuler(ruler) {
  const text = ruler?.transcript ?? null;
  const box = ruler?.composer ?? null;
  if (text === null || box === null) return ok(false, 'transcript or composer not on screen');
  const left = Math.abs(text.left - box.left);
  const right = Math.abs(text.right - box.right);
  const width = Math.abs(text.width - box.width);
  // One pixel of slack for sub-pixel centring of an odd-width viewport.
  return ok(
    left <= 1 && right <= 1 && width <= 1,
    `text ${String(text.left)}–${String(text.right)} (${String(text.width)}px), composer ${String(box.left)}–${String(box.right)} (${String(box.width)}px)`,
  );
}

/**
 * A23b. The two boxes lose the same width to the scrollbar.
 *
 * The mechanism behind A23, read as a quantity instead of as a declaration.
 * `scrollbar-gutter: stable both-edges` on the transcript's scroller made the
 * column and the composer stand on opposite sides of a 24px reservation: the
 * edges agreed only while the window was wide enough for neither box to be
 * clamped, which is why a single wide reading certified a broken ruler.
 *
 * Border box less content box, on each of the two, out of the engine. Equal
 * numbers mean one reservation; the third argument is what tells a run where
 * both are zero — every engine that overlays its scrollbars, which is every
 * engine this repository can run — apart from one where both are real.
 */
export function bothBoxesReserveOneGutter(ruler) {
  const reserve = ruler?.reserve ?? null;
  if (reserve === null || reserve.scroller === null || reserve.composer === null) {
    return ok(false, 'could not find both the transcript scroller and the composer form');
  }
  return ok(
    Math.abs(reserve.scroller - reserve.composer) <= 1,
    `scroller reserves ${String(reserve.scroller)}px, composer reserves ${String(reserve.composer)}px`,
  );
}

/**
 * A24. The sidebar gives way to the reading column, rather than the other way
 * round.
 *
 * A 480px sidebar is a third of a 1440px window and half of a 1000px one, and
 * the sidebar was a constant. Read at two viewports with the sidebar dragged to
 * its maximum, because a single reading cannot tell a responsive width from a
 * constant that happens to look right at the size you measured — and a sidebar
 * left at its default is under the cap at both sizes and would prove nothing.
 *
 * The property is not "the sidebar is small". It is: **the reader's column
 * keeps its measure, and the sidebar is what shrinks.**
 */
export function sidebarTracksTheWindow(wide, narrow) {
  const a = wide?.sidebarWidth ?? null;
  const b = narrow?.sidebarWidth ?? null;
  if (a === null || b === null) return ok(false, 'the sidebar was not on screen at both sizes');
  const gave = b < a;
  // One pixel of slack: a border and sub-pixel centring both land here.
  const keptMeasure = (wide?.transcript?.width ?? 0) - (narrow?.transcript?.width ?? 0) <= 1;
  return ok(
    gave && keptMeasure,
    `${String(wide.viewportWidth)}px → sidebar ${String(a)}px, column ${String(wide?.transcript?.width)}px; ${String(narrow.viewportWidth)}px → sidebar ${String(b)}px, column ${String(narrow?.transcript?.width)}px`,
  );
}

/**
 * A25. The transcript fades into a scroll edge that hides content, and only
 * into one that does.
 *
 * Both failures are the same defect: a hard cut through a line of text at the
 * top of the viewport reads as a paint bug, and a permanent gradient dims the
 * first turn of a conversation you have scrolled to the top of.
 */
export function scrollEdgeIsMasked(ruler) {
  const mask = ruler?.scrollerMask ?? null;
  const edges = ruler?.scrollerEdges ?? null;
  if (mask === null || edges === null) return ok(false, 'no transcript scroll container found');
  const faded = mask !== 'none';
  const hidesContent = edges.atTop === 'false' || edges.atBottom === 'false';
  return ok(
    faded === hidesContent,
    `atTop=${String(edges.atTop)} atBottom=${String(edges.atBottom)} mask=${faded ? mask.slice(0, 90) : 'none'}`,
  );
}

/** A14. Usage claimed only where the endpoint reported it. */
export function usageOnlyWhenReported(turnWholeText, expectReported) {
  const claims = /tokens$|\d+ in ·|\d+ out/mu.test(turnWholeText);
  return ok(claims === expectReported, `usage line present=${String(claims)} expected=${String(expectReported)}`);
}
