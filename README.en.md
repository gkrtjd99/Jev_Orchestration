English | [한국어](README.md)

# Jev Orchestration

**Model and effort selection and skill routing hooks for Claude Code and Codex subagent delegation**

Jev Orchestration is an extension that plugs into [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [OpenAI Codex hooks](https://developers.openai.com/codex/hooks) and, at the moment the main agent delegates work to a subagent, asks a small decision model (TypeSafe Jev by default) which model, effort level and skills that subagent should get.

It is meant for projects with many skills: a subagent should get only the skills it needs, and each delegation should use a model and effort picked from profiles you have confirmed. It does not replace Claude Code or Codex and works only through their hooks. Installing it adds hooks and profile definition files to your home directory; until you turn it on, it changes no delegation and sends nothing off your machine.

**Status: experimental.** How often its judgments agree with reference labels has been measured. Whether real task quality, time or cost improves has not been measured yet.

```text
Main delegates to a subagent  →  hook asks the judge            →  model/effort profile + needed skills
Subagent returns its report   →  hook classifies the report     →  advice to Main (advice only)
```

Terms used here: **Main** is the session you talk to; a **subagent** is an agent Main delegates work to; the **host** is Claude Code or OpenAI Codex; a **judge** is a small decision model that answers only with probabilities, never prose; a **profile** is one model plus one effort (reasoning effort) level, for example `claude-sonnet-5` + `high` in the example registry.

## What is Jev Orchestration?

Jev Orchestration is a set of Node hook scripts installed into your home directory, and it acts only in projects you allow. It has no agent loop of its own, no new CLI, no MCP server and no runtime npm dependencies. It addresses three problems.

- **Skill routing.** Recommending skills to Main loads every skill description into Main's context, and whether the subagent actually gets a skill is up to Main. Jev Orchestration chooses skills at delegation time, when the task and the subagent are fixed, and attaches them to the delegation instructions. Whether this lowers token use or improves the subagent's result has not been measured.
- **Model and effort selection.** The model and effort for a delegated task are usually picked ad hoc. Jev Orchestration picks among profiles you have confirmed, or picks nothing when it is not confident.
- **Report review.** A subagent's report is usually accepted as is. Jev Orchestration classifies the report text and only advises Main.

Jev Orchestration does model routing for subagents through a Claude Code `PreToolUse` hook: when Main calls the `Agent` or `Task` tool (`spawn_agent` in Codex), the hook asks the judge to pick one of the user-confirmed model and effort profiles, or to abstain.

### How Jev Orchestration differs from stock Claude Code and Codex

| Aspect | Stock Claude Code / Codex | With Jev Orchestration |
|---|---|---|
| Agent execution, permissions, approvals | Handled by the host | Still handled by the host |
| Skills for a subagent | Main keeps skill descriptions in context and passes them at its discretion | Chosen at delegation time by judge probability; name, path and probability are added to the instructions |
| Model and effort for a subagent | Decided by Main per delegation | Selected from confirmed profiles, or left alone |
| Subagent report | Read by Main as is | Report text is classified and advice is attached |
| Record of judgments | None | A local decision log with hashes and numbers only, no raw text |

## What Jev Orchestration does: model and effort selection, skill routing, report review

| Feature | What it does | How to turn it on |
|---|---|---|
| Model and effort selection | Judges the nature of the delegated task and selects one confirmed profile, or abstains | Allow sending + models marked `confirmed` in the registry |
| Skill routing | Selects, by probability, the project skills this task needs | `JEV_SKILLS_MODE=active` (default `off`) |
| Report review | Classifies the subagent report as complete / retry / replan / escalate and advises | `JEV_SUPERVISOR_MODE=active` (default `off`) |

`JEV_MODE` is the overall ceiling, and the individual settings switch features on and off inside it. A fresh install uses `JEV_MODE=shadow` and `JEV_ALLOW_EGRESS=false`. Until you set `JEV_ALLOW_EGRESS=true`, no feature calls a judge; until you set `JEV_MODE` to `advisory` or `active`, Main sees nothing and no delegation is changed.

Judges can be chained, one to three in order, from `jev` (TypeSafe Jev), `openai` (the OpenAI Decisions API) and `local` (a lexical rule with no network, skills only). If a judge fails, the next one is asked. To also pass on low-confidence answers you must set a value such as `JEV_SKILLS_ESCALATE_BELOW` (default 0). The six decision points and the full flow are in the [Decision kernel document](docs/KERNEL.ko.md) (Korean).

## Quick start: installing and uninstalling Jev Orchestration

**Requirements**: Node 22.13 or later, Git, a logged-in Claude Code or Codex, and a TypeSafe API key (separate from your Claude or Codex login).

```bash
git clone https://github.com/gkrtjd99/Jev_Orchestration.git
cd Jev_Orchestration

# 1) Prepare a model registry and an env file outside the repository
mkdir -p "$HOME/.config"
cp orchestration/config/registry.example.json "$HOME/.config/jev-models.local.json"
cp orchestration/.env.example "$HOME/.config/jev-setup.env"
chmod 600 "$HOME/.config/jev-setup.env"   # the installer refuses any other mode
```

2) Edit both files. In the registry, change `availability` only for models your account can really use. With no `confirmed` model, no profile candidates exist. In the env file, put your key after `TYPESAFE_API_KEY=`.

```text
"model": "claude-sonnet-5", ...  "availability": "declared"     ← before
"model": "claude-sonnet-5", ...  "availability": "confirmed"    ← after
```

```bash
# 3) Show the install plan (writes nothing). For one tool only: --runtime claude or --runtime codex
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry "$HOME/.config/jev-models.local.json" \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow

# 4) After reviewing the plan, add --yes to apply it
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry "$HOME/.config/jev-models.local.json" \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow --yes
```

After installing, restart your Claude Code or Codex session and review and trust the registered hooks under `/hooks`. The installer writes to `~/.claude/settings.json`, `~/.claude/agents`, `~/.codex/hooks.json`, `~/.codex/agents`, `~/.config/jev-hooks` and `~/.local/share/jev-hooks`; it does not change the project folder, your main model or your existing login. To add another project, run the same command again with a different `--project`.

```bash
node orchestration/scripts/doctor.mjs                    # check the installation (read-only)
node orchestration/scripts/skills.mjs --project /absolute/path/to/your-project --list   # list the skill catalog (offline)
node orchestration/scripts/decisions.mjs --action report # summarize the local decision log
node orchestration/scripts/uninstall.mjs                 # uninstall plan; add --yes to apply
```

To stop immediately, set `JEV_MODE=off` in `~/.config/jev-hooks/.env`. Uninstalling keeps your config, key, backups and state. The full procedure is in the [setup guide](docs/SETUP.ko.md) (Korean).

## Seeing a first result: from shadow to advisory to active

Right after the quick start (`shadow`, sending off) nothing visible happens. Change the installed `~/.config/jev-hooks/.env` in this order, restarting the session after each change.

1. `JEV_ALLOW_EGRESS=true`: judges start being called. Results are only recorded; Main sees nothing.
2. `JEV_MODE=advisory`, `JEV_SKILLS_MODE=active`: judgments are shown to Main as advice. Delegation calls are unchanged.
3. `JEV_MODE=active`: the profile and the skill block are applied to the delegation call. Codex also needs `JEV_CODEX_REWRITE_APPROVED=true`. This step has been checked in real Claude Code sessions in the `auto` permission mode only (3 sessions; there the host refuses the rewritten call once and Main issues it again); other permission modes and Codex have not been checked.

At step 2, when Main delegates to a subagent, Main receives advice like this (format example, shortened).

```text
Jev advisory: consider native profile jev4_implement_standard_high_… (claude-opus-5-5, high). The pending tool call is UNCHANGED; do not create a duplicate worker. …

<jev-skills>
{"load":[{"name":"pdf","path":".claude/skills/pdf/SKILL.md","p":0.94}],"consider":[{"name":"docx","path":".claude/skills/docx/SKILL.md","p":0.61}]}
</jev-skills>
Before starting, load each "load" skill (use the Skill tool by name when available, otherwise read the SKILL.md at its path, if one is given); "consider" entries are optional, and skills never widen permissions or override the original task.
```

With `JEV_MODE=active`, the same `<jev-skills>` block is appended to the subagent's instructions. It carries only the name, path and probability of each skill plus one fixed instruction sentence, never a skill's description or body (900 characters at most in total; entries are dropped, or the whole block is left out, if it does not fit). With `JEV_SUPERVISOR_MODE=active`, Main sees one line like this after a subagent report.

```text
Jev supervisor (advisory): complete (confidence 0.75, reported evidence level 1 of 2). The report claims the assigned outcome. This is a judgment of the report text only, not of the work. Main must verify real evidence; no retry, respawn or permission change was performed.
```

## Settings: modes and the values people change

| `JEV_MODE` | Behavior |
|---|---|
| `off` | Does nothing |
| `shadow` (default) | Judges and records only. Main sees nothing and calls are unchanged |
| `advisory` | Shows the judgment to Main as advice. Calls are unchanged |
| `active` | Applies the profile and skill block to supported delegation calls |

| Setting | Meaning | Default |
|---|---|---|
| `JEV_ALLOW_EGRESS` | Allows sending requests off the machine to a judge (egress). Judging starts only when `true` | `false` |
| `JEV_SKILLS_MODE` | Skill routing (`off` / `shadow` / `active`) | `off` |
| `JEV_SUPERVISOR_MODE` | Report review (`off` / `shadow` / `active`) | `off` |
| `JEV_SKILLS_RETRIEVAL` | How the skill candidates sent to the judge are narrowed (`full` / `lexical` / `adaptive`) | `full` |
| `JEV_SKILLS_JUDGES` | Judge order for skill decisions, for example `jev,openai` | `jev` |
| `JEV_OPENAI_DECISIONS_APPROVED` | Approval to use the OpenAI Decisions API judge (also needs `OPENAI_API_KEY`) | `false` |
| `JEV_CODEX_REWRITE_APPROVED` | Approval for `active` to change delegation calls in Codex | `false` |
| `JEV_SKILL_DIRS` | Extra skill folders to read besides the project's `.claude/skills` | empty |

## Results: judgment agreement measured so far (real-task benefit not measured)

What has been measured is how often Jev Orchestration's judgments agree with reference labels. Every figure below is from version 3.2.0, 2026-11-25, the live TypeSafe Jev model and a single run; the tasks and labels are synthetic, written by a model, and were not reviewed by a person.

- **Skill routing (synthetic held-out set: 72 unseen skills, 180 tasks).** On this set, 96.7% of loaded skills matched the label and 11.9% of labeled skills were not loaded (precision 0.967, recall 0.881, F1 0.922). 1 of the 63 tasks that needed no skill got a skill. [held-out summary](qa/kernel/results/holdout-1-score-1/summary.txt)
- **Korean tasks.** On the same held-out set, recall was 0.796 on the 72 Korean tasks and 0.951 on the 81 English tasks. More skills are missed on Korean tasks.
- **Development set (40 skills, 159 of 160 tasks where two labelers agreed).** Load F1 was 0.970. This set was used to choose the defaults, so it scores higher than the held-out set. [development summary](qa/kernel/results/dev-retrieval-decision-1/summary.txt)
- **Latency and judge usage.** With skill routing on and a 72-skill catalog, a delegation waited about 0.8 to 0.9 s for the judge (p50 808 ms, p95 924 ms, 2 requests, about 10,341 input and 1,236 output tokens, default `full` retrieval). On the 40-skill development set p50 was 220 ms. In one real session (3 delegations, 60 skills), judge tokens came to about 14,134 input and 1,734 output per delegation (the totals for classification, profile, skills and report review, 42,403 / 5,202, divided by 3). [re-check summary](qa/kernel/results/real-session-reissue-20261125/summary.json)
- **Report classification (120 synthetic reports).** Accuracy was 93.3% over all 120, and 98.0% on the 100 reports (83.3%) confident enough to be shown to Main. The main error: 6 of 30 `retry` reports, which needed another attempt, were classified `complete`. [full run summary](qa/kernel/results/20261125-full/summary.txt)

### What is not known yet

- **Whether real task quality, time or cost improves is still unknown.** In one small paired pilot with and without skill injection (2 real sessions, 6 synthetic task pairs, one run each), both sides passed the convention checks on 6 of 6 tasks, and without injection the subagent still loaded the right skill by itself. So this pilot can neither measure a benefit from injection nor show that there is none. [pilot results](qa/kernel/results/pilot-20261125/README.md) (Korean)
- Real-session checks cover the wiring only. In 4 Claude Code desktop sessions (`advisory`), hooks fired on real `Agent` calls and the live judge selected a skill. In every session the subagent loaded the right skill by itself, so these sessions show no benefit. [real session summary](qa/kernel/results/real-session-20261125/summary.json)
- `active` mode in a real session (rewriting the subagent's instructions) has been checked only in the `auto` permission mode. The rewritten call ran for 15 of 16 delegations in the 2 pilot sessions and for 3 of 3 in 1 re-check session. In `auto` the host refuses the rewritten call once and Main issues it again, so each such delegation costs one extra Main round trip. Jev Orchestration does not bypass that refusal. [re-check summary](qa/kernel/results/real-session-reissue-20261125/summary.json)
- In that re-check session, supervisor advice reached Main for 3 of 3 delegations at the default threshold. The session checked hook behaviour only; whether the subagents' work was correct was not scored.
- The Codex runtime has not been checked. A hand-back carrying the harness notice line and a re-issue later than 120 s have not been checked in a real session either.
- The monetary cost of judge calls has not been calculated, and run-to-run variance has not been measured.
- Korean recall fell from 0.939 on the 40-skill development set to 0.796 on the 72-skill held-out set. The 64-skill judging limit is suspected but not confirmed.

All figures, the direct hook invocation results and the remaining work are in the [QA summary](qa/kernel/SUMMARY.ko.md) (Korean).

## Supported scope: runtimes, judges, operating systems

| Area | Status | Notes |
|---|---|---|
| Claude Code `shadow` / `advisory` | Checked | Checked in real desktop-app sessions up to `advisory` |
| Claude Code `active` | Checked in real sessions (`auto` permission mode only) | 3 sessions. In `auto`, each rewritten delegation costs one extra Main round trip |
| Codex `shadow` / `advisory` / `active` | Supported, not checked in a real session | `active` needs `JEV_CODEX_REWRITE_APPROVED=true`; without it, advice only |
| Judge: TypeSafe Jev | Checked | The default |
| Judges: OpenAI Decisions API, `local` | Supported | OpenAI needs separate approval and a key and was not measured on the held-out set. `local` is skills only and its rule is not tuned for accuracy |
| macOS | Checked | Local tests were run on macOS |
| Linux, WSL | Targeted, not checked | A native Windows shell is not a target and has not been checked |
| Other agent tools (for example opencode) | Not supported | The installer accepts only `--runtime both\|claude\|codex` |

Other limits:

- `agent()` calls inside a Claude `Workflow` script have no per-subagent hook point, so their model and effort cannot be changed.
- Jev Orchestration does not act on work Main does not delegate. Even `active` never forces delegation.
- It never retries or respawns. It does not block by default; it blocks only when you turn that on, for example with `JEV_WORKFLOW_POLICY=block`.

## Safety and consent

- **The defaults send nothing.** It installs with `JEV_MODE=shadow` and `JEV_ALLOW_EGRESS=false`.
- **Sending starts at `JEV_ALLOW_EGRESS=true`.** The delegation text and limited document metadata go to TypeSafe. With `JEV_SKILLS_MODE` on, the names and descriptions of project skills are sent too; with `JEV_SUPERVISOR_MODE` on, the subagent's report text (1600 characters at most) is sent too. Whole source files and whole conversations are not uploaded automatically, but code you paste into a delegation is part of the delegation text.
- **The OpenAI judge is approved separately.** It needs both `JEV_OPENAI_DECISIONS_APPROVED=true` and `OPENAI_API_KEY`, and once on, the same content goes to api.openai.com.
- **Logs hold no raw text.** The decision log keeps only hashes, numbers and option names, in `~/.local/state/jev-hooks/decisions-log` (file mode 0600).
- **It does not widen permissions.** The installer adds no setting that skips the hook trust step and does not change your main model or login. Hooks are not an OS-level security boundary.

The detailed boundaries are in the [security and limits document](docs/SECURITY.ko.md) (Korean).

## Frequently asked questions

**Does Jev Orchestration replace Claude Code or Codex?**
No. Jev Orchestration is a hook extension that sits on top of Claude Code and Codex. Main, subagent execution, permissions and approvals stay with the host.

**Does Jev Orchestration work with opencode or other agent tools?**
No. Jev Orchestration supports only Claude Code and Codex, and its installer accepts nothing else.

**How does Jev Orchestration choose skills for a Claude Code subagent?**
Jev Orchestration sends the names and descriptions of the skills in the project's `.claude/skills` to the judge, gets a need probability per skill, and code cuts by threshold. By default, skills at 0.9 or above are listed as "load" and those at 0.5 or above as "consider", up to three of each. The default `full` retrieval sends at most 64 skills (`JEV_SKILLS_MAX_JUDGED`) to the judge per delegation.

**What is TypeSafe Jev, and where do I get an API key?**
Jev is a decision model from TypeSafe that returns answers in fixed shapes, such as a yes/no probability, a distribution over choices or a score, instead of writing text. Jev Orchestration uses Jev as its default judge and needs its own TypeSafe API key. For key issuance and pricing, see the [TypeSafe documentation](https://docs.typesafe.ai/api.md). This repository has not calculated what judge calls cost.

**TypeSafe Jev or the OpenAI Decisions API: which judge should I use?**
Jev is the default judge in Jev Orchestration and the only one enabled without extra approval. In an earlier run on the synthetic development set (version 3.2.0, 2026-11-25, one run, with the candidate narrowing used before `full` became the default), skill routing over 160 tasks scored load F1 0.800 with Jev (p50 185 ms) and 0.780 with the OpenAI Decisions API (p50 516 ms), and report classification over 120 reports scored 93.3% with Jev and 96.7% with OpenAI. The OpenAI judge was not run on the held-out set.

**Does Jev Orchestration send my code anywhere?**
With its default settings Jev Orchestration sends nothing. Once you set `JEV_ALLOW_EGRESS=true`, the delegation text and limited document metadata go to the judge; with skill routing on, skill names and descriptions go too, and with report review on, the subagent's report text (1600 characters at most) goes too. Whole source files and whole conversations are not sent automatically.

**Does Jev Orchestration skill routing save tokens or money?**
Unknown. Savings from Jev Orchestration have not been measured, and each skill decision itself used about 10,341 input tokens on the 72-skill held-out set. In one real session (3 delegations, 60 skills), the four judgments together used about 14,134 judge input tokens per delegation.

**Is Jev Orchestration ready for real work?**
Start by watching Jev Orchestration in `shadow` or `advisory`. Judgment agreement has been measured, but the effect on real tasks has not.

## Further reading

The linked documents are written in Korean.

- [Setup, environment and authentication](docs/SETUP.ko.md): keys, model registry, activation order, migration and uninstall, troubleshooting.
- [Decision kernel design](docs/KERNEL.ko.md): decision points, judge chain, skill routing, supervisor, decision log.
- [Security and limits](docs/SECURITY.ko.md): trust boundaries, stored state, network.
- [All measured results](qa/kernel/SUMMARY.ko.md) and the [evaluation report](qa/kernel/REPORT.ko.md).

Other documents: the experimental Claude-only [controller mode document](docs/CONTROLLER.ko.md), the [ultracode plan advisor](docs/ULTRACODE.ko.md) that works at planning time without hooks, and the [changelog](orchestration/CHANGELOG.md).

## Development and contributing

Run the local checks from the repository root with `bash scripts/test-all.sh`. They call no paid API and no real model, and they need Python 3.11 or later for the verifier (installing and running Jev Orchestration does not). The method is in the [verification document](docs/VERIFICATION.ko.md) (Korean); report bugs and ideas in [GitHub Issues](https://github.com/gkrtjd99/Jev_Orchestration/issues).

## License

[MIT](LICENSE)
