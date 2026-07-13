# Octonoesis — Experimental Reports

This file is the project's experimental record: the validation suite and live benchmarks behind the learning loop's claims. It exists so the [README](README.md) can stay a product document while every number stays inspectable.

Methodology stance, held throughout:

- **External verification only.** A rule earns credit only when the same command that originally failed comes back passing — never from model self-assessment.
- **Pre-registered endpoints.** Experiments 2 and 3 wrote their primary/secondary endpoints and all publishable interpretations into the result-file headers *before* the treatment runs; those headers are unedited.
- **Negative and null results are reported**, not dropped: the first benchmark's null overall result, the RepoQuirk negative finding, and the weak-model methodology lesson are all below, with full transcripts under [`test/demo/results/`](test/demo/results/).
- **No re-runs to chase a better number.** Where an early claim did not replicate (ModuleNotFound's n=10 "negative transfer"), the original table is left intact as the historical record and the correction is reported alongside it.

These campaigns were run on the v0.2 system (June-July 2026, dates inline); v1.0 shipped afterward without changes to the learning loop's mechanics. The harness is [`test/demo/live-ab.ts`](test/demo/live-ab.ts).

---

## Validation

Phase 19 validated the learning loop across six dimensions:

| Test Suite | What It Covers | Scale |
|------------|---------------|-------|
| Fixture corpus | 15 error scenarios across 7 coarse buckets | 150 fixtures |
| Cross-pattern generalization | Rules from one instance fix other instances of same type | ~75 sessions incl. 5 negative-transfer checks |
| Evidence chain integrity | Rule→Episode→Journal provenance is intact for all rules | 5 representative full-pipeline runs |
| Negative controls | 8 failure modes: no-error, non-fingerprinted, miss, permission-deny, abandoned, transient, banned, dedup | 24 runs (8 × 3 seeded random types) |
| Calibration accumulation | Beta posterior convergence over increasing observations | 196 calibration records across 15 buckets |
| Rebuild + scale benchmark | 500-episode rebuild, pool cap enforcement, matching budget, state preservation, idempotency, real-spawn smoke | 199 assertions |

The real-spawn smoke test (sub-test 7) runs actual `bun test` against 3 materialized fixtures and confirms that the fail→fix→pass cycle works with real tool output, not just mock data.

## Known Limitations

1. **Ceiling effect on simple bugs**: Haiku-tier models solve 3/5 benchmark bug types in 1 turn with 100% success rate, leaving no room for rule injection to help. The learning loop's value is best measured on bugs of moderate difficulty — hard enough that the model sometimes fails, but general enough that advice from one instance transfers to another.
2. **Instance-specific fixes vs. repo-scoped facts**: the distiller (`src/memory/rules/distill.ts`) now receives the real error output and the real fix diff, and its prompt requires that advice generalize across *instances* of an error class (e.g. "check what modules exist in the directory," not "change `./config-loader` to `./config`") while still stating *repo-structural* facts plainly when the evidence reveals them (an import alias, a barrel-export convention, a config schema field) — those facts hold for every future occurrence in the same repo, so hiding them behind "go read and confirm" defeats the point of writing the rule down. This fixed ModuleNotFound's negative transfer (see below). What's still open: even with a repo-scoped fact stated directly, injected advice does not reliably make a solver skip re-verification via reads — see the RepoQuirk finding below. A repetition gate (require ≥2 episodes sharing a signature before distilling) and real-repo longitudinal validation are both deferred to v1.0; this benchmark uses single-episode seeding, which is a different regime.

## Live A/B Benchmark

`test/demo/live-ab.ts` measures whether rule injection changes real LLM fix behavior. It runs paired control (no rules) vs. treatment (with distilled rule) sessions against materialized fixtures.

```bash
# Quick smoke (2 runs, 1 type)
bun run test/demo/live-ab.ts --runs 2 --types NullAccess

# Full benchmark (10 runs × 5 types = 50 pairs)
bun run test/demo/live-ab.ts --runs 10

# Weak-model probe (any OpenAI-compatible model) — set --distill-model explicitly.
# Omitting it lets the distiller silently default to the provider's cheapest model
# (gpt-5-nano — a reasoning model that burns the distiller's 1000-token cap on reasoning
# and fails its own JSON protocol; see "Weak-model probes" below). The distiller must be
# a model on the SAME provider as the solver; pick a non-reasoning one.
LLM_PROVIDER=openai OPENAI_API_KEY=... bun run test/demo/live-ab.ts \
  --model gpt-4o-mini --distill-model gpt-4o --runs 20
```

### First benchmark (2026-06-23, Claude Haiku 4.5, 50 pairs, n=10 per type)

```
=== Overall (5 types x 10 runs = 50 pairs) ===
| Metric          | Control       | Treatment     | Delta        | p-value  |
|-----------------|---------------|---------------|--------------|----------|
| Turns           | 1.5 ± 1.3     | 1.4 ± 1.1     | +3% ± 60%     | 0.296    |
| Tokens (input)  | 715 ± 619     | 805 ± 496     | +39% ± 94%    | 0.234    |
| Tokens (output) | 213 ± 292     | 200 ± 193     | +25% ± 93%    | 0.524    |
| Success rate    | 45/50         | 44/50         | —             | —        |
```

**No statistically significant improvement.** Per-type breakdown:

| Type | Control | Treatment | Signal |
|------|---------|-----------|--------|
| NullAccess | 10/10, 1.0 turns | 10/10, 1.0 turns | Ceiling — too easy |
| ParseError | 10/10, 1.0 turns | 10/10, 1.0 turns | Ceiling — too easy |
| UndefinedRef | 10/10, 1.0 turns | 10/10, 1.0 turns | Ceiling — too easy |
| ExpectMismatch | 7/10, 2.8 turns | 7/10, 1.8 turns | Mixed — rule helped on C1/C2/B3, hurt on D1/E1 |
| ModuleNotFound | 8/10, 1.8 turns | 7/10, 2.1 turns | Negative — rule too instance-specific |

ExpectMismatch showed the clearest positive signal: individual runs went from 4 turns to 1 turn, and 2 failures became successes. But negative transfer in other runs offset the gains. The learning loop's mechanics are validated — the question is fixture difficulty and rule generality.

### What changed since the first benchmark

The table above prompted a code-level investigation that found three root causes: (1) the distiller saw only episode metadata — never the real error output or the real edit — so its advice was guessed rather than grounded; (2) the distillation prompt had no generalization requirement, so advice came out as copy-paste instance edits; (3) n=10 was underpowered for the one real signal (ExpectMismatch) and the harness had no way to test the actual thesis-relevant failure mode: a repo-local convention no model can know a priori.

Four fixes landed in response, all on branch `v0.2_fix`:
- **Distiller evidence + generalization** (`src/memory/rules/distill.ts`): `distillEpisode()` now takes optional `{errorExcerpt, fixDiff}` evidence, and the prompt requires advice to generalize *across instances* of an error class while still stating *stable repo facts* directly when the evidence reveals them (see Known Limitations #2 above — this second half was added during a later diagnostic pass, not the first).
- **Harness model/provider flags** (`test/demo/live-ab.ts`): `--model`/`--distill-model` let the solver and distiller use different models; the hardcoded `ANTHROPIC_API_KEY` requirement is now provider-aware.
- **RepoQuirk scenario family + discovery affordance**: every scenario type's prompt now includes a repo file tree and a `{"action":"read","file":...}` response option (guarded by the same path-traversal check used elsewhere in the codebase), so the solver can investigate before fixing. Three new fixtures (import map, barrel export, config schema drift) test convention-discovery specifically — this is the arena the project's actual thesis targets (see PRD §1.2/§2.2), not the classic 5 types, which are closer to isolated bug-fixing than repo-learning.
- **Harness correctness + reporting**: a validation gap where a wrong edit guess against a non-displayed file silently no-op'd instead of being rejected is fixed; the solver's completion budget was raised (1200→4000 tokens, since reasoning-model providers burn completion budget on reasoning before the JSON answer); Success rate now gets a real paired-significance test (exact McNemar, not eyeballed).

**The n=10 ModuleNotFound "negative transfer" claim in the table above does not replicate at n=30** — including under the *old*, pre-fix distiller:

```
=== ModuleNotFound - 30 runs (old distiller, old prompt, 2026-07-03) ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 1.8 ± 1.6     | 1.7 ± 1.4     | -5% ± 16%     | 0.123   |
| Success rate    | 21/30         | 22/30         | —             | —       |
```

The n=10 sample was underpowered — a 2-pair difference at that n produces a headline-looking table cell that isn't distinguishable from noise. Corrected here rather than quietly dropped; the original table above is left intact as the historical record. Full transcript: `test/demo/results/2026-07-baseline-modulenotfound-n30.txt`.

**Comparison rule for everything below**: Task 4 added the file tree/read affordance to *every* scenario type's prompt, so control's own prompt shape changed too — raw turn counts are not comparable across the old system (n=10 table, and the n=30 re-run just above) and the new system (next section). What *is* valid is a delta-of-deltas: each system's own treatment-vs-control gap is internally paired (both arms in a system share the same prompt shape), so compare *gaps*, not raw numbers, across systems.

### Second benchmark (2026-07-03, Claude Haiku 4.5, fully-fixed system)

```
=== ModuleNotFound - 30 runs ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 1.3 ± 0.5     | 1.3 ± 0.7     | +0% ± 23%     | 1.000   |
| Success rate    | 30/30         | 30/30         | —             | 1.000   |

=== ExpectMismatch - 30 runs ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 3.1 ± 2.0     | 3.0 ± 1.8     | +6% ± 39%     | 0.606   |
| Success rate    | 15/30         | 19/30         | —             | 0.219   |
```

**Headline: ModuleNotFound's negative transfer is gone.** Old-system gap (treatment − control): success −1 pair, and the n=10 table's −0.3-turn/-1-pair story. New-system gap: turns tied exactly (+0%, p=1.000) and success rate perfectly tied at 30/30 both arms — zero discordant pairs, so McNemar's p=1.000 is not "no evidence either way," it's "not a single pair disagreed." Two caveats keep this honest. First, the n=30 re-run above already showed the n=10 "negative transfer" was noise — so the defensible claim is not "a regression was fixed" but "the failure mode was made structurally impossible": the advice itself verifiably changed from instance edits to grounded strategy (spot-checked against real distilled output during review), and the data shows zero measurable harm from carrying it. Second, this type now sits at ceiling (30/30, 1.3 turns, both arms), so it can no longer measure *benefit* either — what it measures is that rule carriage costs nothing here beyond input tokens (+21% ± 28%).

**ExpectMismatch: mixed, not a clean win.** The turns significance from the n=30 old-distiller re-run above (p=0.006) does not persist under the new prompt: p=0.606. Success rate moved in the positive direction (15/30 → 19/30, old-system gap was 20/30 → 18/30) but isn't significant either (McNemar p=0.219). Also notable: control's *own* baseline success rate dropped from 20/30 (old prompt) to 15/30 (new prompt) — giving the solver more to read/consider isn't free even for control, exactly the "expect absolute numbers to shift" warning the investigation plan made before this campaign ran. Net honest read: no longer a significant turns win, no longer worse on success — a wash, reported as one, not spun either direction. Full transcripts: `test/demo/results/2026-07-campaign-expectmismatch-n30.txt`, `test/demo/results/2026-07-campaign-modulenotfound-n30.txt`.

### RepoQuirk: a documented negative finding

RepoQuirk fixtures (import map, barrel export, config schema drift) test the project's actual thesis — can a repo-local convention no model can know a priori be discovered once and then reused — via a read-then-edit discovery mechanism. It does not reliably reach the one-shot outcome it's meant to demonstrate.

Two distinct fixes were tried, in sequence, each validated against a pre-registered pass/fail gate before being kept:
1. **Distiller repo-fact framing** (see "What changed" above): verified directly against real fixtures that advice now states the concrete answer as fact instead of "go read and compare." This measurably improved advice *quality* but did not fix the *live outcome* — treatment still averaged more turns than control on re-test.
2. **Neutral solver prompt**: turn-by-turn instrumentation (kept in the harness — see `--verbose` output) showed 0/6 sessions matching a "wrong edit, then recover" pattern and 6/6 matching a "read anyway, then a correct edit" pattern, so the fix targeted the solver's default-to-caution system prompt instead of the distiller again. This closed part of the gap (treatment mean turns dropped below control's) but the pre-registered bar — treatment mean below control **and** at least 2 of 6 runs completing in a single turn — still failed (only 1 of 6). The same fixture with the identical advice one-shot perfectly in one run and took 4 turns in another (reading an irrelevant file twice) — high run-to-run variance, not a reliable mechanism.

This connects to a risk already named in the project's risk register: "rule injection pollutes model context." The evidence here doesn't show pollution exactly — treatment never fails *because* of the rule — but it does show the rule failing to reliably save the reads it's meant to save, which is close in spirit. RepoQuirk is therefore excluded from the campaign numbers below rather than reported as a false positive. The mechanism this scenario family is meant to demonstrate — one real session learns a convention, a later session applies it — moves to a future real-agent end-to-end demo (PRD §2.2's golden-path flow with actual post-failure injection, not this mini-harness), where the model has the full system prompt and tool surface rather than a stripped-down two-shape JSON protocol. Full transcripts of both gate attempts: `test/demo/results/2026-07-gate0v3-step2-diagnostic-n6.txt`, `test/demo/results/2026-07-gate0v3-step4-final-n6.txt`.

### Weak-model probes: a methodology lesson, not a clean result

```
LLM_PROVIDER=openai bun run test/demo/live-ab.ts --model gpt-4o-mini --runs 20 --types NullAccess,ParseError,UndefinedRef
LLM_PROVIDER=openai bun run test/demo/live-ab.ts --model gpt-5-nano --runs 20 --types NullAccess,ParseError,UndefinedRef
```

Both commands omitted `--distill-model`, which defaults to the provider's cheapest model — `gpt-5-nano`, a reasoning model, regardless of what `--model` is set to (the first run therefore paired a `gpt-4o-mini` solver with a `gpt-5-nano` distiller; the second used `gpt-5-nano` for both). Result: the *distiller* hit its own JSON-protocol floor (1000-token cap, untouched by this campaign's solver-side fix) on **44/60** (`gpt-4o-mini` run) and **43/60** (`gpt-5-nano` run) pairs — `Distillation failed ... JSON Parse error: Unexpected EOF`. Most treatment sessions in both runs never received a real rule (`rule=no`), so the aggregate control-vs-treatment numbers from these two runs are **not reported as a rule-injection result** — they mostly measure "the same weak model, twice," diluted by a minority of pairs that got real advice. This is now documented in the command block above and in code (`--help`); a follow-up run with an explicit, reliable `--distill-model` is future work, not repeated here, per the "no re-runs to chase a better number" rule this campaign held itself to. One design note for that follow-up: as currently built it still couldn't say much — the harness only distills a rule when the pair's *control* session succeeds, so on the one type where this solver has real headroom (ParseError, 4/20) almost no treatment pair would receive a rule, while the types where rules are always available (20/20) have no headroom left to show. The informative version is cross-model rule transfer — rules distilled from a strong model's episodes, injected into the weak solver's sessions — a different experimental design, deferred alongside the real-agent demo.

One legitimate finding survives the contamination, since it's about the *solver* alone, independent of whether a rule was injected: `gpt-4o-mini` solved NullAccess and UndefinedRef trivially (20/20 both arms) but struggled genuinely with ParseError (4/20 control, 2/20 treatment) — and the failure pattern was mostly real struggle, not format non-compliance (13/16 control and 14/18 treatment failures exhausted the full 5-turn budget; only 3–4 were quick single-turn rejections). `gpt-5-nano` showed no comparably sharp capability cliff across the three types, but its own numbers carry the same distiller caveat and aren't broken out further here. Full transcripts: `test/demo/results/2026-07-campaign-weakmodel-gpt4o-mini-n20.txt`, `test/demo/results/2026-07-campaign-weakmodel-gpt5-nano-n20.txt`.

## Experiment 2: cross-model rule transfer

The weak-model probes above deferred the informative version of that question: not "does a weak model's own rules help itself" (contaminated by the distiller-collapse bug), but **does a rule distilled from a strong model's (Haiku) resolved episode help a weak model (gpt-4o-mini) on a different, unseen instance of the same error class?** This is the final experiment in the v0.2 benchmark-remediation line.

`getProvider()` (`src/providers/index.ts`) is a module-level singleton fixed for the whole process by `LLM_PROVIDER` — one process can't run a Haiku seed-solver and a gpt-4o-mini transfer-solver at the same time. So this is two phases bridged by a file-based rule bank instead of one paired run:

```bash
# Phase S (plain Anthropic process): solve 3 designated seed fixtures with the strong model,
# distill a rule from each via the existing evidence path, write JSON keyed by scenario type.
bun run test/demo/live-ab.ts --emit-seed-rules test/demo/seed-rules/

# Phase T (OpenAI process): skip per-pair distillation, load the pre-seeded rule for this type,
# exclude its seed instance from the run rotation, inject at whatever match level actually
# computes (not forced to 'fine').
LLM_PROVIDER=openai bun run test/demo/live-ab.ts --model gpt-4o-mini \
  --seed-rules test/demo/seed-rules/ --types ParseError --runs 20
```

**Pre-registered before Phase T** (written into each result file's header, unedited since): primary endpoint = ParseError success rate (exact McNemar); secondary = turns/token deltas plus ExpectMismatch; NullAccess as a negative control (expected null — a large change there would indicate a harness artifact, not transfer). Significant lift on the primary endpoint was pre-worded as "cross-model transfer demonstrated"; a null result as "injection transfers knowledge, not skill — capability floors persist."

```
=== ParseError (primary, n=20) ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 4.3 ± 1.3     | 2.0 ± 0.0     | -40% ± 50%    | 0.000   |
| Success rate    | 2/20          | 20/20         | —             | 0.000   |

=== ExpectMismatch (secondary, n=20) ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 3.4 ± 1.6     | 3.3 ± 1.8     | +36% ± 137%   | 0.921   |
| Success rate    | 11/20         | 8/20          | —             | 0.453   |

=== NullAccess (negative control, n=10) ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 1.0 ± 0.0     | 1.0 ± 0.0     | +0% ± 0%      | 1.000   |
| Success rate    | 10/10         | 10/10         | —             | 1.000   |
```

**Cross-model transfer demonstrated on the primary endpoint** — cleanly. `gpt-4o-mini` alone solves ParseError 2/20 (10%); with a rule distilled by Haiku from a *different* ParseError instance, it solves 20/20, every single run in exactly 2 turns (zero variance), p<0.001 on both turns and success rate (the harness prints 0.000). Per-turn logs show the uniform 2-turn pattern is edit→edit — the first edit does not yet pass the test, the second completes the repair — with zero read actions in the treatment arm, across all five source files in the rotation (i.e., the rule transferred at coarse match level too, not only to the seed's same-file siblings); both arms ran the identical protocol. The negative control came back exactly null as pre-registered (turns and success both tied, p=1.000) — no harness artifact is inflating the primary result.

ExpectMismatch, the secondary endpoint, is a wash (p=0.921 turns, p=0.453 success, numerically slightly worse for treatment) — not a contradiction, but a real boundary condition worth understanding. The seeded rule (see below) was diagnostically scoped to *numeric*-offset arithmetic bugs (`a + b - 1` when the intent was `a + b`); ExpectMismatch's other instances include string-formatting mismatches (currency, casing, padding) that a numeric-offset-shaped rule has nothing to say about, and can plausibly distract from. ParseError's seed rule, by contrast, diagnosed a structural pattern (unclosed brace in a catch block) general enough to matter across most of that type's instances. **The takeaway isn't "ParseError transfers, ExpectMismatch doesn't" — it's that transfer quality depends on how representative the one seed instance is of the target type's actual internal diversity**, which is exactly the kind of thing a repetition gate (≥2 seed episodes before trusting a rule, still deferred to v1.0) would help with.

One mechanical nuance surfaced by the header line (`Match level: medium`, not the anticipated `coarse`): `ParseError_A2`/`ParseError_A3` happen to share the same file (`src/parser.ts`) as the seed fixture `ParseError_A1`, so they match at the *medium* level (file matches too) rather than coarse; instances in other files match at coarse. The match level is genuinely computed per pair via `findMatchingRules()`, never forced — this is real heterogeneity in the fixture set, not a bug, and it doesn't change the interpretation (medium is still not fine — no instance-specific detail from the seed carries over, only the diagnostic pattern).

Seed rule advice texts (all three reviewed before Phase T; none required re-seeding): `test/demo/seed-rules/ParseError.json`, `ExpectMismatch.json`, `NullAccess.json`. Full pre-registered transcripts: `test/demo/results/2026-07-exp2-parseerror-n20.txt`, `2026-07-exp2-expectmismatch-n20.txt`, `2026-07-exp2-nullaccess-n10.txt`. (Auditing note: the Phase T transcript headers print a `Distill model:` field — that is the per-pair default, unused in seeded mode, which performs no distillation at all (`distillation failures: 0`); actual rule provenance is recorded in the seed JSONs' `model_id` field: `claude-haiku-4-5-20251001`.)

This was the first experiment in the cross-model rule-transfer line; see Experiment 3 below for the fully-weak self-loop case.

## Experiment 3: can the weak model teach itself?

The last empty cell of the who-solves × who-distills matrix. Experiment 2 fixed the teacher at Haiku (strong) and asked whether a weak student benefits; this experiment fixes every role at gpt-4o-mini — it solves its own seed episode, distills the rule from that episode, and consumes the rule on unseen instances of the same error class. Same file-bridged seed/transfer infrastructure as Experiment 2, unchanged, except for one prerequisite fix: `runSeedMode()` previously hardcoded the distiller to `getCheapestModel()` and ignored `--types` entirely (the seed phase always emitted all three types regardless). Neither mattered for Experiment 2 — its seed phase ran in a plain Anthropic process, where `getCheapestModel()` happened to equal the intended Haiku distiller anyway — but both had to be fixed for a genuine self-loop, since under `LLM_PROVIDER=openai`, `getCheapestModel()` resolves to `gpt-5-nano`, a *different* weak model, not gpt-4o-mini.

```bash
# Phase S' (OpenAI process): gpt-4o-mini solves AND distills its own seed fixtures.
LLM_PROVIDER=openai bun run test/demo/live-ab.ts \
  --emit-seed-rules test/demo/seed-rules-selfloop/ \
  --model gpt-4o-mini --distill-model gpt-4o-mini --types ParseError,NullAccess

# Phase T' (same process): gpt-4o-mini consumes its own seed rule on unseen instances.
LLM_PROVIDER=openai bun run test/demo/live-ab.ts --model gpt-4o-mini \
  --seed-rules test/demo/seed-rules-selfloop/ --types ParseError --runs 20
```

ExpectMismatch was skipped (a wash in both prior campaigns; it wouldn't have added anything here). `NullAccess_A1` resolved on the solver's first attempt; `ParseError_A1` — the same seed instance Experiment 2 used — resolved on attempt 62/62 with gpt-4o-mini as solver (empirical rate ~1.6% for this specific fixture, well below this experiment's own ~10% pre-registered estimate). That count is disclosed as-is, not treated as a stopping condition: rules are only ever distilled from resolved episodes, however rare, and the pre-registration committed to persisting until one success. A standalone diagnostic session (outside the counted attempts) confirmed the failures are a genuine competence gap, not a harness artifact — 5/5 turns spent on distinct wrong edits to `src/parser.ts`, never a read action, no malformed responses to parse.

**Pre-registered before Phase T'** (three interpretations worded in advance, all publishable, none revising Experiment 2): near-20/20 → "full self-improvement — no stronger teacher needed"; a significant but partial lift → "self-improvement works; distiller quality amplifies it"; a null result (~2/20, matching control) → "distillation quality is the binding constraint — empirical support for the asymmetric-cost design (cheap-but-competent distiller)."

```
=== ParseError (primary, n=20) ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 4.1 ± 1.6     | 2.9 ± 0.9     | +11% ± 113%   | 0.006   |
| Success rate    | 2/20          | 11/20         | —             | 0.012   |

=== NullAccess (negative control, n=10) ===
| Metric          | Control       | Treatment     | Delta        | p-value |
|-----------------|---------------|---------------|--------------|---------|
| Turns           | 1.0 ± 0.0     | 1.0 ± 0.0     | +0% ± 0%      | 1.000   |
| Success rate    | 10/10         | 10/10         | —             | 1.000   |
```

**The middle outcome, exactly as pre-worded: self-improvement works, but distiller quality amplifies it.** gpt-4o-mini alone solves ParseError 2/20 (10%, matching this experiment's own control-arm calibration from the earlier weak-model probe); with a rule it distilled *from its own* resolved episode, it solves 11/20 (55%) on different, unseen instances — a real, statistically significant lift (exact McNemar p=0.012, turns p=0.006). But it falls well short of Experiment 2's 20/20 ceiling, where the same weak solver consumed a Haiku-distilled rule for the same scenario type. Same solver, same fixture rotation, same match level (`medium` — `ParseError_A2`/`A3` again happen to share `src/parser.ts` with the seed, as in Experiment 2); the only variable that moved between this row and Experiment 2's is who wrote the rule. The negative control came back exactly null as pre-registered (turns and success both tied at the ceiling, p=1.000). The significant token deltas on that row (p=0.000 input, p=0.002 output) are the same harmless rule-text-padding effect documented in Experiment 2 — advice text lengthens the prompt without moving turns or success — so they don't undercut the primary result.

Qualitatively, the self-distilled rule reads as real generalized diagnostic strategy, not an instance-specific restatement — but it's noticeably thinner than Haiku's. Haiku's ParseError rule named the exact structural mechanism ("the catch block is missing its closing brace... verify that every catch(...) block has a matching closing brace after its final statement"); gpt-4o-mini's names the general error class correctly ("a mismatched or missing brace in your code... unexpected end of file") but pads it with generic filler a stronger model wouldn't need ("using code linters or IDE features for auto-indentation"). That gap is consistent with an 11/20 lift being real but partial rather than either extreme.

Seed rule advice texts: `test/demo/seed-rules-selfloop/ParseError.json`, `NullAccess.json` (`model_id: gpt-4o-mini` in both, confirming the self-loop actually ran as designed). Full pre-registered transcripts: `test/demo/results/2026-07-exp3-parseerror-n20.txt`, `2026-07-exp3-nullaccess-n10.txt`. (Same auditing note as Experiment 2: the Phase T' header's `Distill model:` field is just the per-pair fallback default — it prints `gpt-5-nano` here, since `--distill-model` isn't passed to a transfer-mode run that performs no distillation at all, `distillation failures: 0`; actual rule provenance is the seed JSONs' `model_id` field.)

This was the second experiment in the cross-model rule-transfer line and closes the who-solves × who-distills matrix begun in Experiment 2: a strong teacher fully rescues a weak student (20/20); a weak teacher partially helps itself (11/20, up from a 2/20 floor). Next work is v1.0 Batch 0 (Phase 21+).
