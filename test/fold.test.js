// Exercises the plugin against a mock renderer tree shaped like the real one:
// a sticky scrollbox holding BlockTool boxes, each a title text node followed by
// the body children the host builds for edit / write / apply_patch.
//
//   node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import plugin from "../index.js"

class Box {
  constructor(kids = [], props = {}) {
    this.kids = kids
    Object.assign(this, props)
  }
  getChildren() {
    return this.kids
  }
}

// Text renderables expose plainText for reading and content for writing, which
// is the pair the plugin uses to restate a folded block's title.
class Text {
  constructor(text) {
    this._text = text
    this.visible = true
  }
  get plainText() {
    return this._text
  }
  set content(value) {
    this._text = value
  }
  getChildren() {
    return []
  }
}

class Diff extends Box {
  constructor(diff) {
    super([])
    this.diff = diff
    this.filetype = "ts"
  }
}

class Code extends Box {
  constructor(content) {
    super([])
    this.content = content
    this.filetype = "ts"
  }
}

class Scrollbox extends Box {
  constructor(kids) {
    super(kids)
    this.stickyScroll = true
    this.stickyStart = "bottom"
    this.scrollHeight = 100
  }
  scrollTo() {}
}

const DIFF = ["--- a/src/app.ts", "+++ b/src/app.ts", " keep", "-gone", "-also gone", "+one", "+two", "+three", "+four"].join(
  "\n",
)

// title + <box><diff/></box> + optional diagnostics, the shape BlockTool renders.
function editBlock(title = "← Edit src/app.ts", diff = DIFF, extra = []) {
  const body = new Box([new Diff(diff)])
  return { block: new Box([new Text(title), body, ...extra]), body }
}

function writeBlock(lines = 40) {
  const body = new Box([new Code(Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n"))])
  return { block: new Box([new Text("# Wrote src/new.ts"), body]), body }
}

function harness(t, kids) {
  const root = new Box([new Scrollbox(kids)])
  const listeners = {}
  const toasts = []
  let layer
  const api = {
    renderer: { root, getSelection: () => undefined },
    route: { current: { name: "session" } },
    event: {
      on(name, handler) {
        listeners[name] = handler
        return () => delete listeners[name]
      },
    },
    keymap: {
      registerLayer(input) {
        layer = input
      },
    },
    ui: { toast: (input) => toasts.push(input) },
    lifecycle: {
      onDispose(fn) {
        t.after(fn)
      },
    },
  }
  return {
    api,
    toasts,
    fire: (name) => listeners[name]?.(),
    run: () => layer.commands[0].run(),
    binding: () => layer.bindings[0],
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

test("folds an edit block to its title and counts the diff", async (t) => {
  const { block, body } = editBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(body.maxHeight, 0)
  assert.equal(body.overflow, "hidden")
  assert.equal(block.gap, 0)
  assert.equal(block.paddingTop, 0)
  assert.equal(block.kids[0].plainText, "← Edit src/app.ts +4 −2 · click to expand")
})

test("counts written files in lines", async (t) => {
  const { block, body } = writeBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(body.maxHeight, 0)
  assert.equal(block.kids[0].plainText, "# Wrote src/new.ts 40 lines · click to expand")
})

test("click toggles one block, restoring the host's chrome", async (t) => {
  const { block, body } = editBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  block.onMouseUp()
  assert.equal(body.maxHeight, undefined)
  assert.equal(block.gap, 1)
  assert.equal(block.paddingTop, 1)
  assert.equal(block.kids[0].plainText, "← Edit src/app.ts")

  block.onMouseUp()
  assert.equal(body.maxHeight, 0)
})

test("a drag that ends on the block is a selection, not a click", async (t) => {
  const { block, body } = editBlock()
  const h = harness(t, [block])
  h.api.renderer.getSelection = () => ({ getSelectedText: () => "gone" })
  await plugin.tui(h.api, {})
  await settle()

  block.onMouseUp()
  assert.equal(body.maxHeight, 0)
})

test("small blocks and other tools are left alone", async (t) => {
  const small = editBlock("← Edit tiny.ts", ["--- a/tiny.ts", "+++ b/tiny.ts", "-a", "+b"].join("\n"))
  const bash = editBlock("# bash npm test")
  const h = harness(t, [small.block, bash.block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(small.body.maxHeight, undefined)
  assert.equal(bash.body.maxHeight, undefined)
  assert.equal(bash.block.kids[0].plainText, "# bash npm test")
})

test("diagnostics stay visible while the diff folds", async (t) => {
  const diagnostics = new Box([new Text("ERROR [3:12] unused variable")])
  const { block, body } = editBlock("← Edit src/app.ts", DIFF, [diagnostics])
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(body.maxHeight, 0)
  assert.equal(diagnostics.maxHeight, undefined)
})

test("blocks arriving later fold on the part event", async (t) => {
  const first = editBlock()
  const kids = [first.block]
  const h = harness(t, kids)
  await plugin.tui(h.api, {})
  await settle()

  const later = editBlock("← Patched src/other.ts")
  kids.push(later.block)
  h.fire("message.part.updated")
  await settle()
  assert.equal(later.body.maxHeight, 0)
})

test("the toggle unfolds everything, then folds what arrives next", async (t) => {
  const one = editBlock()
  const two = writeBlock()
  const kids = [one.block, two.block]
  const h = harness(t, kids)
  await plugin.tui(h.api, {})
  await settle()

  h.run()
  assert.equal(one.body.maxHeight, undefined)
  assert.equal(two.body.maxHeight, undefined)
  assert.match(h.toasts.at(-1).message, /Unfolded 2 blocks/)

  const later = editBlock("# Created src/third.ts")
  kids.push(later.block)
  h.fire("message.updated")
  await settle()
  assert.equal(later.body.maxHeight, undefined, "new blocks follow the toggled mode")

  h.run()
  assert.equal(later.body.maxHeight, 0)
})

test("lines: n leaves a peek and keeps the block's padding", async (t) => {
  const { block, body } = editBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, { lines: 3 })
  await settle()

  assert.equal(body.maxHeight, 3)
  assert.equal(block.gap, undefined, "chrome is only tightened for a title-only fold")
})

test("folded: false only installs the toggle", async (t) => {
  const { block, body } = editBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, { folded: false })
  await settle()

  assert.equal(body.maxHeight, undefined)
  h.run()
  assert.equal(body.maxHeight, 0)
})

test("stats: false leaves the title alone", async (t) => {
  const { block, body } = editBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, { stats: false })
  await settle()

  assert.equal(body.maxHeight, 0)
  assert.equal(block.kids[0].plainText, "← Edit src/app.ts")
})

test("binds ctrl+o by default and nothing when asked", async (t) => {
  const a = harness(t, [])
  await plugin.tui(a.api, {})
  assert.equal(a.binding().key, "ctrl+o")
  assert.equal(a.binding().preventDefault, true)

  const b = harness(t, [])
  await plugin.tui(b.api, { key: "" })
  assert.equal(b.binding(), undefined)
})

// --- bash commands -------------------------------------------------------
//
// Shell wraps its parts in one box: the "$ command" text, the output, and the
// host's own expand hint when that output overflowed. The block carries no
// title unless the tool ran in another workdir.
function shellBlock({ lines = 20, output = "ok", hint = true, running = false, title } = {}) {
  const body = Array.from({ length: lines }, (_, i) => `print(${i})`).join("\n")
  const cmd = new Text(running ? body : "$ " + body)
  const inner = [cmd]
  if (output) inner.push(new Text(output))
  if (hint) inner.push(new Text("Click to expand"))
  const wrap = new Box(inner, { gap: 1 })
  const block = new Box(title ? [new Text(title), wrap] : [wrap])
  return { block, cmd, wrap }
}

const click = () => {
  const event = { stopped: 0, stopPropagation() { this.stopped++ } }
  return event
}

test("folds a long bash command to its first row", async (t) => {
  const { block, cmd, wrap } = shellBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(cmd.maxHeight, 1)
  assert.equal(cmd.overflow, "hidden")
  // The output and the host's hint are siblings of the command, not children,
  // so folding the command leaves both on screen.
  assert.equal(wrap.kids[1].maxHeight, undefined)
  assert.equal(wrap.kids[2].maxHeight, undefined)
  // The block's own handler is the host's output toggle and has no getter to
  // chain, so it must be left exactly as it was found.
  assert.equal(block.onMouseUp, undefined)
  // The chrome holds up the output, so it is not collapsed the way a diff's is.
  assert.equal(block.gap, undefined)
})

test("clicking the command toggles it and stops the host seeing the click", async (t) => {
  const { block, cmd } = shellBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  const open = click()
  cmd.onMouseUp(open)
  assert.equal(cmd.maxHeight, undefined)
  assert.equal(open.stopped, 1)

  const shut = click()
  cmd.onMouseUp(shut)
  assert.equal(cmd.maxHeight, 1)
  assert.equal(shut.stopped, 1)
  assert.equal(block.onMouseUp, undefined)
})

test("a drag ending on the command is a selection, not a click", async (t) => {
  const { block, cmd } = shellBlock()
  const h = harness(t, [block])
  h.api.renderer.getSelection = () => ({ getSelectedText: () => "print(3)" })
  await plugin.tui(h.api, {})
  await settle()

  cmd.onMouseUp(click())
  assert.equal(cmd.maxHeight, 1)
})

test("short and still-running commands are left alone", async (t) => {
  const short = shellBlock({ lines: 3 })
  const running = shellBlock({ running: true })
  const h = harness(t, [short.block, running.block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(short.cmd.maxHeight, undefined)
  assert.equal(running.cmd.maxHeight, undefined)
  assert.equal(running.cmd.onMouseUp, undefined)
})

test("a workdir title does not hide the command", async (t) => {
  const { block, cmd } = shellBlock({ title: "# Running in packages/tui" })
  const h = harness(t, [block])
  await plugin.tui(h.api, {})
  await settle()

  assert.equal(cmd.maxHeight, 1)
  assert.equal(block.kids[0].plainText, "# Running in packages/tui")
})

test("bash: false leaves commands to the host", async (t) => {
  const { block, cmd } = shellBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, { bash: false })
  await settle()

  assert.equal(cmd.maxHeight, undefined)
  assert.equal(cmd.onMouseUp, undefined)
})

test("bash_lines sets how much of the command survives", async (t) => {
  const { block, cmd } = shellBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, { bash_lines: 3 })
  await settle()

  assert.equal(cmd.maxHeight, 3)
})

test("bash_output folds the output, the hint and the chrome too", async (t) => {
  const { block, cmd, wrap } = shellBlock()
  const h = harness(t, [block])
  await plugin.tui(h.api, { bash_output: true })
  await settle()

  assert.equal(cmd.maxHeight, 1)
  assert.equal(wrap.kids[1].visible, false)
  assert.equal(wrap.kids[2].visible, false)
  assert.equal(wrap.gap, 0)
  assert.equal(block.gap, 0)
  assert.equal(block.paddingTop, 0)
  assert.equal(block.paddingBottom, 0)
  assert.equal(block.onMouseUp, undefined)

  cmd.onMouseUp(click())
  assert.equal(cmd.maxHeight, undefined)
  assert.equal(wrap.kids[1].visible, true)
  assert.equal(wrap.kids[2].visible, true)
  assert.equal(wrap.gap, 1)
  assert.equal(block.gap, 1)
  assert.equal(block.paddingTop, 1)
})

test("bash_output leaves an error line outside the wrapper visible", async (t) => {
  const { block, wrap } = shellBlock()
  const error = new Text("exit code 1")
  block.kids.push(error)
  const h = harness(t, [block])
  await plugin.tui(h.api, { bash_output: true })
  await settle()

  assert.equal(wrap.kids[1].visible, false)
  assert.equal(error.visible, true)
})

test("bash_min_lines overrides min_lines for commands only", async (t) => {
  const short = shellBlock({ lines: 1 })
  const small = editBlock("← Edit tiny.ts", ["--- a/tiny.ts", "+++ b/tiny.ts", "-a", "+b"].join("\n"))
  const h = harness(t, [short.block, small.block])
  await plugin.tui(h.api, { bash_min_lines: 0 })
  await settle()

  assert.equal(short.cmd.maxHeight, 1)
  assert.equal(small.body.maxHeight, undefined)
})

test("ctrl+o folds and unfolds commands alongside diffs", async (t) => {
  const edit = editBlock()
  const shell = shellBlock()
  const h = harness(t, [edit.block, shell.block])
  await plugin.tui(h.api, {})
  await settle()

  h.run()
  assert.equal(edit.body.maxHeight, undefined)
  assert.equal(shell.cmd.maxHeight, undefined)
  assert.match(h.toasts.at(-1).message, /Unfolded 2 blocks/)

  h.run()
  assert.equal(edit.body.maxHeight, 0)
  assert.equal(shell.cmd.maxHeight, 1)
})
