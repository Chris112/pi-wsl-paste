# pi-wsl-paste

Paste screenshots and drop Windows files into [pi](https://pi.dev) when it runs in WSL.

- Snip something with the Snipping Tool (Win+Shift+S), then press Ctrl+V in pi. The image is saved to `~/.cache/pi-clipboard/` and attached to your message as `[#image N]`. Alt+V does the same.
- Drag a file from Explorer onto the terminal and pi gets `/mnt/c/Users/...` instead of `C:\Users\...`. Images become `[#image N]` attachments. Other files stay as paths the model can open.

The `[#image N]` attachments come from [pi-paster](https://www.npmjs.com/package/pi-paster), which this package installs for you. This package adds the WSL clipboard and path handling on top.

## Requirements

- pi running in WSL 2.
- Windows Terminal for Ctrl+V. [How it works](#how-it-works) explains why. Alt+V works in any terminal that passes the key through to pi.
- `powershell.exe` on your WSL `PATH`. WSL sets this up by default.

## Install

If you already have pi-paster installed, remove it first. Otherwise pi loads it twice. For an npm install of pi-paster:

```bash
pi remove npm:pi-paster
```

Then install this package:

```bash
pi install git:github.com/Chris112/pi-wsl-paste
```

Start a new pi, or run `/reload` in an open one.

## Use

| To | Do this |
|---|---|
| Attach a screenshot | Snip it, then press Ctrl+V or Alt+V in pi |
| Attach an image file | Drag it onto the terminal |
| Point pi at any other file | Drag it onto the terminal |

Reading the clipboard goes through PowerShell and takes a second or two. A spinner shows above the input box while it runs. If the clipboard has no image, pi says "No image on the clipboard".

Snips go in `~/.cache/pi-clipboard/`, or `$XDG_CACHE_HOME/pi-clipboard/` if you set that. When pi starts, it deletes snips older than 7 days. By default pi-paster adds each image's file path to your message, so you can also ask the model to copy or edit the file.

If you remap pi's `app.clipboard.pasteImage` action in its `keybindings.json`, Alt+V moves to your new key. Ctrl+V keeps working either way.

## Update

```bash
pi update git:github.com/Chris112/pi-wsl-paste
```

## How it works

This package loads two extensions: `extensions/wsl-paths.ts` from this repo, and pi-paster.

`wsl-paths.ts` watches terminal input before pi's editor sees it:

- Alt+V, or an empty paste, starts a clipboard read. PowerShell saves the image into the cache folder, then the extension pastes the file's path into the prompt. The empty paste is how Ctrl+V gets detected. Windows Terminal handles Ctrl+V itself, and when the clipboard holds only an image it sends pi a paste with nothing in it. That was checked with Windows Terminal 1.24.
- A paste made up entirely of Windows paths, which is what a file drop looks like, gets rewritten to WSL paths. Pasted code or prose that mentions a Windows path is left alone.

pi-paster then sees an image path arrive and turns it into an `[#image N]` attachment. Because `wsl-paths.ts` handles Ctrl+V and Alt+V first, pi-paster's own clipboard handler never runs.

## Development

```bash
pnpm install
pnpm test
```

To try your changes in pi without installing the package:

```bash
pi --no-extensions -e .
```

`--no-extensions` stops an installed copy of this package from loading alongside your working copy.

pi installs this package with npm, not pnpm, so a few files exist for npm's sake:

- `package.json` pins pi-paster to an exact version. To move to a new release, change the version, run `pnpm install` and `pnpm test`, try it in pi, then commit.
- `.npmrc` sets `legacy-peer-deps=true`. pi-paster lists pi as a peer dependency, and without this npm would install a spare copy of pi into the package.

The tests run against the pi version pinned in `devDependencies`. When you bump it, pnpm may stop with `ERR_PNPM_IGNORED_BUILDS` because a new dependency wants to run a build script. The tests only load JavaScript, so skip it with `pnpm approve-builds '!<package>'`. That records the choice in `pnpm-workspace.yaml`, which npm ignores.
