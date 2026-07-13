# Learning-loop demo: session 1 fails+fixes a bug; `rebuild-rules` distills the
# episode into a human-readable rule; session 2 hits the same error class in a
# different file with the rule available for post-failure injection.
# Prereq: bash demo/tapes/setup-demo-repos.sh   (then run `vhs demo/tapes/learning-loop.tape` from the repo root)
#
# Determinism notes:
# - The scratch repo's untracked .octonoesis/config.json allowlists the Bash
#   test commands, so each session prompts exactly once — the Edit.
# - An OPEN permission prompt is detected as the cursor line ending "input:"
#   (Line scope); answered prompts are no longer the cursor line.
# - Session completion is the shell prompt line returning ("^>\s*$" — vhs PS1).
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

# Show the failure first
Type "bun test src/user.test.ts 2>&1 | tail -6"
Enter
Sleep 4s

# Session 1: one-shot fix — a single Edit approval, test runs are config-allowlisted
Type "octonoesis 'Run bun test src/user.test.ts, fix src/user.ts so it passes, then run it again to confirm.'"
Enter
Wait@120s /input:\s*$/
Sleep 1500ms
Type "y"
Enter
Wait@240s /^>\s*$/
Sleep 1500ms

# Distill the recorded episode into a rule, then show it — a plain markdown file
Type "octonoesis rebuild-rules"
Enter
Wait@120s /^>\s*$/
Sleep 1s
Type "cat .octonoesis/rules/*.md"
Enter
Sleep 8s

# Session 2: same error class, different file — the rule is now in the pool
Hide
Type "clear"
Enter
Show
Type "octonoesis 'bun test src/order.test.ts fails the same way. Run it, fix src/order.ts, then run bun test to confirm everything passes.'"
Enter
Wait@120s /input:\s*$/
Sleep 1500ms
Type "y"
Enter
Wait@240s /^>\s*$/
Sleep 5s
