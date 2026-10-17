# Cell-level conformance: the check a leaf corpus structurally cannot do

## The gap

Every conformance suite in this fleet compares **leaves**: one record
in, one hash out. The 20,043-record corpus, the 29-case fold corpus,
and the 131,499-mutant pass all work that way.

**A leaf is a function of ONE record.** The leaf of record `r` does not
depend on any other record's presence, kind, or parentage.

So a leaf corpus **cannot see a fold bug**, no matter how large it is.
The four fold bugs found this session were all invisible to it:

| bug | what it changes | visible to a leaf corpus? |
|---|---|---|
| `gitpp-cs` `kind: null` throws | nothing is applied | no |
| `gitpp-js` tie-break not topo order | which record WINS a key | no |
| three ports: cycle descendants not orphans | which records are APPLIED | no |
| `reader3-c`: §5.5 orphan rule | which records are APPLIED | no |

Each of those changes the *fold* — the set of records applied and the
order they win in — and none of them changes what any single record
contains.

Demonstrated on the orphan bug, with the two records' leaves computed
by the reference:

```
ade36660306396b63d6e63d8f4abc07555b24c767c68af12a6d392c0c3a77828   (leaf of o)
290bd28651f4d50184d2c888c143a2048072d65e5ecfa4d91f40dd066247d93f   (leaf of k)
```

Those are identical under both ports. The difference is only in the
fold:

```
reference: orphans=[o],    state={y:2}
reader3-c: orphans=[o,k],  state={}
```

## What cell-level conformance does

`src/conform.mjs` compares two ports' folds **cell by cell**:

- the **value** each key holds
- the **setter** — which record set it
- the **orphans**
- the **order**

and it distinguishes two failure kinds that look identical in a
diff:

| kind | meaning | which clause it points at |
|---|---|---|
| `value` | the two ports disagree on what the key holds | §5.2 resolution |
| `setter` | same value, different record set it | §5.6 provenance |
| `provenance` (in `contestedAgreement`) | contested cell, same value, different winner | §5.2 tie-break |

That distinction is the point. "The ports disagree" is not a finding.
"They disagree on 3 of 12 cells, all contested, and the values agree but
the winners do not" points straight at the tie-break.

## The negative control, measured

| | js vs the python reference | js vs reader3-c (the known bug) |
|---|---|---|
| orphan + descendant | 0 disagreements, orphans agree, order agrees | **1/1 cell differs, orphans DIFFER, order DIFFERS** |
| cycle + descendant | 0 disagreements, all agree | **1/1 cell differs, orphans DIFFER, order DIFFERS** |
| same-class tie-break | 0 disagreements, all agree | 0 disagreements, all agree |

The check is **specific**: it catches the orphan bug and does not
manufacture a failure on the case where the two ports genuinely agree.

## The structural point

> **A leaf corpus tests encoding. A cell-level corpus tests the fold.
> They are different claims, and only one of them is about the thing
> the project keeps saying is pinned.**

The fleet had 20,043 leaf cases, 29 fold cases, and 131,499 mutants, and
no cell-level comparison between two ports at all. The fold corpus
compared each port against a *stored expectation* — which is authored
data, and authored data is exactly the thing this project has learned
not to trust without an independent check.

Comparing two ports to each other removes the authored expectation from
the loop entirely. That is the same move as `EXPECTATION-AUDIT.py` in
the reading-room, applied to the fold instead of the corpus.
