# pi-shaper

The Shaper lifts thin typed prompts toward a consistent high-quality shape, in its own pi package,
separate from pi-prompterize.

## Language

**Shaper**:
The pi extension in this repo, which lifts a thin typed prompt toward a consistent high-quality
shape.
_Avoid_: rewriter, enhancer, prompterize

**Tweaker**:
pi-prompterize's role in the pair: a cheap model that silently repairs typos and near-miss names,
plus the Clarity note that lets the main agent ask when a prompt is unclear.
_Avoid_: Fixer (the Tweaker's own part), pi-shaper

**Typed prompt**:
A prompt the Boss types into an interactive pi session. Prompts written by a Factory node, an
extension or RPC are not typed prompts.
_Avoid_: user input, message

**Shaping**:
The Shaper's work on a typed prompt: checking the standing elements, filling the absent ones,
reorganizing the text under headers, and offering the result in the editor for accept or edit.
_Avoid_: rewriting, enhancement

**Thin prompt**:
A typed prompt that is short, or missing one or more standing elements, so the Shaper engages.
_Avoid_: vague prompt, bad prompt

**Shaped prompt**:
A typed prompt after shaping, offered in the editor with the original kept for revert.
_Avoid_: rewritten prompt, improved prompt

**Standing elements**:
The elements every prompt is checked for: goal, context, constraints and done-when, plus a
preservation clause (nothing the Boss did not name stays out). Task-type extras apply where the
type is evident: a bug carries observed-versus-expected, a feature carries acceptance criteria.
_Avoid_: template, rubric

**Scout**:
The agent that looks up a gap the Shaper can place but cannot fill from the session.
_Avoid_: researcher, lookup agent
