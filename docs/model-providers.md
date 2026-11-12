# External model providers

Untether can run a task's (or a session's) Claude Code against an external provider that speaks
the **Anthropic Messages API** (`/v1/messages`), instead of the user's own Anthropic account.
It is **opt-in**: with nothing configured, nothing changes anywhere.

The key is **never** stored in `config.json`, never passed on argv, and never printed in logs,
`ut task status`, task notes, the orchestrator relays or the terminal screen capture.

## Configuration (`~/.untether/config.json`)

```jsonc
{
  "modelProviders": [
    {
      "id": "abliteration",                      // referenced as <id>:<model>; [a-z0-9-]
      "label": "Abliteration",                   // shown as "Claude · Abliteration"
      "baseUrl": "https://api.abliteration.ai",  // https only
      "keychainService": "abliteration-ai-api-key", // macOS Keychain service holding the key
      // "keyEnv": "ABLITERATION_KEY",           // …or a server environment variable instead
      "defaultModel": "abliterated-model-large-flash",
      "models": [
        { "id": "abliterated-model-large-flash", "label": "Large Flash", "alias": "sonnet", "contextTokens": 1000000 },
        { "id": "abliterated-model-large-v2",   "label": "Large v2",   "alias": "opus",   "contextTokens": 1000000 },
        { "id": "abliterated-model",            "label": "Abliterated", "alias": "haiku",  "contextTokens": 262144 }
      ],
      "pricing": "auto"                          // or { "prompt": 4e-7, "completion": 1.6e-6, "models": { … } }
    }
  ]
}
```

- **The key** is read from the macOS Keychain (`security find-generic-password -s <service> -w`)
  or from a server environment variable (`keyEnv`). A provider needs one of the two; `baseUrl`
  must be `https`.
- **`models`** is optional. Each entry may be a bare id or `{ id, label, alias, contextTokens }`.
  `alias` maps the model onto Claude Code's built-in `sonnet`/`opus`/`haiku` slot (so `/model`
  shows it under the provider's label); `contextTokens` sets the real context window.
- **`icon`** is optional: one emoji (`"🦊"`), an icon name of the app's set (`"zap"`), or the bare
  file name of an image in `~/.untether/icons/` (`"acme.png"`; `.png`, `.webp` or `.svg`, up to
  2 MB). It replaces the agent's logo in the session and task rows. Where the avatar is a project's
  logo, that logo stays and the icon is a badge in its top-left corner. Without `icon`, or with an
  unknown icon name, the rows show a discreet plug. An invalid value is ignored and the provider
  stays on.
- **`iconFallback`** is optional: one emoji or icon name, shown when the image named by `icon` is
  missing.
- With its own image or emoji the icon fills the whole avatar and the tile behind it goes away;
  the state dot stays. An icon name is a line drawing and keeps its tile.
- **`pricing`** is `"auto"` (rates fetched from `GET <baseUrl>/v1/models`, OpenRouter-like
  `pricing.prompt` / `.completion` / `.input_cache_read` per token, cached for an hour) or an
  object with flat rates plus optional per-model overrides. Missing: tokens are counted as usual.

A broken `modelProviders` entry drops the whole list (providers stay off) rather than resetting
the rest of the config.

## Launching a task

```bash
ut task new --model abliteration:abliterated-model-large-v2 "…"   # a specific model
ut task new --model abliteration: "…"                             # the provider's default model
```

The task's Claude Code session runs with `ANTHROPIC_BASE_URL` set to the provider, the key in
`ANTHROPIC_AUTH_TOKEN`, `--model`/`ANTHROPIC_MODEL` on the chosen model, the sonnet/opus/haiku
aliases (and the internal small/fast model) remapped onto provider models, and the real context
window on `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. The user's own Anthropic credentials
(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, …) are removed so the two never mix. Inside the
session, `/model` offers only the provider's models (a `modelPicker` in the task's `--settings`).

The reviews, the router and the copilot keep using the normal agent unless told otherwise. A
provider whose account is out of balance, over quota or has a bad key **pauses** the task with
the reason (no retry loop); it never falls back onto the user's own Anthropic account.

`ut task status` and the card show the provider and model.

## Cost

With a price (config or `pricing: "auto"`), a task's tokens are turned into dollars:

```bash
ut task new --model abliteration:abliterated-model-large-v2 --budget usd=5 "…"
```

`usd` is a budget limit like any other (shown only on a priced provider task); at the limit the
task is stopped with its work kept, as with the other budgets. `ut project stats` counts provider
tasks apart from the token-saving comparison and reports their number and total `$`.

## Interactive sessions

The **New Session** dialog offers, for each provider, **"Claude · &lt;label&gt;"** with a model
selector (the default model preselected). It opens a normal shielded Claude Code session with the
same environment as a task (one shared builder), shows the provider/model on its row and header,
and resumes against the same provider ("Resume Claude").

## Orchestrators

When providers are configured, a project orchestrator's brief lists them (id, label, default
model, price) and explains that "launch this with &lt;label&gt;" means
`ut task new --model <id>:<model>`. With none configured the brief is unchanged.

## Where it lives

- `web/src/types/config/model-providers.ts`, `web/src/server/services/config-service.ts` — config + schema.
- `web/src/server/services/model-providers.ts` — the one session-environment builder, key
  reader, `--model` parsing and the `/model` picker.
- `web/src/server/services/model-provider-pricing.ts` — `/v1/models` rates and `usdCost`.
- `web/src/server/services/model-provider-launch.ts` — resolves provider + key + env + picker,
  shared by the task launcher, the guard's `/model` picker and the shield restore resolver.

## Avatar icons

`avatarIcons` in `~/.untether/config.json` replaces the app's own marks in the avatars, the same
way `icon` does for a provider. It is opt-in: without it nothing changes.

```json
{
  "avatarIcons": {
    "claude": "my-claude.png",
    "codex": "🦊",
    "shell": "terminal",
    "preview": "eye-open.png",
    "previewPaused": "eye-closed.png"
  }
}
```

- Every key is optional and takes what `icon` takes: one emoji, an icon name of the app's set, or
  the bare file name of an image in `~/.untether/icons/` (`.png`, `.webp` or `.svg`, up to 2 MB,
  no folders). An invalid value is ignored on its own.
- `claude`, `codex` and `shell` apply to every avatar of that agent: rows, sidebar, cards, task
  rows, lists and the launch shortcuts. `preview` is a page preview in use and `previewPaused`
  one whose server is down.
- A key that is missing, or an image that is missing or can't be drawn, leaves the app's mark.
- A session on an external provider never uses these: the provider's `icon` goes there, or the
  app's mark when it has none.
- An image or emoji fills the avatar with no tile behind it, as with a provider. On a project's
  logo it stays the small corner mark.
- Use images with a transparent background; 256 px is plenty, up to the 96 px the avatars can
  reach. On light themes images get a soft shadow, so a pale one does not melt into the surface;
  a separate set per theme is not needed.
