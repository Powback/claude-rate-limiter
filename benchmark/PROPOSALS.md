# Prompt Compression Proposals

## Current state

| Component | Default tokens | Current slim | Reduction |
|-----------|-------------:|-------------:|----------:|
| System prompt | 6,892 | 259 | 96.2% |
| Tool descriptions | ~14,626 | 283 | 98.1% |
| **Total** | **~21,518** | **542** | **97.5%** |

The slim prompt is already at 2.5% of the original. Further gains are diminishing. The real problem is **behavior degradation**, not token count.

---

## Diagnosis: why stripped ≠ passthrough behavior

From benchmark data (5 tasks, run `isolated-20260329-011044`):

| Metric | Stripped | Passthrough | Delta |
|--------|--------:|----------:|------:|
| Output tokens | 21,524 | 18,153 | **+18.6%** |
| Cost | $0.138 | $0.139 | −0.5% |
| Valid | 5/5 | 5/5 | — |

The slim prompt produces **18.6% more output tokens**. Root cause: the default system prompt's `# Output efficiency` and `# Tone and style` sections (358 combined tokens) contain specific directives that reduce verbosity. The current slim has a 1-line stub. The parallel tool call instruction is also weaker.

Output token cost for haiku: $4/MTok. 3,371 extra tokens across 5 tasks = **$0.013 extra**. This nearly cancels the cache read savings from stripping.

---

## Section-by-section keepability

| Section | Default tokens | Keepability | Why |
|---------|-------------:|:-----------:|-----|
| billing header | 21 | must-keep | Anthropic injects it |
| agent SDK line | 16 | must-keep | Anthropic injects it |
| security policy (CTF/SQL) | 112 | skip | Handled by training + we're not doing security tasks |
| # System | 431 | 30 tok | Only the "tags are system info" and "parallel tool calls" parts matter |
| # Doing tasks | 834 | 50 tok | Core: read-first, scope-to-ask, no-speculation, secure |
| # Executing actions with care | 708 | 15 tok | Core: confirm destructive ops. bypassPermissions negates most of this |
| # Using your tools | 694 | 30 tok | Already handled by SLIM_TOOLS descriptions |
| # Tone and style | 176 | 40 tok | No-emoji, file:line, owner/repo#N — missing from slim |
| # Output efficiency | 182 | 50 tok | Lead-with-action, no-preamble — ROOT CAUSE of +18% output tokens |
| auto-memory | 3,570 | 15 tok | Just "memory at ~/.claude/... check MEMORY.md" |

**Minimum viable: ~230 tokens** (vs current 259). But the issue isn't total count — it's that the wrong 259 tokens were chosen.

---

## Proposals

### Proposal A: v2-fixed (recommended for deploy now)

Fix the output verbosity issue by adding proper output efficiency rules. Slight token reduction from tightening prose.

```
You are Claude, an AI coding assistant. Be concise and direct.

# Tools
Prefer dedicated tools: Read>cat, Edit>sed, Write>echo, Glob>find, Grep>rg.
Call independent tools in parallel. Chain dependent calls with &&.

# Code
Read before modifying. Scope to what's asked. No speculation, no dead-error-handling,
no comments on unchanged code. Secure: prevent XSS, injection, SQLi.

# Safety
Confirm before: rm -rf, force-push, drop tables, killing procs, pushing, PRs.
No hook bypass without explicit ask.

# Output
IMPORTANT: Lead with action, not reasoning. No preamble, no trailing summary.
One sentence if possible. If you can say it in one sentence, don't use three.

# Format
file_path:line_number for code refs. owner/repo#N for PRs/issues.
Write files relative to CWD, never absolute paths.
```

**Estimated tokens: ~194** (vs 259 current, vs 6892 default)
**Expected improvement**: eliminates the +18% output token gap

---

### Proposal B: v3-sexp (LISP/s-expression notation)

Maximally compact structural encoding. Tests whether LLMs parse structured notations for instruction-following as reliably as prose.

```lisp
;; Claude: coding assistant
(rules
  (identity "terse, action-first, no-preamble, no-reasoning, no-emoji")
  (tools
    (prefer Read>cat Edit>sed Write>echo Glob>find Grep>rg)
    (parallel :independent)
    (sequential :dependent)
    (paths :cwd-relative))
  (code
    (read-first)
    (scope :asked-only)
    (no speculation dead-errhandling unchanged-comments)
    (secure :xss :injection :sqli))
  (safety
    (confirm rm-rf force-push drop-table kill-proc push pr)
    (no-bypass git-hooks signing))
  (output
    (lead :action)
    (no preamble summary reasoning)
    (terse :one-sentence-if-possible))
  (fmt
    (code-ref "file:line")
    (pr-ref "owner/repo#N")))
```

**Estimated tokens: ~160**

**Analysis:**

Pros:
- Maximum structural clarity, zero ambiguity in rule hierarchy
- No filler tokens ("Additionally", "In general", "It is important to")
- Nested rules expressed more densely than prose lists

Cons:
- LLMs are trained on English instructions, not DSLs. LISP parsing is reliable but the mapping from parsed structure to instruction-following behavior has higher variance.
- Tokenization is inefficient for symbols: `(`, `:`, `"` each tokenize individually, reducing the character-to-token ratio advantage
- `:keywords` add tokens without strong grounding (`:xss` is not a reserved word in LLM training)
- Ambiguous precedence: does `(no speculation dead-errhandling)` mean "no speculation" AND "no dead-error-handling" or "no (speculation for dead-error-handling)"?

**Verdict**: Theoretically dense but practically risky. Instruction-following reliability degrades when format strays from training distribution. Not recommended for production without benchmarking.

---

### Proposal C: v4-grammar (BNF-like notation)

```
<agent>  = coding-assistant | terse | no-emoji | action-first | no-preamble
<tools>  = prefer{Read,Edit,Write,Glob,Grep} > {cat,sed,echo,find,rg}
         | parallel(independent) | sequential(dependent) | paths=cwd
<code>   = read-before-modify | scope=asked | no{speculation,dead-errhandling,unchanged-comments}
         | secure{xss,injection,sqli}
<safety> = confirm{rm-rf,force-push,drop-table,kill-proc,push,pr} | no-bypass{hooks,signing}
<output> = lead=action | no{preamble,summary,reasoning} | ref{file:line,owner/repo#N}
```

**Estimated tokens: ~137**

**Analysis:**

Pros:
- Even denser than s-expressions
- BNF-like syntax is well-represented in LLM training data (grammar specs, regex docs, API docs)
- `{a,b,c}` set notation is familiar from shell brace expansion and regex

Cons:
- Same instruction-following reliability concerns as v3
- `<tags>` will collide with XML tags that Claude is specifically trained to recognize
- The `|` operator in grammar means "or" which creates ambiguity (are these alternatives or additive constraints?)

**Verdict**: Interesting but the `<tag>` collision and `|` ambiguity make this worse than v3 for instruction-following.

---

### Proposal D: v5-ultradense (noun-verb prose stripped to skeleton)

```
Coding assistant. Terse. Action-first. No preamble/reasoning/summary/emoji.

Tools: Read>cat Edit>sed Write>echo Glob>find Grep>rg. Parallel independent, sequential dependent. CWD-relative paths.

Code: Read first. Scope to ask. No speculation/dead-errhandling/unchanged-comments. Secure: XSS injection SQLi.

Safety: Confirm rm-rf/force-push/drop-table/push/pr. No hook bypass.

Refs: file:line_num  owner/repo#N
```

**Estimated tokens: ~99**

**Analysis:**

This is stripped natural language — removes all grammatical connective tissue while keeping the semantic payload. Unlike LISP/BNF, this format appears heavily in LLM training data (README bullets, API docs, changelogs) and has high instruction-following reliability despite the brevity.

The risk: without explicit connectives ("Before modifying", "When referencing"), the model must infer when rules apply. This works well for universal rules (always read first) but may be missed for conditional ones.

**Verdict**: Highest compression with best reliability tradeoff. The main risk is rule applicability inference, not parsing.

---

### Proposal E: ultra-terse tool descriptions

Current slim tool descriptions (283 tokens) can be cut further without losing critical hints:

| Tool | Current | Ultra-terse |
|------|---------|------------|
| Bash | `Execute bash commands. Working dir persists. Timeout: 120s default, 600s max. Use run_in_background for long commands. Use && to chain. Prefer dedicated tools (Read/Edit/Write/Glob/Grep) over shell equivalents.` | `Shell. Dir persists. 120s/600s timeout. run_in_background avail.` |
| Read | `Read file contents. Supports images, PDFs (use pages param), notebooks. Use offset/limit for large files.` | `Read file. offset/limit for large files.` |
| Edit | `Replace exact strings in files. old_string must be unique. Read the file first. Preserves indentation.` | `Replace string. old_string must be unique. Read first.` |
| Write | `Create new files or full rewrites. Read existing files first. Prefer Edit for modifications.` | `Create/rewrite file. Prefer Edit.` |
| Glob | `Find files by pattern (e.g. "**/*.ts", "src/**/*.tsx"). Returns paths sorted by modification time.` | `Find files by glob pattern.` |
| Grep | `Search file contents with regex. Modes: files_with_matches (default), content, count. Use -i for case insensitive. Use glob/type params to filter.` | `Regex search. output_mode: files_with_matches\|content\|count.` |
| Agent | `Launch subagent for complex tasks. Types: general-purpose (default), Explore (codebase search), Plan (architecture). Use run_in_background:true for independent work.` | `Subagent. types: general\|Explore\|Plan. run_in_background avail.` |
| Skill | `Execute a skill/slash command (e.g. "commit", "review-pr"). Only use for skills listed in system messages.` | `Run slash command. Listed skills only.` |
| WebSearch | `Search the web. Returns links and summaries. Include sources in response.` | `Web search.` |
| WebFetch | `Fetch a URL and return its content.` | `Fetch URL.` |

**Current slim tool tokens: 283 → ultra-terse: ~90 tokens (−68%)**

Critical hints preserved:
- `old_string must be unique` — without this, Edit calls fail on duplicate strings
- `offset/limit for large files` — without this, Read truncates silently
- `output_mode` for Grep — users need to know modes exist
- `run_in_background` for Agent/Bash — not discoverable from schema
- `Listed skills only` — prevents hallucinated skill names

---

## Token budget comparison

| Variant | System tokens | Tool tokens | Total | vs default |
|---------|:------------:|:-----------:|:-----:|:---------:|
| Default | 6,892 | ~14,626 | ~21,518 | 100% |
| v1 current | 259 | 283 | 542 | 2.5% |
| **v2 fixed** | **194** | **283** | **477** | **2.2%** |
| v2 + ultra-terse tools | 194 | 90 | 284 | 1.3% |
| v5 ultradense | 99 | 90 | 189 | 0.9% |
| v3 sexp + ultra-terse | 160 | 90 | 250 | 1.2% |

---

## Recommendation

**Deploy now**: v2-fixed system prompt (fixes the +18% output token gap).

**Next benchmark**: test v5-ultradense + ultra-terse tools. Expected: same validity, better cost parity with passthrough.

**Don't deploy**: v3-sexp, v4-grammar — symbolic notation has unpredictable instruction-following behavior. The token savings (~80 tokens) don't justify the reliability risk. LLMs are trained on English instructions; DSL syntax for behavioral rules is out-of-distribution.

**Key insight**: The current slim is already at 2.5% of default. We've captured 97.5% of available savings. The remaining 1.2% difference (542 → 189 tokens) saves ~$0.000028 per task at haiku prices. The behavioral fix (output efficiency rules) is worth 10× more than any further compression.

---

## What symbolic notation IS good for

LISP/BNF notation is useful for:
- **Structured data** (configs, schema definitions): LLMs parse these reliably because they appear in training data in context
- **Code generation** (`(defun foo ...)` in a Lisp project)
- **Grammars** (when the grammar IS the subject)

It is NOT reliable for:
- **Behavioral instructions** where prose is the dominant training format
- **Conditional rules** where applicability inference is needed
- **Emergency fallback** — when uncertain, models default to English instruction-following patterns

The takeaway: use DSL notation for data, use dense prose for instructions.
