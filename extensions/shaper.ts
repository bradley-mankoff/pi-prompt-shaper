/**
 * pi-shaper: the Shaper lifts thin typed prompts toward a consistent high-quality shape.
 *
 * This slice is the cascade's first step, inference. With shaping on, the Shaper asks the session's
 * own model which of the four standing elements a typed prompt carries: goal, context, constraints
 * and done-when (see GLOSSARY.md). A short prompt that leaves an element missing has the absent
 * ones filled from what the session already knows (the repo, the conversation so far, and the
 * session's own briefing), and each gap the session cannot fill is marked for the scout, where the
 * answer can be looked up, or for a question, where it cannot. Nothing is invented: a fill survives
 * only when its words come from the session itself. A short prompt whose four elements are then all
 * there is reshaped: words moved under the four headers, put in the editor for the Boss to accept
 * or edit, never sent by itself. The original is kept, and one press of `alt+r` puts it back in the
 * editor. A prompt that still has a gap is reported element by element and goes on as typed.
 *
 * Shaping is opt-in under the `shaper.enabled` setting, which is off when it is absent, so the
 * Tweaker's silence stays the default (pp-csw).
 *
 * The check, the inference and the reshape all fail open: a model that cannot be reached, a reply
 * that is not the one asked for, a fill the session's words do not carry, or a reshape that changes
 * the words it was given or runs past the length cap leaves the prompt to go on as typed, and puts
 * nothing in the editor. A mode with no UI (print, JSON) has no editor for a shape to wait in, so
 * its prompt goes on unchecked.
 *
 * The seam is the real pi session (see tests/shaper.test.ts): this file wires pi's `input` event
 * to the Shaper, the check, the inference and the reshape speak to the session's model through
 * `ctx.modelRegistry.streamSimple()` so pi's own credentials and model choice are used, and the
 * report and the shaped text reach the Boss through `ctx.ui.notify()` and `ctx.ui.setEditorText()`,
 * the same notices and editor the tests read. The one-key revert is pi's shortcut, registered as
 * `alt+r`, and the tests press it through pi's shortcut registry.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

/** What pi's settings.json holds under the shaper key. */
type ShaperSettings = { enabled?: boolean };

/**
 * pi's effective settings as `pi.getSettings()` returns them. The alias exists because pi's own
 * `Settings` type does not name the `shaper` key and is not exported from the package.
 */
type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

/** The shaper settings pi holds, before any default is filled in. */
function shaperSettings(settings: PiSettings): ShaperSettings {
	return (settings as { shaper?: ShaperSettings }).shaper ?? {};
}

/** Whether shaping is on. It is off unless the setting says exactly `true`, so an omitted setting keeps silence. */
function shapingEnabled(settings: PiSettings): boolean {
	return shaperSettings(settings).enabled === true;
}

/** The standing elements every typed prompt is checked for, in the order the Boss reads them. */
const STANDING_ELEMENTS = ["goal", "context", "constraints", "done-when"] as const;

/** One standing element, named the way GLOSSARY.md names it. */
type StandingElement = (typeof STANDING_ELEMENTS)[number];

/** What the check's model reported about one standing element. */
type ElementReport = { element: StandingElement; present: boolean };

/** What the inference decided about one absent element: fill it, look it up, or ask about it. */
type Inference = { filled: string } | "scout" | "ask";

/**
 * Where one standing element stands after the check and the inference: carried by the prompt,
 * filled from the session, or a gap with the mark the inference gave it. Without a mark the element
 * is `missing`, which is every gap in a prompt the Shaper does not shape in this slice.
 */
type ElementState =
	| { element: StandingElement; standing: "present" | "missing" | "scout" | "ask" }
	| { element: StandingElement; standing: "filled"; words: string };

/**
 * The first line of the check's instructions, so a provider that stands in for the session's model
 * can tell the check from a prompt's own run (tests/fixtures/shaper-test-provider.ts).
 */
const CHECK_MARK = "You are the Shaper's element check.";

/**
 * What each standing element means, shared by the check and the reshape so the two calls judge
 * against the same definitions.
 */
const ELEMENT_GUIDE = `- goal: what the Boss wants done.
- context: the situation that aims the work: the repo or file, the error or behaviour, the branch,
  or the conversation the prompt belongs to.
- constraints: what the work must respect: what must not change, what to avoid, and limits on
  scope, technology or style.
- done-when: how anyone can tell the work is finished: the check that passes, the behaviour that
  changes, or the artifact that exists.`;

/**
 * What the Shaper asks the session's own model: read one typed prompt and report which standing
 * elements it carries. The check judges only what the prompt says. What the session already knows
 * is for the inference slice, so it cannot make a missing element present here.
 */
const CHECK_INSTRUCTIONS = `${CHECK_MARK}
Read one typed prompt and report which of its four standing elements it carries. Do not rewrite,
summarize or grade the prompt.

${ELEMENT_GUIDE}

An element is present only when the prompt itself carries it in words. Something only the session
or the repo knows does not count, and naming the thing to work on is not context for it.

Answer with one JSON object and nothing else, one boolean per element:

{"goal": true, "context": false, "constraints": false, "done-when": false}`;

/** The text an assistant message carries, which is where a model's reply lives. */
const textOf = (message: AssistantMessage): string =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * The one JSON object a reply carries, or `undefined` when the reply is not one. A fenced block is
 * unwrapped first because models often answer with one.
 */
function readJsonObject(reply: string): Record<string, unknown> | undefined {
	const text = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	return parsed as Record<string, unknown>;
}

/**
 * Read the model's reply as one report per standing element, or `undefined` when it is not that.
 * A reply is usable only when it names all four elements with a boolean each, so a cut-off or
 * partial answer can never pass for a check.
 */
function readElementReport(reply: string): ElementReport[] | undefined {
	const reported = readJsonObject(reply);
	if (reported === undefined) return undefined;
	const report: ElementReport[] = [];
	for (const element of STANDING_ELEMENTS) {
		const present = reported[element];
		if (typeof present !== "boolean") return undefined;
		report.push({ element, present });
	}
	return report;
}

/** The words each standing element's place in the cascade gets in the notice. */
const STANDING_WORDS: Record<ElementState["standing"], string> = {
	present: "present",
	filled: "filled from the session",
	missing: "missing",
	scout: "marked for the scout",
	ask: "marked for a question",
};

/**
 * The notice a thin prompt earns: every element's place in the cascade, in the order the Boss reads
 * them. `missing` is a gap no inference was made for, which is every gap in a long prompt.
 */
function thinPromptNotice(draft: readonly ElementState[]): string {
	const elements = draft
		.map(({ element, standing }) => `${element} ${STANDING_WORDS[standing]}`)
		.join("; ");
	return `Shaper: thin prompt. ${elements}`;
}

/** The request the check sends: its instructions and the prompt as typed, with no conversation. */
function checkContext(prompt: string): Context {
	return {
		systemPrompt: CHECK_INSTRUCTIONS,
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};
}

/**
 * Ask the session's own model one question and return what it said. The result is total: a
 * missing model, a failed call, or a reply the model stopped short of answering answers
 * `undefined`, so the caller leaves the prompt alone instead of guessing. The call names the pi
 * session's id, as pi's own requests do, because opencode's providers answer `400 MissingSessionID`
 * unless the request carries a session to route by.
 */
async function askModel(ctx: ExtensionContext, context: Context): Promise<string | undefined> {
	const model: Model<Api> | undefined = ctx.model;
	if (model === undefined) return undefined;
	try {
		const reply = await ctx.modelRegistry
			.streamSimple(model, context, { sessionId: ctx.sessionManager.getSessionId() })
			.result();
		if (reply.stopReason !== "stop") return undefined;
		return textOf(reply);
	} catch {
		return undefined;
	}
}

/**
 * Ask the session's own model which standing elements one typed prompt carries. A reply that is not
 * one report per element answers `undefined`.
 */
async function checkElements(ctx: ExtensionContext, prompt: string): Promise<ElementReport[] | undefined> {
	const reply = await askModel(ctx, checkContext(prompt));
	return reply === undefined ? undefined : readElementReport(reply);
}

/**
 * The first line of the inference's instructions, so a provider that stands in for the session's
 * model can tell the inference from the check and the reshape
 * (tests/fixtures/shaper-test-provider.ts).
 */
const INFER_MARK = "You are the Shaper's inference.";

/** The most characters of the session's conversation the inference reads. */
const SESSION_CONTEXT_MAX_CHARS = 5000;

/** The most messages of the session's conversation the inference reads. */
const SESSION_CONTEXT_MAX_MESSAGES = 8;

/** The most characters of the session's briefing, its system prompt, the inference reads. */
const BRIEFING_MAX_CHARS = 6000;

/** The text one session message carries: its string content, or the text parts of its content. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
}

/** What the conversation calls the speaker of one session message. */
function speakerOf(role: unknown): string {
	if (role === "user") return "Boss";
	if (role === "assistant") return "Assistant";
	if (role === "toolResult") return "Tool result";
	return "Session";
}

/**
 * The newest of the session's conversation, one line per message, bounded in both messages and
 * characters: the inference reads what the Boss and the agent said, and a long session must not
 * turn every thin prompt into a second full context.
 */
function conversationText(messages: readonly unknown[]): string {
	const lines: string[] = [];
	let budget = SESSION_CONTEXT_MAX_CHARS;
	for (const message of [...messages].reverse()) {
		if (lines.length >= SESSION_CONTEXT_MAX_MESSAGES || budget <= 0) break;
		if (typeof message !== "object" || message === null) continue;
		const { role, content } = message as { role?: unknown; content?: unknown };
		const text = messageText(content).trim();
		if (text === "") continue;
		const line = `${speakerOf(role)}: ${text.slice(0, budget)}`;
		budget -= line.length;
		lines.push(line);
	}
	return lines.reverse().join("\n");
}

/**
 * The session context the inference may fill from: the repo, the conversation so far, and the
 * session's briefing, which carries the project's instructions and the notes pi loads at session
 * start (AGENTS.md, Beads). The briefing keeps its tail: pi renders its own tools and rules first
 * and the project's sections after them, so the end is where what this project knows lives. The
 * branch is not here: pi exposes it only to a footer render, and looking it up is the scout's work
 * (pi-shaper-73v.4).
 */
function sessionContext(ctx: ExtensionContext): string {
	const parts = [`Repo: ${ctx.cwd}`];
	const conversation = conversationText(ctx.sessionManager.buildSessionProjection().messages);
	if (conversation !== "") parts.push(`Session so far:\n${conversation}`);
	const briefing = ctx.getSystemPrompt().trim();
	if (briefing !== "") {
		const tail = briefing.slice(-BRIEFING_MAX_CHARS);
		parts.push(`Session briefing:\n${tail}`);
	}
	return parts.join("\n\n");
}

/**
 * What the Shaper asks the session's own model: fill the elements one typed prompt lacks from what
 * the session already knows, or say where an answer can be looked up or that only the Boss can
 * answer it. The reply's fills are checked against the session context before they are used, so the
 * model is told the rule, not trusted with it.
 */
const INFER_INSTRUCTIONS = `${INFER_MARK}
Fill the standing elements one typed prompt lacks, from what the session already knows. Do not
rewrite the prompt.

${ELEMENT_GUIDE}

The session context is the repo, the conversation so far, and the session's briefing. Fill an
element only with words copied from that context: a fill has to appear in it word for word, and
nothing else is accepted. When the answer is not in the context but the session says where it
lives, mark the element for the scout, with the place to look. When neither the answer nor a place
to look is there, mark it for a question to the Boss.

Answer with one JSON object and nothing else, one entry per element the prompt lacks, keyed by the
element's name, and exactly one of these three forms per entry:

{"context": {"filled": "<words copied from the session context>"},
 "constraints": {"scout": "<where the answer can be looked up>"},
 "done-when": {"ask": "<the question to put to the Boss>"}}`;

/** The request the inference sends: its instructions, and the session context with the prompt as typed. */
function inferContext(prompt: string, context: string, absent: readonly StandingElement[]): Context {
	const text = `The prompt lacks: ${absent.join(", ")}.

${context}

Prompt as typed:
${prompt}`;
	return {
		systemPrompt: INFER_INSTRUCTIONS,
		messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
	};
}

/** Text with its whitespace collapsed and its letters lowercased: what "the same words" is judged on. */
const comparable = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/** Whether a fill is words the session already carries, in one stretch of the session context. */
const isSessionWords = (fill: string, context: string): boolean =>
	wordsOf(fill).length > 0 && comparable(context).includes(comparable(fill));

/** What the inference said about one absent element, read against the session's words. */
function inferenceFor(reported: Record<string, unknown>, element: StandingElement, context: string): Inference {
	const entry = reported[element];
	if (typeof entry !== "object" || entry === null) return "ask";
	const { filled, scout, ask } = entry as { filled?: unknown; scout?: unknown; ask?: unknown };
	// A fill the session's words do not carry is no fill: the entry falls through to its mark, and to a
	// question when it names no place, so an invented answer can never fill an element.
	if (typeof filled === "string" && isSessionWords(filled, context)) return { filled: filled.trim() };
	if (typeof scout === "string" && scout.trim() !== "") return "scout";
	if (typeof ask === "string" && ask.trim() !== "") return "ask";
	return "ask";
}

/**
 * Ask the session's own model to fill the prompt's absent elements from what the session knows. One
 * call answers for all of them, and each answer is read against the session context, so what comes
 * back is either the session's own words, a place to look, or a question. A model that cannot be
 * reached or a reply that is not one JSON object answers `undefined`, leaving every absent element
 * missing.
 */
async function inferAbsent(
	ctx: ExtensionContext,
	prompt: string,
	absent: readonly StandingElement[],
): Promise<Map<StandingElement, Inference> | undefined> {
	const context = sessionContext(ctx);
	const reply = await askModel(ctx, inferContext(prompt, context, absent));
	const reported = reply === undefined ? undefined : readJsonObject(reply);
	if (reported === undefined) return undefined;
	return new Map(absent.map((element) => [element, inferenceFor(reported, element, context)]));
}

/**
 * The state of every standing element after the check and the inference: present in the prompt,
 * filled from the session, or a gap carrying the inference's mark.
 */
function draftOf(
	report: readonly ElementReport[],
	decisions?: ReadonlyMap<StandingElement, Inference>,
): ElementState[] {
	return report.map(({ element, present }): ElementState => {
		if (present) return { element, standing: "present" };
		const decision = decisions?.get(element);
		if (decision === undefined) return { element, standing: "missing" };
		return decision === "scout" || decision === "ask"
			? { element, standing: decision }
			: { element, standing: "filled", words: decision.filled };
	});
}

/** The fills a draft carries, one per filled element, ready for the reshape. */
function fillsOf(draft: readonly ElementState[]): Partial<ShapeFields> {
	const fills: Partial<ShapeFields> = {};
	for (const state of draft) {
		if (state.standing === "filled") fills[state.element] = state.words;
	}
	return fills;
}

/**
 * The most words a short prompt may carry and still be reshaped: 20. The Spec names thinness as
 * short or missing elements and leaves the short line open; 20 words is one rushed line, and its
 * reshape budget still leaves room for the four headers.
 */
const SHORT_PROMPT_MAX_WORDS = 20;

/** How many whitespace-separated words a text carries. */
const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** Whether a typed prompt is short, the first half of what GLOSSARY.md calls a thin prompt. */
const isShort = (prompt: string): boolean => wordCount(prompt) <= SHORT_PROMPT_MAX_WORDS;

/**
 * The first line of the reshape's instructions, so a provider that stands in for the session's
 * model can tell the reshape from the check and the prompt's own run
 * (tests/fixtures/shaper-test-provider.ts).
 */
const RESHAPE_MARK = "You are the Shaper's reshape.";

/**
 * The most words a reshape may use, however long the prompt: the second half of `min(3 x, 250)`.
 * This slice reshapes only prompts of 20 words or fewer, so the three-times bound is the one a
 * reshape can hit here; the 250 bound is kept for the wider reshapes later slices allow.
 */
const SHAPE_WORD_CAP = 250;

/** The reshape's word budget: three times the prompt's words, or 250, whichever is smaller. */
const reshapeCap = (prompt: string): number => Math.min(wordCount(prompt) * 3, SHAPE_WORD_CAP);

/**
 * What the Shaper asks the session's own model: reorganize one short prompt under the four
 * standing headers without changing what it asks for. The Boss's own words are the contract: every
 * word of the prompt moves into exactly one field, and nothing is added, rephrased or explained.
 * An element the session already fills keeps the session's words and is not the model's to answer.
 * The length cap is `min(3 x the prompt's words, 250)`, borrowed from Kiro's contract (pp-csw), so
 * the reshape cannot balloon past what the Boss asked for.
 */
const reshapeInstructions = (prompt: string, filled: readonly StandingElement[]): string => {
	const budget = reshapeCap(prompt);
	// The session's fills are not answered by the model: they are the session's own words, and the
	// Shaper keeps them rather than letting a reshape reword or drop them.
	const answered = STANDING_ELEMENTS.filter((element) => !filled.includes(element));
	const filledNote =
		filled.length === 0
			? ""
			: `
The session already fills ${filled.join(", ")} with its own words. Answer only ${answered.join(", ")}:
those elements are not yours, and the shape keeps the session's words for them.
`;
	return `${RESHAPE_MARK}
Reorganize one short typed prompt under its four standing elements, using the prompt's own words.
Do not change what the prompt asks for: add no requirement, step, edge case or value that the
prompt did not name, and leave every word of it in place.
${filledNote}
${ELEMENT_GUIDE}

Each word of the prompt appears in exactly one field, unchanged. Move whole clauses under the
element they serve; do not rephrase, shorten or explain them. The reshaped prompt, headers
included, may use at most ${budget} words: three times the prompt's ${wordCount(prompt)} words, or
${SHAPE_WORD_CAP}, whichever is smaller.

Answer with one JSON object and nothing else, one string per element you answer:

{${answered.map((element) => `"${element}": "..."`).join(", ")}}`;
};

/** The four fields of a reshape, one per standing element. */
type ShapeFields = Record<StandingElement, string>;

/** The header each standing element is rendered under, in the order the Boss reads them. */
const SHAPE_HEADERS: Record<StandingElement, string> = {
	goal: "## Goal",
	context: "## Context",
	constraints: "## Constraints",
	"done-when": "## Done-when",
};

/**
 * Read the model's reshape as one string per element it was asked for, or `undefined` when it is not
 * that. A field that is absent or empty cannot carry the element it names, so the reshape is
 * unusable.
 */
function readShapeFields(
	reply: string,
	elements: readonly StandingElement[],
): Partial<ShapeFields> | undefined {
	const reported = readJsonObject(reply);
	if (reported === undefined) return undefined;
	const fields: Partial<ShapeFields> = {};
	for (const element of elements) {
		const text = reported[element];
		if (typeof text !== "string" || text.trim() === "") return undefined;
		fields[element] = text.trim();
	}
	return fields;
}

/** The shaped prompt the Boss reads: each field under its header, in the standing order. */
function renderShape(fields: ShapeFields): string {
	return STANDING_ELEMENTS.map((element) => `${SHAPE_HEADERS[element]}\n${fields[element]}`).join("\n\n");
}

/**
 * The words a text carries, lowercased and stripped of the punctuation around each word but not
 * inside it, in a stable order. A path or identifier stays one word, so the comparison notices when
 * one is dropped or invented.
 */
function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/\s+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
		.filter(Boolean)
		.sort();
}

/** Whether two texts carry the same words, each as often as the other. */
function sameWords(left: string, right: string): boolean {
	const a = wordsOf(left);
	const b = wordsOf(right);
	return a.length === b.length && a.every((word, index) => word === b[index]);
}

/** The request the reshape sends: its instructions, and the prompt as typed, with no conversation. */
function reshapeContext(prompt: string, filled: readonly StandingElement[]): Context {
	return {
		systemPrompt: reshapeInstructions(prompt, filled),
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};
}

/**
 * Ask the session's own model to reorganize one short prompt under the headers, with the elements
 * the session already fills kept as the session's words, and render the result. A missing model, a
 * failed call, a reply that does not carry a field for every element the prompt supplies, a
 * reshape that changes the words it was given, or a reshape past the length cap answers `undefined`,
 * so the caller leaves the prompt to go on as typed.
 */
async function reshape(
	ctx: ExtensionContext,
	prompt: string,
	fills: Partial<ShapeFields>,
): Promise<string | undefined> {
	const filled = STANDING_ELEMENTS.filter((element) => fills[element] !== undefined);
	const asked = STANDING_ELEMENTS.filter((element) => fills[element] === undefined);
	const fields: Partial<ShapeFields> = { ...fills };
	// With every element filled from the session there is nothing for the model to place, and the
	// shape is the session's words alone.
	if (asked.length > 0) {
		const reply = await askModel(ctx, reshapeContext(prompt, filled));
		const answered = reply === undefined ? undefined : readShapeFields(reply, asked);
		if (answered === undefined) return undefined;
		Object.assign(fields, answered);
	}
	const complete = STANDING_ELEMENTS.map((element) => fields[element]);
	if (complete.some((text) => text === undefined)) return undefined;
	const all = complete as string[];
	// The words are the contract: the fields together carry every word of the prompt and of the
	// session's fills, and no other, so a reshape cannot quietly add, drop or reword anything.
	const supplied = [prompt, ...filled.map((element) => fills[element] as string)].join(" ");
	if (!sameWords(all.join(" "), supplied)) return undefined;
	const shaped = renderShape(fields as ShapeFields);
	return wordCount(shaped) <= reshapeCap(prompt) ? shaped : undefined;
}

/** The key that puts the Boss's original words back in the editor after a reshape. */
const REVERT_KEY = "alt+r";

/** The notice after a reshape, naming the elements the session filled when it filled any. */
function shapeNotice(filled: readonly StandingElement[]): string {
	const fromSession = filled.length === 0 ? "" : ` ${filled.join(", ")} filled from the session.`;
	return `Shaper: shaped.${fromSession} ${REVERT_KEY} restores your words.`;
}

/** A shaped prompt held for the Boss: the words as typed, and the reshape shown in the editor. */
type PendingShape = { original: string; shaped: string };

export default function shaper(pi: ExtensionAPI): void {
	/** The shape waiting in the editor for the Boss to accept, edit or revert, if any. */
	let pending: PendingShape | undefined;
	/** The original a revert put back in the editor: it goes on once, unshaped. */
	let revertedText: string | undefined;

	// The one-key revert: the Boss's own words go back in the editor, and the next Enter sends them
	// as typed. The shape is dropped, so nothing the Boss did not approve can follow the revert.
	pi.registerShortcut(REVERT_KEY, {
		description: "Shaper: restore the words you typed before the reshape",
		handler: (ctx) => {
			if (pending === undefined) return;
			ctx.ui.setEditorText(pending.original);
			revertedText = pending.original;
			pending = undefined;
		},
	});

	pi.on("input", async (event, ctx) => {
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Shaper's.
		if (event.text.startsWith("/")) return { action: "continue" };
		// A shape has to wait in an editor, and print and JSON modes have none: there the prompt goes
		// on unchecked, rather than being held back with nowhere to land.
		if (!ctx.hasUI) return { action: "continue" };
		// Shaping is opt-in and off by default, so a prompt is untouched unless the Boss turned it on.
		if (!shapingEnabled(pi.getSettings())) return { action: "continue" };
		// The Boss's own shaped text coming back from the editor goes on as it stands: accepting it is
		// the send, and it is never checked or shaped a second time.
		const acceptedShape = pending !== undefined && pending.shaped === event.text;
		// A reverted original goes on once, exactly as the Boss typed it, without a second reshape.
		const revertedOriginal = revertedText !== undefined && revertedText === event.text;
		// Either way the held state has done its work; anything else is a new typed prompt, so a shape
		// left in the editor is no longer waiting.
		pending = undefined;
		revertedText = undefined;
		if (acceptedShape || revertedOriginal) return { action: "continue" };
		// A shape is text in the editor, which cannot carry the prompt's images, so a prompt with images
		// goes on as typed rather than losing them.
		if (event.images !== undefined && event.images.length > 0) return { action: "continue" };
		const report = await checkElements(ctx, event.text);
		if (report === undefined) return { action: "continue" };
		const absent = report.filter(({ present }) => !present).map(({ element }) => element);
		// A shape has to be short in this slice, so a long prompt's gaps get no inference: the reshape
		// could not carry a fill anywhere. Its elements are reported and it goes on as typed.
		if (!isShort(event.text)) {
			if (absent.length > 0) ctx.ui.notify(thinPromptNotice(draftOf(report)), "info");
			return { action: "continue" };
		}
		// The cascade's first step: the session fills what it knows, and every gap it cannot fill is
		// marked for the scout or for a question. The inference reads the repo, the conversation and the
		// session's briefing, not just the prompt.
		const decisions = absent.length === 0 ? undefined : await inferAbsent(ctx, event.text, absent);
		const draft = draftOf(report, decisions);
		// A prompt that still has a gap is reported element by element and goes on as typed.
		if (draft.some(({ standing }) => standing !== "present" && standing !== "filled")) {
			ctx.ui.notify(thinPromptNotice(draft), "info");
			return { action: "continue" };
		}
		const fills = fillsOf(draft);
		const shaped = await reshape(ctx, event.text, fills);
		if (shaped === undefined) return { action: "continue" };
		// The reshape waits in the editor for the Boss; returning handled keeps it from sending itself.
		pending = { original: event.text, shaped };
		ctx.ui.setEditorText(shaped);
		const filled = draft.flatMap((state) => (state.standing === "filled" ? [state.element] : []));
		ctx.ui.notify(shapeNotice(filled), "info");
		return { action: "handled" };
	});
}
