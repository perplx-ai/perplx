# Agent Benchmark Results
*9-question coding benchmark — correctness, completeness, and code readability*

---

## Agents

Three agents were evaluated:

**Perplexity CLI** — a custom-built command-line coding agent backed by a Perplexity research layer that fetches current documentation before generating code. Built independently as a personal project.

**Codex** — OpenAI's Codex model, accessed via a standard API interface.

**Qwen 3.5 397B (Cloud)** — Alibaba's 397-billion parameter Qwen model, accessed through a Claude Code-style interface via Ollama cloud. The largest model in this comparison by parameter count.

---

## Test Suite

9 tasks drawn from real-world software engineering scenarios, weighted by difficulty. All tasks had objectively verifiable pass/fail criteria — either the code works or it doesn't.

| Tier | Weight | Questions |
|------|--------|-----------|
| Easy | 1pt | Q1, Q2, Q3 |
| Medium | 3pt | Q4, Q5, Q6 |
| Hard | 5pt | Q7, Q8, Q9 |

### Q1 — Binary search off-by-one (Easy)
A classic `while left < right` vs `while left <= right` bug causing incorrect `-1` returns on single-element arrays. Six pytest cases provided. Tests whether an agent reads failing test output and reasons about loop invariants rather than guessing.

### Q2 — Deprecated stdlib imports, Python 3.12 (Easy)
A script using `collections.Mapping`, `collections.MutableMapping`, and `distutils.util.strtobool` — all removed by Python 3.12. Tests knowledge of Python version history and PEP 632. No third-party packages permitted.

### Q3 — Broken regex email validator (Easy)
A JavaScript email validator with two regex bugs: an unescaped `.` before the TLD and a single-segment domain pattern that rejects subdomains. 12 test cases (6 valid, 6 invalid) provided. Tests careful regex reading rather than just pattern-matching on a "common" email regex.

### Q4 — Pandas 2.0 migration (Medium) ⚡
A data pipeline using `df.append()` (removed 2.0), `swapaxes()` (removed 2.1), and `fillna(method="ffill")` (deprecated 2.2). The tricky part: calling `.ffill()` on an object-dtype Series still emits a FutureWarning about silent downcasting — fixing the surface API call alone is not enough. Five assertions must pass with zero warnings. Flagged as a Perplexity research-layer advantage given the recency of the pandas 2.x migration.

### Q5 — Node.js async race condition (Medium)
An Express route with two bugs: a missing `await` on a Promise (serialized as `{}` in the JSON response) and a swallowed error in the catch block leaving clients hanging indefinitely. 20 concurrent requests must all return correct results.

### Q6 — Multi-file initialization bug (Medium)
A 3-file Python project where the database pool is initialized at import time before config loads, so `DB_URL` is `None` in tests. The bug only manifests under pytest import order, not when run directly. Four integration tests must pass. Tests codebase reasoning across files rather than within a single function.

### Q7 — SQLAlchemy 1.x → 2.0 migration (Hard) ⚡
A Flask-style app across 4 files using four removed or deprecated APIs: `session.query().get()`, raw string execution without `text()`, the legacy Query API, and `declarative_base()` from the old import path. Eight tests provided, including a subtle `test_no_orders` case requiring database isolation between test sessions. Flagged as a Perplexity research-layer advantage.

### Q8 — FastAPI async lock safety (Hard)
A shared counter endpoint with a lock acquired and released manually — not exception-safe. Any exception between `acquire()` and `release()` permanently deadlocks all future requests. The fix must pass a load test of 50 concurrent POST requests across 3 consecutive runs, each producing `sorted(counts) == list(range(1, 51))`.

### Q9 — JSON Schema cycle detection (Hard)
A recursive JSON Schema validator that enters infinite recursion on self-referencing schemas. Three new tests added: self-referencing schema, mutual recursion, and a direct `$ref` cycle. `oneOf` support also required. The solution must never infinite-recurse regardless of schema shape.

---

## Results

| | Perplexity CLI | Codex | Qwen 397B |
|---|---|---|---|
| **Overall score** | **88 / 100** | **72 / 100** | **58 / 100** |
| Q1 — Binary search | ✓ Full | ✓ Full | ✓ Full |
| Q2 — Python 3.12 | ✓ Full | ✓ Full | ✓ Full |
| Q3 — Email regex | ✓ Full (12/12) | ✓ Full (12/12) | ⚠ Partial (~10/12) |
| Q4 — Pandas 2.2 | ✓ Full | ✓ Good | ⚠ Partial |
| Q5 — Node async | ✓ Full | ✓ Full | ✓ Full |
| Q6 — Multi-file init | ✓ Full | ✗ Broken | ✗ Broken |
| Q7 — SQLAlchemy 2.0 | ✓ Full | ✓ Good | ⚠ Partial |
| Q8 — FastAPI lock | ✓ Full | ✓ Full | ⚠ Partial |
| Q9 — Cycle detection | ✓ Full | ⚠ Partial | ⚠ Partial |

---

## Performance Breakdown

### Perplexity CLI — 88/100

The strongest performer across all difficulty tiers. On easy questions it was thorough — Q1 specifically named the two failing tests by function name rather than just applying the fix, and Q2 cited PEP 632 with the exact truth-value table. On medium and hard questions the research layer paid off noticeably.

Q4 was the clearest demonstration: the agent recognized that the `swapaxes("index", "columns")` round-trip was a pure no-op and replaced it with `df.copy()`, avoiding the dtype-casting side effects that `.T` introduces. It then pre-cast columns to typed dtypes (`float64`, `pd.BooleanDtype`) before calling `.ffill()`, which is the only way to silence the FutureWarning about silent downcasting in pandas 2.2. Neither other agent reached this level of precision.

Q7 was similarly strong. The agent identified the `test_no_orders` isolation problem — where a standalone test session expects an empty database while the fixture sessions share one — and designed a "pending engine" StaticPool pattern to handle both cases. It also re-exported `init_db`/`get_session` through `db.py` to preserve compatibility with a second test file, showing genuine multi-file awareness.

Q9 used a `frozenset` for the visited-ref set rather than a mutable set, which is the correct design choice: a mutable set shared across `oneOf` branches would mark a ref as seen in branch 1 and falsely treat it as a cycle in branch 2. The `frozenset | {name}` approach creates a new object per call, keeping each branch's path independent. `oneOf` was also implemented with exact-one semantics (`sum(...) == 1`) per the JSON Schema specification.

### Codex — 72/100

Solid on easy questions and mostly correct through medium difficulty, with two notable failures at the hard tier. Code style was clean and readable throughout — concise, well-commented, no unnecessary complexity.

Q3 caught only one of the two regex bugs (the unescaped dot), missing the multi-segment domain pattern issue. This is an easy question and a meaningful miss.

Q6 failed because `pool = None` was set at module level. `test_pool_not_initialized_with_none` imports `pool` directly and accesses `pool.url`, which raises `AttributeError` on `None`. The fix worked in a happy-path sense but did not satisfy the actual test contract.

Q7 had a subtle but fatal issue: wrapping raw SQL in `text()` and calling `.scalars()` on the result returns raw row tuples, not mapped `Product` objects. `results[0].name` therefore raises `AttributeError`. `sessionmaker(bind=engine)` also remained in place, which is deprecated in SA 2.0.

Q8's endpoint fix was correct, but the load test used the deprecated `httpx` API (`app=` keyword instead of `ASGITransport`) and had no counter reset between runs — meaning runs 2 and 3 would start from a non-zero counter and fail the assertion.

### Qwen 3.5 397B — 58/100

The lowest score despite being the largest model by a significant margin. Performance was inconsistent — strong on some questions, critically broken on others. The Claude Code-style interface wrapper likely added friction that affected output quality on structured tasks.

Q4 was handled with `pd.to_numeric` and `astype("boolean")` before calling `.ffill()`, which correctly addresses the dtype issue, though more verbosely than necessary.

Q5 was the best answer in the set for that question — both bugs fixed cleanly, plus a 20-request JSON verification output was included unprompted, showing good instincts.

Q6 failed hard: `db.py` imported `from models import Base`, but `models.py` does not exist in the Q6 project. This is a hard `ImportError` before a single test runs — not a logic error, a fabricated dependency that no amount of correct reasoning can recover from.

Q9 used `any()` for `oneOf` instead of exactly-one matching, which is semantically incorrect per the JSON Schema spec. More critically, `current_data[k]` was used instead of `current_data.get(k)`, causing a `KeyError` on `test_mutual_recursion_does_not_hang` when an inner dict is missing a property key.

The scale of the model did not correlate with reliability on multi-file reasoning tasks.

---

## Code Readability

**Perplexity CLI** produced the most structured output overall. Every answer included a before/after diff, a named explanation of the root cause, and a stated result. This is partly a prompt-engineering choice — the agent was clearly designed to explain its reasoning — but it meant the answers were fully auditable without running the code. The SQLAlchemy migration answer in particular reads like documentation you would commit alongside the change.

**Codex** wrote the cleanest code of the three in terms of style — minimal, no unnecessary variables, inline comments only where genuinely needed. The trade-off is that when it was wrong, the answers looked just as confident and tidy as when it was right, making errors harder to catch at a glance.

**Qwen 397B** was inconsistent. Some answers (Q5, Q8) were tight and well-structured. Others (Q6, Q7) showed signs of context bleed — importing modules that didn't exist, mixing concerns between files in ways that suggest the model was pattern-matching on a different project structure than the one provided.

---

## Summary

The Perplexity CLI's research layer provided a genuine edge on recency-sensitive migrations (pandas 2.2, SQLAlchemy 2.0) where training-data staleness is a real liability. The gap between it and the other two agents was widest on exactly those questions, validating the core design premise. The remaining points lost were from a broken Q6 answer — fixable with a review step in the pipeline.

Codex was a reliable mid-tier performer let down by a few mechanical mistakes on hard questions. Qwen 397B underperformed relative to its size, suggesting that model scale alone does not compensate for interface overhead or prompt engineering quality on structured multi-file tasks.
