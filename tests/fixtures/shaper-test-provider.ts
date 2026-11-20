/**
 * The outside service the Shaper's tests talk to: a pi provider at the edge that plays the
 * session's own model. It answers with SHAPER_TEST_REPLY, and writes every request as one JSON
 * object a line to SHAPER_TEST_LOG, with the system prompt and message text the request carried,
 * so a test can see what the main agent received without reading inside the extension.
 *
 * The settings are read at request time, not at load time, so one test process can run several
 * sessions through a fresh environment.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	getSystemMessageText,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** The provider this fixture registers, which stands for the model the session runs on. */
const provider = "shaper-test";
const api = "shaper-test";

/** One test setting, read at request time so a fresh environment per test is enough. */
const setting = (name: string, fallback: string): string => process.env[name] ?? fallback;

const model = (id: string) => ({
	id,
	name: id,
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});

/** One assistant message carrying its text. */
const message = (requested: Model<Api>, text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

/**
 * The system prompt a request carries: the context's plain prompt, then each system message
 * rendered as pi renders it, sections included. A system message that patches named prompt
 * sections carries no text in `content`, so skipping the sections would hide it.
 */
function systemOf(context: Context): string {
	const systemMessages = context.messages.flatMap((entry) =>
		entry.role === "system" ? [getSystemMessageText(entry)] : [],
	);
	return [context.systemPrompt ?? "", ...systemMessages].filter(Boolean).join("\n");
}

/** The text a message carries. */
const textOf = (entry: unknown): string => {
	if (typeof entry !== "object" || entry === null) return "";
	const { content } = entry as { content?: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
};

/** The one request the log records, so a test can see what the model was sent. */
function record(requested: Model<Api>, context: Context): void {
	appendFileSync(
		setting("SHAPER_TEST_LOG", "/dev/null"),
		`${JSON.stringify({
			provider: requested.provider,
			model: requested.id,
			system: systemOf(context),
			messages: context.messages.filter((entry) => entry.role !== "system").map(textOf),
		})}\n`,
	);
}

/** One reply, as pi's stream of events. */
function replyOf(requested: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const reply = message(requested, text);
	stream.push({ type: "start", partial: reply });
	stream.push({ type: "text_start", contentIndex: 0, partial: reply });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: reply });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: reply });
	stream.push({ type: "done", reason: "stop", message: reply });
	return stream;
}

export default function shaperTestProvider(pi: ExtensionAPI): void {
	pi.registerProvider(provider, {
		name: "Shaper test provider: the session's own model",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("main")],
		streamSimple: (requested: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
			record(requested, context);
			return replyOf(requested, setting("SHAPER_TEST_REPLY", "answered"));
		},
	});
}
