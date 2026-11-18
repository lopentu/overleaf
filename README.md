> **LOPE Overleaf CE+:** use the [Docker Compose deployment guide](deploy/README.md)
> to build or load the fork image, start a dedicated instance, and restore from backup.
> See [development and blocking checks](docs/lope/DEVELOPMENT.md), the
> [workflow acceptance matrix](docs/lope/FEATURE_MATRIX.md), and the
> [LOPE lab operations notes](docs/lope/OPERATIONS.md).

<h1 align="center">
  <br>
  <a href="https://www.overleaf.com"><img src="doc/logo.png" alt="Overleaf" width="300"></a>
</h1>

<h4 align="center">An open-source online real-time collaborative LaTeX editor.</h4>

<p align="center">
  <a href="https://github.com/yu-i-i/overleaf-cep/wiki">Wiki</a> •
  <a href="https://www.overleaf.com/for/enterprises">Server Pro</a> •
  <a href="#authors">Authors</a> •
  <a href="#license">License</a>
</p>

<img src="doc/screenshot.png" alt="A screenshot of a project being edited in Overleaf Extended Community Edition">
<p align="center">
  Figure 1: A screenshot of a project being edited in Overleaf CE+
</p>

## Community Edition

[Overleaf](https://www.overleaf.com) is an open-source online real-time collaborative LaTeX editor. Overleaf runs a hosted version at [www.overleaf.com](https://www.overleaf.com), but you can also run your own local version, and contribute to the development of Overleaf.

## Extended Community Edition (CE+)

The present "extended" version of Overleaf CE includes:

- Sandboxed compiles with TeX Live image selection
- Sign Up page
- LDAP authentication
- SAML authentication
- OpenID Connect authentication
- Real-time track changes and comments
- Symbol palette
- Template gallery
- Import file from external URL
- Git integration
- GitHub synchronization
- Zotero integration
- Reference Search and Pick Tool
- Document Import (`.docx`, `.md`) and Export (`.docx`, `.md`, `.html`)
- Advanced administrator tools for managing user accounts and projects
- Python script runner
- Logo tools

> [!CAUTION]
> Overleaf Community Edition is intended for use in environments where **all** users are trusted. Community Edition is **not** appropriate for scenarios where isolation of users is required due to Sandbox Compiles not being available. When not using Sandboxed Compiles, users have full read and write access to the `sharelatex` container resources (filesystem, network, environment variables) when running LaTeX compiles.
> Therefore, in any environment where not all users can be fully trusted, it is strongly recommended to enable the Sandboxed Compiles feature available in the Extended Community Edition.

For more information on Sandbox Compiles check out Overleaf [documentation](https://docs.overleaf.com/on-premises/configuration/overleaf-toolkit/server-pro-only-configuration/sandboxed-compiles).

## Enterprise

If you want help installing and maintaining Overleaf in your lab or workplace, Overleaf offers an officially supported version called [Overleaf Server Pro](https://www.overleaf.com/for/enterprises).

## Installation

Follow the [Docker Compose deployment guide](deploy/README.md) for this fork.
It covers building or importing the image, creating trusted accounts, HTTPS,
backup, restore and rollback. The old
[upstream Compose example](examples/upstream-docker-compose.yml) describes a
stock-image setup. The
[Extended CE wiki](https://github.com/yu-i-i/overleaf-cep/wiki) documents
additional upstream configuration options.

## Authors

[The Overleaf Team](https://www.overleaf.com/about)\
[yu-i-i](https://github.com/yu-i-i), [davrot](https://github.com/davrot) — CE extensions; references to adapted code are listed in [`CREDITS`](CREDITS.md). See also the authors of individual commits.

## License

The code in this repository is released under the GNU AFFERO GENERAL PUBLIC LICENSE, version 3. A copy can be found in the [`LICENSE`](LICENSE) file.

Copyright (c) Overleaf, 2014-2026.\
Copyright (c) @yu-i-i, @davrot, 2024-2026, for CE extensions.

Portions of the code are derived from other open-source projects; see [`CREDITS`](CREDITS.md).
