---
name: appstore-phased-rollout
description: "Control the phased release of an already-approved iOS version in App Store Connect: pause, resume, release to all users, and decide based on crash-free rate. Use after the build is live to a percentage of users, not for beta builds."
---

# App Store phased release

- Phases run 1/2/5/10/20/50/100% over seven days; a pause can last up to 30 days in total.
- Gate: crash-free sessions must stay within 0.3 points of the previous version before moving on.
- To halt: Pause Phased Release. To finish early: Release to All Users.
- Record each decision in #release with the metric snapshot.
