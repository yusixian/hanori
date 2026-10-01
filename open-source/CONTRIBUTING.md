# Contributing

Use Issues for reproducible bugs and feature proposals, and pull requests for reviewed changes. Include the affected product version, deployment method, expected behavior and a minimal reproduction. Remove credentials and personal data before attaching logs or screenshots.

Follow [AGENTS.md](AGENTS.md) for repository boundaries and [readme.md](readme.md) for setup and verification. Keep each PR focused; include behavior tests and documentation for user-visible changes. Do not rewrite historical database migrations or generated changelog files.

The maintainer develops and tests the same application in a private deployment repository. Public changes are imported there for integration verification; outgoing changes arrive on branches based on this public repository. Private Git history, configuration and deployment data are not imported into public branches. Public and private deployment SHAs can differ while representing the same product version.

MIT applies to contributions. Submit only code, text and assets you have the right to distribute. External services, models and media have their own terms.
