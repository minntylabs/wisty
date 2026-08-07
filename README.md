# Wisty

Wisty is a lightweight text editor for Linux with a clean, elegant look. It is intended for general use (don't expect code highlighting). It only handles UTF-8 files and has support for very large files (streamed read/write, will attempt to open files up to 1GB).

Wisty was originally a fork of [Parchment](https://github.com/tywil04/parchment) but has been completely rewritten in Typescript using AI tools.

![wisty light](images/wisty-light.png)
![wisty dark](images/wisty-dark.png)

The main motivation for creating wisty was aesthetics. I wasn't happy with the visual style of any existing Linux graphical text editors. Also, I wanted a simple, non-coding-oriented text editor. I think there is room for at least one editor which doesn't have code parsing and highlighting features. Wisty is just for basic text viewing/editing functions. It has a basic Formatted mode for displaying styled markdown and spell-checking options.

## Features

- **Markdown-style formatting** — bold (`**text**`), italic (`*text*` / `_text_`) and ATX headings (`#` .. `######`) are recognised and can be shown either as raw markup ("Plain" view) or with the markers hidden and the content styled ("Formatted" view).
- Text wrapping, adjustable font, light/dark theme, spell check with installable dictionaries.

## Installation

The simplest approach (IMHO) is a user-only install (sudo not required, installs in your home dir). 

### Install from user tarball

1. Download the latest `wisty-user-install-<version>-linux-<arch>.tar.gz` from [Releases](https://github.com/timothy-strange/wisty/releases/).
2. Extract it:

```bash
tar -xzf wisty-user-install-*.tar.gz
cd wisty-user-install-*
```

3. Run the installer:

```bash
./install.sh
```

The installer will:

- install the binary to `~/.local/bin/wisty`
- install the desktop entry to `~/.local/share/applications/wisty.desktop`
- install icons to:
  - `~/.local/share/icons/hicolor/32x32/apps/wisty.png`
  - `~/.local/share/icons/hicolor/64x64/apps/wisty.png`
  - `~/.local/share/icons/hicolor/128x128/apps/wisty.png`
  - `~/.local/share/icons/hicolor/256x256/apps/wisty.png`

If `~/.local/bin` is not already on your `PATH`, the installer will prompt you and offer to add it so `wisty` can be run from the command line.

To uninstall, run `./uninstall.sh` from the extracted archive. It removes the files above and can also remove the PATH block (with confirmation).

### Other package formats

You can also download packaged builds from Releases:

- `.deb`
- `.rpm`
- `.AppImage`

## Linux runtime libraries

wisty requires **WebKitGTK 4.1** at runtime (`libwebkit2gtk-4.1`).

It also requires GTK runtime libraries (GTK 3) and related system components used by Tauri/WebKitGTK.

You may already have these, if not, install them like this:

### Ubuntu / Debian

```bash
sudo apt install -y libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1
```

### Fedora

```bash
sudo dnf install -y webkit2gtk4.1 gtk3 libappindicator-gtk3
```

### Arch Linux

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 libappindicator-gtk3
```

## Build prerequisites (from source)

If you are building wisty from source, you will also need development packages.

Two of these are easy to miss, because neither failure names a package. Spell
check binds to hunspell through bindgen, which needs libclang at build time and
fails as a bindgen error. Transcript playback binds to ALSA through rodio, which
needs the ALSA development headers and fails as a linker error from alsa-sys.
The runtime ALSA library is on every desktop already; only the headers are
missing by default. Both are included below.

### Ubuntu / Debian

```bash
sudo apt install -y build-essential pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libclang-dev libasound2-dev
```

### Fedora

```bash
sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config openssl-devel gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel clang-devel alsa-lib-devel
```

### Arch Linux

```bash
sudo pacman -S --needed base-devel pkgconf openssl gtk3 webkit2gtk-4.1 libappindicator-gtk3 librsvg clang alsa-lib
```

## Build and run

From the project root:

```bash
npm run tauri -- dev
```

Build Linux release artifacts:

```bash
npm run tauri -- build
```

## Documentation

- [The `.tsf` transcript container](docs/tsf-format.md) — the interview
  transcript format, its time markers, and where `.tsf` files come from.
- [A WebKitGTK crash when an editor contains an image](docs/webkitgtk-accessibility-crash.md)
  — a browser bug this ran into, written up for anyone building a rich-text
  editor on WebKitGTK.

## Open source libraries used

Many thanks to the developers of these libraries which are used in this project.

### App framework and runtime

- [Tauri](https://github.com/tauri-apps/tauri)
- [WebKitGTK](https://webkitgtk.org/)
- [GTK](https://www.gtk.org/)

### Tauri plugins

- [plugin-dialog](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/dialog)
- [plugin-fs](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/fs)
- [plugin-store](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/store)
- [plugin-log](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/log)
- [plugin-clipboard-manager](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/clipboard-manager)

### Frontend and editor

- [SolidJS](https://github.com/solidjs/solid)
- [CodeMirror 6](https://github.com/codemirror/dev)

### Tooling

- [Vite](https://github.com/vitejs/vite)
- [vite-plugin-solid](https://github.com/solidjs/vite-plugin-solid)

## Credits

- Original project: [Parchment](https://github.com/tywil04/parchment)
