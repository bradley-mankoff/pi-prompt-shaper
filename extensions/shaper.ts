/**
 * pi-shaper: the Shaper lifts thin typed prompts toward a consistent high-quality shape.
 *
 * This is the scaffold. The package installs, loads and does nothing to a prompt yet: shaping is
 * opt-in under the `shaper.enabled` setting, which is off when it is absent, so the Tweaker's
 * silence stays the default (pp-csw). Shaping arrives one slice at a time; until then a typed
 * prompt goes to the main agent exactly as it was typed, whatever the setting says.
 *
 * The seam is the real pi session (see tests/shaper.test.ts): this file wires pi's `input` event
 * to the Shaper, and the tests type a prompt through pi and read what the main agent received.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function shaper(pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Shaper's.
		if (event.text.startsWith("/")) return { action: "continue" };
		// Shaping is opt-in and off by default, so a prompt is untouched unless the Boss turned it on.
		if (!shapingEnabled(pi.getSettings())) return { action: "continue" };
		// This slice has no shaping to do; the next slice fills this branch (pp-csw.2 and after).
		return { action: "continue" };
	});
}
