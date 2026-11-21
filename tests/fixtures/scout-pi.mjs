#!/usr/bin/env node
/**
 * The scout agent's pi process, standing in for the true external the Shaper reaches at its edge.
 *
 * The Shaper sends a gap to the scout agent by starting pi with the scout's own definition. A test
 * puts this file on PATH as `pi`, so the process the Shaper would start is a stand-in that answers
 * with SHAPER_TEST_SCOUT_REPLY and writes every call it received as one JSON line to
 * SHAPER_TEST_SCOUT_LOG. A test reads the log to see how the scout was asked, and the editor to see
 * what the Shaper made of the answer; it never reaches inside the extension.
 */
import { appendFileSync } from "node:fs";

const log = process.env.SHAPER_TEST_SCOUT_LOG;
if (log !== undefined) {
	appendFileSync(log, `${JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })}\n`);
}

const reply = process.env.SHAPER_TEST_SCOUT_REPLY ?? "";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } }));
