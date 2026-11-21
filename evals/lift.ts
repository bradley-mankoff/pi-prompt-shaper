/**
 * The Shaper's lift, measured: replay thin prompts with and without shaping and count the
 * correction turns each way.
 *
 * This is a separate harness, not part of `npm test` (Spec pp-csw, Testing Decisions). It runs real
 * pi sessions against a real model, so it needs the Boss's credentials in pi's agent folder and a
 * network. The corpus in `evals/cases.jsonl` is written by hand for the harness, not drawn from a
 * Correction log. For each case in it the harness runs four arms:
 *
 * - the thin prompt as the Boss typed it, with shaping off;
 * - the same thin prompt, with shaping on;
 * - the clear variant, the same task fully stated, with shaping off;
 * - the clear variant, with shaping on.
 *
 * The clear arms are the control: a judge that asks for corrections on a complete prompt would be
 * measuring itself, not the Shaper. In every arm a main agent answers with no tools, as a replay;
 * a judge model then checks the answer against the case's named facts (the file, the change, the
 * constraint and the check the full task states) and names the ones it does not state. The harness
 * sends those facts back as one correction turn, until nothing is missing or the turn cap is
 * reached.
 *
 * The number reported is the mean correction turns on the thin prompt without shaping minus the
 * mean with shaping. The Shaper shapes from what the session knows: the workspace is a git repo on
 * the case's branch with the case's context in a Beads memory, and its agent folder has no scout,
 * so a gap the model cannot fill becomes the question round, which the harness's Boss answers with
 * yes. The main agent's system prompt has no tools, so a complete plan is its answer; the judge is
 * told that, and judges completeness against the task, not style.
 *
 * Shaping is the only variable. The Shaper's own model is the session's model, as in the product.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The package root, so the session loads this repo's extension. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The question the model sees when it judges one answer. */
const JUDGE_INSTRUCTIONS = `You are the Boss grading an assistant's answer to a coding task in a small TypeScript project. The task as you would have written it in full is below, followed by the facts it requires, each with a name.

For each named fact, decide whether the assistant's answer states its substance. A fact is stated when the answer gives it, even in different words; the exact wording is not required. The assistant cannot run tools in this replay, so "I cannot run tools" is not a missing fact, and a complete plan counts as a complete answer. Do not require anything the task does not state.

Answer with exactly {"missing":["<name>",...]} and nothing else, naming only the facts the answer does not state, in the order they are listed. Each entry is the fact's name alone, never its value. If every fact is stated, answer {"missing":[]}.`;

/** The system prompt of the replayed main agent: no tools, a plan, and the task's own facts stated when known. */
const AGENT_SYSTEM_PROMPT = `You are a coding assistant working in a small TypeScript project. You cannot run tools in this replay. Answer the request in prose, in at most 80 words. Name the file, the change or finding, the constraint, and the check when you know them. If the request lacks something you need, say exactly what is missing.`;

/** How many correction turns one arm may take before the harness stops and counts the cap. */
const MAX_CORRECTION_TURNS = 3;

/** One prompt in the corpus, and the session facts that let the Shaper fill what it lacks. */
type EvalCase = {
	id: string;
	type: string;
	/** The thin prompt as the Boss typed it. */
	thin: string;
	/** The same task fully stated: the standard the judge grades against. */
	clear: string;
	/** What the project's Beads remember: the session's own words for the missing facts. */
	context: string;
	branch: string;
	/** The facts the full task states, by name, so the judge checks for each instead of judging the whole answer. */
	facts: Record<string, string>;
};

/** Which prompt an arm sends. */
type Variant = "thin" | "clear";

/** An arm's identity: the prompt it sends, and whether shaping is on for it. */
type ArmKind = { variant: Variant; shaping: boolean };

/** What one arm of one case did. */
type ArmRun = { turns: number; shapes: number; capped: boolean };

/** One arm's results over every case. */
type Arm = ArmKind & {
	runs: ArmRun[];
};

/** The model a run uses, as the catalogue names it. */
type ModelRef = { provider: string; id: string };

/** What the harness is asked to do. */
type Options = {
	model: string;
	judge: string;
	limit?: number;
	verbose: boolean;
	keep: boolean;
};

/** One temporary Mac for a case: a git repo, a Beads memory, and an agent folder with no scout. */
type Workspace = { dir: string; agentDir: string };

/** The slice of pi's SDK the harness uses. */
type PiSdk = {
	ModelRuntime: { create(options?: Record<string, unknown>): Promise<PiRuntime> };
	DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
	createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
	SessionManager: { inMemory(cwd: string): unknown };
	SettingsManager: { create(cwd: string, agentDir: string): unknown };
};

/** The model runtime, which resolves credentials and makes the judge's call. */
type PiRuntime = {
	getModel(provider: string, id: string): Record<string, unknown> | undefined;
	complete(
		model: Record<string, unknown>,
		context: Record<string, unknown>,
		options?: { sessionId?: string },
	): Promise<PiMessage>;
};

/** One message the session or a model call carries. */
type PiMessage = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };

/** The session operations the replay uses. */
type PiSession = {
	prompt(text: string): Promise<void>;
	bindExtensions(bindings: { uiContext: unknown; mode: "tui" }): Promise<void>;
	messages: PiMessage[];
	dispose(): void;
};

/** The models, SDK and options every case's arms share, so an arm takes the harness, not its parts. */
type Harness = {
	sdk: PiSdk;
	runtime: PiRuntime;
	model: Record<string, unknown>;
	judgeModel: Record<string, unknown>;
	options: Options;
};

/** The text a message carries: its string content, or the text parts of its content. */
function textOf(message: PiMessage | undefined): string {
	if (message === undefined) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("");
}

/** The one JSON object a reply carries, or `undefined` when it is not one. A fence is unwrapped first. */
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

/** The facts a verdict names as missing, or `undefined` when the reply is not that verdict. */
function missingOf(reply: string): string[] | undefined {
	const parsed = readJsonObject(reply);
	if (parsed === undefined) return undefined;
	const { missing } = parsed;
	if (!Array.isArray(missing)) return undefined;
	return missing.flatMap((entry) => (typeof entry === "string" && entry.trim() !== "" ? [entry.trim()] : []));
}

/** Split `provider/id` the way pi's model pattern does, defaulting to opencode-go. */
function modelRef(name: string): ModelRef {
	const at = name.indexOf("/");
	return at === -1 ? { provider: "opencode-go", id: name } : { provider: name.slice(0, at), id: name.slice(at + 1) };
}

/** The options the harness takes, with the model and judge it runs unless told otherwise. */
function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		model: "opencode-go/kimi-k3.1-pro",
		judge: "opencode-go/deepseek-v4.1-flash",
		verbose: false,
		keep: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--model") options.model = argv[++index] ?? options.model;
		else if (arg === "--judge") options.judge = argv[++index] ?? options.judge;
		else if (arg === "--limit") options.limit = Number(argv[++index]);
		else if (arg === "--verbose") options.verbose = true;
		else if (arg === "--keep") options.keep = true;
		else if (arg === "--help" || arg === "-h") {
			console.log("usage: npm run eval -- [--model provider/id] [--judge provider/id] [--limit n] [--verbose] [--keep]");
			process.exit(0);
		} else {
			throw new Error(`unknown option: ${arg}`);
		}
	}
	return options;
}

/** The corpus, read from the file beside this script, with every field it needs. */
function loadCases(): EvalCase[] {
	const text = readFileSync(join(root, "evals", "cases.jsonl"), "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EvalCase)
		.map((entry) => {
			for (const field of ["id", "type", "thin", "clear", "context", "branch"] as const) {
				if (typeof entry[field] !== "string" || entry[field].trim() === "") {
					throw new Error(`a case is missing its ${field}: ${JSON.stringify(entry)}`);
				}
			}
			if (typeof entry.facts !== "object" || entry.facts === null || Object.keys(entry.facts).length === 0) {
				throw new Error(`a case is missing its facts: ${JSON.stringify(entry)}`);
			}
			return entry;
		});
}

/** The PATH the harness started with, so the installed pi is found past any stand-in on PATH. */
const startupPath = process.env.PATH ?? "";

/** The installed pi package, found from the `pi` binary on PATH, so the harness uses the same pi as the CLI. */
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
const loadSdk = async (): Promise<PiSdk> =>
	(await import(pathToFileURL(join(piPackageRoot(), "dist", "index.js")).href)) as PiSdk;

/** One command, run in the workspace, failing the harness when it does not succeed. */
function run(cwd: string, command: string, args: string[]): void {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
}

/**
 * A temporary Mac for one case: a git repo on the case's branch with one empty commit, a Beads
 * memory carrying the case's context, and an agent folder with the settings the arm writes. There
 * is no scout definition, so a gap the session cannot fill goes to the question round instead of a
 * separate lookup, which keeps a replay bounded.
 */
function prepareWorkspace(entry: EvalCase): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "pi-shaper-eval-"));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	run(dir, "git", ["init", "-q", "-b", entry.branch, "."]);
	run(dir, "git", ["-c", "user.name=Shaper Eval", "-c", "user.email=eval@example.com", "commit", "--allow-empty", "-qm", "fixture"]);
	run(dir, "bd", ["init"]);
	run(dir, "bd", ["remember", "--key", entry.id, entry.context]);
	return { dir, agentDir };
}

/** The pi's agent folder, where the real credentials live; `PI_CODING_AGENT_DIR` wins when it is set. */
const realAgentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

/** One open replay: the session, the last editor text the Shaper set, and the case's data folder. */
type Replay = {
	session: PiSession;
	/** The text the Shaper last put in the editor, or "" when it put nothing there. */
	takeEditor(): string;
};

/**
 * Open the replay's session: a real pi session that loads this package, with the Boss's screen
 * standing in at the UI edge. The stand-in records the editor text instead of drawing it, and
 * answers a question round with the one word that accepts every suggestion. The session's model
 * plays both the Shaper's model and the main agent, as the product does.
 */
async function openReplay(harness: Harness, workspace: Workspace): Promise<Replay> {
	let editor = "";
	const loader = new harness.sdk.DefaultResourceLoader({
		cwd: workspace.dir,
		agentDir: workspace.agentDir,
		additionalExtensionPaths: [root],
		// Nothing but the package and this replay's own prompt: no skills, templates or project files
		// add context the Shaper or the agent could read.
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: AGENT_SYSTEM_PROMPT,
	});
	await loader.reload();
	const { session } = await harness.sdk.createAgentSession({
		cwd: workspace.dir,
		agentDir: workspace.agentDir,
		model: harness.model,
		modelRuntime: harness.runtime,
		resourceLoader: loader,
		sessionManager: harness.sdk.SessionManager.inMemory(workspace.dir),
		settingsManager: harness.sdk.SettingsManager.create(workspace.dir, workspace.agentDir),
		// The eval runs at pi's lowest thinking level, so a full corpus finishes in minutes; the
		// product's own sessions keep whatever level the Boss has set.
		thinkingLevel: "low",
		noTools: "all",
	});
	await session.bindExtensions({
		uiContext: {
			notify: () => {},
			setEditorText: (text: string) => {
				editor = text;
			},
			editor: async (_title: string, prefill = "") => `${prefill} yes`,
		},
		mode: "tui",
	});
	return {
		session,
		takeEditor: () => {
			const text = editor;
			editor = "";
			return text;
		},
	};
}

/**
 * Type one prompt and answer with what the main agent said. A shape the Shaper offers is accepted
 * first, as the Boss accepts it, so the main agent receives the shaped text; a prompt the Shaper
 * passes through goes to the main agent as typed. A model error stops the replay rather than
 * counting as a correction the Shaper should have prevented.
 */
async function askAgent(replay: Replay, text: string): Promise<string> {
	await replay.session.prompt(text);
	const shaped = replay.takeEditor();
	if (shaped !== "") await replay.session.prompt(shaped);
	const reply = [...replay.session.messages].reverse().find((message) => message.role === "assistant");
	if (reply === undefined) throw new Error("the session has no assistant message");
	if (reply.stopReason === "error") throw new Error(`the main model failed: ${reply.errorMessage ?? "no message"}`);
	return textOf(reply);
}

/** The facts the task states, written for the judge one per line. */
function factsText(entry: EvalCase): string {
	return Object.entries(entry.facts)
		.map(([name, text]) => `- ${name}: ${text}`)
		.join("\n");
}

/**
 * Ask the judge which of the task's facts the answer does not state. An unknown fact name is a
 * malformed verdict, not a correction: the harness stops rather than count a turn against a fact
 * the case never named.
 */
async function judge(harness: Harness, entry: EvalCase, reply: string): Promise<string[]> {
	const answer = await harness.runtime.complete(
		harness.judgeModel,
		{
			systemPrompt: JUDGE_INSTRUCTIONS,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `The task as fully written:\n${entry.clear}\n\nThe facts it requires:\n${factsText(entry)}\n\nThe assistant's answer:\n${reply}`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		// opencode's providers answer 400 MissingSessionID unless the request carries a session.
		{ sessionId: randomUUID() },
	);
	const text = textOf(answer);
	const missing = missingOf(text);
	if (missing === undefined) throw new Error(`the judge's reply was not a missing-facts object: ${text}`);
	const names = missing.map((said) => {
		const name = Object.keys(entry.facts).find((fact) => new RegExp(`^${fact}\\b`, "i").test(said));
		if (name === undefined) throw new Error(`the judge named a fact the case does not have: ${said}`);
		return name;
	});
	return [...new Set(names)];
}

/** The correction the Boss would type: the missing facts in one message, so one turn supplies them all. */
function correctionMessage(entry: EvalCase, missing: readonly string[]): string {
	const facts = missing.map((name) => `${name} is ${entry.facts[name]}`);
	return `The task also states these facts, so use them and answer again: ${facts.join("; ")}.`;
}

/** How many shapes one arm's Correction log holds, read from the log the Shaper wrote. */
function shapeCount(dataDir: string): number {
	const path = join(dataDir, "pi-shaper", "corrections.jsonl");
	if (!existsSync(path)) return 0;
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { outcome?: string })
		.filter(({ outcome }) => outcome === "shaped").length;
}

/** The word the report and an arm's folder give to whether shaping is on, so they cannot disagree. */
const shapingWord = (shaping: boolean): string => (shaping ? "on" : "off");

/**
 * One arm of one case: the prompt, the judge's corrections, and the turns they cost. The arm's
 * settings and its Correction log live in a folder of their own, so the four arms of a case never
 * read each other's shapes.
 */
async function runArm(harness: Harness, workspace: Workspace, entry: EvalCase, arm: ArmKind): Promise<ArmRun> {
	const { variant, shaping } = arm;
	writeFileSync(join(workspace.agentDir, "settings.json"), JSON.stringify({ shaper: { enabled: shaping } }));
	const dataDir = join(workspace.dir, "data", `${variant}-${shapingWord(shaping)}`);
	mkdirSync(dataDir, { recursive: true });
	const savedDataHome = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dataDir;
	const replay = await openReplay(harness, workspace);
	try {
		let reply = await askAgent(replay, variant === "thin" ? entry.thin : entry.clear);
		if (harness.options.verbose) console.error(`    reply: ${reply}`);
		let turns = 0;
		while (turns < MAX_CORRECTION_TURNS) {
			const missing = await judge(harness, entry, reply);
			if (missing.length === 0) break;
			turns += 1;
			if (harness.options.verbose) console.error(`    missing: ${missing.join(", ")}`);
			reply = await askAgent(replay, correctionMessage(entry, missing));
			if (harness.options.verbose) console.error(`    reply: ${reply}`);
		}
		const shapes = shapeCount(dataDir);
		if (harness.options.verbose) {
			console.error(`    ${variant}/${shapingWord(shaping)}: ${turns} turns, ${shapes} shape(s)`);
		}
		return { turns, shapes, capped: turns === MAX_CORRECTION_TURNS };
	} finally {
		replay.session.dispose();
		if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedDataHome;
	}
}

/** The mean of a list of numbers, or 0 for an empty list. */
const mean = (values: readonly number[]): number =>
	values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** How a number is written in the report: two places, so a lift below one still reads. */
const twoPlaces = (value: number): string => value.toFixed(2);

/** The arm's name as the report shows it. */
const armName = ({ variant, shaping }: Arm): string => `${variant}, shaping ${shapingWord(shaping)}`;

/** The mean correction turns of one arm, or 0 when it has not run. */
const meanTurns = (arm: Arm | undefined): number => mean(arm?.runs.map(({ turns }) => turns) ?? []);

/** The report: every arm, then the one number the Bead asks for. */
function report(arms: Arm[], caseCount: number, options: Options): void {
	const thinOff = arms.find((arm) => arm.variant === "thin" && !arm.shaping);
	const thinOn = arms.find((arm) => arm.variant === "thin" && arm.shaping);
	const lift = meanTurns(thinOff) - meanTurns(thinOn);
	console.log(
		`Shaper lift: ${twoPlaces(lift)} correction turns per task (thin prompts: ${twoPlaces(meanTurns(thinOff))} without shaping, ${twoPlaces(meanTurns(thinOn))} with)`,
	);
	console.log("");
	console.log("  arm                    corrections/task   shapes");
	for (const arm of arms) {
		const shapedRuns = arm.runs.filter(({ shapes: count }) => count > 0).length;
		console.log(
			`  ${armName(arm).padEnd(22)} ${twoPlaces(meanTurns(arm)).padStart(16)}   ${shapedRuns}/${arm.runs.length}`,
		);
	}
	console.log("");
	console.log(`  prompts ${caseCount} · model ${options.model} · judge ${options.judge}`);
	const capped = arms.flatMap(({ runs }) => runs).filter(({ capped }) => capped).length;
	if (capped > 0) console.log(`  ${capped} arm(s) reached the ${MAX_CORRECTION_TURNS}-turn cap`);
}

/** Run the corpus, arm by arm, and report the lift. */
async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const cases = loadCases().slice(0, options.limit);
	const sdk = await loadSdk();
	const runtime = await sdk.ModelRuntime.create({
		authPath: join(realAgentDir(), "auth.json"),
		modelsPath: join(realAgentDir(), "models.json"),
	});
	const modelRefs = modelRef(options.model);
	const judgeRef = modelRef(options.judge);
	const model = runtime.getModel(modelRefs.provider, modelRefs.id);
	const judgeModel = runtime.getModel(judgeRef.provider, judgeRef.id);
	if (model === undefined) throw new Error(`the model ${options.model} is not in pi's catalogue`);
	if (judgeModel === undefined) throw new Error(`the judge ${options.judge} is not in pi's catalogue`);
	const harness: Harness = { sdk, runtime, model, judgeModel, options };

	const arms: Arm[] = [
		{ variant: "thin", shaping: false, runs: [] },
		{ variant: "thin", shaping: true, runs: [] },
		{ variant: "clear", shaping: false, runs: [] },
		{ variant: "clear", shaping: true, runs: [] },
	];
	const workspaces: Workspace[] = [];
	try {
		for (const entry of cases) {
			console.error(`case ${entry.id} (${entry.type})`);
			const workspace = prepareWorkspace(entry);
			workspaces.push(workspace);
			for (const arm of arms) {
				arm.runs.push(await runArm(harness, workspace, entry, arm));
			}
		}
		report(arms, cases.length, options);
	} finally {
		if (!options.keep) for (const workspace of workspaces) rmSync(workspace.dir, { recursive: true, force: true });
	}
}

await main();
