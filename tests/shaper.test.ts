/**
 * The seam the Bead's Spec names: a real pi session that loads the Shaper, with a test provider
 * at the provider edge playing the session's own model. A test types a prompt the way the Boss
 * does and checks what the main model received; it never reads inside the extension.
 *
 * The first test runs pi's SDK in-process, so it can ask the resource loader which extensions
 * loaded before it types a prompt. The second drives the installed `pi` command with the package
 * directory, as `pi install` will.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "shaper.ts");
const testProvider = join(root, "tests", "fixtures", "shaper-test-provider.ts");

/** The prompt every test types, worded the way a thin prompt is: a goal and nothing else. */
const TYPED = "fix the login bug";

/** One temporary Mac: a HOME, an agent folder, and the test provider's log. */
type Workspace = { dir: string; home: string; agentDir: string; log: string };

/** Every workspace this file made, removed once its tests are done. */
const workspaces: Workspace[] = [];

after(() => {
	for (const workspace of workspaces) rmSync(workspace.dir, { recursive: true, force: true });
});

/** A temporary Mac for one test. */
function makeWorkspace(): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "pi-shaper-"));
	const home = join(dir, "home");
	const agentDir = join(dir, "pi-agent");
	const log = join(dir, "requests.jsonl");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const workspace = { dir, home, agentDir, log };
	// The log exists, empty, from the start: a test reads it before any request is written, so a
	// missing file stays a fault instead of answering the same as no request.
	writeFileSync(log, "");
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

/** The session operations the in-process test uses. */
type SdkSession = { prompt(text: string): Promise<void>; dispose(): void };

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
type Request = { provider: string; model: string; system: string; messages: string[] };

/** Every request the test provider wrote, in order. */
function requests(workspace: Workspace): Request[] {
	return readFileSync(workspace.log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Request);
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
			additionalExtensionPaths: [extension, testProvider],
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
