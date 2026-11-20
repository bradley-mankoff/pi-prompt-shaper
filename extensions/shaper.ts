/**
 * pi-shaper: the Shaper lifts thin typed prompts toward a consistent high-quality shape.
 *
 * This slice is the reshape. With shaping on, the Shaper asks the session's own model which of the
 * four standing elements a typed prompt carries: goal, context, constraints and done-when (see
 * GLOSSARY.md). A thin prompt that leaves a standing element missing gets a notice naming every
 * element present or missing. A short prompt that carries all four is reshaped: the same words,
 * moved under the four headers, put in the editor for the Boss to accept or edit, never sent by
 * itself. The original is kept, and one press of `alt+r` puts it back in the editor.
 *
 * Shaping is opt-in under the `shaper.enabled` setting, which is off when it is absent, so the
 * Tweaker's silence stays the default (pp-csw).
 *
 * The check and the reshape both fail open: a model that cannot be reached, a reply that is not the
 * one asked for, or a reshape that changes the Boss's words or runs past the length cap leaves the
 * prompt to go on as typed, and puts nothing in the editor. A mode with no UI (print, JSON) has no
 * editor for a shape to wait in, so its prompt goes on unchecked.
 *
 * The seam is the real pi session (see tests/shaper.test.ts): this file wires pi's `input` event
 * to the Shaper, the check and the reshape speak to the session's model through
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

/**
 * The notice a thin prompt earns: every element present or missing, in the order the Boss reads
 * them. The caller only asks for it when an element is missing.
 */
function thinPromptNotice(report: readonly ElementReport[]): string {
	const elements = report.map(({ element, present }) => `${element} ${present ? "present" : "missing"}`).join("; ");
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
 * The length cap is `min(3 x the prompt's words, 250)`, borrowed from Kiro's contract (pp-csw), so
 * the reshape cannot balloon past what the Boss asked for.
 */
const reshapeInstructions = (prompt: string): string => {
	const budget = reshapeCap(prompt);
	return `${RESHAPE_MARK}
Reorganize one short typed prompt under its four standing elements, using the Boss's own words.
Do not change what the prompt asks for: add no requirement, step, edge case or value that the
prompt did not name, and leave every word of it in place.

${ELEMENT_GUIDE}

Each word of the prompt appears in exactly one field, unchanged. Move whole clauses under the
element they serve; do not rephrase, shorten or explain them. The reshaped prompt, headers
included, may use at most ${budget} words: three times the prompt's ${wordCount(prompt)} words, or
${SHAPE_WORD_CAP}, whichever is smaller.

Answer with one JSON object and nothing else, one string per element:

{"goal": "...", "context": "...", "constraints": "...", "done-when": "..."}`;
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
 * Read the model's reshape as one string per standing element, or `undefined` when it is not that.
 * A field that is absent or empty cannot carry the element it names, so the reshape is unusable.
 */
function readShapeFields(reply: string): ShapeFields | undefined {
	const reported = readJsonObject(reply);
	if (reported === undefined) return undefined;
	const fields = {} as ShapeFields;
	for (const element of STANDING_ELEMENTS) {
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

/** The request the reshape sends: its instructions and the prompt as typed, with no conversation. */
function reshapeContext(prompt: string): Context {
	return {
		systemPrompt: reshapeInstructions(prompt),
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};
}

/**
 * Ask the session's own model to reorganize one short prompt under the headers, and render the
 * result. A missing model, a failed call, a reply that does not carry four fields, a reshape that
 * changes the Boss's words, or a reshape past the length cap answers `undefined`, so the caller
 * leaves the prompt to go on as typed.
 */
async function reshape(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
	const reply = await askModel(ctx, reshapeContext(prompt));
	const fields = reply === undefined ? undefined : readShapeFields(reply);
	if (fields === undefined) return undefined;
	// The Boss's words are the contract: the four fields together carry every word of the prompt and
	// no other, so a reshape cannot quietly add, drop or reword what the Boss asked for.
	if (!sameWords(STANDING_ELEMENTS.map((element) => fields[element]).join(" "), prompt)) return undefined;
	const shaped = renderShape(fields);
	return wordCount(shaped) <= reshapeCap(prompt) ? shaped : undefined;
}

/** The key that puts the Boss's original words back in the editor after a reshape. */
const REVERT_KEY = "alt+r";

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
		// A thin prompt that leaves an element missing gets the elements reported, and goes on as typed.
		if (report.some(({ present }) => !present)) {
			ctx.ui.notify(thinPromptNotice(report), "info");
			return { action: "continue" };
		}
		// A prompt that carries every element is reshaped only while it is short; a long one is already
		// in the shape the Boss chose, and passes untouched.
		if (!isShort(event.text)) return { action: "continue" };
		const shaped = await reshape(ctx, event.text);
		if (shaped === undefined) return { action: "continue" };
		// The reshape waits in the editor for the Boss; returning handled keeps it from sending itself.
		pending = { original: event.text, shaped };
		ctx.ui.setEditorText(shaped);
		ctx.ui.notify(`Shaper: shaped. ${REVERT_KEY} restores your words.`, "info");
		return { action: "handled" };
	});
}
