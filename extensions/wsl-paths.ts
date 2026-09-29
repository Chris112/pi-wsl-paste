/**
 * WSL paste helpers.
 *
 * 1. Windows paths dropped onto the terminal become WSL paths as they are pasted:
 *      "C:\Users\me\Downloads\shot 1.png"  ->  "/mnt/c/Users/me/Downloads/shot 1.png"
 *      \\wsl.localhost\Ubuntu\home\me\x    ->  /home/me/x
 *    Only a paste made up entirely of Windows paths is rewritten (a file drop), so pasted
 *    code or prose that merely mentions a Windows path is left untouched.
 *
 * 2. Pi's image-paste key (Alt+V on WSL) saves a clipboard image, e.g. a Snipping Tool
 *    capture, to the pi-clipboard cache folder and pastes the file's path. So does Ctrl+V:
 *    with only an image on the clipboard, Windows Terminal (checked on 1.24) sends an empty
 *    paste. If pi-paster is installed it turns that path into an [#image N] attachment.
 *    Snips older than 7 days are deleted when pi starts.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, type KeyId, Loader, matchesKey } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const TOKEN = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
const SNIP_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-clipboard");
const SNIP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const IS_WSL = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

const execFileAsync = promisify(execFile);

export function toWslPath(winPath: string): string | undefined {
	const drive = /^([A-Za-z]):[\\/](.*)$/s.exec(winPath);
	if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;

	const wslShare = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/is.exec(winPath);
	if (wslShare) return (wslShare[1] ?? "\\").replace(/\\/g, "/");

	return undefined;
}

export function convertDroppedPaths(text: string): string | undefined {
	if (text.trim() === "" || text.replace(TOKEN, "").trim() !== "") return undefined;

	let allPaths = true;
	const converted = text.replace(TOKEN, (token, doubleQuoted, singleQuoted, bare) => {
		const wsl = toWslPath(doubleQuoted ?? singleQuoted ?? bare);
		if (wsl === undefined) {
			allPaths = false;
			return token;
		}
		const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
		return quote + wsl + quote;
	});

	return allPaths ? converted : undefined;
}

export function rewritePaste(data: string): { data: string } | undefined {
	const start = data.indexOf(PASTE_START);
	if (start === -1) return undefined;
	const contentStart = start + PASTE_START.length;
	const end = data.indexOf(PASTE_END, contentStart);
	if (end === -1) return undefined;

	const converted = convertDroppedPaths(data.slice(contentStart, end));
	if (converted === undefined) return undefined;
	return { data: data.slice(0, contentStart) + converted + data.slice(end) };
}

export function snipFileName(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `snip-${day}-${time}.png`;
}

export function nextSnipPath(dir: string, date: Date, exists: (path: string) => boolean = existsSync): string {
	const base = snipFileName(date).replace(/\.png$/, "");
	let candidate = join(dir, `${base}.png`);
	for (let n = 2; exists(candidate); n++) candidate = join(dir, `${base}-${n}.png`);
	return candidate;
}

export function isExpiredSnip(name: string, mtimeMs: number, nowMs: number): boolean {
	return /^snip-.*\.png$/.test(name) && nowMs - mtimeMs > SNIP_MAX_AGE_MS;
}

/** Keys bound to pi's app.clipboard.pasteImage action, given the parsed keybindings.json. */
export function pasteImageKeys(config: unknown): KeyId[] {
	const bound = (config as Record<string, unknown> | undefined)?.["app.clipboard.pasteImage"];
	if (typeof bound === "string") return [bound as KeyId];
	if (Array.isArray(bound)) return bound.filter((key): key is KeyId => typeof key === "string");
	return ["alt+v"];
}

export function isPasteImageKey(data: string, keys: KeyId[]): boolean {
	return !isKeyRelease(data) && keys.some((key) => matchesKey(data, key));
}

export function isEmptyPaste(data: string): boolean {
	return data === PASTE_START + PASTE_END;
}

/** Pi's spinner without the blank line Loader puts above itself. */
export class InlineLoader extends Loader {
	override render(width: number): string[] {
		return super.render(width).slice(1);
	}

	dispose(): void {
		this.stop();
	}
}

function readKeybindingsConfig(): unknown {
	try {
		return JSON.parse(readFileSync(join(getAgentDir(), "keybindings.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/** Saves the Windows clipboard image as a PNG and returns its path, or undefined if the clipboard holds no image. */
async function saveClipboardImage(): Promise<string | undefined> {
	await mkdir(SNIP_DIR, { recursive: true });
	const file = nextSnipPath(SNIP_DIR, new Date());
	const winPath = (await execFileAsync("wslpath", ["-w", file])).stdout.trim();
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		`if ($img) { $img.Save('${winPath.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'empty' }`,
	].join("; ");
	const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
		timeout: 15_000,
	});
	return stdout.trim() === "ok" && existsSync(file) ? file : undefined;
}

async function pruneOldSnips(): Promise<void> {
	const now = Date.now();
	for (const name of await readdir(SNIP_DIR).catch(() => [])) {
		const path = join(SNIP_DIR, name);
		const { mtimeMs } = await stat(path);
		if (isExpiredSnip(name, mtimeMs, now)) await unlink(path);
	}
}

export default function (pi: ExtensionAPI) {
	let unsubscribe: (() => void) | undefined;
	let reading = false;

	async function pasteClipboardImage(ctx: ExtensionContext): Promise<void> {
		reading = true;
		ctx.ui.setWidget("wsl-paste", (tui, theme) => {
			const dim = (text: string) => theme.fg("dim", text);
			return new InlineLoader(tui, dim, dim, "reading clipboard…");
		});
		try {
			const file = await saveClipboardImage();
			if (file) ctx.ui.pasteToEditor(file);
			else ctx.ui.notify("No image on the clipboard", "info");
		} catch (error) {
			ctx.ui.notify(`Couldn't read the clipboard image: ${error instanceof Error ? error.message : error}`, "warning");
		} finally {
			reading = false;
			ctx.ui.setWidget("wsl-paste", undefined);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unsubscribe?.();

		const imageKeys = IS_WSL ? pasteImageKeys(readKeybindingsConfig()) : [];
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (isPasteImageKey(data, imageKeys) || (IS_WSL && isEmptyPaste(data))) {
				if (!reading) void pasteClipboardImage(ctx);
				return { consume: true };
			}
			return rewritePaste(data);
		});

		if (IS_WSL) pruneOldSnips().catch(() => {});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
