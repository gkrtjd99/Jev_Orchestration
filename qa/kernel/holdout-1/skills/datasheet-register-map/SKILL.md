---
name: datasheet-register-map
description: "Turn the register tables in a chip datasheet PDF into a C header with bitfield macros and reset values. Use when writing a driver for a new sensor, PMIC or peripheral IC."
---

# Datasheet to register header

1. Extract every register: address, name, access type, reset value.
2. Emit `#define <CHIP>_REG_<NAME>` plus `_MASK` / `_SHIFT` macros for each field.
3. Note reserved bits and write-1-to-clear fields in comments.
4. Cross-check the count of registers against the datasheet summary table.
