---
name: uart-console-debug
description: "Debug an embedded board over its serial console: finding the baud rate, capturing boot logs, and interrupting the bootloader. Use when a board powers up but its behaviour is unclear and a debug header is available."
---

# Serial console debugging

1. Identify TX/RX/GND and confirm 1.8 V or 3.3 V logic before connecting.
2. Try 115200 8N1 first; otherwise measure the shortest pulse to derive the baud rate.
3. Capture the full boot log to a file.
4. Interrupt the bootloader to inspect the environment and boot arguments.
