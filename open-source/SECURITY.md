# Security reporting

Do not disclose credentials, personal data or unpatched exploits in public Issues. Use this repository's Security → Report a vulnerability feature if enabled. If it is unavailable, ask the maintainer in an Issue to enable private reporting, without describing the exploit or including secrets.

Include the affected version, deployment mode, impact, and minimal reproduction using synthetic data. Never send a production database, `.env`, cookies, Bot Tokens, API keys or private keys.

Deploy release versions behind HTTPS, back up encrypted data and its key separately, and keep coding workers isolated. Publishing source does not authorize anyone to access a maintainer's deployment, network or user data.
