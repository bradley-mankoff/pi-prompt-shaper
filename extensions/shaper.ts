/**
 * pi-shaper: the Shaper lifts thin typed prompts toward a consistent high-quality shape.
 *
 * This slice is the trigger. With shaping on, the Shaper asks the session's own model which of the
 * four standing elements a typed prompt carries: goal, context, constraints and done-when (see
 * GLOSSARY.md). A prompt that carries all four passes untouched and silently. A thin prompt, one
 * that leaves a standing element missing, engages the Shaper, which tells the Boss every element
 * present or missing. There is no reshape in this slice, so the prompt itself goes on as typed.
 *
 * Shaping is opt-in under the `shaper.enabled` setting, which is off when it is absent, so the
 * Tweaker's silence stays the default (pp-csw).
 *
 * The check fails open: a model that cannot be reached, or a reply that is not one report naming
 * every standing element, leaves the prompt to go on as typed and says nothing to the Boss.
 *
 * The seam is the real pi session (see tests/shaper.test.ts): this file wires pi's `input` event
 * to the Shaper, the check speaks to the session's model through `ctx.modelRegistry.streamSimple()`
 * so pi's own credentials and model choice are used, and the report reaches the Boss through
 * `ctx.ui.notify()`, the same notice the tests read.
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
 * What the Shaper asks the session's own model: read one typed prompt and report which standing
 * elements it carries. The check judges only what the prompt says. What the session already knows
 * is for the inference slice, so it cannot make a missing element present here.
 */
const CHECK_INSTRUCTIONS = `${CHECK_MARK}
Read one typed prompt and report which of its four standing elements it carries. Do not rewrite,
summarize or grade the prompt.

- goal: what the Boss wants done.
- context: the situation that aims the work: the repo or file, the error or behaviour, the branch,
  or the conversation the prompt belongs to.
- constraints: what the work must respect: what must not change, what to avoid, and limits on
  scope, technology or style.
- done-when: how anyone can tell the work is finished: the check that passes, the behaviour that
  changes, or the artifact that exists.

An element is present only when the prompt itself carries it in words. Something only the session
or the repo knows does not count, and naming the thing to work on is not context for it.

Answer with one JSON object and nothing else, one boolean per element:

{"goal": true, "context": false, "constraints": false, "done-when": false}`;

/** The text an assistant message carries, which is where the check's reply lives. */
const textOf = (message: AssistantMessage): string =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * Read the model's reply as one report per standing element, or `undefined` when it is not that.
 * A reply is usable only when it names all four elements with a boolean each, so a cut-off or
 * partial answer can never pass for a check.
 */
function readElementReport(reply: string): ElementReport[] | undefined {
	const text = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const reported = parsed as Record<string, unknown>;
	const report: ElementReport[] = [];
	for (const element of STANDING_ELEMENTS) {
		const present = reported[element];
		if (typeof present !== "boolean") return undefined;
		report.push({ element, present });
	}
	return report;
}

/**
 * The notice a report earns, or `undefined` when the Boss is to be told nothing: either the check
 * could not be read, or the prompt carries every standing element and is not thin. A thin prompt's
 * notice names every element present or missing, in the order the Boss reads them.
 */
function thinPromptNotice(report: readonly ElementReport[] | undefined): string | undefined {
	if (report === undefined || report.every(({ present }) => present)) return undefined;
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
 * Ask the session's own model which standing elements one typed prompt carries. The result is
 * total: a missing model, a failed call, or a reply that is not one report per element answers
 * `undefined`, so the caller leaves the prompt alone instead of guessing. The call names the pi
 * session's id, as pi's own requests do, because opencode's providers answer `400 MissingSessionID`
 * unless the request carries a session to route by.
 */
async function checkElements(ctx: ExtensionContext, prompt: string): Promise<ElementReport[] | undefined> {
	const model: Model<Api> | undefined = ctx.model;
	if (model === undefined) return undefined;
	try {
		const reply = await ctx.modelRegistry
			.streamSimple(model, checkContext(prompt), { sessionId: ctx.sessionManager.getSessionId() })
			.result();
		if (reply.stopReason !== "stop") return undefined;
		return readElementReport(textOf(reply));
	} catch {
		return undefined;
	}
}

export default function shaper(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Shaper's.
		if (event.text.startsWith("/")) return { action: "continue" };
		// Shaping is opt-in and off by default, so a prompt is untouched unless the Boss turned it on.
		if (!shapingEnabled(pi.getSettings())) return { action: "continue" };
		// The trigger is thinness: a prompt that carries every element passes untouched and silently,
		// while a thin one gets the elements reported. This slice has no reshape, so the prompt goes on.
		const notice = thinPromptNotice(await checkElements(ctx, event.text));
		if (notice !== undefined) ctx.ui.notify(notice, "info");
		return { action: "continue" };
	});
}
