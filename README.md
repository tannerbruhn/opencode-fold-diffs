# opencode-fold-diffs

**Every `write` and `edit` dumps the whole file or the whole diff into your transcript, and stays there. So does every `bash` command, however long.** This plugin folds those blocks down to their title line — `← Edit src/app.ts +12 −3 · click to expand` — and opens them again on click, or `ctrl+o` for all of them at once.

opencode already does this for the tools it considers noisy: bash output collapses to 10 lines, generic tool output to 3, both with click-to-expand. The three tools that actually fill the scrollback are the ones it leaves alone. Upstream has been asked three times — [#9089](https://github.com/anomalyco/opencode/issues/9089) (minimal diff display), [#14511](https://github.com/anomalyco/opencode/issues/14511) (a toggle keybind, like Claude Code's ctrl+o), [#19074](https://github.com/anomalyco/opencode/issues/19074) (collapse tool output) — and all three were closed without a setting. This is that setting, from outside.

## What you see

Before:

```
← Edit src/session/index.ts
│  1  import { createMemo } from "solid-js"
│  2 -  const [expanded, setExpanded] = createSignal(false)
│  3 +  const [expanded, setExpanded] = createSignal(props.open)
│  … 40 more lines
```

After:

```
← Edit src/session/index.ts +12 −3 · click to expand
```

Bash commands fold the same way, to their first line. opencode trims what a command *printed* — ten lines, with click-to-expand — but never the command that printed it, so a heredoc'd throwaway script keeps its full height forever:

```
$ /repos/app/.venv/bin/python - <<'PY'          $ /repos/app/.venv/bin/python - <<'PY'
                                                from PIL import Image
Traceback (most recent call last):              import numpy as np
  File "<stdin>", line 7, in <module>           im = Image.open('spectrum.png')
ValueError: cannot reshape array of size…       … 8 more lines
                                                
        folded (the default)                    Traceback (most recent call last):
                                                  File "<stdin>", line 7, in <module>
                                                ValueError: cannot reshape array of size…
```

The output is untouched either way — you still see what happened, just not the script that did it.

Click the row to open it. `ctrl+o` folds or unfolds every block in the session, and sets what newly arriving blocks do — same as a verbose toggle.

## Install

```sh
opencode plugin opencode-fold-diffs -g
```

That installs the package into your global OpenCode config and adds it to `tui.json`. Drop `-g` for the current project only. Restart OpenCode afterwards; plugins load at startup.

### Without npm

```sh
mkdir -p ~/.config/opencode/tui-plugins
curl -fsSL https://raw.githubusercontent.com/tannerbruhn/opencode-fold-diffs/main/index.js \
  -o ~/.config/opencode/tui-plugins/fold-diffs.js
```

Then add it to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["./tui-plugins/fold-diffs.js"]
}
```

Do not put the file in `~/.config/opencode/plugin/`. That directory is auto-discovered for *server* plugins and will load it the wrong way.

## Options

```json
"plugin": [["opencode-fold-diffs", { "lines": 3, "min_lines": 10, "key": "ctrl+f" }]]
```

| Option | Default | Meaning |
|---|---|---|
| `lines` | `0` | Lines of the body left showing when folded. `0` is the title only, and also tightens the block's padding so it occupies one row. Any positive number leaves a peek at the top. |
| `min_lines` | `6` | Blocks with fewer changed lines than this are left alone — a two-line edit is already its own summary. |
| `stats` | `true` | Append `+12 −3 · click to expand` to the title. |
| `folded` | `true` | Whether blocks start folded. `false` gives you only the toggle. |
| `key` | `"ctrl+o"` | Binding for fold/unfold-all. `ctrl+o` is unbound in opencode; Claude Code uses it for the same thing. Set to `""` for none. |
| `bash` | `true` | Fold long bash commands too. `false` leaves every bash block exactly as the host draws it. |
| `bash_lines` | `1` | Rows of the command left showing when folded. `1` keeps the line that says what the thing was. Commands shorter than `bash_min_lines` are never folded. |
| `bash_min_lines` | `min_lines` | Commands occupying fewer rows than this are left alone. `0` folds every finished command, however short. |
| `bash_output` | `false` | Fold the output and the host's `Click to expand` hint along with the command, and tighten the padding, so a finished command occupies one row. Errors stay visible. |

## What it does not touch

- **Permission dialogs.** The diff you approve renders in full, always. The plugin only ever walks inside the transcript scrollbox, and the permission preview is not in it.
- **Diagnostics and errors.** Only the children carrying a diff or a file body get folded, so an edit that introduced a type error still says so with the block closed.
- **Bash output, and the click that expands it.** By default only the *command* folds; the output keeps the host's ten-line collapse (set `bash_output: true` to fold it as well). opencode puts its own click handler on a bash block to expand that output, and opentui declares `onMouseUp` as a setter with no getter — so a handler cannot be read back and chained, and overwriting one destroys it. This plugin attaches to the command text instead and calls `stopPropagation()`: clicking the command folds the command, clicking anywhere else in the block does exactly what it did before.
- **Todos, questions, and the generic fallback.** They keep the host's own collapse behaviour. Matching is on the six BlockTool titles the file tools use (`← Edit`, `# Wrote`, `← Patched`, `# Created`, `# Deleted`, `# Moved`), plus the `$ ` a bash block prefixes its command with.

## How it works, for anyone extending it

The TUI plugin API has no slot for message parts — `sidebar_content`, `session_prompt_right`, `app`, `app_bottom` and the `home_*` slots are the whole list — so a plugin cannot render a tool part itself. It has to reach the renderables the host already made:

1. Find the transcript: the only scrollbox in the tree with `stickyScroll && stickyStart === "bottom"`. The sidebar, dialogs, autocomplete and diff viewer all have scrollboxes; none of them are sticky.
2. Find the blocks: a node whose first child's `plainText` starts with one of the six titles. Bash blocks carry no title at all — BlockTool renders one only when the tool ran in another workdir — so they are found by shape: the first child that has children of its own, whose own first child is the `$ `-prefixed command. Do not count children to find it; solid's `<Show>` leaves childless placeholders, so a bash block reports three children with no title present.
3. Fold: `maxHeight = 0` and `overflow = "hidden"` on the children carrying the bulk. Yoga accepts a zero max-height, so the body leaves layout instead of leaving a hole.
4. Size a command by `max(source lines, node.height)`. `height` is the laid-out row count, which catches a one-line command long enough to wrap, but it reads `0` for anything the virtualised transcript has not laid out — so the line count is the floor, not the other way round.
5. Toggle: assign `onMouseUp` on the block. The solid adapter sets that as a plain property, so a plugin can set it the same way — it replaces BlockTool's own handler, which is why the copy-on-select guard is reimplemented here.

Classes are matched by duck-typing (`typeof node.diff === "string"`, `content` + `filetype` for code) rather than `instanceof`, because the opentui classes are minified in the shipped binary and their names are not stable.

Blocks are re-scanned on `message.part.updated` and `message.updated`, plus a 2 s sweep that catches a session opened from history, whose parts land before any event this plugin sees.

## Status

Written against opencode 1.18.28. The tree-walking, block matching, fold/unfold
and toggle logic run green against a mock renderer tree (`node --test test/`),
and every renderable property it touches was checked against the shipped binary:
`maxHeight` and `overflow` are yoga setters, `onMouseUp` is a setter with no
getter, `plainText` is a getter on text renderables, and `height` is a getter
that reads 0 until the transcript lays a node out.

Bash folding was additionally checked in a real terminal against a real session:
a ten-line heredoc laid out at one row with its traceback still fully visible,
and `ctrl+o` restored the body. The rest of this table is still worth a pass on
first run, since none of it is what a mock can prove:

| Case | Expected |
|---|---|
| `edit` completes | Folds to the title with `+n −n` |
| `write` completes | Folds to the title with `n lines` |
| `apply_patch` over 3 files | Each file's block folds on its own |
| Click a folded block | Opens; click again to close |
| Select text across a block | Copy-on-select still works, no toggle |
| `ctrl+o` | Folds/unfolds all, and sets the default for new blocks |
| Edit with diagnostics | Diagnostics stay visible while folded |
| Permission dialog | Full diff, untouched |
| A long `bash` command | Folds to its first line; the output stays as the host left it |
| Click a folded command | Opens just that command |
| Click a bash block's output | Still expands the output, as it did before |
| A short or still-running command | Left alone |

If the title never grows its `+12 −3` suffix, solid is holding that text node and
the plugin has stopped trying to write it; everything else still works. Set
`"stats": false` to skip it.

## License

MIT
