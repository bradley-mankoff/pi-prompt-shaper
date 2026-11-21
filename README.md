# pi-shaper

The Shaper lifts thin typed pi prompts toward a consistent high-quality shape. It is a separate
product from [pi-prompterize](https://github.com/bradley-mankoff/pi-prompterize), which stays the
Tweaker: the Tweaker repairs typos and near-miss names silently, while the Shaper reorganizes a
thin prompt under standing headers, fills what it can from the session, and puts the result in
the editor for accept or edit.

This repository is the Shaper's own home. The package installs and loads, and with shaping on it
checks each typed prompt for the standing elements (goal, context, constraints, done-when), fills
the absent ones from what the session already knows, sends each remaining gap the session can
place to the scout agent, puts what neither of them can answer to the Boss as one round of
questions, and reshapes a short prompt whose elements are then all there under the four headers in
the editor, with the original one keystroke away. Shaping arrives one slice at a time (Epic
pp-csw).

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

This slice builds the reshape and the cascade's last resort, the question round. With the
setting on, the Shaper asks the session's own model which standing elements a typed prompt carries.
A short prompt (20 words or fewer) that leaves an element missing has the absent ones filled from
what the session already knows: the repo and branch it runs in, what the project's Beads remember,
the conversation so far, and the project's own notes (the `AGENTS.md` files pi loads). Each gap the
session can place but not fill goes to the scout agent, in a process of its own cut off after 30
seconds. The scout runs on the model its own definition names and with the read tools only: the
Shaper drops `write` and `edit` from whatever the definition names, gives it the read tools when
the definition names none of them, and tells the scout to leave no file behind. The Boss is told
while a lookup runs, and the Shaper holds no lookup tool and reads nothing itself. The scout is
told the words the reshape's cap leaves for its answer, and an answer that runs long is cut to
that budget rather than thrown away. What the scout finds fills the element. Nothing is invented: a
fill from the session is kept only when every one of its words is a whole word the session's own
sources carry, and an unsupported fill becomes a gap.

What neither the session nor the scout can answer is put to the Boss as one round of questions, in
the grilling skill's format: each question numbered, each with the answer the Shaper suggests, and
one word, yes, accepts every suggestion. The round opens in pi's dialog with the round itself and a
line to answer after it, so the Boss can also answer by number, as `Q1: ...`. The questions are
written by the session's own model, which states the facts the session has for each, and only the
elements that got through the session and the scout are asked. The round states the words each
answer has room for, since the reshape drops a shape past its length cap; an answer that runs past
that room is left out with a notice and its element stays open, rather than the Boss's words
vanishing when the shape is refused. An answer that fits fills its element, and the reshape goes on
with it: one word, yes, and the answered element reads under its header in the editor.

A short prompt whose four elements are then all there comes back under the four headers, carrying
the typed words, the session's fills, the scout's context and the Boss's answers, in the editor. A
prompt that still has a gap, because a question went unanswered, is reported element by element and
goes on exactly as it was typed, and no second round is asked. Nothing is sent until Enter; `alt+r`
puts the original words back in the editor. A reshape that changes a word or runs past the length
cap (`min(3 x the original's words, 250)`) is dropped, and the prompt goes on as typed. The default
stays silence.

Every shaped prompt goes to the Correction log: one JSONL file outside every repo, at
`~/.local/share/pi-shaper/corrections.jsonl` (or under `XDG_DATA_HOME` when it is set). It keeps
the record shape pi-prompterize's Correction log uses, so the two products can be studied together:
each record names the session, the model and thinking level, the folder and its repo facts, the
text as typed, the shaped text, and every standing element with the words and source that filled
it, and the outcome (`shaped`, `kept` or `reverted`). The shape is written when it reaches the
editor, and its outcome when the Boss accepts it or presses `alt+r`. A log that cannot be written
never stops or changes a prompt.

## What the Shaper will do

The standing elements it checks are goal, context, constraints and done-when, with task-type
extras where the type is evident: a bug carries observed-versus-expected, a feature carries
acceptance criteria. An absent element is inferred from the session where possible, sent to the
scout agent where it can be placed but not filled, and asked of the Boss only when neither works,
in one round of numbered questions with a suggested answer each. The reshaped text lands in the
editor for accept or edit, and the original is kept for revert. Of that, this slice builds the
check, the inference from the session, the scout lookup, the question round, the reshape of a
prompt whose elements are all there, the editor review and the one-key revert.

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
read that record to see the scout ran on its own model, with the read tools only, at the place the
session named, with the words the reshape's cap leaves, and the editor to see what the Shaper made
of the answer, including one that runs past that budget. The question round tests stage what the
session's model writes for the elements nothing else could answer and what the Boss types after the
round's answer line, so they read the round in the dialog, the words each answer has room for, the
shape the answers produce in the editor, and the notice that names which source filled each
element; they answer by number, with a leading no, on one line, and too long for the shape, and one
dismisses the round and checks that the questions stay open and no second round is asked. One test
follows the whole cascade: the scout answers NOT FOUND, the round asks the question, and the Boss's
answer fills the element. Every test checks what the main model received, what the Shaper said, what
it asked the session's model or the scout to do, or what it left in the editor or the round, never
how the extension is built.

## License

MIT. See [LICENSE](LICENSE).
