# Local macOS releases

All compilation, code signing, Apple notarization and package verification run locally. GitHub stores source and receives the verified distribution files; tags do not start a cloud build.

The publishing Mac needs one valid Developer ID Application identity, the existing Nectisse updater private key at `~/.config/nectisse/updater.key`, and a notarization credential profile. To save the Apple account credentials once, run:

```sh
xcrun notarytool store-credentials nectisse-notary --apple-id '<Apple ID>' --team-id '<Team ID>'
```

Apple's command securely prompts for the App-specific password and stores it in Keychain. It is not stored in the repository or uploaded to GitHub. An existing profile can be selected with `NECTISSE_NOTARY_PROFILE`. Public settings such as `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `CSC_KEYCHAIN`, `NECTISSE_NOTARY_PROFILE` and `NECTISSE_NOTARY_KEYCHAIN` may also be kept in `~/.config/nectisse/release.env`.

Before publishing, align the versions in package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json, the README badges and `.github/release-notes/<version>.md`. Commit the changes, then run:

```sh
npm run check
npm run test:python
npm run test:native:release
npm run release:prepare
npm run release:mac
```

The release command signs the bundled Python libraries, builds the app, notarizes and staples it, creates and notarizes the final DMG, creates a version-bound signed updater archive, and verifies the extracted app and mounted DMG. Artifacts and SHA-256 checksums are saved to `release/<version>/macos/arm64/`.

Push the committed source and its matching version tag before uploading:

```sh
git tag -a v<version> -m 'Nectisse <version>'
git push origin main --follow-tags
npm run release:publish
```

Publishing uses `gh` authentication or the repository's existing Git credential helper, verifies the tag and exact source commit, uploads a draft, checks each uploaded asset's size and SHA-256, and then publishes. Existing releases and drafts are never overwritten.

`npm run package:app:signed` produces a signed app without notarization. `npm run release:mac:preview` creates an ad-hoc local preview that cannot be published. Neither command uploads files.
