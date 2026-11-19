// Fold write / edit / apply_patch blocks -- and long bash commands -- in the
// opencode transcript.
//
// opencode already collapses bash OUTPUT to 10 lines and generic tool output to
// 3, both with click-to-expand. The three tools that produce the most
// scrollback -- write, edit and apply_patch -- are the ones it does not touch:
// they render the whole diff, or the whole written file, forever. The three
// upstream requests for a setting (#9089 minimal diff display, #14511 a toggle
// keybind, #19074 collapse tool output) were all closed without one, so this
// does it from a plugin.
//
// The bash command is that same gap seen from the other side: the host trims
// what a command printed, never the command that printed it, so a heredoc'd
// throwaway script keeps its full height in the transcript forever. Those fold
// to their first line, which is the one that says what the thing was.
//
// A folded block renders as its title line -- "← Edit src/app.ts +12 −3" --
// and opens on click, or with ctrl+o for every block at once.
//
// Options (tui.json -> ["opencode-fold-diffs", { ... }]):
//   lines      lines of the body left visible when folded  (default 0, title only)
//   min_lines  leave blocks with fewer content lines alone  (default 6)
//   stats      append "+12 −3 · click to expand" to the title (default true)
//   folded     new blocks start folded                      (default true)
//   key        binding that folds/unfolds every block        (default "ctrl+o")
//   bash       fold long bash commands too                   (default true)
//   bash_lines rows of the command left visible when folded  (default 1)
//   bash_min_lines  leave commands shorter than this alone   (default min_lines)
//   bash_output     fold the output and padding with the command (default false)

const DEFAULTS = {
  lines: 0,
  min_lines: 6,
  stats: true,
  folded: true,
  key: "ctrl+o",
  bash: true,
  bash_lines: 1,
  bash_output: false,
}

// BlockTool titles of the file-writing tools, as rendered in the transcript.
// Matching the title is what keeps this off every other block tool: bash,
// todowrite, questions and the generic fallback all collapse themselves
// already, and folding them again would fight the host.
const TITLES = [/^← Edit /, /^# Wrote /, /^← Patched /, /^# Created /, /^# Deleted /, /^# Moved /]

// A shell block carries no title to match on -- BlockTool renders one only when
// the tool ran in another workdir -- so it is found by shape instead. Shell
// wraps its parts in one box whose first child is the command, and the host
// writes that command with a "$ " in front of it.
const PROMPT = "$ "

// How often to re-scan when nothing is streaming. Events cover the live case;
// this catches a session opened from history, whose parts arrive as one batch
// before any event this plugin sees.
const SWEEP_MS = 2000

function children(node) {
  return typeof node?.getChildren === "function" ? node.getChildren() : []
}

function plain(node) {
  const value = node?.plainText
  return typeof value === "string" ? value : undefined
}

// Duck-typing, not instanceof: the classes live in the host's bundled
// @opentui/core and are minified, so their names are not stable. A diff
// renderable is the only thing in the tree carrying a `diff` string, and a code
// renderable the only thing pairing `content` with `filetype`.
function isDiff(node) {
  return typeof node?.diff === "string"
}

function isCode(node) {
  return typeof node?.content === "string" && typeof node?.filetype === "string"
}

// The command text of a bash block, or nothing. The wrapper is the first child
// with children of its own; a workdir title, when there is one, is a childless
// text node sitting before it. While the tool is still running the host renders
// the command inside a Spinner with no "$ ", so a running command is skipped and
// picked up by a later sweep once it settles.
function shellCommand(block) {
  const kids = children(block)
  if (!kids.length || kids.length > 3) return
  for (const child of kids) {
    const inner = children(child)
    if (!inner.length) continue
    const text = plain(inner[0])
    if (typeof text !== "string" || !text.startsWith(PROMPT)) return
    return { node: inner[0], text, box: child }
  }
}

// Rows the command occupies, not lines it contains: a single-line command long
// enough to wrap is exactly the kind worth folding. `height` is the laid-out
// row count and reads 0 before the first layout, so the line count is the floor.
function commandRows(node, text) {
  const height = typeof node?.height === "number" ? node.height : 0
  return Math.max(text.split("\n").length, height)
}

function bulk(node, found = []) {
  if (!node || node.isDestroyed) return found
  if (isDiff(node) || isCode(node)) {
    found.push(node)
    return found
  }
  for (const child of children(node)) bulk(child, found)
  return found
}

// The transcript is the only scrollbox in the TUI that asks to stick to the
// bottom (same discriminator opencode-snap-to-bottom uses). Staying inside it
// is what keeps the permission dialog's diff preview untouched -- you should
// always see in full what you are about to approve.
function isTranscript(node) {
  return (
    typeof node?.scrollTo === "function" &&
    typeof node?.scrollHeight === "number" &&
    node.stickyScroll === true &&
    node.stickyStart === "bottom"
  )
}

function findTranscript(node) {
  if (!node || node.isDestroyed) return
  if (isTranscript(node)) return node
  if (typeof node.scrollTo === "function") return
  for (const child of children(node)) {
    const hit = findTranscript(child)
    if (hit) return hit
  }
}

// A BlockTool renders the title text first, then its body. Read the title off
// the first child; anything else is not one of ours.
function blockTitle(node) {
  const kids = children(node)
  // Title plus at least one body child. The guard also keeps the plain-text
  // read -- which rebuilds a string every call -- off the leaf nodes, and the
  // transcript is mostly leaf nodes.
  if (kids.length < 2) return
  const head = plain(kids[0])
  if (!head) return
  return TITLES.some((re) => re.test(head)) ? head : undefined
}

function scan(node, hits = [], shell = true) {
  if (!node || node.isDestroyed) return hits
  // A matched block never contains another one, so stop descending.
  if (blockTitle(node) || (shell && shellCommand(node))) {
    hits.push(node)
    return hits
  }
  for (const child of children(node)) scan(child, hits, shell)
  return hits
}

// "+12 −3" from a unified diff, "42 lines" from a written file. Counted off the
// renderable's own props, so it stays right even for parts the TUI store has
// already dropped.
function summarise(nodes) {
  let added = 0
  let removed = 0
  let lines = 0
  let diffs = 0
  for (const node of nodes) {
    if (isDiff(node)) {
      diffs++
      for (const line of node.diff.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue
        if (line.startsWith("+")) added++
        else if (line.startsWith("-")) removed++
      }
      continue
    }
    lines += node.content.split("\n").length
  }
  if (diffs) return { size: added + removed, label: `+${added} −${removed}` }
  return { size: lines, label: `${lines} ${lines === 1 ? "line" : "lines"}` }
}

export default {
  id: "opencode-fold-diffs",
  tui: async (api, options) => {
    const opts = { ...DEFAULTS, ...(options ?? {}) }
    const peek = Math.max(0, Number(opts.lines) || 0)
    const floor = Math.max(0, Number(opts.min_lines) || 0)
    const shell = opts.bash !== false
    const shellPeek = Math.max(0, Number(opts.bash_lines) || 0)
    const shellFloor = opts.bash_min_lines === undefined ? floor : Math.max(0, Number(opts.bash_min_lines) || 0)
    const shellOutput = opts.bash_output === true

    // Folded blocks, by their block renderable. WeakMap so a session switch,
    // which destroys the renderables, drops the state with them.
    const known = new WeakMap()
    // The mode new blocks adopt. ctrl+o flips it, so "expand everything" also
    // means "and stop folding what arrives next", the way a verbose toggle works.
    let folding = opts.folded !== false
    // Set once the title rewrite is proven not to take, so we stop retrying it.
    let titles = opts.stats !== false

    let cached
    function transcript() {
      if (cached && !cached.isDestroyed) return cached
      cached = findTranscript(api.renderer.root)
      return cached
    }

    function apply(state, fold) {
      state.folded = fold
      state.body.forEach((node, index) => {
        try {
          // A text renderable at max-height 0 still paints its first row, so
          // the output and the hint, stacked at the same spot, would bleed into
          // each other. display: none takes them out of layout and paint both.
          if (state.hide && index > 0) {
            node.visible = fold ? false : state.visible[index]
            return
          }
          // Yoga honours a 0 max-height, so the body disappears from layout
          // entirely rather than leaving a gap where it used to be.
          node.maxHeight = fold ? (index === 0 ? state.peek : 0) : undefined
          node.overflow = fold ? "hidden" : state.overflow[index]
        } catch {}
      })
      // With the body at zero height, the block's own padding and the gap it
      // keeps between children are all that is left: four near-blank rows
      // around one line of title. Collapse the chrome too so a folded block
      // reads as the single row it now is. The restored values are BlockTool's
      // own (paddingTop/Bottom 1, gap 1) because opentui gives these setters no
      // getters to read the originals back from. A shell block uses the same
      // values, plus a gap-1 wrapper around command and output; it only
      // collapses when the output folds too, since otherwise the chrome is
      // still holding something up.
      if (state.chrome) {
        try {
          state.block.gap = fold ? 0 : 1
          state.block.paddingTop = fold ? 0 : 1
          state.block.paddingBottom = fold ? 0 : 1
          if (state.inner) state.inner.gap = fold ? 0 : 1
        } catch {}
      }
      if (!titles || !state.title) return
      const next = fold ? `${state.title.text} ${state.suffix}` : state.title.text
      try {
        state.title.node.content = next
      } catch {
        titles = false
        return
      }
      // The host owns that text node. If solid is not letting go of it there is
      // nothing to be gained by asking again on every block.
      if (plain(state.title.node) !== next) titles = false
    }

    function adoptDiff(block) {
      const title = blockTitle(block)
      if (!title) return false
      const kids = children(block)
      // Everything after the title that actually carries a diff or a file body.
      // Diagnostics and the error line carry neither, so an edit that broke the
      // build still says so while folded.
      const body = []
      const heavy = []
      for (const child of kids.slice(1)) {
        const found = bulk(child)
        if (!found.length) continue
        body.push(child)
        heavy.push(...found)
      }
      if (!body.length) return false
      const stats = summarise(heavy)
      if (stats.size < floor) return false

      const head = kids[0]
      const state = {
        block,
        body,
        overflow: body.map((node) => node.overflow),
        title: plain(head) === title ? { node: head, text: title } : undefined,
        suffix: `${stats.label} · click to expand`,
        peek,
        chrome: peek === 0,
        folded: false,
      }
      known.set(block, state)

      block.onMouseUp = () => {
        // Copy-on-select is a drag ending on the block; that is not a click.
        if (api.renderer.getSelection?.()?.getSelectedText?.()) return
        apply(state, !state.folded)
      }

      if (folding) apply(state, true)
      return true
    }

    function adoptShell(block) {
      const found = shellCommand(block)
      if (!found) return
      if (commandRows(found.node, found.text) < shellFloor) return

      // The command, then everything after it in the same box: the output and
      // the host's "Click to expand" hint. An error line is a sibling of the
      // box, not inside it, so a failed command still says so while folded.
      const body = shellOutput ? [found.node, ...children(found.box).slice(1)] : [found.node]
      const state = {
        block,
        body,
        overflow: body.map((node) => node.overflow),
        visible: body.map((node) => node.visible),
        title: undefined,
        peek: shellPeek,
        chrome: shellOutput,
        hide: shellOutput,
        inner: found.box,
        folded: false,
      }
      known.set(block, state)

      // The block's own onMouseUp belongs to the host here -- for a bash block
      // it is what expands the collapsed OUTPUT -- and opentui declares the
      // handler as a setter with no getter, so it cannot be read back and
      // chained. Take the command text instead and stop the event on it:
      // clicking the command folds the command, clicking anywhere else in the
      // block still does exactly what it did before this plugin loaded.
      found.node.onMouseUp = (event) => {
        if (api.renderer.getSelection?.()?.getSelectedText?.()) return
        apply(state, !state.folded)
        event?.stopPropagation?.()
      }

      if (folding) apply(state, true)
    }

    function adopt(block) {
      if (adoptDiff(block)) return
      if (shell) adoptShell(block)
    }

    function sweep() {
      if (api.route.current.name !== "session") return
      const box = transcript()
      if (!box) return
      for (const block of scan(box, [], shell)) {
        if (known.has(block)) continue
        adopt(block)
      }
    }

    function all(fold) {
      folding = fold
      const box = transcript()
      if (!box) return 0
      let count = 0
      for (const block of scan(box, [], shell)) {
        const state = known.get(block)
        if (!state || state.folded === fold) continue
        apply(state, fold)
        count++
      }
      return count
    }

    let pending
    function schedule() {
      if (pending) return
      pending = setTimeout(() => {
        pending = undefined
        sweep()
      }, 120)
    }

    const offs = [
      api.event.on("message.part.updated", schedule),
      api.event.on("message.updated", schedule),
    ]
    const timer = setInterval(sweep, SWEEP_MS)
    schedule()

    api.keymap.registerLayer({
      mode: "base",
      priority: 100,
      commands: [
        {
          name: "fold_diffs.toggle",
          title: "Fold / unfold file diffs",
          category: "Plugin",
          run() {
            sweep()
            const fold = !folding
            const changed = all(fold)
            api.ui.toast({
              variant: "info",
              message: changed
                ? `${fold ? "Folded" : "Unfolded"} ${changed} ${changed === 1 ? "block" : "blocks"}`
                : `New file blocks will be ${fold ? "folded" : "unfolded"}`,
              duration: 2000,
            })
            return true
          },
        },
      ],
      bindings: opts.key
        ? [{ key: opts.key, cmd: "fold_diffs.toggle", desc: "Fold / unfold file diffs", preventDefault: true }]
        : [],
    })

    api.lifecycle.onDispose(() => {
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      for (const off of offs) if (typeof off === "function") off()
    })
  },
}
