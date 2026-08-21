/**
 * The frame a document is drawn in — the one boundary in this feature that is
 * held by something other than Vela's own good intentions.
 *
 * ## The two attributes that are the whole of it
 *
 * `sandbox` never contains `allow-same-origin`. That single omission is what
 * makes the frame's origin opaque, and an opaque origin is what
 * `{ family: 'document', level: 'opaqueOriginFrame' }` names: no access to
 * Vela's DOM, no cookies, no storage, no same-origin request back into the app.
 * Adding `allow-same-origin` beside `allow-scripts` would hand model-authored
 * script Vela's own origin, which is the single worst line of code that could be
 * written in this repo. `document-frame.test.ts` asserts it is not there, for
 * every program shape, because a rule this consequential must be watched by a
 * machine rather than by a reviewer's memory.
 *
 * `srcdoc` carries a document **Vela builds**, whose first element is a
 * `Content-Security-Policy` meta of `default-src 'none'`. The model's source is
 * the body of that document, never the document itself, and the reason is
 * ordering: a CSP meta is honoured only until the first token that is not a meta,
 * so a page whose skeleton came from the model could put anything it liked ahead
 * of the policy. Owning the skeleton is what makes the policy first.
 *
 * Together those two are what a `network: 'kernel'` claim about a document frame
 * would rest on. The frame reaches nothing — no fetch, no image, no font, no
 * stylesheet, no nested frame — because the browser refuses, not because a policy
 * object in this process says so.
 *
 * **No shipped host makes that claim.** `absent_document_backend` in the
 * `vela-sandbox` crate reports the document family at `sameOrigin` with every
 * guarantee `unenforced`, because that host draws no frame and will not describe
 * one it does not own. The only `SandboxBackendReport` in this tree that says
 * `kernel` about a document is the fake host in `document-host-double.ts`, which
 * is a test double and says so. The mechanism below is real either way; what is
 * missing is a host that has one and reports it.
 *
 * ## What this file does not do
 *
 * It does not sanitise, rewrite, or inspect the model's source for meaning. The
 * contract is explicit that a boundary you can describe without reading the
 * program is a boundary and anything else is a filter with good intentions. The
 * only transformation applied is stripping an XML prologue off an SVG, which is
 * a syntax fix for inlining and not a judgement about content.
 */

import type { DocumentProgram, DocumentScripts } from '@/platform/contract-sandbox';

/** Everything the `<iframe>` needs, and nothing that would let it be widened. */
export interface FrameSource {
  /** Goes on `srcDoc`. Vela's skeleton, the model's body. */
  readonly html: string;
  /**
   * Goes on `sandbox`. The empty string is the strongest value there is — every
   * restriction on — and it is what a document with `scripts: 'denied'` gets.
   */
  readonly sandbox: string;
}

/**
 * The message a frame with script sends its parent. Nothing else is listened for.
 *
 * `vela` is a discriminator and not a secret: a null-origin frame can post
 * whatever it likes, so the receiver's real check is `event.source` against the
 * frame's own `contentWindow`. This tag only keeps an unrelated `postMessage`
 * from a browser extension out of the diagnostic stream.
 */
export const CANVAS_FRAME_MESSAGE = 'vela:canvas:diagnostic';

/**
 * Injected ahead of the model's script when — and only when — script is allowed.
 *
 * Without it the `diagnostic` arm of `DocumentObservation` has no producer, and
 * an event type with no producer is exactly what the contract's own author
 * removed from the first draft of that file. With it, an artifact that throws at
 * minute three says so in the panel.
 *
 * It is deliberately not a capability: it hands the frame nothing it did not
 * already have. `postMessage` to a parent is available to every frame, and this
 * only decides what shape the frame's own noise arrives in.
 */
const DIAGNOSTIC_BRIDGE = `(function(){
  var send=function(severity,text){
    try{parent.postMessage({tag:'${CANVAS_FRAME_MESSAGE}',severity:severity,text:String(text).slice(0,4000)},'*');}catch(e){}
  };
  ['log','info','warn','error'].forEach(function(name){
    var severity=name==='error'?'error':name==='warn'?'warning':'info';
    var original=console[name];
    console[name]=function(){
      send(severity,Array.prototype.map.call(arguments,String).join(' '));
      if(typeof original==='function')original.apply(console,arguments);
    };
  });
  window.addEventListener('error',function(e){send('error',e.message);});
  window.addEventListener('unhandledrejection',function(e){send('error','Unhandled rejection: '+e.reason);});
})();`;

/**
 * The policy, per script decision.
 *
 * `form-action` and `base-uri` are named explicitly because `default-src` does
 * not cover either of them: a form that posts somewhere and a `<base>` that
 * repoints every relative URL are both navigations, and a navigation is the one
 * way out of `default-src 'none'`.
 *
 * `style-src 'unsafe-inline'` is not a hole. It is the whole point of the
 * artifact: a model-drawn page styles itself inline, and there is no origin here
 * for a style to exfiltrate to — `default-src 'none'` means a CSS `url()` reaches
 * nothing either.
 */
function contentSecurityPolicy(scripts: DocumentScripts): string {
  const directives = [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    'font-src data:',
    "form-action 'none'",
    "base-uri 'none'",
  ];
  if (scripts === 'sandboxedNullOrigin') directives.push("script-src 'unsafe-inline'");
  return `${directives.join('; ')};`;
}

/**
 * The reset every artifact is drawn against.
 *
 * `color-scheme: light` is deliberate and is the one place this feature ignores
 * the app's theme. A model writing a page assumes a white canvas — that is what
 * every browser it has ever seen output for gives it — so drawing its unstyled
 * text on Vela's dark surface would show the user black on black and blame the
 * model for it. The artifact is a document, not a part of the app's chrome.
 */
const RESET = 'html,body{margin:0;padding:0;color-scheme:light;background:#fff;color:#111}';

const SVG_FIT = 'svg{max-width:100%;height:auto;display:block;margin:0 auto}';

/** `<?xml …?>` and `<!DOCTYPE …>` are document-level syntax and cannot be inlined. */
const XML_PROLOGUE = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?/i;

/**
 * Build the frame for one program.
 *
 * Total over {@link DocumentProgram} without a default arm, so a language added
 * to the contract stops compiling here rather than silently rendering as HTML —
 * which is what a `default:` returning the source would have done for `mermaid`,
 * and drawing a Mermaid diagram's text as an HTML page is exactly the sort of
 * quiet wrong answer this repo's guards exist to prevent.
 *
 * ## The confinement is computed from the program, not from the grant
 *
 * Stated because it is the largest renderer-side decision left in this feature
 * and it is invisible from the signature's shape. Both values returned here —
 * `sandbox`, and whether the CSP carries a `script-src` line — come off
 * `program.scripts` and nothing else. `EffectiveGrant` is not a parameter here,
 * and three of its fields are read anywhere in `DocumentPreview`:
 * `backend.isolation`, which `isolationSentence` turns into one sentence on the
 * approval card, `network.kind`, which is another, and `limits.outputBytes`,
 * which bounds the diagnostics byte counter. Two sentences and a counter: no
 * field of the grant reaches this function, and none of those three decides what
 * the frame is confined by.
 *
 * An earlier version of this paragraph ended "every other mention of the grant
 * there tests the object for `null`". That is false, and it was corrected here
 * rather than softened: the object is also passed to `frameable` and to
 * `isolationSentence`, constructed into a pair, read off `drawable`'s result,
 * and listed in two dependency arrays. The count of *fields read* was the true
 * half, and it is the half that bears on this function.
 *
 * That is defensible exactly as far as `program` is the host's own copy — which
 * is what `RunPhase` in `use-document-run.ts` now carries and what the approval
 * card describes — and no further. It is not that the grant is being ignored in
 * favour of the renderer: it is that a host wanting a document confined
 * differently from what its own `ApprovalRequest.program` says has nowhere on
 * `EffectiveGrant` to say it. That interface is `backend`, `filesystem`,
 * `network`, `limits` and `workingDirectory`, and none of the five names script
 * execution in a drawn frame. If one ever does, this function is where it has to
 * be read, and today it would not be.
 */
export function frameFor(program: DocumentProgram): FrameSource {
  switch (program.language) {
    case 'html':
    case 'react': {
      const scripts = program.scripts;
      const bridge =
        scripts === 'sandboxedNullOrigin' ? `<script>${DIAGNOSTIC_BRIDGE}</script>` : '';
      return {
        html: skeleton(contentSecurityPolicy(scripts), RESET, `${bridge}${program.source}`),
        sandbox: scripts === 'sandboxedNullOrigin' ? 'allow-scripts' : '',
      };
    }
    case 'svg':
    case 'mermaid':
      return {
        html: skeleton(
          contentSecurityPolicy('denied'),
          `${RESET}${SVG_FIT}`,
          program.source.replace(XML_PROLOGUE, ''),
        ),
        sandbox: '',
      };
  }
}

function skeleton(policy: string, style: string, body: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`;
}

/**
 * Does this source fail to parse as SVG?
 *
 * The only route to `sourceRejectedByParser` this build has. A frame with an
 * opaque origin cannot be read, so a document that failed to parse *inside* it is
 * invisible to Vela — the browser shows its own error page and Vela's `load`
 * handler fires exactly as it would for a good document. Parsing a copy out here,
 * before the frame is drawn, is the one honest way to tell the two apart.
 *
 * HTML has no equivalent and does not get one: the HTML parser has no failure
 * mode, so `sourceRejectedByParser` is unreachable for an `html` program and no
 * code in this feature pretends otherwise.
 */
export function svgFailsToParse(source: string): boolean {
  if (typeof DOMParser === 'undefined') return false;
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  return parsed.getElementsByTagName('parsererror').length > 0;
}
