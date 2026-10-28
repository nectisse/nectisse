# Distribution source

The source for each release is the matching version tag in https://github.com/nectisse/nectisse. It includes the Rust backend, React interface, Python collectors, vendored Peach/amane adaptations, extraction manifests, dependency locks and release scripts. Third-party license terms are preserved in THIRD_PARTY_NOTICES.md and the referenced files.

To reproduce the macOS Apple Silicon application, use macOS 13.3 or later with Xcode command-line tools, Node.js 26, Rust 1.99.1 and uv 0.13.5. Run `npm ci`, then `npm run package:app`. The build prepares the Python version in `.python-version` and dependencies in `python/requirements.lock`. Node.js, Rust and uv are build tools; the distributed app runs its Rust backend and bundled Python without Node.js. Signing and notarization use the release workflow under `.github/workflows/release-macos.yml` and the distributor's own credentials.
