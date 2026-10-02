# Changelog

- Requests start with the same bytes from one request of a task to the next (system prompt, project instructions, skills, repository context; the date moved out into a message of its own), and tiers that need one carry a prompt cache marker at the end of that part (`RAFIKICODE_CACHE_MARKERS`), so repeated context can be billed at cache rates.
