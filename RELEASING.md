# Releasing Lanes

`app/release.sh` turns a release tag into a signed, notarized `Lanes-<tag>.zip` on the GitHub release, and installed
copies of Lanes offer it from their right-click menu. A source build (`app/build.sh`) needs none of this.

## How the pieces fit

- **Developer ID certificate.** Signs the app so macOS knows who made it.
- **Notarization.** Apple scans the signed app and issues a ticket, which `stapler` attaches to the app, so Gatekeeper
  opens it without a warning, even offline.
- **Update check.** A downloaded copy carries its team id (`LanesTeamID` in its Info.plist). About once a day it asks
  `https://api.github.com/repos/hunterbohm/lanes/releases/latest` for a newer, published `vX.Y.Z` release with a
  `Lanes-vX.Y.Z.zip` asset. The right-click menu then offers "Update to Lanes X.Y.Z…". The app downloads the zip
  and installs it only if every check passes: the app inside is `io.github.hunterbohm.lanes` at the offered version,
  its code signature is a Developer ID Application certificate of the same team (`codesign -R`), and Gatekeeper
  accepts it as notarized (`spctl` says `Notarized Developer ID`). Otherwise nothing is changed and an alert says why.
  A source build has no team id, so it never checks.
- **Trust.** The team check is the gate, so a stolen GitHub login alone cannot push an app the running copy accepts:
  the attacker would also need the team's Developer ID certificate.

## One-time setup

1. The "Developer ID Application" certificate is in the login keychain of the releasing Mac. Check it:
   `security find-identity -v -p codesigning` lists `"Developer ID Application: <company> (<TEAM ID>)"`.
2. These Infisical secrets (prod, path `/`) exist; `release.sh` reads them from its environment:

   | Name | Value |
   | --- | --- |
   | `HEREBY_SIGN_IDENTITY` | the certificate's full name from step 1 |
   | `HEREBY_TEAM_ID` | the ten-character team id |
   | `HEREBY_NOTARY_KEY`, `HEREBY_NOTARY_KEY_ID`, `HEREBY_NOTARY_ISSUER` | an App Store Connect API key's `.p8` text (line breaks may be stored as literal `\n`), key id and issuer id |
   | or `HEREBY_NOTARY_PROFILE` | a `notarytool store-credentials` keychain profile, instead of the three above |

## Each release

1. Merge to `main`, then tag the commit `vX.Y.Z` (three numbers; the app compares them as numbers) and push the tag.
   Check out that tag in a clean clone.
2. `infisical run --env=prod -- app/release.sh --no-upload` builds, signs (hardened runtime), notarizes, staples,
   zips and checks the app, and leaves `app/build/release-out/<tag>/Lanes-<tag>.zip`.
3. `infisical run --env=prod -- app/release.sh` does the same, then creates the GitHub release for the tag with the zip
   attached and marks it latest. Installed apps offer it within a day.

Never mark a release as a draft or prerelease and expect it to reach installed apps: the check skips both.

## Moving to a new certificate or team

The running app only accepts updates from the team stamped into it. If the team ever changes, installed copies cannot
update themselves: people download the new release by hand once.
