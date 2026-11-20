# pi-shaper

The Shaper lifts thin typed pi prompts toward a consistent high-quality shape. It is a separate
product from [pi-prompterize](https://github.com/bradley-mankoff/pi-prompterize), which stays the
Tweaker: the Tweaker repairs typos and near-miss names silently, while the Shaper reorganizes a
thin prompt under standing headers, fills what it can from the session, and puts the result in
the editor for accept or edit.

This repository is the Shaper's own home. The package installs and loads, and with shaping on it
checks each typed prompt for the standing elements (goal, context, constraints, done-when),
reports the thin ones element by element, and reshapes a short prompt that carries all four under
the four headers in the editor, with the original one keystroke away. Shaping arrives one slice at
a time (Epic pp-csw).

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

This slice builds the reshape. With the setting on, the Shaper asks the session's own model which
standing elements a typed prompt carries. A prompt with an element missing gets a notice naming
every element as present or missing, and the prompt still goes on exactly as it was typed. A short
prompt (20 words or fewer) that carries all four comes back under the four headers, carrying the
typed words and nothing else, in the editor. Nothing is sent until Enter; `alt+r` puts the original
words back in the editor. A reshape that changes a word or runs past the length cap
(`min(3 x the original's words, 250)`) is dropped, and the prompt goes on as typed. The default
stays silence.

## What the Shaper will do

The standing elements it checks are goal, context, constraints and done-when, with task-type
extras where the type is evident: a bug carries observed-versus-expected, a feature carries
acceptance criteria. An absent element is inferred from the session where possible, sent to the
scout agent where it can be placed but not filled, and asked of the Boss only when neither works.
The reshaped text lands in the editor for accept or edit, and the original is kept for revert. Of
that, this slice builds the check, the element report, and the reshape of an all-present prompt
under the headers, with the editor review and the one-key revert.

## Development

```bash
npm test
```

The tests drive the seam the Spec names: a real pi session that loads the package, with a test
provider at the provider edge playing the session's own model. One test asks pi's resource
loader which extensions loaded and types a prompt in-process; two more load the package
directory with the installed `pi` command, one with shaping off and one proving a print-mode
prompt still goes on because there is no editor to hold it. The shape tests type a prompt
in-process with a recorder standing in for the Boss's screen, so they read the Shaper's report and
the editor the way the Boss does, and press the revert key through pi's shortcut registry. Every
test checks what the main model received, what the Shaper said, or what it left in the editor,
never how the extension is built.

## License

MIT. See [LICENSE](LICENSE).
