/**
 * The seam the Bead's Spec names: a real pi session that loads the Shaper, with a test provider
 * at the provider edge playing the session's own model. A test types a prompt the way the Boss
 * does, presses the shortcut the Boss presses, and checks what the main model received, what the
 * Shaper told the Boss, and what it left in the editor; it never reads inside the extension.
 *
 * The first test runs pi's SDK in-process and gives the loader the package directory, so the
 * extension it reports is the one the package manifest names. The next two drive the installed
 * `pi` command with the package directory, as `pi install` will.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "shaper.ts");
const testProvider = join(root, "tests", "fixtures", "shaper-test-provider.ts");
const scoutPi = join(root, "tests", "fixtures", "scout-pi.mjs");

/**
 * The thin prompt the tests type: a goal and nothing else, so context, constraints and done-when
 * are missing.
 */
const THIN = "fix the login bug";

/** A prompt carrying all four standing elements, in the Boss's prose rather than under headers. */
const COMPLETE =
	"In src/queue.ts, rename the `recieve` flag to `receive`, keeping the JSON output shape the CLI tests parse. Done when tests/queue.test.ts passes and npm test is green.";

/** A prompt carrying context, constraints and done-when, but nothing that asks for a change. */
const NO_GOAL =
	"The queue tests in src/queue.ts fail on the retry case; keep the public API unchanged, and done when npm test is green.";

/** A prompt carrying a goal, constraints and done-when, but no context that aims the work. */
const NO_CONTEXT =
	"Add a retry limit to the queue, keep the public API unchanged, and done when the limit is tested.";

/** A prompt carrying a goal, context and done-when, but nothing the work must respect. */
const NO_CONSTRAINTS =
	"In src/queue.ts, raise the retry limit from 3 to 5 because the flaky integration job needs it; done when npm test is green.";

/** A prompt carrying a goal, context and constraints, but no way to tell the work is finished. */
const NO_DONE_WHEN =
	"In src/queue.ts, raise the retry limit from 3 to 5 because the flaky integration job needs it, and keep the public API unchanged.";

/**
 * A short prompt carrying all four standing elements in the Boss's rushed prose: the prompt this
 * slice reshapes. It is 19 words, under the Shaper's line for a short prompt.
 */
const SHORT_COMPLETE =
	"In src/queue.ts, rename recieve to receive, keep the JSON shape the CLI tests parse, and done when tests/queue.test.ts passes.";

/** The reshape the session's model gives SHORT_COMPLETE, as the test provider's canned reply. */
const SHAPED_FIELDS = JSON.stringify({
	goal: "rename recieve to receive",
	context: "In src/queue.ts",
	constraints: "keep the JSON shape the CLI tests parse",
	"done-when": "and done when tests/queue.test.ts passes",
});

/** The shaped prompt the Boss sees in the editor: four headers carrying the original's words. */
const SHAPED = `## Goal
rename recieve to receive

## Context
In src/queue.ts

## Constraints
keep the JSON shape the CLI tests parse

## Done-when
and done when tests/queue.test.ts passes`;

/**
 * A short prompt carrying goal, constraints and done-when, but no context that aims the work. It is
 * 17 words, under the Shaper's line for a short prompt, so the cascade runs on it.
 */
const SHORT_NO_CONTEXT =
	"Rename recieve to receive, keep the JSON shape the CLI tests parse, and done when tests/queue.test.ts passes.";

/**
 * The conversation the Boss already had before typing SHORT_NO_CONTEXT: long enough (22 words) to
 * pass untouched with every element present, and carrying the repo and the failing test in words.
 */
const EARLIER_TURN =
	"I'm working in src/queue.ts on the retry bug: the CLI tests parse the JSON output, and the flaky job needs a limit.";

/**
 * The words the session already carries for the missing context, copied from EARLIER_TURN. An
 * inference may use only words the session has, and this phrase is among them.
 */
const SESSION_CONTEXT_FILL = "I'm working in src/queue.ts on the retry bug";

/** The branch the test workspace's repo is on, so the session knows it without the Boss typing it. */
const BRANCH = "queue-retry-fix";

/** The project notes the workspace's AGENTS.md carries: where the queue work lives. */
const NOTES_FACT = "The queue work for this task is in src/queue.ts, where recieve is spelled wrong.";

/** The words the project's notes carry for the missing context, copied from NOTES_FACT. */
const NOTES_CONTEXT_FILL = "the queue work in src/queue.ts";

/** The key of the one memory the workspace's Beads holds, and the fact it remembers. */
const BEAD_KEY = "queue-retry-limit";
const BEAD_FACT = "The queue retry limit is 5 because the flaky integration job needs it, in src/queue.ts.";

/** The words the workspace's Bead carries for the missing context, copied from BEAD_FACT. */
const BEAD_CONTEXT_FILL = "the retry limit is 5 in src/queue.ts";

/**
 * What the model answers when the project's notes, not the prompt or the conversation, carry the
 * missing context: the fill is copied from NOTES_FACT.
 */
const NOTES_CONTEXT_INFER = JSON.stringify({ context: { filled: NOTES_CONTEXT_FILL } });

/**
 * What the model answers when the branch, not the prompt or the conversation, carries the missing
 * context: the fill is the branch the session is already on.
 */
const BRANCH_CONTEXT_INFER = JSON.stringify({ context: { filled: BRANCH } });

/**
 * What the model answers when the project's Beads, not the prompt or the conversation, carry the
 * missing context: the fill is copied from BEAD_FACT.
 */
const BEAD_CONTEXT_INFER = JSON.stringify({ context: { filled: BEAD_CONTEXT_FILL } });

/**
 * What the model answers when it fills the missing context with a piece of a path the session gave:
 * "queue.ts" sits inside the session's "src/queue.ts", but it is not a word the session said, and a
 * fill carrying half a path names the wrong file.
 */
const SHORT_PATH_CONTEXT_INFER = JSON.stringify({ context: { filled: "queue.ts" } });

/**
 * What the model answers when it fills the missing context with pi's own briefing words instead of
 * the session's facts: none of these words is in the conversation, the project's notes, the branch
 * or the repo, so the session never gave this answer.
 */
const BRIEFING_CONTEXT_INFER = JSON.stringify({ context: { filled: "an expert coding assistant" } });

/** A check reply for SHORT_NO_CONTEXT: everything but the context is in the prompt. */
const NO_CONTEXT_CHECK = '{"goal":true,"context":false,"constraints":true,"done-when":true}';

/**
 * What the model answers when asked to infer SHORT_NO_CONTEXT's context from a session that carries
 * it: the fill, copied from the conversation.
 */
const SESSION_CONTEXT_INFER = JSON.stringify({ context: { filled: SESSION_CONTEXT_FILL } });

/** The place the inference sends the scout, as the model named it. */
const SCOUT_PLACE = "the queue tests in src/queue.test.ts";

/**
 * What the model answers when it knows where the missing context lives but not the answer: the
 * element is marked for the scout.
 */
const SCOUT_CONTEXT_INFER = JSON.stringify({ context: { scout: SCOUT_PLACE } });

/** The model the staged definition names, so the scout's own definition decides the model it runs on. */
const SCOUT_MODEL = "chain/scout";
/** The tools the staged definition names, as the Boss's own scout does: the read tools and write. */
const SCOUT_DEFINITION_TOOLS = "read, bash, grep, find, ls, write";

/** The tools the Shaper runs the scout with: the read tools only, so a lookup leaves no file behind. */
const SCOUT_READ_TOOLS = "read, bash, grep, find, ls";
const SCOUT_BODY = "You are a Scout. Look the answer up in the repository and never guess.";

/**
 * The context the scout finds for SHORT_NO_CONTEXT: words that are not in the session's own
 * sources, because the scout read them from the repository.
 */
const SCOUT_CONTEXT_FILL = "the retry queue tests live in src/queue.test.ts";

/**
 * What the scout answers when its lookup reads long: 29 words, past the 26 the reshape cap leaves
 * for SHORT_NO_CONTEXT, so only its first 26 words can land in the shape.
 */
const SCOUT_LONG_ANSWER =
	"the retry queue tests live in src/queue.test.ts, where each retry runs three times before the job is dropped, and the CLI tests read the JSON shape the queue prints";

/** The first 26 words of SCOUT_LONG_ANSWER: the context the shaped prompt carries. */
const SCOUT_LONG_FILL =
	"the retry queue tests live in src/queue.test.ts, where each retry runs three times before the job is dropped, and the CLI tests read the JSON shape";

/**
 * The words the reshape cap leaves the scout for SHORT_NO_CONTEXT: 3 x 17 words is a 51-word cap,
 * the prompt's own 17 words and the four headers' 8 leave 26, with no other element filled.
 */
const SCOUT_WORD_BUDGET = 26;

/** What the scout answers when the place it was sent to does not hold the gap's answer. */
const SCOUT_NOT_FOUND = "NOT FOUND";

/**
 * What the Boss is told while the scout looks the only gap up, so a slow lookup never reads as a
 * frozen editor.
 */
const SCOUTING_NOTICE = "Shaper: scouting context.";

/** The notice after a shape whose context the scout filled. */
const SCOUT_FILLED_NOTICE = "Shaper: shaped. context filled by the scout. alt+r restores your words.";

/**
 * What the model answers when it makes up words the session never carried: no session fact says
 * src/payments.ts, so the Shaper may not fill the context with it.
 */
const INVENTED_CONTEXT_INFER = JSON.stringify({ context: { filled: "the flaky retry job in src/payments.ts" } });

/**
 * The reshape the session's model gives SHORT_NO_CONTEXT: the three elements the prompt carries,
 * with the missing context left to the session's fill.
 */
const NO_CONTEXT_SHAPE_FIELDS = JSON.stringify({
	goal: "Rename recieve to receive",
	constraints: "keep the JSON shape the CLI tests parse",
	"done-when": "and done when tests/queue.test.ts passes",
});

/**
 * The shaped prompt the Boss sees when SHORT_NO_CONTEXT's context is filled with the given words:
 * the three elements the prompt carries, and the fill under Context.
 */
const contextFilledShape = (context: string): string => `## Goal
Rename recieve to receive

## Context
${context}

## Constraints
keep the JSON shape the CLI tests parse

## Done-when
and done when tests/queue.test.ts passes`;

/** The notice a prompt whose only gap is context earns when nothing fills it. */
const CONTEXT_QUESTION_NOTICE =
	"Shaper: thin prompt. goal present; context marked for a question; constraints present; done-when present";

/** The notice after a shape that filled context from the session's words. */
const CONTEXT_FILLED_NOTICE = "Shaper: shaped. context filled from the session. alt+r restores your words.";

/**
 * A prompt short enough that the headers matter to the cap: four words give a 12-word cap, and the
 * four headers add eight words to whatever the fields carry.
 */
const TINY_COMPLETE = "Fix the queue now.";

/**
 * A reshape that keeps TINY_COMPLETE's four words and still bursts the cap: the lone "." is a
 * token the word check ignores, so the rendered shape is 13 words against a cap of 12. A reshape
 * that also dropped or added a word would be refused by the word check instead, and would test
 * nothing about the cap.
 */
const OVER_LONG_FIELDS = JSON.stringify({
	goal: "Fix",
	context: "the",
	constraints: "queue",
	"done-when": "now .",
});

/** A reshape inside the cap that adds a word the Boss never typed: "now". */
const CHANGED_FIELDS = JSON.stringify({
	goal: "rename recieve to receive now",
	context: "In src/queue.ts",
	constraints: "keep the JSON shape the CLI tests parse",
	"done-when": "and done when tests/queue.test.ts passes",
});

/**
 * The reshape a model would give NO_CONTEXT if the Shaper asked for one: its 19 words split across
 * the four fields. It is valid in length and in words, so only the missing context stands between
 * that prompt and a reshape.
 */
const NO_CONTEXT_FIELDS = JSON.stringify({
	goal: "Add a retry limit to",
	context: "the queue",
	constraints: "keep the public API unchanged",
	"done-when": "and done when the limit is tested",
});

/** A valid one-pixel PNG, enough for pi to treat a typed prompt as carrying an image. */
const IMAGE = {
	type: "image" as const,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

/** The standing elements every typed prompt is checked for, as GLOSSARY.md names them. */
const STANDING_ELEMENTS = ["goal", "context", "constraints", "done-when"] as const;

/** The settings a workspace's pi reads when shaping is on. */
const SHAPING_ON = { shaper: { enabled: true } };

/**
 * What a test sets up before pi runs: the settings pi reads, and how the session's model answers
 * the Shaper's three calls, the element report the check receives, the fills and marks the
 * inference receives, and the fields the reshape receives. A test that names none gets the
 * check's all-present default, an inference that answers nothing, and a reshape reply the Shaper
 * must refuse.
 */
type WorkspaceOptions = {
	settings?: Record<string, unknown>;
	check?: string;
	infer?: string;
	reshape?: string;
};

/**
 * One temporary Mac: a HOME, an agent folder pi reads its settings from, the test provider's log,
 * a PATH of its own for the scout's pi, and, when a test names them, the answers the session's
 * model and the scout give the Shaper's calls.
 */
type Workspace = {
	dir: string;
	home: string;
	agentDir: string;
	log: string;
	bin: string;
	scoutLog: string;
	check?: string;
	infer?: string;
	reshape?: string;
	scoutReply?: string;
};

/** Every workspace this file made, removed once its tests are done. */
const workspaces: Workspace[] = [];

after(() => {
	for (const workspace of workspaces) rmSync(workspace.dir, { recursive: true, force: true });
});

/** A temporary Mac for one test. */
function makeWorkspace(options: WorkspaceOptions = {}): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "pi-shaper-"));
	const home = join(dir, "home");
	const agentDir = join(dir, "pi-agent");
	const log = join(dir, "requests.jsonl");
	const bin = join(dir, "bin");
	const scoutLog = join(dir, "scout.jsonl");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(bin, { recursive: true });
	// The logs exist, empty, from the start: a test reads one before any call is written, so a
	// missing file stays a fault instead of answering the same as no call.
	writeFileSync(log, "");
	writeFileSync(scoutLog, "");
	if (options.settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	const workspace = {
		dir,
		home,
		agentDir,
		log,
		bin,
		scoutLog,
		check: options.check,
		infer: options.infer,
		reshape: options.reshape,
	};
	workspaces.push(workspace);
	return workspace;
}

/**
 * Run one command in the workspace, and fail the test with its stderr when it does not succeed. The
 * setup a test stages inside the workspace is part of what the test proves, so a failed command is
 * the test's fault, not a case to read.
 */
function runInWorkspace(workspace: Workspace, command: string, args: string[]): void {
	const result = spawnSync(command, args, { cwd: workspace.dir, encoding: "utf8" });
	assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
}

/** Make the workspace a git repository on the named branch, so the session has a branch to read. */
function initRepo(workspace: Workspace, branch: string): void {
	runInWorkspace(workspace, "git", ["init", "-q", "-b", branch, "."]);
}

/** Put the project's own notes in the workspace, as AGENTS.md, the file pi loads as its context. */
function writeNotes(workspace: Workspace, notes: string): void {
	writeFileSync(join(workspace.dir, "AGENTS.md"), notes);
}

/** Give the workspace a Beads database holding one memory, so the session's Beads knows a fact. */
function writeBead(workspace: Workspace, key: string, fact: string): void {
	runInWorkspace(workspace, "bd", ["init"]);
	runInWorkspace(workspace, "bd", ["remember", "--key", key, fact]);
}

/**
 * Stage the scout agent in the workspace's agent folder, as the Boss's own scout sits in
 * `~/.pi/agent/agents`: the model and the tools it runs with, and the instructions it follows. An
 * empty tools list leaves the tools line out, as an incomplete definition would.
 */
function writeScoutAgent(workspace: Workspace, tools: string = SCOUT_DEFINITION_TOOLS): void {
	const agents = join(workspace.agentDir, "agents");
	mkdirSync(agents, { recursive: true });
	const toolsLine = tools === "" ? "" : `tools: ${tools}\n`;
	writeFileSync(
		join(agents, "scout.md"),
		`---\nname: scout\ndescription: Looks one question up.\nmodel: ${SCOUT_MODEL}\n${toolsLine}---\n\n${SCOUT_BODY}\n`,
	);
}

/**
 * Put the scout's pi in the workspace's PATH, answering with the given reply. It stands in for the
 * installed pi the Shaper starts with the scout's definition, and records how it was called.
 */
function writeScoutProcess(workspace: Workspace, reply: string): void {
	const pi = join(workspace.bin, "pi");
	copyFileSync(scoutPi, pi);
	chmodSync(pi, 0o755);
	workspace.scoutReply = reply;
}

/**
 * A workspace whose session can place its only gap but not fill it, with the scout staged in the
 * workspace's agent folder and its pi answering the given reply: the setup the scout tests share.
 */
function scoutWorkspace(reply: string): Workspace {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: SCOUT_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	writeScoutAgent(workspace);
	writeScoutProcess(workspace, reply);
	return workspace;
}

/**
 * The environment a pi process runs in: a temporary HOME and agent folder, the provider's log, the
 * scout's log, and, when a test names them, the answers the session's model and the scout give the
 * Shaper's calls. A test that names no answer leaves the variables out, so the provider's and the
 * scout's own defaults answer.
 */
const piEnv = (workspace: Workspace): Record<string, string | undefined> => ({
	...process.env,
	HOME: workspace.home,
	PI_CODING_AGENT_DIR: workspace.agentDir,
	PI_SKIP_VERSION_CHECK: "1",
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	// The workspace's own bin comes first, so a test that puts the scout's pi there shadows the
	// installed one for every process the session starts.
	PATH: [workspace.bin, process.env.PATH].filter(Boolean).join(delimiter),
	SHAPER_TEST_LOG: workspace.log,
	SHAPER_TEST_SCOUT_LOG: workspace.scoutLog,
	...(workspace.check === undefined ? {} : { SHAPER_TEST_CHECK_REPORT: workspace.check }),
	...(workspace.infer === undefined ? {} : { SHAPER_TEST_INFER_REPORT: workspace.infer }),
	...(workspace.reshape === undefined ? {} : { SHAPER_TEST_RESHAPE_REPORT: workspace.reshape }),
	...(workspace.scoutReply === undefined ? {} : { SHAPER_TEST_SCOUT_REPLY: workspace.scoutReply }),
});

/**
 * Put the workspace's environment in place: a temporary HOME and agent folder, which pi's auth
 * storage and settings read, and the test provider's log and canned replies. The returned
 * function restores the environment, so a later test starts clean even though the process is
 * shared.
 */
function applyPiEnvironment(workspace: Workspace): () => void {
	const saved = { ...process.env };
	for (const [key, value] of Object.entries(piEnv(workspace))) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const key of Object.keys(process.env)) {
			if (!(key in saved)) delete process.env[key];
		}
		Object.assign(process.env, saved);
	};
}

/** What pi's resource loader reports it loaded: the extensions, and any extension that failed to load. */
type LoadedExtensions = { errors: unknown[]; extensions: { sourceInfo: { path: string } }[] };

/** The slice of pi's SDK these tests use. */
type PiSdk = {
	DefaultResourceLoader: new (options: Record<string, unknown>) => {
		reload(): Promise<void>;
		getExtensions(): LoadedExtensions;
	};
	createAgentSession(options: Record<string, unknown>): Promise<{ session: SdkSession }>;
	SessionManager: { inMemory(cwd: string): unknown };
	SettingsManager: { create(cwd: string, agentDir: string): unknown };
};

/** The session operations the in-process tests use. */
type SdkSession = {
	prompt(text: string, options?: { images?: SdkImage[] }): Promise<void>;
	bindExtensions(bindings: { uiContext: ExtensionUIContext; mode: "tui" }): Promise<void>;
	extensionRunner: {
		getShortcuts(keybindings: Record<string, unknown>): Map<string, { handler(ctx: unknown): void | Promise<void> }>;
		createContext(): unknown;
	};
	dispose(): void;
};

/** An image as pi's prompt carries one; a test that attaches one only needs the shape. */
type SdkImage = { type: "image"; data: string; mimeType: string };

/** The session's own model, as the test provider registers it. */
const MAIN_MODEL = {
	id: "main",
	name: "main",
	api: "shaper-test",
	provider: "shaper-test",
	baseUrl: "http://localhost:0",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

/**
 * The PATH the test process started with, before any test gives a workspace its own bin folder. The
 * installed pi is found there, so a workspace's stand-in pi can never answer for the SDK's package.
 */
const startupPath = process.env.PATH ?? "";

/** The installed pi package, found from the `pi` binary on PATH, so the tests use the same pi as the CLI. */
function piPackageRoot(): string {
	const bin = startupPath
		.split(delimiter)
		.map((directory) => join(directory, "pi"))
		.find((path) => existsSync(path));
	if (bin === undefined) throw new Error("pi is not on PATH");
	for (let directory = dirname(realpathSync(bin)); ; directory = dirname(directory)) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) {
			const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
			if (name === "@earendil-works/pi-coding-agent") return directory;
		}
		if (dirname(directory) === directory) throw new Error(`the package that holds ${bin} is not on disk`);
	}
}

/** pi's SDK, loaded once from the installed package. */
let piSdk: Promise<PiSdk> | undefined;
const loadPiSdk = (): Promise<PiSdk> =>
	(piSdk ??= import(pathToFileURL(join(piPackageRoot(), "dist", "index.js")).href).then((module) => module as PiSdk));

/** One request the test provider saw, as it wrote it to the log. */
type Request = {
	provider: string;
	model: string;
	kind: "main" | "check" | "infer" | "reshape";
	system: string;
	messages: string[];
};

/** Every request the test provider wrote, in order. */
function requests(workspace: Workspace): Request[] {
	return readFileSync(workspace.log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Request);
}

/** Every request the Shaper sent the session's model to check a prompt's standing elements. */
function checkRequests(workspace: Workspace): Request[] {
	return requests(workspace).filter(({ kind }) => kind === "check");
}

/**
 * Change the answer the session's model gives one kind of request from now on. The test provider
 * reads its settings at request time, so a test whose session holds two prompts can have the model
 * answer each prompt its own way, as a real model would.
 */
function answer(kind: "check" | "infer" | "reshape", reply: string): void {
	process.env[`SHAPER_TEST_${kind.toUpperCase()}_REPORT`] = reply;
}

/** Every request the Shaper sent the session's model to infer a prompt's missing standing elements. */
function inferRequests(workspace: Workspace): Request[] {
	return requests(workspace).filter(({ kind }) => kind === "infer");
}

/** Every request the Shaper sent the session's model to reshape a prompt. */
function reshapeRequests(workspace: Workspace): Request[] {
	return requests(workspace).filter(({ kind }) => kind === "reshape");
}

/** One call the Shaper made to the scout agent, as the scout's own process recorded it. */
type ScoutCall = { cwd: string; args: string[] };

/** Every call the Shaper made to the scout agent, in order. */
function scoutCalls(workspace: Workspace): ScoutCall[] {
	return readFileSync(workspace.scoutLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ScoutCall);
}

/** The value one flag of a call carries, or undefined when the call has no such flag. */
function flagValue(call: ScoutCall, flag: string): string | undefined {
	const index = call.args.indexOf(flag);
	return index === -1 ? undefined : call.args[index + 1];
}

/** Every request the session's own model answered for the prompt itself, not for the Shaper's calls. */
function mainRequests(workspace: Workspace): Request[] {
	return requests(workspace).filter(({ kind }) => kind === "main");
}

/** One notice the Shaper showed the Boss through pi's UI. */
type Notice = { message: string; type?: "info" | "warning" | "error" };

/** What one in-process session leaves a test to read: the notices the Shaper showed, and what pi loaded. */
type SessionReadings = { notices: Notice[]; loaded: LoadedExtensions };

/**
 * A real pi session that loads the package, with the Boss's screen standing in at the UI edge, kept
 * open for a test's steps: typing, pressing a key, and reading the editor the Boss would see.
 */
type OpenSession = SessionReadings & {
	prompt(text: string, images?: SdkImage[]): Promise<void>;
	editorText(): string;
	press(key: string): Promise<void>;
	dispose(): void;
};

/**
 * Open a real pi session that loads the package. The UI stand-in records the notices the Shaper
 * shows and the editor it sets, and it keeps the workspace's environment in place because the test
 * provider reads its canned replies at request time. The caller disposes the session, which
 * restores the environment.
 */
async function openSession(workspace: Workspace): Promise<OpenSession> {
	const notices: Notice[] = [];
	let editor = "";
	// pi types the whole UI port; only the two calls the Shaper uses are implemented, so the cast
	// avoids a stand-in full of no-ops. The notices and the editor text are what the Boss would read.
	const ui = {
		notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
		setEditorText: (text: string) => {
			editor = text;
		},
	} as unknown as ExtensionUIContext;
	const restore = applyPiEnvironment(workspace);
	try {
		const sdk = await loadPiSdk();
		const loader = new sdk.DefaultResourceLoader({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			// The package directory, so pi reads the extension from package.json's pi.extensions.
			additionalExtensionPaths: [root, testProvider],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			// Off only what a session's own agents and prompts would add to the transcript; the project's
			// notes stay on, because AGENTS.md in the workspace is one of the sources a fill reads.
			noContextFiles: false,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		const { session } = await sdk.createAgentSession({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			model: MAIN_MODEL,
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(workspace.dir),
			settingsManager: sdk.SettingsManager.create(workspace.dir, workspace.agentDir),
		});
		try {
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
		} catch (error) {
			session.dispose();
			throw error;
		}
		return {
			notices,
			loaded,
			// The TUI clears the editor when the Boss submits, so the stand-in does too; the Shaper's own
			// setEditorText call puts the shaped text back before the prompt returns handled.
			prompt: (text, images) => {
				editor = "";
				return session.prompt(text, { images });
			},
			editorText: () => editor,
			// Press one key the way the TUI does: through the shortcut the extension registered, with pi's
			// own context for the session.
			press: async (key) => {
				const shortcut = session.extensionRunner.getShortcuts({}).get(key);
				if (shortcut === undefined) throw new Error(`no extension registered the ${key} shortcut`);
				await shortcut.handler(session.extensionRunner.createContext());
			},
			dispose: () => {
				session.dispose();
				restore();
			},
		};
	} catch (error) {
		restore();
		throw error;
	}
}

/** Run a test's steps against one open session, and dispose it whichever way they end. */
async function withSession<T>(workspace: Workspace, run: (session: OpenSession) => Promise<T>): Promise<T> {
	const session = await openSession(workspace);
	try {
		return await run(session);
	} finally {
		session.dispose();
	}
}

/**
 * Type one prompt into a real pi session that loads the package, and return what the session
 * leaves a test to read: the notices the Shaper showed the Boss and the extensions pi loaded from
 * the package directory. What the session's model was asked stays in the test provider's log.
 */
async function promptInSession(workspace: Workspace, text: string): Promise<SessionReadings> {
	return withSession(workspace, async (session) => {
		await session.prompt(text);
		return { notices: session.notices, loaded: session.loaded };
	});
}

/** Run the installed pi with the package directory and one typed prompt. */
function runPi(workspace: Workspace, prompt: string) {
	return spawnSync(
		"pi",
		["--no-session", "-ne", "-e", root, "-e", testProvider, "--model", "shaper-test/main", "-p", prompt],
		{ cwd: workspace.dir, encoding: "utf8", env: piEnv(workspace) },
	);
}

test("the package loads the Shaper extension, and with shaping off by default the typed prompt reaches the main model untouched", async () => {
	const workspace = makeWorkspace();
	const { loaded } = await promptInSession(workspace, THIN);
	assert.deepEqual(loaded.errors, [], "every extension the test loads loaded without errors");
	assert.ok(
		loaded.extensions.some(({ sourceInfo }) => realpathSync(sourceInfo.path) === realpathSync(extension)),
		"the Shaper extension is one of the extensions pi loaded",
	);
	const main = mainRequests(workspace);
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), THIN, "the main model received the words the Boss typed and nothing else");
});

test("pi loads the package directory, and with shaping off by default the typed prompt reaches the main model untouched", () => {
	const workspace = makeWorkspace();
	const result = runPi(workspace, THIN);
	assert.equal(result.status, 0, result.stderr);
	const main = mainRequests(workspace);
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), THIN, "the main model received the words the Boss typed and nothing else");
});

test("with shaping on, a print-mode prompt still reaches the main model, because there is no editor to hold it", () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	const result = runPi(workspace, SHORT_COMPLETE);
	assert.equal(result.status, 0, result.stderr);
	const main = mainRequests(workspace);
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), SHORT_COMPLETE, "the main model received the words the Boss typed");
});

test("a thin prompt engages the Shaper, which reports each standing element as present or a gap marked for a question", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":false,"constraints":false,"done-when":false}',
	});
	const { notices } = await promptInSession(workspace, THIN);
	assert.deepEqual(
		notices.map(({ message }) => message),
		[
			"Shaper: thin prompt. goal present; context marked for a question; constraints marked for a question; done-when marked for a question",
		],
		"the Boss is told which standing elements the thin prompt carries and how the session placed the rest",
	);
	assert.equal(
		mainRequests(workspace).at(-1)?.messages.at(-1),
		THIN,
		"the main model received the words the Boss typed and nothing else",
	);
});

test("a long complete typed prompt passes through untouched, and the Shaper says nothing", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON });
	const { notices } = await promptInSession(workspace, COMPLETE);
	const main = mainRequests(workspace);
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), COMPLETE, "the main model received the words the Boss typed and nothing else");
	assert.deepEqual(notices, [], "the Boss was told nothing, because every element was present");
	assert.equal(reshapeRequests(workspace).length, 0, "the Shaper did not reshape a long complete prompt");
});

test("a prompt missing its goal reports the goal missing and the other standing elements present", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":false,"context":true,"constraints":true,"done-when":true}',
	});
	const { notices } = await promptInSession(workspace, NO_GOAL);
	assert.deepEqual(
		notices.map(({ message }) => message),
		["Shaper: thin prompt. goal missing; context present; constraints present; done-when present"],
	);
});

test("a prompt missing its context reports the context marked for a question and the other standing elements present", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":false,"constraints":true,"done-when":true}',
	});
	const { notices } = await promptInSession(workspace, NO_CONTEXT);
	assert.deepEqual(
		notices.map(({ message }) => message),
		[CONTEXT_QUESTION_NOTICE],
	);
});

test("a prompt missing its constraints reports the constraints missing and the other standing elements present", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":true,"constraints":false,"done-when":true}',
	});
	const { notices } = await promptInSession(workspace, NO_CONSTRAINTS);
	assert.deepEqual(
		notices.map(({ message }) => message),
		["Shaper: thin prompt. goal present; context present; constraints missing; done-when present"],
	);
});

test("a prompt missing its done-when reports the done-when missing and the other standing elements present", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":true,"constraints":true,"done-when":false}',
	});
	const { notices } = await promptInSession(workspace, NO_DONE_WHEN);
	assert.deepEqual(
		notices.map(({ message }) => message),
		["Shaper: thin prompt. goal present; context present; constraints present; done-when missing"],
	);
});

test("the Shaper asks the session's own model about every standing element, reading the prompt as typed", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":false,"constraints":false,"done-when":false}',
	});
	await promptInSession(workspace, THIN);
	const [check, ...extra] = checkRequests(workspace);
	assert.equal(extra.length, 0, "the Shaper checked the prompt once");
	assert.equal(check.model, "main", "the check runs on the session's own model");
	assert.equal(check.messages.at(-1), THIN, "the check read the prompt the Boss typed");
	for (const element of STANDING_ELEMENTS) {
		assert.ok(check.system.includes(`${element}:`), `the check asks about the standing element ${element}`);
	}
});

test("a check the Shaper cannot read leaves the prompt to go on as typed, and the Boss is told nothing", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, check: "not a report" });
	const { notices } = await promptInSession(workspace, THIN);
	assert.deepEqual(notices, [], "the Boss was told nothing, because the check named no element");
	assert.equal(
		mainRequests(workspace).at(-1)?.messages.at(-1),
		THIN,
		"the main model received the words the Boss typed and nothing else",
	);
});

test("a short typed prompt that carries every standing element comes back under the four headers in the editor", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		assert.equal(session.editorText(), SHAPED, "the editor holds the prompt reorganized under the four headers");
		assert.equal(mainRequests(workspace).length, 0, "nothing the Boss did not accept reached the main model");
	});
});

test("the Shaper asks for a reshape from the session's own model, with the Boss's words and the length cap", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		const [call, ...extra] = reshapeRequests(workspace);
		assert.equal(extra.length, 0, "the Shaper asked for one reshape");
		assert.equal(call.model, "main", "the reshape runs on the session's own model");
		assert.equal(call.messages.at(-1), SHORT_COMPLETE, "the reshape read the prompt the Boss typed");
		for (const element of STANDING_ELEMENTS) {
			assert.ok(call.system.includes(`${element}:`), `the reshape asks about the standing element ${element}`);
		}
		assert.ok(call.system.includes("add no requirement"), "the reshape is told to invent nothing the Boss did not name");
		assert.ok(call.system.includes("at most 57 words"), "the reshape is told the cap: three times the prompt's 19 words");
	});
});

test("pressing enter on the shaped prompt sends the shaped text to the main model", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		await session.prompt(session.editorText());
		const main = mainRequests(workspace);
		assert.equal(main.length, 1, "the shaped prompt reached the main model once");
		assert.equal(main[0].messages.at(-1), SHAPED, "the main model received the shaped text the Boss accepted");
		assert.equal(checkRequests(workspace).length, 1, "the Shaper checked the original once, not its own shaped text");
	});
});

test("an edited shaped prompt goes on exactly as the Boss edited it", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		const edited = `${SHAPED}\n\nAlso keep the docs in step.`;
		await session.prompt(edited);
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			edited,
			"the main model received the prompt as the Boss edited it",
		);
	});
});

test("one press of the revert shortcut puts the original words back in the editor", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		await session.press("alt+r");
		assert.equal(session.editorText(), SHORT_COMPLETE, "the editor holds the Boss's words again");
	});
});

test("the original restored by revert goes on as the Boss typed it, without another reshape", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		await session.press("alt+r");
		await session.prompt(session.editorText());
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			SHORT_COMPLETE,
			"the main model received the Boss's own words",
		);
		assert.equal(reshapeRequests(workspace).length, 1, "the reverted prompt was not reshaped a second time");
	});
});

test("a reshape past the length cap never reaches the editor, and the prompt goes on as typed", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: OVER_LONG_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(TINY_COMPLETE);
		assert.equal(session.editorText(), "", "the editor stays empty, so the over-long reshape never reaches the Boss");
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			TINY_COMPLETE,
			"the main model received the Boss's words as typed",
		);
	});
});

test("a reshape that changes the Boss's words never reaches the editor, and the prompt goes on as typed", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: CHANGED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		assert.equal(session.editorText(), "", "the editor stays empty, so the changed words never reach the Boss");
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			SHORT_COMPLETE,
			"the main model received the Boss's words as typed",
		);
	});
});

test("a short prompt that leaves a standing element missing is reported, not reshaped", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":false,"constraints":true,"done-when":true}',
		reshape: NO_CONTEXT_FIELDS,
	});
	await withSession(workspace, async (session) => {
		await session.prompt(NO_CONTEXT);
		assert.equal(session.editorText(), "", "nothing is put in the editor");
		assert.equal(reshapeRequests(workspace).length, 0, "the Shaper did not ask for a reshape");
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			NO_CONTEXT,
			"the main model received the words as typed",
		);
	});
});

test("a typed prompt carrying an image goes on as typed, because the editor cannot hold it", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE, [IMAGE]);
		assert.equal(session.editorText(), "", "nothing was put in the editor");
		assert.equal(reshapeRequests(workspace).length, 0, "the Shaper did not reshape a prompt carrying an image");
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			SHORT_COMPLETE,
			"the main model received the words as typed",
		);
	});
});

test("the notice after a reshape names the key that brings the original words back", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, reshape: SHAPED_FIELDS });
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_COMPLETE);
		assert.deepEqual(session.notices.map(({ message }) => message), [
			"Shaper: shaped. alt+r restores your words.",
		]);
	});
});

test("a gap the session already fills is inferred from the conversation, and the shaped prompt carries it under its header", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		infer: SESSION_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	await withSession(workspace, async (session) => {
		await session.prompt(EARLIER_TURN);
		// The Boss has said where he is working, so the next prompt is the thin one: its check reports the
		// context the prompt itself lacks, and the conversation now holds the words the session can fill it with.
		answer("check", NO_CONTEXT_CHECK);
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(
			session.editorText(),
			contextFilledShape(SESSION_CONTEXT_FILL),
			"the editor holds the prompt under the four headers, with the session's words under Context",
		);
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[CONTEXT_FILLED_NOTICE],
			"the Boss is told the shape carries context the session supplied",
		);
		const main = mainRequests(workspace);
		assert.equal(main.length, 1, "only the earlier turn reached the main model; the shape waited in the editor");
		assert.equal(main[0].messages.at(-1), EARLIER_TURN, "the earlier turn reached the main model as the Boss typed it");
	});
});

test("a gap the project's notes already fill is inferred from them, and the shaped prompt carries it under its header", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: NOTES_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	writeNotes(workspace, NOTES_FACT);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(
			session.editorText(),
			contextFilledShape(NOTES_CONTEXT_FILL),
			"the editor holds the prompt under the four headers, with the project's notes under Context",
		);
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[CONTEXT_FILLED_NOTICE],
			"the Boss is told the shape carries context the session supplied",
		);
	});
});

test("a gap the branch already fills is inferred from it, and the shaped prompt carries it under its header", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: BRANCH_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	initRepo(workspace, BRANCH);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(
			session.editorText(),
			contextFilledShape(BRANCH),
			"the editor holds the prompt under the four headers, with the branch under Context",
		);
	});
});

test("a gap the project's Beads already fill is inferred from them, and the shaped prompt carries it under its header", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: BEAD_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	writeBead(workspace, BEAD_KEY, BEAD_FACT);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(
			session.editorText(),
			contextFilledShape(BEAD_CONTEXT_FILL),
			"the editor holds the prompt under the four headers, with what the Beads remember under Context",
		);
	});
});

test("an inference drawn only from pi's own briefing words is refused, and the gap is marked for a question", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: BRIEFING_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(session.editorText(), "", "nothing is put in the editor, so no invented words reach the Boss");
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[CONTEXT_QUESTION_NOTICE],
			"the fill the session's own sources do not carry is refused, and the context becomes a question",
		);
	});
});

test("an inference made of a piece of a word the session said is refused, and the gap is marked for a question", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		infer: SHORT_PATH_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	await withSession(workspace, async (session) => {
		await session.prompt(EARLIER_TURN);
		answer("check", NO_CONTEXT_CHECK);
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(session.editorText(), "", "nothing is put in the editor, so half a path never reaches the Boss");
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[CONTEXT_QUESTION_NOTICE],
			"the fill built from part of a path the session gave is refused, and the context becomes a question",
		);
	});
});

test("a placeable gap is asked of the scout agent once, in the session's folder, on its own model and instructions", async () => {
	const workspace = scoutWorkspace(SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		const [call, ...extra] = scoutCalls(workspace);
		assert.equal(extra.length, 0, "the Shaper asked the scout once for the one gap");
		assert.equal(call.cwd, realpathSync(workspace.dir), "the scout looked in the folder the session runs in");
		assert.equal(flagValue(call, "--model"), SCOUT_MODEL, "the scout ran on the model its own definition names");
		assert.equal(
			flagValue(call, "--append-system-prompt"),
			SCOUT_BODY,
			"the scout ran under its own instructions, not the Shaper's",
		);
	});
});

test("the scout runs with the read tools only, though its definition names write", async () => {
	const workspace = scoutWorkspace(SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		const [call] = scoutCalls(workspace);
		assert.equal(
			flagValue(call, "--tools"),
			SCOUT_READ_TOOLS,
			"the scout ran with the read tools only, though its definition also names write",
		);
	});
});

test("the scout is told the place to look, the prompt as typed and the words the shape has room for", async () => {
	const workspace = scoutWorkspace(SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		const task = scoutCalls(workspace)[0].args.at(-1) ?? "";
		assert.ok(task.includes(SCOUT_PLACE), "the scout was told the place the session said the answer lives");
		assert.ok(task.includes(SHORT_NO_CONTEXT), "the scout read the prompt as the Boss typed it");
		assert.ok(
			task.includes(`at most ${SCOUT_WORD_BUDGET} words`),
			"the scout is told the words the reshape cap leaves for its answer",
		);
		assert.ok(task.includes("Change no file"), "the scout was told to answer in its message and leave no file behind");
	});
});

test("a scout definition that names no tools is asked with the read tools only, so a lookup can never change a file", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: SCOUT_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	writeScoutAgent(workspace, "");
	writeScoutProcess(workspace, SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		const [call] = scoutCalls(workspace);
		assert.equal(
			flagValue(call, "--tools"),
			SCOUT_READ_TOOLS,
			"a scout that names no tools runs with the read tools only, never one that writes",
		);
	});
});

test("the context the scout finds fills its element, and the Boss is told the scout supplied it", async () => {
	const workspace = scoutWorkspace(SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(
			session.editorText(),
			contextFilledShape(SCOUT_CONTEXT_FILL),
			"the editor holds the prompt under the four headers, with what the scout found under Context",
		);
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[SCOUTING_NOTICE, SCOUT_FILLED_NOTICE],
			"the Boss is told the scout is looking before it starts, then that the shape carries what it found",
		);
		assert.equal(mainRequests(workspace).length, 0, "the shape waits in the editor; nothing reached the main model");
	});
});

test("an answer the scout runs long still fills its element, cut to the words the reshape cap leaves", async () => {
	const workspace = scoutWorkspace(SCOUT_LONG_ANSWER);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(
			session.editorText(),
			contextFilledShape(SCOUT_LONG_FILL),
			"the shaped prompt carries the scout's answer, cut to the 26 words the cap leaves",
		);
	});
});

test("what the scout cannot find becomes a question, even when the workspace holds the answer", async () => {
	const workspace = scoutWorkspace(SCOUT_NOT_FOUND);
	// The answer is at the exact place the session named, and the Shaper must not go looking for it:
	// only the scout may, and it found none.
	mkdirSync(join(workspace.dir, "src"), { recursive: true });
	writeFileSync(join(workspace.dir, "src", "queue.test.ts"), "// the retry queue tests live here\n");
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(session.editorText(), "", "nothing is put in the editor while a gap remains");
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[SCOUTING_NOTICE, CONTEXT_QUESTION_NOTICE],
			"the scout's lookup is announced, and the gap it could not fill is a question, not a guess",
		);
		assert.equal(reshapeRequests(workspace).length, 0, "the Shaper did not reshape a prompt that still has a gap");
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			SHORT_NO_CONTEXT,
			"the main model received the words the Boss typed",
		);
	});
});

test("a scout definition the Shaper cannot read leaves the gap marked for the scout, and the prompt goes on as typed", async () => {
	const workspace = scoutWorkspace(SCOUT_CONTEXT_FILL);
	// A definition in the place the staged one sits, with frontmatter that is not YAML.
	writeFileSync(join(workspace.agentDir, "agents", "scout.md"), "---\nmodel: [unclosed\n---\n\nYou are a Scout.\n");
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			["Shaper: thin prompt. goal present; context marked for the scout; constraints present; done-when present"],
			"a definition the Shaper cannot read leaves the gap where the Boss can see it",
		);
		assert.deepEqual(scoutCalls(workspace), [], "no scout was started from a definition the Shaper could not read");
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			SHORT_NO_CONTEXT,
			"the main model received the words the Boss typed, so an unreadable scout cannot hold the prompt back",
		);
	});
});

test("with no scout agent to ask, a placeable gap stays marked for the scout and the prompt goes on as typed", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: SCOUT_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	// A pi that answers if it runs at all: the log stays empty only if the Shaper never starts a scout.
	writeScoutProcess(workspace, SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(session.editorText(), "", "nothing is put in the editor while a gap remains");
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			["Shaper: thin prompt. goal present; context marked for the scout; constraints present; done-when present"],
			"the Boss is told the context is to be looked up, and no scout was there to look",
		);
		assert.deepEqual(scoutCalls(workspace), [], "no scout was started without a scout agent to run");
		assert.equal(reshapeRequests(workspace).length, 0, "the Shaper did not reshape a prompt that still has a gap");
	});
});

test("a prompt too short to hold a scout's answer is not looked up, and its gap becomes a question", async () => {
	const workspace = scoutWorkspace(SCOUT_CONTEXT_FILL);
	await withSession(workspace, async (session) => {
		await session.prompt(TINY_COMPLETE);
		assert.deepEqual(scoutCalls(workspace), [], "no lookup was started that the shape has no room to carry");
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			["Shaper: thin prompt. goal present; context marked for a question; constraints present; done-when present"],
			"the Boss is asked for the element the scout's answer could not fit",
		);
	});
});

test("an inference the session's words do not carry is never filled, and the gap is marked for a question", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: NO_CONTEXT_CHECK,
		infer: INVENTED_CONTEXT_INFER,
		reshape: NO_CONTEXT_SHAPE_FIELDS,
	});
	await withSession(workspace, async (session) => {
		await session.prompt(SHORT_NO_CONTEXT);
		assert.equal(session.editorText(), "", "nothing is put in the editor, so no invented words reach the Boss");
		assert.deepEqual(
			session.notices.map(({ message }) => message),
			[CONTEXT_QUESTION_NOTICE],
			"the fill the session does not carry is refused, and the context becomes a question",
		);
		assert.equal(
			mainRequests(workspace).at(-1)?.messages.at(-1),
			SHORT_NO_CONTEXT,
			"the main model received the words the Boss typed",
		);
	});
});

test("the Shaper asks the session's own model to infer from the repo, the branch, the conversation, the session's Beads and the project's notes", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON, infer: SESSION_CONTEXT_INFER, reshape: NO_CONTEXT_SHAPE_FIELDS });
	initRepo(workspace, BRANCH);
	writeNotes(workspace, NOTES_FACT);
	writeBead(workspace, BEAD_KEY, BEAD_FACT);
	await withSession(workspace, async (session) => {
		await session.prompt(EARLIER_TURN);
		answer("check", NO_CONTEXT_CHECK);
		await session.prompt(SHORT_NO_CONTEXT);
		const [call, ...extra] = inferRequests(workspace);
		assert.equal(extra.length, 0, "the Shaper asked for one inference");
		assert.equal(call.model, "main", "the inference runs on the session's own model");
		const reading = call.messages.at(-1) ?? "";
		assert.ok(reading.includes(`Repo:\n${workspace.dir}`), "the inference reads the repo the session runs in");
		assert.ok(reading.includes(`Branch:\n${BRANCH}`), "the inference reads the branch the session is on");
		assert.ok(reading.includes(EARLIER_TURN), "the inference reads the conversation the session already had");
		assert.ok(reading.includes(BEAD_FACT), "the inference reads what the project's Beads remember");
		assert.ok(reading.includes(NOTES_FACT), "the inference reads the project's own notes");
		assert.ok(reading.endsWith(`Prompt as typed:\n${SHORT_NO_CONTEXT}`), "the inference reads the prompt as typed");
		assert.ok(call.system.includes("every word of a fill must appear in it"), "the inference is told a fill has to be the session's own words");
	});
});
