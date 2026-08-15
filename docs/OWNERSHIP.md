# Ownership — moved

The registry is **[`docs/desktop-gate/OWNERSHIP.md`](desktop-gate/OWNERSHIP.md)**. Claim there.

This file existed for part of Wave 1 because the lead told two builders to claim in
`docs/OWNERSHIP.md` without checking whether it existed. One created it; the other found the real
registry and said so. For a while both were live.

It is kept as a pointer rather than deleted, because the failure it represents recurs by itself: a
second registry is worse than no registry. Two agents each claim correctly, in different files, and
neither finds the other — so the conflict surfaces in a merge instead of before an edit, which is
the one thing a registry exists to prevent.

The `fix/dead-skill-mount` row that used to be here is gone because that branch merged, which its
own rule required.
