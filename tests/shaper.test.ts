/**
 * The seam the Bead's Spec names: a real pi session that loads the Shaper, with a test provider
 * at the provider edge playing the session's own model. A test types a prompt the way the Boss
 * does and checks what the main model received and what the Shaper told the Boss; it never reads
 * inside the extension.
 *
 * The first test runs pi's SDK in-process and gives the loader the package directory, so the
 * extension it reports is the one the package manifest names. The second drives the installed
 * `pi` command with the package directory, as `pi install` will.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "shaper.ts");
const testProvider = join(root, "tests", "fixtures", "shaper-test-provider.ts");

/** The prompt every test types, worded the way a thin prompt is: a goal and nothing else. */
const TYPED = "fix the login bug";

/** The same thin prompt, named for the trigger tests. */
const THIN = TYPED;

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

/** The standing elements every typed prompt is checked for, as GLOSSARY.md names them. */
const STANDING_ELEMENTS = ["goal", "context", "constraints", "done-when"] as const;

/** The settings a workspace's pi reads when shaping is on. */
const SHAPING_ON = { shaper: { enabled: true } };

/** The check's report when a test does not set one: every standing element present. */
const ALL_PRESENT = '{"goal":true,"context":true,"constraints":true,"done-when":true}';

/**
 * One temporary Mac: a HOME, an agent folder pi reads its settings from, the test provider's log,
 * and the element report the session's model gives the Shaper's check.
 */
type Workspace = { dir: string; home: string; agentDir: string; log: string; check: string };

/** What a test sets up before pi runs: its settings, and the report the check's model gives. */
type WorkspaceOptions = { settings?: Record<string, unknown>; check?: string };

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
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// The log exists, empty, from the start: a test reads it before any request is written, so a
	// missing file stays a fault instead of answering the same as no request.
	writeFileSync(log, "");
	if (options.settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	const workspace = { dir, home, agentDir, log, check: options.check ?? ALL_PRESENT };
	workspaces.push(workspace);
	return workspace;
}

/** The environment a pi process runs in: a temporary HOME and agent folder, and the provider's log. */
const piEnv = (workspace: Workspace): Record<string, string | undefined> => ({
	...process.env,
	HOME: workspace.home,
	PI_CODING_AGENT_DIR: workspace.agentDir,
	PI_SKIP_VERSION_CHECK: "1",
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	SHAPER_TEST_LOG: workspace.log,
	SHAPER_TEST_CHECK_REPORT: workspace.check,
});

/**
 * Run something with the workspace's environment in place: a temporary HOME and agent folder,
 * which pi's auth storage and settings read, and the test provider's log. The environment is
 * restored afterwards, so a later test starts clean even though the process is shared.
 */
async function withPiEnvironment<T>(workspace: Workspace, run: () => Promise<T>): Promise<T> {
	const saved = { ...process.env };
	for (const [key, value] of Object.entries(piEnv(workspace))) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in saved)) delete process.env[key];
		}
		Object.assign(process.env, saved);
	}
}

/** The slice of pi's SDK these tests use. */
type PiSdk = {
	DefaultResourceLoader: new (options: Record<string, unknown>) => {
		reload(): Promise<void>;
		getExtensions(): { errors: unknown[]; extensions: { sourceInfo: { path: string } }[] };
	};
	createAgentSession(options: Record<string, unknown>): Promise<{ session: SdkSession }>;
	SessionManager: { inMemory(cwd: string): unknown };
	SettingsManager: { create(cwd: string, agentDir: string): unknown };
};

/** The session operations the in-process tests use. */
type SdkSession = {
	prompt(text: string): Promise<void>;
	bindExtensions(bindings: { uiContext: ExtensionUIContext; mode: "tui" }): Promise<void>;
	dispose(): void;
};

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

/** The installed pi package, found from the `pi` binary on PATH, so the tests use the same pi as the CLI. */
function piPackageRoot(): string {
	const bin = (process.env.PATH ?? "")
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
type Request = { provider: string; model: string; check: boolean; system: string; messages: string[] };

/** Every request the test provider wrote, in order. */
function requests(workspace: Workspace): Request[] {
	return readFileSync(workspace.log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Request);
}

/** Every request the Shaper sent the session's model to check a prompt's standing elements. */
function checkRequests(workspace: Workspace): Request[] {
	return requests(workspace).filter(({ check }) => check);
}

/** Every request the session's own model answered for the prompt itself, not for the element check. */
function mainRequests(workspace: Workspace): Request[] {
	return requests(workspace).filter(({ check }) => !check);
}

/** One notice the Shaper showed the Boss through pi's UI. */
type Notice = { message: string; type?: "info" | "warning" | "error" };

/** pi's UI as a test sees it: the notices the Shaper shows the Boss. */
type TestUi = { notices: Notice[]; ui: ExtensionUIContext };

/**
 * The Boss's screen as a test sees it: a recorder for the notices the Shaper shows. It stands in
 * for pi's UI port at the edge, so a test reads the Shaper's report the way the Boss reads it.
 * Only the notice is implemented because it is the one UI the Shaper uses in this slice; pi types
 * the whole port, so the cast avoids a stand-in full of no-ops. The next slice adds the editor.
 */
function makeTestUi(): TestUi {
	const notices: Notice[] = [];
	const ui = {
		notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
	} as unknown as ExtensionUIContext;
	return { notices, ui };
}

/**
 * Type one prompt into a real pi session that loads the package, with the Boss's screen standing
 * in at the UI edge, and return the notices the Shaper showed. What the session's model was
 * asked stays in the test provider's log. The environment is swapped for the session and restored
 * afterwards, so a later test starts clean even though the process is shared.
 */
async function promptInSession(workspace: Workspace, text: string): Promise<TestUi> {
	const testUi = makeTestUi();
	await withPiEnvironment(workspace, async () => {
		const sdk = await loadPiSdk();
		const loader = new sdk.DefaultResourceLoader({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			additionalExtensionPaths: [root, testProvider],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { session } = await sdk.createAgentSession({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			model: MAIN_MODEL,
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(workspace.dir),
			settingsManager: sdk.SettingsManager.create(workspace.dir, workspace.agentDir),
		});
		try {
			await session.bindExtensions({ uiContext: testUi.ui, mode: "tui" });
			await session.prompt(text);
		} finally {
			session.dispose();
		}
	});
	return testUi;
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
	await withPiEnvironment(workspace, async () => {
		const sdk = await loadPiSdk();
		const loader = new sdk.DefaultResourceLoader({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			// The package directory, so pi reads the extension from package.json's pi.extensions.
			additionalExtensionPaths: [root, testProvider],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, [], "every extension the test loads loaded without errors");
		assert.ok(
			loaded.extensions.some(({ sourceInfo }) => realpathSync(sourceInfo.path) === realpathSync(extension)),
			"the Shaper extension is one of the extensions pi loaded",
		);
		const { session } = await sdk.createAgentSession({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			model: MAIN_MODEL,
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(workspace.dir),
			settingsManager: sdk.SettingsManager.create(workspace.dir, workspace.agentDir),
		});
		try {
			await session.prompt(TYPED);
		} finally {
			session.dispose();
		}
	});
	const main = requests(workspace);
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), TYPED, "the main model received the words the Boss typed and nothing else");
});

test("pi loads the package directory, and with shaping off by default the typed prompt reaches the main model untouched", () => {
	const workspace = makeWorkspace();
	const result = runPi(workspace, TYPED);
	assert.equal(result.status, 0, result.stderr);
	const main = requests(workspace).filter((request) => request.provider === "shaper-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), TYPED, "the main model received the words the Boss typed and nothing else");
});

test("a thin prompt engages the Shaper, which reports each standing element as present or missing", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":false,"constraints":false,"done-when":false}',
	});
	const { notices } = await promptInSession(workspace, THIN);
	assert.deepEqual(
		notices.map(({ message }) => message),
		["Shaper: thin prompt. goal present; context missing; constraints missing; done-when missing"],
		"the Boss is told which standing elements the thin prompt carries and which it lacks",
	);
	assert.equal(
		mainRequests(workspace).at(-1)?.messages.at(-1),
		THIN,
		"the main model received the words the Boss typed and nothing else",
	);
});

test("a complete typed prompt passes through untouched, and the Shaper says nothing", async () => {
	const workspace = makeWorkspace({ settings: SHAPING_ON });
	const { notices } = await promptInSession(workspace, COMPLETE);
	const main = mainRequests(workspace);
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), COMPLETE, "the main model received the words the Boss typed and nothing else");
	assert.deepEqual(notices, [], "the Boss was told nothing, because every element was present");
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

test("a prompt missing its context reports the context missing and the other standing elements present", async () => {
	const workspace = makeWorkspace({
		settings: SHAPING_ON,
		check: '{"goal":true,"context":false,"constraints":true,"done-when":true}',
	});
	const { notices } = await promptInSession(workspace, NO_CONTEXT);
	assert.deepEqual(
		notices.map(({ message }) => message),
		["Shaper: thin prompt. goal present; context missing; constraints present; done-when present"],
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
	const workspace = makeWorkspace({ settings: SHAPING_ON });
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
