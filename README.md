# pi-shaper

The Shaper lifts thin typed pi prompts toward a consistent high-quality shape. It is a separate
product from [pi-prompterize](https://github.com/bradley-mankoff/pi-prompterize), which stays the
Tweaker: the Tweaker repairs typos and near-miss names silently, while the Shaper reorganizes a
thin prompt under standing headers, fills what it can from the session, and puts the result in
the editor for accept or edit.

This repository is the Shaper's own home and, for now, its scaffold. The package installs and
loads, and every typed prompt passes through untouched. Shaping arrives one slice at a time
(Epic pp-csw).

## Install

```bash
pi install git:github.com/bradley-mankoff/pi-shaper
```

Or try it for one session without installing:

```bash
pi -e ./pi-shaper
```

## Settings

Settings live under a `shaper` key in pi's `settings.json`, either the global file
(`~/.pi/agent/settings.json`) or a project's `.pi/settings.json`:

```json
{
  "shaper": {
    "enabled": false
  }
}
```

| Setting | Default | What it means |
|---|---|---|
| `shaper.enabled` | `false` | Whether the Shaper may shape a typed prompt. Off, or absent, sends every typed prompt on exactly as it was typed. |

This slice has no shaping stage yet, so turning the setting on does not change a prompt either.
The setting is the switch the next slices build behind, and the default is silence.

## What the Shaper will do

The standing elements it will check are goal, context, constraints and done-when, with
task-type extras where the type is evident: a bug carries observed-versus-expected, a feature
carries acceptance criteria. An absent element is inferred from the session where possible, sent
to the scout agent where it can be placed but not filled, and asked of the Boss only when neither
works. The reshaped text lands in the editor for accept or edit, and the original is kept for
revert. No part of that is built in this slice.

## Development

```bash
npm test
```

The tests drive the seam the Spec names: a real pi session that loads the package, with a test
provider at the provider edge playing the session's own model. One test asks pi's resource
loader which extensions loaded and types a prompt in-process; the other loads the package
directory with the installed `pi` command. Both check what the main model received, never how
the extension is built.

## License

MIT. See [LICENSE](LICENSE).
