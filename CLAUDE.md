## SSH + Browser Auth Pattern
When running remote login commands that produce auth URLs (codex login, gh auth, etc.):
1. Set up the SSH tunnel
2. Run the login command and capture the auth URL from output
3. Run `open "<URL>"` as a SEPARATE local command to open it in the Mac browser
