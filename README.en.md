English | [한국어](README.md)

# Jev Orchestration

Jev Orchestration is a hook extension for Claude Code and Codex users that, at the moment the main agent delegates work to a subagent, asks a small decision model (TypeSafe Jev by default) which model, effort level and skills that subagent should get.

It does not run its own agent loop. Claude Code and Codex keep running the main agent, the workers, permissions and approvals as before, and Jev Orchestration only adds judgment at their native hooks. Code owns the flow and the thresholds; the decision model only returns answers as probabilities. Installing it changes nothing and sends nothing until you turn it on.

```text
Main delegates to a subagent  →  hook asks the decision model  →  model/effort profile + needed skills
Subagent returns its report   →  hook classifies the report    →  advice to Main (no retry, no blocking)
```

## What is Jev Orchestration

Jev Orchestration is a set of Node scripts that plug into Claude Code hooks and Codex hooks. It installs into your home directory (`~/.claude/settings.json`, `~/.codex/hooks.json`) and acts only in projects you allow.

- **Who it is for**: people who delegate to subagents often in Claude Code or Codex and have several skills in their project.
- **How it works**: at fixed "decision points" such as just before and just after a delegation, it asks a judge (the decision model doing the judging) for a yes/no probability, a distribution over choices, or a score distribution. It never accepts free text.
- **What it is not**: there is no new interactive CLI, no separate worker engine, no MCP server and no recursive `claude -p` or `codex exec`. The runtime has no npm dependencies.

## Why use it: model and effort selection and skill routing at delegation time

The goal of Jev Orchestration is to move three judgments around subagent delegation into code plus a small decision model.

1. **Skill routing.** Recommending skills to the main agent loads every skill description into its context, and whether the worker actually gets a skill is up to the main agent. At delegation time the task and the worker are already fixed, so skills can be chosen there and attached to the worker brief (the delegation instructions).
2. **Model and effort selection.** The model and effort for a delegated task are usually picked ad hoc. Jev Orchestration picks among profiles you have confirmed, or picks nothing when it is not confident.
3. **Report review.** A worker's report is usually accepted as is. Jev Orchestration classifies the report text and advises the main agent.

### How it differs from the stock harness (Claude Code, Codex)

| Aspect | Stock Claude Code / Codex | With Jev Orchestration |
|---|---|---|
| Agent execution, permissions, approvals | Handled by the host | Still handled by the host |
| Skills for a subagent | Main keeps skill descriptions in context and passes them at its discretion | Chosen at delegation time by judge probability; only name, path and probability are added to the brief |
| Model and effort for a subagent | Decided by Main per delegation | Selected from confirmed profiles, or left alone |
| Subagent report | Read by Main as is | Report text is classified and advice is attached |
| Record of judgments | None | A decision log with hashes and numbers only, no raw text |

## What it does: six decision points

Jev Orchestration 3.2.0 has six decision points, each switched separately to `off`, `shadow` or `active`.

| Decision point | What it does | Default |
|---|---|---|
| `delegation.classify` | Judges the role, scope, risk and reasoning level of the delegated task | active |
| `delegation.profile` | Selects one of the allowed model x effort profiles, or abstains | active |
| `delegation.skills` | Selects the project skills this task needs (skill routing) | off |
| `supervisor.outcome` | Classifies the worker report as complete / retry / replan / escalate and advises | off |
| `failure.classify` | Classifies the failure type of a failed delegation | active |
| `read.advice` | Hints on document kind and reading style when a document is read | off (`JEV_READ_ADVICE=false`) |

One delegation flows like this.

```text
Main calls a subagent delegation (Agent / Task / spawn_agent)
  │  PreToolUse hook
  ├─ delegation.classify   nature of the task ────────┐ in parallel
  ├─ delegation.skills     per-skill need probability ┘
  ├─ delegation.profile    select a model x effort profile, or abstain
  │  code applies thresholds and validation
  ├─ shadow   : record only
  ├─ advisory : show it to Main as advice
  └─ active   : apply the profile and a <jev-skills> block to the delegation call
Subagent runs (the host owns execution, permissions, approvals)
  │  PostToolUse / SubagentHandback hook
  └─ supervisor.outcome    classify the report text → advice to Main
```

Judges can be chained, one to three in order, from `jev` (TypeSafe Jev), `openai` (the OpenAI Decisions API) and `local` (a lexical rule with no network, skills only). If a judge fails or its confidence is low, the next one is asked. The full design is in the [Decision kernel document](docs/KERNEL.ko.md) (Korean).

## Quick start: installing and uninstalling Jev Orchestration

**Requirements**: Node 22.13 or later, Git, a logged-in Claude Code or Codex, and a TypeSafe API key (separate from your Claude or Codex login). Python 3.11 or later is needed only to run the verifier.

Clone the repository and run these from its root.

```bash
# 1) Local checks. No paid API and no real model is called.
bash scripts/test-all.sh

# 2) Prepare a model registry and an env file outside the repository
cp orchestration/config/registry.example.json /tmp/jev-models.local.json
mkdir -p "$HOME/.config"
cp orchestration/.env.example "$HOME/.config/jev-setup.env"
chmod 600 "$HOME/.config/jev-setup.env"   # the installer refuses any other mode
# In the registry, set availability to confirmed only for models you can really use,
# and put TYPESAFE_API_KEY in the env file.

# 3) Show the install plan (writes nothing)
node orchestration/scripts/install.mjs \
  --project /absolute/path/to/your-project --runtime both \
  --registry /tmp/jev-models.local.json \
  --env-file "$HOME/.config/jev-setup.env" --mode shadow

# 4) After reviewing the plan, add --yes to the same command to apply it
```

After installing, restart your Claude Code or Codex session and review and trust the registered hooks under `/hooks`. The installer does not change your main model or your existing login.

```bash
node orchestration/scripts/doctor.mjs                    # check the installation (read-only)
node orchestration/scripts/skills.mjs --project /absolute/path/to/your-project --list   # list the skill catalog (offline)
node orchestration/scripts/uninstall.mjs                 # uninstall plan; add --yes to apply
```

To stop immediately, set `JEV_MODE=off` in `~/.config/jev-hooks/.env`. Uninstalling keeps your config, key, backups and state. See the [setup guide](docs/SETUP.ko.md) (Korean) for keys, models and migration.

## Usage: modes and the settings people change

You use Jev Orchestration by running `claude` or `codex` in that project as usual. The hooks fire when the main agent calls a subagent delegation. One setting, `JEV_MODE`, decides the overall behavior.

| `JEV_MODE` | Behavior |
|---|---|
| `off` | Does nothing |
| `shadow` (default) | Judges and records only. Main sees nothing and calls are unchanged |
| `advisory` | Shows the judgment to Main as advice. Calls are unchanged |
| `active` | Applies the profile and skill block to supported delegation calls |
| `controller` | Experimental, Claude only. See the [controller document](docs/CONTROLLER.ko.md) (Korean) |

The recommended order is: install in `shadow` → `JEV_ALLOW_EGRESS=true` → `advisory` → `active`. Change settings in the installed `~/.config/jev-hooks/.env`.

| Setting | Meaning | Default |
|---|---|---|
| `JEV_ALLOW_EGRESS` | Whether requests may be sent to a judge. Judging starts only when `true` | `false` |
| `JEV_SKILLS_MODE` | Skill routing (`off` / `shadow` / `active`) | `off` |
| `JEV_SUPERVISOR_MODE` | Report review (`off` / `shadow` / `active`) | `off` |
| `JEV_SKILLS_RETRIEVAL` | How skill candidates are narrowed (`full` / `lexical` / `adaptive`) | `full` |
| `JEV_SKILLS_JUDGES` | Judge order for skill decisions, for example `jev,openai` | `jev` |
| `JEV_OPENAI_DECISIONS_APPROVED` | Approval to use the OpenAI Decisions API judge (also needs `OPENAI_API_KEY`) | `false` |
| `JEV_SKILL_DIRS` | Extra skill folders to read besides the project's `.claude/skills` | empty |

When skill routing is `active`, a block like this is appended to the worker brief. It carries only the name, path and probability of each skill, never its description or body (900 characters at most).

```text
<jev-skills>
{"load":[{"name":"pdf","path":".claude/skills/pdf/SKILL.md","p":0.94}],"consider":[{"name":"docx","path":".claude/skills/docx/SKILL.md","p":0.61}]}
</jev-skills>
```

## Results: what has been measured so far

What has been measured for Jev Orchestration is **how often its judgments agree with reference labels**. Every figure below is from 2026-11-25, version 3.2.0, the live TypeSafe Jev model and a single run. The tasks and labels are synthetic, written by a model, and were not reviewed by a person.

| Measurement | Result | How to read it | Evidence |
|---|---|---|---|
| Skill routing, unseen set (72 skills, 180 tasks) | load precision 0.967, recall 0.881, F1 0.922 | Selected skills are mostly right; about 12% of needed skills are missed | [held-out summary](qa/kernel/results/holdout-1-score-1/summary.txt) |
| Skill routing, development set (40 skills, 160 tasks) | load F1 0.970 | Higher because this set was used to choose the defaults | [development summary](qa/kernel/results/dev-retrieval-decision-1/summary.txt) |
| Skills wrongly injected into tasks needing none (63 held-out tasks) | 1.6% (1 task) | Unneeded skill injection is rare | [held-out summary](qa/kernel/results/holdout-1-score-1/summary.txt) |
| Recall on Korean tasks (72 held-out tasks) | 0.796 (0.951 on 81 English tasks) | More skills are missed on Korean tasks | [QA summary](qa/kernel/SUMMARY.ko.md) |
| Skill decision latency (held-out, per task) | p50 808 ms, p95 924 ms, 2 requests, about 10,341 input tokens | Each delegation adds close to a second and a judge cost | [QA summary](qa/kernel/SUMMARY.ko.md) |
| Report classification (120 synthetic reports) | accuracy 93.3%; accuracy of advice shown to Main 98.0% | `retry` was read as `complete` in 6 of 30 cases | [full run summary](qa/kernel/results/20261125-full/summary.txt) |
| 100 direct invocations of the installed hook | 212 of 214 expectations passed, 0 failed | The hook wiring behaves as expected | [hook end-to-end results](qa/kernel/results/20261125-e2e/hooks.txt) |
| 4 real Claude Code desktop sessions (`advisory`) | hook execution, skill selection and advice delivery observed | The path connects in a real session | [real session summary](qa/kernel/results/real-session-20261125/summary.json) |

### What is not known yet

- **Whether real task quality, time or cost improves has not been measured.** No paired comparison with and without skill injection has been run.
- `active` mode in a real session (rewriting the subagent brief) and the Codex runtime have not been checked.
- The monetary cost of judge calls has not been calculated, and run-to-run variance has not been measured.
- The cause of the lower Korean recall on catalogs larger than 64 skills has not been identified.

All figures and the remaining work are in the [QA summary](qa/kernel/SUMMARY.ko.md) (Korean).

## Supported scope: runtimes, judges, operating systems

| Area | Supported | Notes |
|---|---|---|
| Runtimes | Claude Code, Codex | Only these two can be installed: `--runtime both\|claude\|codex` |
| Claude Code | `shadow` / `advisory` / `active` / `controller` | Checked in real sessions only up to `advisory` in the desktop app |
| Codex | `shadow` / `advisory`; `active` after separate approval | Advice only in `active` until `JEV_CODEX_REWRITE_APPROVED=true`. Not checked in a real session |
| Judges | TypeSafe Jev, OpenAI Decisions API, `local` | Jev alone by default. OpenAI needs separate approval and a key. `local` is skills only and uncalibrated |
| Operating systems | macOS, Linux and WSL are the targets | Checks were run on macOS. Installing from a native Windows shell has not been checked |

Not supported:

- Agent tools other than Claude Code and Codex (for example opencode).
- `agent()` calls inside a Claude `Workflow` script. There is no per-worker hook point, so model and effort cannot be changed.
- Work the main agent does not delegate. Even `active` never forces delegation.
- Retrying, respawning or blocking. The supervisor only advises.

## Safety and consent

- **The defaults send nothing.** It installs with `JEV_MODE=shadow` and `JEV_ALLOW_EGRESS=false`, and the model registry yields no candidates until you mark entries `confirmed`.
- **Sending starts at `JEV_ALLOW_EGRESS=true`.** The delegation text and limited document metadata go to TypeSafe. Whole source files and whole conversations are not uploaded automatically. Code you paste into a delegation is part of the delegation text.
- **The OpenAI judge is approved separately.** It needs both `JEV_OPENAI_DECISIONS_APPROVED=true` and `OPENAI_API_KEY`.
- **Logs hold no raw text.** The decision log keeps only hashes, numbers and option names, locally (file mode 0600).
- **It does not widen permissions.** The installer registers no trust bypass and does not change your main model or login. Hooks are not an OS-level security boundary.

The detailed boundaries are in the [security and limits document](docs/SECURITY.ko.md) (Korean).

## Frequently asked questions

**Does Jev Orchestration replace Claude Code or Codex?**
No. It is a hook extension that sits on top of Claude Code and Codex. The main agent, worker execution, permissions and approvals stay with the host.

**Does it work with opencode or other agent tools?**
No. The supported runtimes are Claude Code and Codex only, and the installer accepts nothing else.

**What is Jev?**
Jev is a decision model from TypeSafe that returns answers in fixed shapes, such as a yes/no probability, a distribution over choices or a score, instead of writing text. Jev Orchestration uses it as the default judge, and it needs its own TypeSafe API key.

**Does it send my code anywhere?**
Not with the default settings. Once you set `JEV_ALLOW_EGRESS=true`, the delegation text and limited document metadata go to the judge; whole source files and whole conversations are not sent automatically.

**Does it save tokens or money?**
Unknown. Savings have not been measured, and the judge calls themselves use requests and tokens (about 10,341 input tokens per skill decision on the held-out set).

**How does it pick skills?**
It sends the catalog from the project's `.claude/skills` to the judge, gets a need probability per skill, and code cuts by threshold. Skills at 0.9 or above are listed as "load" and those at 0.5 or above as "consider", up to three of each.

**Is it ready for real work?**
Start by watching it in `shadow` or `advisory`. Judgment agreement has been measured, but the effect on real tasks has not.

## Further reading

The linked documents are written in Korean.

- [Decision kernel](docs/KERNEL.ko.md): design and verification status of the decision points, judge chain, skill routing, supervisor and decision log.
- [Setup, environment and authentication](docs/SETUP.ko.md): keys, model registry, activation order, migration and uninstall, troubleshooting.
- [Security and limits](docs/SECURITY.ko.md): trust boundaries, stored state, network.
- [Verification method](docs/VERIFICATION.ko.md): how to use the independent verifier and what its verdicts cover. Earlier results are in the [offline verification record](reports/VERIFICATION.md).
- [QA summary](qa/kernel/SUMMARY.ko.md) and [evaluation report](qa/kernel/REPORT.ko.md): all measured figures and the evaluation method.
- [Claude controller mode](docs/CONTROLLER.ko.md): rules and schema of the experimental Claude-only mode.
- [ultracode plan advisor](docs/ULTRACODE.ko.md): a separate path that consults Jev only at planning time, without hooks.
- [Comparison and integration decisions](docs/COMPARISON.ko.md): what was taken from earlier versions and what was left out.
- [Publishing scope](docs/PUBLISH.ko.md) and [changelog](orchestration/CHANGELOG.md).

## License

[MIT](LICENSE)
