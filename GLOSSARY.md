# pi-prompt-shaper

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

**Question round**:
The one round of numbered questions, each with a suggested answer, that the Shaper puts to the Boss
for what neither the session nor the scout could answer; one word, yes, accepts every suggestion.
Each answer has the words the reshape's length cap leaves, and an answer that runs past them is left
out with a notice that leaves its element open.
_Avoid_: interview, clarification, follow-up questions

**Correction log**:
The one JSONL file outside every repo, under pi's data folder, where each shaped prompt, the
elements it carries, and what became of it (shaped, kept, reverted or edited) are recorded in the
record shape pi-prompterize's Correction log uses, so a later study can judge the lift.
_Avoid_: history, audit log, metrics
