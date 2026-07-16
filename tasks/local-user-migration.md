---
project: apps/frieren
---

# Description

When the user logged in for the first time, we need to detect whether this is a new account. Couple of potential ways:
1. getting that from clerk.
2. check user's DO, empty?

If it is the a new account, we should ask user whether they want to migrate the local account to the new account.
This is the flow where people play around with the site for a while, then decided to create an account.
whatever they did as a local user should be offered to migrate over to the new account to prevent data loss.

# Investigation Outcome
<!-- investigate the codebase, do research if necessary, write outcome here -->

# Plan
<!-- based on the investigation, generate concrete plan -->
