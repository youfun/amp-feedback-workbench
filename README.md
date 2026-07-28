# amp-feedback-workbench

Amp plugin that mirrors **pi-feedback-workbench** claim flow against `hono_feedback_duck`.

## Install

Project (recommended):

```bash
# already wired if .amp/plugins/feedback-workbench.ts exists in this monorepo
# In Amp command palette: plugins: reload
```

User-wide:

```bash
mkdir -p ~/.config/amp/plugins
ln -sfn "$(pwd)/amp-feedback-workbench/src/plugin.ts" ~/.config/amp/plugins/feedback-workbench.ts
```

Optional types:

```bash
cd amp-feedback-workbench && npm i
```

## Config

Precedence:

1. `.amp/feedback-workbench.json`
2. `.factory/feedback-workbench.json`
3. `.pi/feedback-workbench.json` (shared with Pi)
4. env `AMP_FEEDBACK_*` / `DROID_FEEDBACK_*` / `PI_FEEDBACK_*`
5. `~/.config/amp/feedback-workbench.json`

Personal Token required for claim/actions (not Project Token).

## Commands (palette category **feedback**)

| Command id | Title | Pi equivalent |
|---|---|---|
| `fb-config` | Configure workbench | `/fb-config` |
| `fb-config-show` | Show config | `/fb-config show` |
| `fb` | Pick & claim feedback | `/fb` |
| `fb-open` | Open & claim by id | `/fb-open` |
| `fb-next` | Claim next pending | `/fb-next` |
| `fb-mine` | List my claimed items | `/fb-mine` |

Flow: list/select → **claim** → download attachments → inject user message into thread → agent works → tools for `start_processing` / `submit_for_review`.

## Tools

`feedback_list` · `feedback_get` · `feedback_claim` · `feedback_start_processing` · `feedback_submit_for_review` · `feedback_add_comment` · `feedback_add_ai_analysis` · `feedback_add_link` · `feedback_current_claimed_id`

Actor type: `amp_agent` (server supports it).

## Never

- Do not mark `done` via agent — only `submit_for_review` then Web verify.
