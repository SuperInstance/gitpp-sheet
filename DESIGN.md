# gitpp-sheet — a fold as a spreadsheet with cell-level confidence

## The synergy this is built on

A git.pp fold already IS a spreadsheet:

    state     : key -> value          (the cells)
    setters   : key -> record id      (cell provenance)
    order     : [record id]           (the dependency order)
    conflicts : key -> {winner, losers}   (the audit trail)

What it does NOT have is a way to say **how sure we are** of a cell.

Jev supplies exactly that: a calibrated probability that a claim is
supported by text. And a fold is a *propagation* structure — the value
of a cell depends on which record won, which depends on the class of
every candidate, which depends on the spec.

So the synergy is:

    spec text ──Jev──> per-record confidence ──fold──> per-CELL confidence

A cell's confidence is not the confidence of the record that set it.
It is the confidence of the *decision* that made it the winner, which
depends on the losing candidates too.

## Why this is more than a score on a picture

A graph view that colours nodes by Jev score is a picture. What makes
it a system is:

1. **Scores are attached to claims, not to records.** "This record is a
   task" is a claim about the record; "this record's class beats that
   record's class" is the claim the fold actually depends on. Scoring
   the second gives a cell-level number that is *derived* rather than
   asserted.

2. **Confidence propagates through the fold, not through the picture.**
   If a key's winner was decided by a class comparison, and that
   comparison was uncertain, the cell inherits the uncertainty. A cell
   whose value is unaffected by any uncertain decision is certain even
   if every record involved was scored 0.7.

3. **Downstream effects become queryable.** "Which cells would change
   if this one record's class were different?" is a question a
   spreadsheet abstraction answers directly — it is a dependency
   question, and the fold is already a dependency graph.

## The trigger/effect connection

`gitpp-gate` already uses Jev to ROUTE: a nudge is applied only if Jev's
confidence clears a threshold, and absent signal fails closed. This
project supplies the other half — the thing the gate acts on.

    gate  : "should we apply this action?"   -> a score on a CLAIM
    sheet : "what does that action affect?"   -> a score per CELL

Together: an action whose confidence is 0.9 but which touches a cell
whose confidence is 0.2 is a different proposition from an action whose
confidence is 0.6 touching a cell whose confidence is 0.95. The gate
alone cannot see the difference, because the gate asks about the action
and not about what the action touches.
