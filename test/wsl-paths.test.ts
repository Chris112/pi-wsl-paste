import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	convertDroppedPaths,
	InlineLoader,
	isEmptyPaste,
	isExpiredSnip,
	isPasteImageKey,
	nextSnipPath,
	pasteImageKeys,
	rewritePaste,
	snipFileName,
} from "../extensions/wsl-paths.ts";

describe("dropped Windows paths", () => {
	test("quoted drive path with spaces", () =>
		assert.equal(
			convertDroppedPaths(String.raw`"C:\Users\me\Downloads\Screenshot 2026-09-29 165713.png"`),
			`"/mnt/c/Users/me/Downloads/Screenshot 2026-09-29 165713.png"`,
		));
	test("unquoted drive path", () => assert.equal(convertDroppedPaths(String.raw`C:\Users\me\a.png`), "/mnt/c/Users/me/a.png"));
	test("single-quoted path on another drive", () => assert.equal(convertDroppedPaths(String.raw`'D:\x y\z.txt'`), "'/mnt/d/x y/z.txt'"));
	test("several files dropped at once", () =>
		assert.equal(convertDroppedPaths(String.raw`"C:\a b.png" C:\c.png`), `"/mnt/c/a b.png" /mnt/c/c.png`));
	test("wsl.localhost share", () =>
		assert.equal(convertDroppedPaths(String.raw`\\wsl.localhost\Ubuntu-24.04\home\me\f.txt`), "/home/me/f.txt"));
	test("wsl$ share", () => assert.equal(convertDroppedPaths(String.raw`\\wsl$\Ubuntu\etc`), "/etc"));
	test("prose mentioning a path is left alone", () =>
		assert.equal(convertDroppedPaths(String.raw`see C:\Users\me\a.png please`), undefined));
	test("code containing a path is left alone", () =>
		assert.equal(convertDroppedPaths(String.raw`{"path": "C:\\Program Files"}`), undefined));
	test("linux path is left alone", () => assert.equal(convertDroppedPaths("/home/me/already.png"), undefined));
	test("blank paste is left alone", () => assert.equal(convertDroppedPaths("   "), undefined));
	test("bracketed paste is rewritten", () =>
		assert.deepEqual(rewritePaste(`\x1b[200~"C:\\a b\\c.png"\x1b[201~`), { data: `\x1b[200~"/mnt/c/a b/c.png"\x1b[201~` }));
	test("typed input is left alone", () => assert.equal(rewritePaste("C:\\typed"), undefined));
});

describe("snip files", () => {
	const at = new Date(2026, 8, 29, 17, 12, 3); // local time; months are 0-based
	const DAY = 24 * 60 * 60 * 1000;
	const now = at.getTime();

	test("name uses the local timestamp", () => assert.equal(snipFileName(at), "snip-20260929-171203.png"));
	test("path when the name is free", () =>
		assert.equal(nextSnipPath("/c", at, () => false), join("/c", "snip-20260929-171203.png")));
	test("path avoids taken names", () => {
		const taken = new Set([join("/c", "snip-20260929-171203.png"), join("/c", "snip-20260929-171203-2.png")]);
		assert.equal(nextSnipPath("/c", at, (path) => taken.has(path)), join("/c", "snip-20260929-171203-3.png"));
	});
	test("snips older than 7 days expire", () =>
		assert.equal(isExpiredSnip("snip-20260901-000000.png", now - 8 * DAY, now), true));
	test("recent snips are kept", () => assert.equal(isExpiredSnip("snip-20260928-000000.png", now - DAY, now), false));
	test("other files are never pruned", () => assert.equal(isExpiredSnip("notes.txt", now - 30 * DAY, now), false));
});

describe("image paste trigger", () => {
	test("default key is alt+v", () => assert.deepEqual(pasteImageKeys(undefined), ["alt+v"]));
	test("default when the action is not remapped", () =>
		assert.deepEqual(pasteImageKeys({ "app.session.new": "ctrl+n" }), ["alt+v"]));
	test("remapped to one key", () =>
		assert.deepEqual(pasteImageKeys({ "app.clipboard.pasteImage": "ctrl+alt+v" }), ["ctrl+alt+v"]));
	test("remapped to several keys", () =>
		assert.deepEqual(pasteImageKeys({ "app.clipboard.pasteImage": ["alt+v", "ctrl+shift+v"] }), ["alt+v", "ctrl+shift+v"]));
	test("unbinding disables the key", () => assert.deepEqual(pasteImageKeys({ "app.clipboard.pasteImage": [] }), []));

	test("ESC v is alt+v", () => assert.equal(isPasteImageKey("\x1bv", ["alt+v"]), true));
	test("plain v is not", () => assert.equal(isPasteImageKey("v", ["alt+v"]), false));
	test("a paste is not a key", () => assert.equal(isPasteImageKey("\x1b[200~v\x1b[201~", ["alt+v"]), false));
	test("no bound keys never match", () => assert.equal(isPasteImageKey("\x1bv", []), false));

	// Windows Terminal sends an empty paste for Ctrl+V when the clipboard holds only an image.
	test("empty paste is detected", () => assert.equal(isEmptyPaste("\x1b[200~\x1b[201~"), true));
	test("text paste is not empty", () => assert.equal(isEmptyPaste("\x1b[200~hello\x1b[201~"), false));
	test("whitespace paste is not empty", () => assert.equal(isEmptyPaste("\x1b[200~ \x1b[201~"), false));
	test("alt+v is not an empty paste", () => assert.equal(isEmptyPaste("\x1bv"), false));
});

describe("progress spinner", () => {
	test("renders on one line", () => {
		const loader = new InlineLoader({ requestRender() {} } as never, (s) => s, (s) => s, "reading clipboard…");
		try {
			const lines = loader.render(80);
			assert.equal(lines.length, 1);
			assert.match(lines[0], /⠋ reading clipboard…/);
		} finally {
			loader.dispose();
		}
	});
});
