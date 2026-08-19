"""Run a command on a pty, close the master, report whether it left.

Bun has no `openpty`, and the defect only appears when the other end of a
terminal closes -- which is what an editor spawning a TUI and then exiting does.
Nothing else in this repository can produce that condition.
"""
import json, os, pty, subprocess, sys, time

settle, grace, command = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3:]
master, slave = pty.openpty()
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
time.sleep(settle)
os.close(master)
deadline = time.time() + grace
while time.time() < deadline and child.poll() is None:
    time.sleep(0.05)
alive = child.poll() is None
if alive:
    child.kill()
    child.wait(timeout=5)
print(json.dumps({"alive": alive, "exit": child.returncode if not alive else None}))
