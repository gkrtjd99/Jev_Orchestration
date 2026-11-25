---
name: react-component-patterns
description: "Conventions for building components in our shared React UI package: controlled and uncontrolled props, forwardRef, slot composition, Storybook stories and prop naming. Use when adding or restructuring a component in packages/ui."
---

# React Component Patterns

## Guidelines

1. Support both value/onChange and defaultValue via the useControllableState hook.
2. Forward refs to the focusable element and spread rest props onto the root.
3. Expose sub-parts as slots (Root, Trigger, Content) rather than boolean props.
4. Add a story per variant and state.
