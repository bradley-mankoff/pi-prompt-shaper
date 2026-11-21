/**
 * pi-shaper: the Shaper lifts thin typed prompts toward a consistent high-quality shape.
 *
 * This slice is the cascade's second step, the scout. With shaping on, the Shaper asks the session's
 * own model which of the four standing elements a typed prompt carries: goal, context, constraints
 * and done-when (see GLOSSARY.md). A short prompt that leaves an element missing has the absent
 * ones filled from what the session already knows (the repo, the branch, what the project's Beads
 * remember, the conversation so far and the project's own notes), and each gap the session can
 * place but not fill is sent to the scout agent, which looks it up with the read tools of its own
 * definition. What the scout finds fills the element with the scout's own words; what it cannot
 * find is marked for a question, never guessed. The Shaper holds no lookup of its own: it asks for
 * one, and nothing else.
 *
 * Nothing is invented: a fill from the session survives only when every word of it is a word the
 * session itself carries. A short prompt whose four elements are then all there is reshaped: words
 * moved under the four headers, put in the editor for the Boss to accept or edit, never sent by
 * itself. The original is kept, and one press of `alt+r` puts it back in the editor. A prompt that
 * still has a gap is reported element by element and goes on as typed.
 *
 * Shaping is opt-in under the `shaper.enabled` setting, which is off when it is absent, so the
 * Tweaker's silence stays the default (pp-csw).
 *
 * The check, the inference, the scout and the reshape all fail open: a model that cannot be
 * reached, a reply that is not the one asked for, a fill the session's words do not carry, a scout
 * definition that cannot be read or a scout that cannot run, or a reshape that changes the words it
 * was given or runs past the length cap leaves the prompt to go on as typed, and puts nothing in the
 * editor. A mode with no UI (print, JSON) has no editor for a shape to wait in, so its prompt goes
 * on unchecked.
 *
 * The seam is the real pi session (see tests/shaper.test.ts): this file wires pi's `input` event
 * to the Shaper, the check, the inference and the reshape speak to the session's model through
 * `ctx.modelRegistry.streamSimple()` so pi's own credentials and model choice are used, the scout
 * runs as a pi process of its own so the Shaper never holds a lookup tool, and the report and the
 * shaped text reach the Boss through `ctx.ui.notify()` and `ctx.ui.setEditorText()`, the same
 * notices and editor the tests read. The one-key revert is pi's shortcut, registered as `alt+r`,
 * and the tests press it through pi's shortcut registry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
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

/** What the inference decided about one absent element: fill it from the session, look it up, or ask about it. */
type Inference = { filled: string } | { scout: string } | "ask";

/**
 * Where one standing element stands after the check, the inference and the scout: carried by the
 * prompt, filled with words from the session or the scout, a gap with the place its answer lives,
 * or a gap to put to the Boss. Without a mark the element is `missing`, which is every gap in a
 * prompt the Shaper does not shape in this slice.
 */
type ElementState =
	| { element: StandingElement; standing: "present" | "missing" | "ask" }
	| { element: StandingElement; standing: "scout"; place: string }
	| { element: StandingElement; standing: "filled"; words: string; source: FillSource };

/** Who supplied the words an element is filled with: the session's own sources, or the scout. */
type FillSource = "session" | "scout";

/**
 * The first line of the check's instructions, so a provider that stands in for the session's model
 * can tell the check from a prompt's own run (tests/fixtures/shaper-test-provider.ts).
 */
const CHECK_MARK = "You are the Shaper's element check.";

/**
 * What each standing element means, shared by the check, the inference and the reshape so the three
 * calls judge against the same definitions.
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

/** The most characters of the project's Beads memories the inference reads. */
const BEADS_MAX_CHARS = 4000;

/** The most characters of the project's own notes the inference reads. */
const PROJECT_NOTES_MAX_CHARS = 6000;

/**
 * How long one shell read may take before the inference goes without that source. The reads are
 * extras beside the prompt, so a slow repository costs the inference its branch, never the prompt.
 */
const LOOKUP_TIMEOUT_MS = 2000;

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

/** One part of the session context: the label the model reads it under, and the source's own words. */
type SessionSource = { label: string; text: string };

/**
 * The session context the inference may fill from: the repo, the branch, what the project's Beads
 * remember, the conversation so far, and the project's own notes. The branch and the Beads need a
 * shell read in the session's folder, so gathering the context is a task rather than a string, and
 * each read that fails leaves its source out instead of failing the prompt.
 */
type SessionContext = {
	/** The reading the inference's model gets, one labelled part per source. */
	text: string;
	/** Every word the session's own sources carry, without the labels: what a fill is judged against. */
	words: ReadonlySet<string>;
};

/** A read-only command run in the session's folder, answering what it printed or `undefined`. */
type SessionRead = (command: string, args: string[]) => Promise<string | undefined>;

/**
 * Run one read-only command in the session's folder and answer what it printed, or `undefined` when
 * it cannot run: a binary that is not installed, a timeout, a non-zero exit and a throw all leave
 * the source out. The reads are extras beside the prompt, so one that fails costs the inference a
 * source and never the prompt.
 */
async function readCommand(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	cwd: string,
): Promise<string | undefined> {
	try {
		const { code, stdout } = await pi.exec(command, args, { cwd, timeout: LOOKUP_TIMEOUT_MS });
		return code === 0 ? stdout : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The branch the session is on, from git in the session's own folder, or `undefined` when the folder
 * has no repository, git is not installed, or the head is detached and there is no branch to name.
 */
async function branchOf(read: SessionRead): Promise<string | undefined> {
	const branch = (await read("git", ["branch", "--show-current"]))?.trim();
	return branch === undefined || branch === "" ? undefined : branch;
}

/**
 * What the project's Beads remember, one line per memory, or `undefined` when the folder holds no
 * Beads database. `bd memories --json` is the cheapest read that carries them: the schema version
 * beside the memories is not one of them, and a reply that is not that JSON leaves the source out.
 */
async function beadsMemories(read: SessionRead): Promise<string | undefined> {
	const output = await read("bd", ["memories", "--json"]);
	if (output === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const lines = Object.entries(parsed as Record<string, unknown>)
		.filter(([key, value]) => key !== "schema_version" && typeof value === "string")
		.map(([key, value]) => `- ${key}: ${(value as string).trim()}`);
	return lines.length === 0 ? undefined : lines.join("\n").slice(0, BEADS_MAX_CHARS);
}

/**
 * The project's own notes from the session's system prompt: the `<project_context>` section pi
 * renders from the folder's instruction files (AGENTS.md and its neighbours). pi renders its tools,
 * rules and docs before that section and its skills and working folder after it, so the section is
 * read by its tag, not by its place in the prompt: a long skills list must not push the notes out.
 */
function projectNotes(systemPrompt: string): string | undefined {
	const section = /<project_context>([\s\S]*?)<\/project_context>/.exec(systemPrompt)?.[1]?.trim();
	return section === undefined || section === "" ? undefined : section.slice(0, PROJECT_NOTES_MAX_CHARS);
}

/**
 * What the session already knows, read the one way the inference reads it and judged the one way a
 * fill is judged: the repo it runs in, the branch, what the project's Beads remember, the
 * conversation so far, and the project's own notes. The sources are labelled for the model and their
 * words are gathered without the labels, so one list feeds both the reading and the check.
 */
async function sessionContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<SessionContext> {
	const repo = ctx.cwd;
	const read: SessionRead = (command, args) => readCommand(pi, command, args, repo);
	const sources: SessionSource[] = [{ label: "Repo", text: repo }];
	const branch = await branchOf(read);
	if (branch !== undefined) sources.push({ label: "Branch", text: branch });
	const beads = await beadsMemories(read);
	if (beads !== undefined) sources.push({ label: "Beads", text: beads });
	const conversation = conversationText(ctx.sessionManager.buildSessionProjection().messages);
	if (conversation !== "") sources.push({ label: "Session so far", text: conversation });
	const notes = projectNotes(ctx.getSystemPrompt());
	if (notes !== undefined) sources.push({ label: "Project notes", text: notes });
	return {
		text: sources.map(({ label, text }) => `${label}:\n${text}`).join("\n\n"),
		words: new Set(wordsOf(sources.map(({ text }) => text).join("\n"))),
	};
}

/**
 * What the Shaper asks the session's own model: fill the elements one typed prompt lacks from what
 * the session already knows, or say where an answer can be looked up or that only the Boss can
 * answer it. The reply's fills are checked against the session's own words before they are used, so
 * the model is told the rule, not trusted with it.
 */
const INFER_INSTRUCTIONS = `${INFER_MARK}
Fill the standing elements one typed prompt lacks, from what the session already knows. Do not
rewrite the prompt.

${ELEMENT_GUIDE}

The session context is the repo, the branch, what the project's Beads remember, the conversation
so far, and the project's own notes. Fill an element only with words copied from that context:
every word of a fill must appear in it, in the same spelling, and nothing else is accepted. When
the answer is not in the context but the session says where it lives, mark the element for the
scout, with the place to look. When neither the answer nor a place to look is there, mark it for a
question to the Boss.

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

/**
 * Whether a fill is words the session's own sources carry. Every word of the fill has to be a whole
 * word of the sources, so a fill cannot be invented out of a stray substring ("e" inside the
 * briefing's "receive") and cannot borrow pi's own preamble, which is not one of the sources. The
 * words may come from more than one source, as a model filling from notes does.
 */
function isSessionWords(fill: string, carried: ReadonlySet<string>): boolean {
	const filled = wordsOf(fill);
	return filled.length > 0 && filled.every((word) => carried.has(word));
}

/** What the inference said about one absent element, read against the session's words. */
function inferenceFor(
	reported: Record<string, unknown>,
	element: StandingElement,
	carried: ReadonlySet<string>,
): Inference {
	const entry = reported[element];
	if (typeof entry !== "object" || entry === null) return "ask";
	const { filled, scout } = entry as { filled?: unknown; scout?: unknown };
	// A fill the session's words do not carry is no fill: the entry falls through to its mark, and to a
	// question when it names no place, so an invented answer can never fill an element. An entry that
	// carries only a question reaches the same mark.
	if (typeof filled === "string" && isSessionWords(filled, carried)) return { filled: filled.trim() };
	if (typeof scout === "string" && scout.trim() !== "") return { scout: scout.trim() };
	return "ask";
}

/**
 * Ask the session's own model to fill the prompt's absent elements from what the session knows. One
 * call answers for all of them, and each answer is read against the session's own words, so what
 * comes back is either a fill from those words, a place to look, or a question. A model that cannot
 * be reached or a reply that is not one JSON object decides nothing, leaving every absent element a
 * plain gap.
 */
async function inferAbsent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	absent: readonly StandingElement[],
): Promise<Map<StandingElement, Inference>> {
	const session = await sessionContext(pi, ctx);
	const reply = await askModel(ctx, inferContext(prompt, session.text, absent));
	const reported = reply === undefined ? undefined : readJsonObject(reply);
	if (reported === undefined) return new Map();
	return new Map(absent.map((element) => [element, inferenceFor(reported, element, session.words)]));
}

/**
 * The scout agent's own definition: the instructions it runs under, and the model and tools its
 * frontmatter names. The Shaper reads it from the user's agent folder, where pi keeps its agents,
 * and starts the lookup with it, so the Shaper holds no read tool and never looks a gap up itself.
 */
type ScoutDefinition = { instructions: string; model?: string; tools: string };

/** The agent a placeable gap goes to: the name its file carries in the agent folder pi reads. */
const SCOUT_AGENT = "scout";

/** The tools a scout runs with when its definition names none, so a lookup can never change a file. */
const SCOUT_READ_TOOLS = "read, bash, grep, find, ls";

/** How long one scout lookup may run before the gap goes without it. */
const SCOUT_TIMEOUT_MS = 30_000;

/** The answer the scout gives when the place it was sent to does not hold the gap's context. */
const SCOUT_NOT_FOUND = "NOT FOUND";

/** The tools an agent definition names, either as the comma-separated list pi takes or as a YAML array. */
function scoutTools(tools: unknown): string[] {
	const named = typeof tools === "string" ? tools.split(",") : Array.isArray(tools) ? tools : [];
	return named.flatMap((tool) => (typeof tool === "string" && tool.trim() !== "" ? [tool.trim()] : []));
}

/**
 * The scout agent's definition, or `undefined` when the user has no scout agent to ask. The
 * definition lives where pi looks for agents, so the scout is the one that says how a gap is looked
 * up: the Shaper never carries a copy of it.
 */
function scoutDefinition(): ScoutDefinition | undefined {
	try {
		const definition = readFileSync(join(getAgentDir(), "agents", `${SCOUT_AGENT}.md`), "utf8");
		const { frontmatter, body } = parseFrontmatter<{ model?: unknown; tools?: unknown }>(definition);
		const instructions = body.trim();
		if (instructions === "") return undefined;
		const model =
			typeof frontmatter.model === "string" && frontmatter.model.trim() !== ""
				? frontmatter.model.trim()
				: undefined;
		const tools = scoutTools(frontmatter.tools);
		return { instructions, model, tools: tools.length === 0 ? SCOUT_READ_TOOLS : tools.join(", ") };
	} catch {
		// A missing or malformed definition is no scout to ask, and never a reason the prompt cannot go on.
		return undefined;
	}
}

/** One gap the scout is asked about: the element, and the place the session said the answer lives. */
type ScoutGap = { element: StandingElement; place: string };

/** What one question to the scout came back with: the context it found, none there, or no scout to ask. */
type ScoutLookup = { found: string } | "not-found" | "unavailable";

/** The question the Shaper puts to the scout: the gap, the place to look, and the prompt it serves. */
function scoutTask(prompt: string, gap: ScoutGap): string {
	return `Look up one gap in a prompt the Boss is typing, so the gap can be filled with what the sources say instead of a guess.

The gap: ${gap.element}. Where the session says it can be looked up: ${gap.place}.

Look it up in one or two reads and answer at once. Give the context itself, copied as the sources state it, in one short paragraph. Answer exactly ${SCOUT_NOT_FOUND} when the place does not hold it.

The prompt as typed:
${prompt}`;
}

/**
 * The answer one scout run left: the first paragraph of its last message, or `undefined` when the
 * scout said nothing or said the place does not hold the gap. The first paragraph is the scout's
 * short answer, which its own instructions put first; its evidence and any findings path follow it.
 */
function scoutAnswer(output: string): string | undefined {
	let reply = "";
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof event !== "object" || event === null) continue;
		const { type, message } = event as { type?: unknown; message?: unknown };
		if (type !== "message_end" || typeof message !== "object" || message === null) continue;
		const { role, content } = message as { role?: unknown; content?: unknown };
		if (role !== "assistant") continue;
		reply = messageText(content);
	}
	const answer = reply.trim().split(/\n\s*\n/)[0]?.trim() ?? "";
	if (answer === "" || answer.toUpperCase().startsWith(SCOUT_NOT_FOUND)) return undefined;
	return answer;
}

/**
 * Ask the scout agent one question and read what it found. The lookup is a pi process of its own,
 * started with the scout's own definition, so the Shaper holds no read tool and never looks the gap
 * up itself. A missing scout agent, a failed, slow or empty run, and an answer that says the place
 * does not hold the gap all leave the element without a fill.
 */
async function askScout(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	gap: ScoutGap,
): Promise<ScoutLookup> {
	const scout = scoutDefinition();
	if (scout === undefined) return "unavailable";
	const args = ["--mode", "json", "-p", "--no-session"];
	if (scout.model !== undefined) args.push("--model", scout.model);
	args.push("--tools", scout.tools, "--append-system-prompt", scout.instructions, scoutTask(prompt, gap));
	try {
		const { code, stdout } = await pi.exec("pi", args, { cwd: ctx.cwd, timeout: SCOUT_TIMEOUT_MS });
		const answer = code === 0 ? scoutAnswer(stdout) : undefined;
		return answer === undefined ? "not-found" : { found: answer };
	} catch {
		return "not-found";
	}
}

/** The places the scout is asked about: every gap the session could place but not fill. */
function placeableGaps(states: readonly ElementState[]): ScoutGap[] {
	return states.flatMap((state) => (state.standing === "scout" ? [{ element: state.element, place: state.place }] : []));
}

/**
 * The cascade's second step: every gap the session could place but not fill goes to the scout. The
 * lookups run together, each cut off by the scout's own timeout, so a prompt with several gaps
 * waits for the slowest one rather than for all of them one after another. What the scout finds
 * fills its element; a place that does not hold the answer becomes a question; a scout that cannot
 * be asked at all leaves the gap marked for the scout, so the Boss still knows where it stands.
 */
async function placeGaps(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
	states: readonly ElementState[],
): Promise<ElementState[]> {
	const gaps = placeableGaps(states);
	if (gaps.length === 0) return [...states];
	const lookups = await Promise.all(gaps.map((gap) => askScout(pi, ctx, prompt, gap)));
	const answers = new Map(gaps.map((gap, index) => [gap.element, lookups[index]] as const));
	return states.map((state): ElementState => {
		if (state.standing !== "scout") return state;
		const lookup = answers.get(state.element);
		if (lookup === undefined || lookup === "unavailable") return state;
		if (lookup === "not-found") return { element: state.element, standing: "ask" };
		return { element: state.element, standing: "filled", words: lookup.found, source: "scout" };
	});
}

/**
 * The state of every standing element after the check and the inference: present in the prompt,
 * filled from the session, or a gap carrying the inference's mark.
 */
function statesOf(
	report: readonly ElementReport[],
	decisions?: ReadonlyMap<StandingElement, Inference>,
): ElementState[] {
	return report.map(({ element, present }): ElementState => {
		if (present) return { element, standing: "present" };
		const decision = decisions?.get(element);
		if (decision === undefined) return { element, standing: "missing" };
		if (decision === "ask") return { element, standing: "ask" };
		if ("filled" in decision) return { element, standing: "filled", words: decision.filled, source: "session" };
		return { element, standing: "scout", place: decision.scout };
	});
}

/** Whether an element is still a gap: neither carried by the prompt nor filled. */
const isGap = (state: ElementState): boolean => state.standing !== "present" && state.standing !== "filled";

/** One standing element a lookup fills, the words it fills the element with, and who supplied them. */
type Fill = { element: StandingElement; words: string; source: FillSource };

/** The fills a prompt's state carries, ready for the reshape and the notice. */
function fillsOf(states: readonly ElementState[]): Fill[] {
	return states.flatMap((state) =>
		state.standing === "filled" ? [{ element: state.element, words: state.words, source: state.source }] : [],
	);
}

/** The phrase each unfilled standing element's place in the cascade gets in the notice. */
const STANDING_PHRASES: Record<Exclude<ElementState["standing"], "filled">, string> = {
	present: "present",
	missing: "missing",
	scout: "marked for the scout",
	ask: "marked for a question",
};

/** The phrase one standing element's place in the cascade gets in the notice, fills naming their source. */
function standingPhrase(state: ElementState): string {
	if (state.standing !== "filled") return STANDING_PHRASES[state.standing];
	return state.source === "scout" ? "filled by the scout" : "filled from the session";
}

/**
 * The notice a thin prompt earns: every element's place in the cascade, in the order the Boss reads
 * them. `missing` is a gap no inference was made for, which is every gap in a long prompt.
 */
function thinPromptNotice(states: readonly ElementState[]): string {
	const elements = states.map((state) => `${state.element} ${standingPhrase(state)}`).join("; ");
	return `Shaper: thin prompt. ${elements}`;
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
 * model can tell the reshape from the check, the inference and the prompt's own run
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

/** Which standing elements the session already fills, and which are the model's to place. */
type ShapePlan = { filled: readonly StandingElement[]; toPlace: readonly StandingElement[] };

/** Split a prompt's standing elements into the session's fills and the ones left to the model. */
function planOf(fills: readonly Fill[]): ShapePlan {
	const filled = fills.map(({ element }) => element);
	return { filled, toPlace: STANDING_ELEMENTS.filter((element) => !filled.includes(element)) };
}

/**
 * What the Shaper asks the session's own model: reorganize one short prompt under the four
 * standing headers without changing what it asks for. The Boss's own words are the contract: every
 * word of the prompt moves into exactly one field, and nothing is added, rephrased or explained.
 * An element the session already fills keeps the session's words and is not the model's to answer.
 * The length cap is `min(3 x the prompt's words, 250)`, borrowed from Kiro's contract (pp-csw), so
 * the reshape cannot balloon past what the Boss asked for.
 */
const reshapeInstructions = (prompt: string, plan: ShapePlan): string => {
	const budget = reshapeCap(prompt);
	// The session's fills are not answered by the model: they are the session's own words, and the
	// Shaper keeps them rather than letting a reshape reword or drop them.
	const filledNote =
		plan.filled.length === 0
			? ""
			: `
These elements are already filled with words that are not yours to change: ${plan.filled.join(", ")}.
Answer only ${plan.toPlace.join(", ")}: the shape keeps the filled words as they stand.
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

{${plan.toPlace.map((element) => `"${element}": "..."`).join(", ")}}`;
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
function reshapeContext(prompt: string, plan: ShapePlan): Context {
	return {
		systemPrompt: reshapeInstructions(prompt, plan),
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};
}

/**
 * Whether the session's fills and the model's answers together carry every standing element, so the
 * shape can be rendered. The one place the partial record is proved complete, so no caller casts.
 */
function isCompleteShape(fields: Partial<ShapeFields>): fields is ShapeFields {
	return STANDING_ELEMENTS.every((element) => typeof fields[element] === "string");
}

/**
 * Ask the session's own model to reorganize one short prompt under the headers, with the elements
 * the session already fills kept as the session's words, and render the result. A missing model, a
 * failed call, a reply that does not carry a field for every element the model was asked for, a
 * reshape that changes the words it was given, or a reshape past the length cap answers `undefined`,
 * so the caller leaves the prompt to go on as typed.
 */
async function reshape(
	ctx: ExtensionContext,
	prompt: string,
	fills: readonly Fill[],
): Promise<string | undefined> {
	const plan = planOf(fills);
	const fields: Partial<ShapeFields> = {};
	for (const { element, words } of fills) fields[element] = words;
	// With every element filled from the session there is nothing for the model to place, and the
	// shape is the session's words alone.
	if (plan.toPlace.length > 0) {
		const reply = await askModel(ctx, reshapeContext(prompt, plan));
		const answered = reply === undefined ? undefined : readShapeFields(reply, plan.toPlace);
		if (answered === undefined) return undefined;
		Object.assign(fields, answered);
	}
	if (!isCompleteShape(fields)) return undefined;
	// The words are the contract: the fields together carry every word of the prompt and of the
	// session's fills, and no other, so a reshape cannot quietly add, drop or reword anything.
	const supplied = [prompt, ...fills.map(({ words }) => words)].join(" ");
	if (!sameWords(STANDING_ELEMENTS.map((element) => fields[element]).join(" "), supplied)) return undefined;
	const shaped = renderShape(fields);
	return wordCount(shaped) <= reshapeCap(prompt) ? shaped : undefined;
}

/** The key that puts the Boss's original words back in the editor after a reshape. */
const REVERT_KEY = "alt+r";

/** The notice after a reshape, naming the elements each source filled when any did. */
function shapeNotice(fills: readonly Fill[]): string {
	const elements = (source: FillSource): string =>
		fills.filter((fill) => fill.source === source).map(({ element }) => element).join(", ");
	const filled = [
		elements("session") === "" ? "" : `${elements("session")} filled from the session`,
		elements("scout") === "" ? "" : `${elements("scout")} filled by the scout`,
	]
		.filter(Boolean)
		.join("; ");
	return `Shaper: shaped.${filled === "" ? "" : ` ${filled}.`} ${REVERT_KEY} restores your words.`;
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
			if (absent.length > 0) ctx.ui.notify(thinPromptNotice(statesOf(report)), "info");
			return { action: "continue" };
		}
		// The cascade's first step: the session fills what it knows, and the second sends every gap it can
		// place but not fill to the scout. What comes back is a fill, or a question for what no lookup could
		// answer; the Shaper itself never looks anything up.
		const decisions = absent.length === 0 ? undefined : await inferAbsent(pi, ctx, event.text, absent);
		const states = await placeGaps(pi, ctx, event.text, statesOf(report, decisions));
		// A prompt that still has a gap is reported element by element and goes on as typed.
		if (states.some(isGap)) {
			ctx.ui.notify(thinPromptNotice(states), "info");
			return { action: "continue" };
		}
		const fills = fillsOf(states);
		const shaped = await reshape(ctx, event.text, fills);
		if (shaped === undefined) return { action: "continue" };
		// The reshape waits in the editor for the Boss; returning handled keeps it from sending itself.
		pending = { original: event.text, shaped };
		ctx.ui.setEditorText(shaped);
		ctx.ui.notify(shapeNotice(fills), "info");
		return { action: "handled" };
	});
}
