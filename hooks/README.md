# Hook: no self-matching wait loop

A Claude Code `PreToolUse` hook for the `Bash` tool. It denies a loop such as

```sh
while pgrep -f build-worker; do sleep 5; done
```

`pgrep -f` matches full command lines. The shell running the loop has
`build-worker` in its own command line, so `pgrep` always finds the shell and
the loop never exits. `'[b]uild-worker'` does not match its own text and is allowed.

Incident note:
- One such loop ran about 4h50m, because the pattern matched the loop's own shell.
- It blocked a fleet restart for that time.
- The fix is mechanical: the hook makes the pattern unavailable instead of relying on guidance.

Wire it in `settings.json`: matcher `Bash`, command
`node /path/to/hooks/no-self-matching-wait.mjs`. It reads the hook JSON on stdin
and prints a `hookSpecificOutput` deny decision, per the
[hooks reference](https://code.claude.com/docs/en/hooks). Unreadable input or an
unparseable pattern is allowed, not denied.

Limits: it reads the command text only, so a loop built through variables,
`eval`, or a script file is not seen. `node --test` runs its tests.
