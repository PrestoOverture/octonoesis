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

Type "Run bun test to see the failure, read src/buggy.test.ts and src/buggy.ts, fix src/buggy.ts with a single Edit, then run bun test again. Be brief."
Sleep 500ms
Enter

# Permission 1: Bash (bun test — the failing run)
Wait+Screen@60s /Permission Required/
Sleep 1500ms
Type "y"
Sleep 2s

# Permission 2: Edit (diff preview)
Wait+Screen@60s /Permission Required/
Sleep 2500ms
Type "y"
Sleep 2s

# Permission 3: Bash (bun test — the confirming run)
Wait+Screen@60s /Permission Required/
Sleep 1500ms
Type "y"

# Completion: the passing rerun's tool line (never in the echoed prompt), then
# linger for the short final answer.
Wait+Screen@120s /bun test · exit 0/
Sleep 8s
Ctrl+C
Sleep 2500ms
