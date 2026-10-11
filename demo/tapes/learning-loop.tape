# Learning-loop demo (TUI): session 1 fails, fixes a bug and auto-distills a rule
# (`✻ learned 1 rule`); session 2 hits the same error class in a different file —
# the rule is recalled under the failing test run and scored a hit when it passes.
# Prereq: bash demo/tapes/setup-demo-repos.sh   (then run `vhs demo/tapes/learning-loop.tape` from the repo root)
#
# Determinism notes:
# - The scratch repo's untracked .octonoesis/config.json allowlists the Bash
#   test commands, so each session prompts exactly once — the Edit.
# - Session ends are detected on the learning lines themselves (`learned`,
#   `hit ·`, `strengthened`), which never appear in the echoed user prompt.
# - Permission prompts are detected on the dialog heading, not its footer: vhs's
#   Screen read can miss the bottom rows of a frame taller than the window.
Require bun

Output demo/learning-loop.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 15
Set Width 1100
Set Height 640
Set Framerate 15
Set TypingSpeed 35ms
Set Padding 12

Hide
Type "cd /tmp/octo-demo/learning-repo && export PATH=/tmp/octo-demo/bin:$PATH && clear"
Enter
Show

# Session 1: the rule pool is empty
Type "octonoesis"
Sleep 500ms
Enter
Wait+Screen@30s /Type a message/
Sleep 1s
Type "Run bun test src/user.test.ts, fix src/user.ts so it passes, then run it again to confirm. Be brief."
Sleep 500ms
Enter
Wait+Screen@120s /Permission Required/
Sleep 2s
Type "y"
Wait+Screen@240s /learned \d+ rules?:/
Sleep 4s
Ctrl+C
Sleep 2s

# The learned rule is a plain markdown file
Hide
Type "clear"
Enter
Show
Type "head -16 .octonoesis/rules/*.md"
Enter
Sleep 6s

# Session 2: same error class, different file — recalled, then scored
Hide
Type "clear"
Enter
Show
Type "octonoesis"
Sleep 500ms
Enter
Wait+Screen@30s /Type a message/
Sleep 1s
Type "bun test src/order.test.ts fails too. Run it, fix src/order.ts, then run it again to confirm. Be brief."
Sleep 500ms
Enter
Wait+Screen@120s /Permission Required/
Sleep 2s
Type "y"
Wait+Screen@240s /hit ·/
# Query-end distillation runs after the answer; wait for its line, then linger.
Wait+Screen@120s /(strengthened|learned) \d+ rules?/
Sleep 5s
Ctrl+C
Sleep 2500ms
