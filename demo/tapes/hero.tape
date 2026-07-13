# Hero demo: golden-path bug fix in the TUI.
# Prereq: bash demo/tapes/setup-demo-repos.sh   (then run `vhs demo/tapes/hero.tape` from the repo root)
Require bun

Output demo/hero.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 15
Set Width 1100
Set Height 640
Set Framerate 15
Set TypingSpeed 35ms
Set Padding 12

Hide
Type "cd /tmp/octo-demo/hero-repo && export PATH=/tmp/octo-demo/bin:$PATH && clear"
Enter
Show

Type "octonoesis"
Sleep 500ms
Enter
Wait+Screen@30s /Type a message/
Sleep 1s

Type "First run bun test to see the failure. Then fix src/buggy.ts with a single Edit. Then run bun test again to confirm. End your reply with exactly: All green!"
Sleep 500ms
Enter

# Permission 1: Bash (bun test — the failing run)
Wait+Screen@60s /Press \[y\]/
Sleep 1500ms
Type "y"
Sleep 2s

# Permission 2: Edit (diff preview)
Wait+Screen@60s /Press \[y\]/
Sleep 2500ms
Type "y"
Sleep 2s

# Permission 3: Bash (bun test — the confirming run)
Wait+Screen@60s /Press \[y\]/
Sleep 1500ms
Type "y"

# Completion: the sentinel also appears in the echoed user prompt, so waiting on
# it would fire immediately — a fixed sleep covers the final (fast) answer turn.
Sleep 12s
Ctrl+C
Sleep 2500ms
