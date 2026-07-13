# v1.0 integration demo: background test suite + sub-agent delegation + task notification.
# Run from the octonoesis repo root (records against this repo itself):
#   bash demo/tapes/setup-demo-repos.sh && vhs demo/tapes/v1-integration.tape
Require bun

Output demo/v1-integration.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 15
Set Width 1100
Set Height 700
Set Framerate 15
Set TypingSpeed 35ms
Set Padding 12

Hide
Type "export PATH=/tmp/octo-demo/bin:$PATH && clear"
Enter
Show

Type "octonoesis"
Sleep 500ms
Enter
Wait+Screen@30s /Type a message/
Sleep 1s

Type "Run the full test suite (bun test) as a background task with run_in_background. Then delegate to a sub-agent via the Agent tool: find where the compaction threshold formula is computed and report the file and formula. After the sub-agent returns, run exactly one foreground 'sleep 30' command. Then report the background test outcome and the sub-agent's finding."
Sleep 500ms
Enter

# Permission 1: Bash with run_in_background — the TaskChip appears after this
Wait+Screen@60s /Press \[y\]/
Sleep 1500ms
Type "y"
Sleep 2s

# Permission 2: Agent (sub-agent delegation)
Wait+Screen@60s /Press \[y\]/
Sleep 1500ms
Type "y"
Sleep 2s

# Permission 3: the single foreground sleep while waiting for the notification
Wait+Screen@120s /Press \[y\]/
Sleep 1500ms
Type "y"

# Completion: after the third permission the remaining flow is sleep 30 →
# <task-notification> at the next turn boundary → final answer. Fixed sleep;
# sentinel text would collide with the echoed user prompt.
Sleep 55s
Ctrl+C
Sleep 2500ms
