# pi-shaper

The Shaper lifts thin typed pi prompts toward a consistent high-quality shape. It is a separate
product from [pi-prompterize](https://github.com/bradley-mankoff/pi-prompterize), which stays the
Tweaker: the Tweaker repairs typos and near-miss names silently, while the Shaper reorganizes a
thin prompt under standing headers, fills what it can from the session, and puts the result in
the editor for accept or edit.

This repository is the Shaper's own home. The package installs and loads, and with shaping on it
checks each typed prompt for the standing elements (goal, context, constraints, done-when), fills
the absent ones from what the session already knows, sends each remaining gap the session can
place to the scout agent, marks what the scout cannot find for a question, and reshapes a short
prompt whose elements are then all there under the four headers in the editor, with the original
one keystroke away. Shaping arrives one slice at a time (Epic pp-csw).

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

This slice builds the reshape and the cascade's first two steps, inference and the scout. With the
setting on, the Shaper asks the session's own model which standing elements a typed prompt carries.
A short prompt (20 words or fewer) that leaves an element missing has the absent ones filled from
what the session already knows: the repo and branch it runs in, what the project's Beads remember,
the conversation so far, and the project's own notes (the `AGENTS.md` files pi loads). Each gap the
session can place but not fill goes to the scout agent, which looks it up with the read tools and
the model its own definition names, in a process of its own cut off after 30 seconds; the Shaper
holds no lookup tool and reads nothing itself. What the scout finds fills the element, and what it
cannot find becomes a question, not a guess. Nothing is invented: a fill from the session is kept
only when every one of its words is a whole word the session's own sources carry, and an
unsupported fill becomes a gap. A short prompt whose four elements are then all there comes back
under the four headers, carrying the typed words, the session's fills and the scout's context, in
the editor. A prompt that still has a gap is reported element by element and goes on exactly as it
was typed. Nothing is sent until Enter; `alt+r` puts the original words back in the editor. A
reshape that changes a word or runs past the length cap (`min(3 x the original's words, 250)`) is
dropped, and the prompt goes on as typed. The default stays silence.

## What the Shaper will do

The standing elements it checks are goal, context, constraints and done-when, with task-type
extras where the type is evident: a bug carries observed-versus-expected, a feature carries
acceptance criteria. An absent element is inferred from the session where possible, sent to the
scout agent where it can be placed but not filled, and asked of the Boss only when neither works.
The reshaped text lands in the editor for accept or edit, and the original is kept for revert. Of
that, this slice builds the check, the inference from the session, the scout lookup, the marks the
question round will use, the reshape of a prompt whose elements are all there, the editor review
and the one-key revert.

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
the editor the way the Boss does, and press the revert key through pi's shortcut registry. The
inference tests stage the session a fill may come from: an earlier turn for the conversation, a git
repository with a branch, an `AGENTS.md` for the project's notes, and a `bd` memory for Beads, then
type the thin prompt. The scout tests stage the scout agent's own definition in the workspace's
agent folder and put a stand-in `pi` on the workspace's PATH, so the process the Shaper starts for
the scout is a stand-in that records how it was asked and answers with the test's finding; they
read that record to see the scout ran on its own model, with its own tools, at the place the
session named, and the editor to see what the Shaper made of the answer. Every test checks what
the main model received, what the Shaper said, what it asked the session's model or the scout to
do, or what it left in the editor, never how the extension is built.

## License

MIT. See [LICENSE](LICENSE).
