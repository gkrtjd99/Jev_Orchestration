---
name: board-bringup-checklist
description: "Step-by-step first power-on procedure for a new PCB revision: rail sequencing, clock checks, reset lines, and first boot. Use when a freshly assembled board arrives from the fab and has never been powered."
---

# Board bring-up

1. Visual inspection and resistance-to-ground on every rail before applying power.
2. Power from a current-limited bench supply; bring rails up in schematic order and log voltages.
3. Probe oscillators and reset lines, then attempt bootloader entry.
4. Fill in the bring-up sheet per board serial; stop at the first out-of-range reading.
