/**
 * Confirmation before a configured endpoint is destroyed.
 *
 * ## Why this exists, when renaming the button was supposed to be the fix
 *
 * Commit `8e91daf` on this branch renamed the endpoint delete button from
 * `Remove` to `Remove: <endpoint>`, because bare `Remove` was a substring of the
 * attachment tray's `Remove shot.png` and the two are on screen together. That
 * closed the *name* collision and left the reason the collision mattered
 * untouched: this button deleted an endpoint **and the key stored for it** with
 * nothing in between. A name is a way of pointing at a control; it is not a
 * property of what the control does. So the fix carried its own defect one level
 * down — two endpoints given the same display name still produce two identical
 * `Remove: X` buttons, and no naming scheme closes that, because the text inside
 * the name is the user's.
 *
 * What closes it is the consequence. `src/app/accessible-names.test.tsx` admits
 * a duplicate when either landing is survivable, and this dialog is what makes
 * the landing survivable: it names the address and the identifier — the two
 * things that actually differ between two rows a user called the same thing —
 * and defaults the keyboard to Cancel.
 *
 * That property is guarded, not merely intended. `EndpointsPanel.test.tsx`
 * seeds two rows with one display name, clicks the *second* one, and asserts
 * that the question names that row's address and identifier and that confirming
 * leaves the other endpoint alive. Until that test existed the guarantee had no
 * reader at all: making `onConfirm` remove the head of the provider list
 * instead of the clicked target left the whole suite green, which is the
 * round-1 finding — a guard that stopped at its own family — one level further
 * down again.
 *
 * ## Why an endpoint is not a schedule
 *
 * The same ledger accepts two `Delete: Daily digest` buttons with no dialog at
 * all, on the grounds that a schedule is re-creatable from what is on screen. An
 * endpoint is re-creatable from what is on screen too — address, model, kind —
 * **except its credential**, which is write-only by construction
 * (`use-providers.storeCredential`: "One-way: written to the OS keychain, never
 * read back"). That one field is why this row gets a dialog and that row does
 * not.
 *
 * ## The confirm button is not called `Remove`
 *
 * `DeleteConversationDialog`'s confirm button is bare `Delete`, and the ledger
 * accepts `Delete` inside `Delete New conversation` because its only container
 * is the control that opened it. A bare `Remove` here would land inside the
 * attachment tray's `Remove shot.png` — an unrelated control over a different
 * object — which is the containment this branch refused to admit in the first
 * place. So the accessible name is `Remove this endpoint` and the visible word
 * stays `Remove`, which WCAG 2.5.3 wants: the visible label is contained in the
 * accessible name.
 *
 * ## Focus
 *
 * `ModalSurface` captures the opener and hands the keyboard back through the
 * ladder in `src/state/focus-store.ts` on unmount. Confirming destroys the row
 * that opened this dialog, so the opener is a detached node and the ladder is
 * what stops the keyboard reaching `<body>` — the same case
 * `DeleteConversationDialog` records. Which rung answers is asserted in
 * `src/app/focus-ownership.test.tsx` rather than described here, and the order
 * that makes the opener rung correctly refusable is the subject of the comment
 * on `onConfirm` in `EndpointsPanel.tsx`.
 *
 * **Honesty (conventions §10):** driven in jsdom by the tests named above, and
 * separately in real Chromium against the built bundle — first in round 2 of
 * this branch and then independently by the round-3 critic, who reproduced the
 * same figures rather than reading them: a 420×205 box on a `position: fixed`
 * scrim at `z-index: 40`, and exactly the endpoint the body named removed. Two
 * of those numbers are checkable from the tree without a browser
 * (`--vela-overlay-sm: 420px`, `--vela-z-dialog: 40` in `src/styles/tokens.css`);
 * the 205px height is not, and rests on those two runs. All of it is a machine
 * reading a layout, not a person looking at a screen: no screen reader announced
 * this dialog, no human eye has seen it, and neither its wording nor its rhythm
 * has been reviewed by one.
 */

import { useRef } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import type { ProviderView } from '@/platform/contract';

import styles from './RemoveEndpointDialog.module.css';

interface RemoveEndpointDialogProps {
  readonly view: ProviderView;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RemoveEndpointDialog({ view, onCancel, onConfirm }: RemoveEndpointDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface
      role="alertdialog"
      labelledBy="remove-endpoint-title"
      describedBy="remove-endpoint-body"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      // Cancel, never Remove. Same statement DeleteConversationDialog makes, for
      // the same reason: a reflexive Enter should cost nothing.
      initialFocus={cancelRef}
      onDismiss={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h2 id="remove-endpoint-title" className={styles.title}>
        Remove this endpoint?
      </h2>
      <p id="remove-endpoint-body" className={styles.body}>
        {/* The address and the identifier, not just the name: two endpoints may
            be called the same thing, and these are what differ. */}
        <strong className={styles.name}>{view.displayName}</strong> at {view.baseUrl}, identified
        as <code className={styles.identifier}>{view.id}</code>, will be removed from this device.
        {view.credentialPresent
          ? ' The key stored for it is deleted with it, and Vela cannot read a stored key back to show you what it was.'
          : ' No key is stored for it.'}{' '}
        This cannot be undone.
      </p>
      <div className={styles.actions}>
        <button type="button" ref={cancelRef} className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.confirm}
          aria-label="Remove this endpoint"
          onClick={onConfirm}
        >
          Remove
        </button>
      </div>
    </ModalSurface>
  );
}
