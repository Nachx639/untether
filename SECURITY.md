# Security policy

Untether gives remote access to a terminal: whoever signs in gets a shell on the computer, as the
account the server runs as. A way around its sign-in, or a way to make it run something its user
did not ask for, is a serious vulnerability, and reports are welcome.

## Reporting a vulnerability

Report it privately through GitHub: on this repository, **Security → Report a vulnerability**
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Only the maintainers see the report.

Please do not open a public issue, a discussion or a pull request for it, and do not test against
an installation that is not yours.

A useful report says which version or commit, how the server was started (flags, access mode,
tunnel), the steps to reproduce and what an attacker gains. This is a small project maintained in
spare time: there is no bounty and no guaranteed response time, but reports are read and fixed
with priority, and credited if you wish.

## Scope

In scope: the server (`web/`), the Mac app (`mac/`), the iOS app (`ios/`), the `ut` command and the
native forwarder (`native/`). In particular: authentication and tokens, the local bypass, the
Tailscale Serve identity, the dev-server previews, the project connector, and anything that lets
a web page or another local user reach a session.

Not a vulnerability: what an authenticated user can do (a shell is the product), and a server
its owner started with `--no-auth` together with `--unsafe-no-auth-on-network`.

Only the latest version is supported.

## How it is protected

[docs/security.md](docs/security.md) describes the sign-in modes and their limits. To try
anything, use the throwaway server (`scripts/gemelo.sh`, on `127.0.0.1:4100` with a temporary
home), never a real installation.
